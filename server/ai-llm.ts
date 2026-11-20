// ИИ-разбор через Claude. Если ключа нет или запрос упал — остаётся эвристика, демо не ломается.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import type { AiStatus, Incident, Insight } from '../shared/types.ts';
import { riskLevel } from './ai-heuristic.ts';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

const PRIO_TEXT = { P1: 'Наивысший', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' } as const;

function outputSchema(teams: [string, ...string[]]) {
  return z.object({
    summary: z.string().describe('2–3 предложения: что случилось, в каком продукте и сервисе, кого затронуло, что сейчас происходит'),
    cause: z.string().describe('Наиболее вероятная причина или связь с другим инцидентом одной фразой'),
    next_steps: z.array(z.string()).describe('2–4 конкретных действия координатора, коротко, в повелительном наклонении'),
    team_id: z.enum(teams).describe('Группа назначения, которой нужно передать инцидент'),
    team_reason: z.string().describe('Почему именно эта группа, одной фразой'),
    risk_score: z.number().describe('Риск, что инцидент станет критическим или сорвёт дедлайн, 0–100'),
    risk_note: z.string().describe('Пояснение к риску одной фразой'),
  });
}

const SYSTEM_PROMPT = `Ты — ассистент дежурного координатора массовых инцидентов (МИ) крупного телеком-оператора.
Координатор следит за сотнями инцидентов, передаёт их в нужные группы и эскалирует, если сроки срываются. Ему некогда читать длинные тексты.
По данным инцидента из выгрузки ITSM:
1) кратко объясни, что произошло, простым языком;
2) выбери одну группу назначения из списка; опирайся на то, какие группы решали инциденты того же продукта, сервиса и сценария;
3) оцени риск, что инцидент станет критическим или сорвёт дедлайн: приоритет, срочность, влияние, тип сервиса, остаток времени до дедлайна, связанные инциденты.
Если инцидент — дубль или дочерний и в данных есть мастер-инцидент или причина, скажи об этом.
Пиши по-русски, коротко и по делу. Не выдумывай факты, которых нет в данных.`;

let client: Anthropic | null = null;
let disabledReason: string | null = null;

export function aiStatus(): AiStatus {
  if (llmEnabled()) return { mode: 'claude', model: MODEL, reason: 'Claude уточняет разбор, эвристика отвечает мгновенно' };
  return { mode: 'heuristic', model: null, reason: disabledReason ?? 'Ключ Claude не задан — работают эвристики' };
}

export function llmEnabled(): boolean {
  if (disabledReason) return false;
  if (process.env.AI_DISABLE_LLM === '1') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.AI_LLM === '1');
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
  return client;
}

const minutes = (a: number | null, b: number) => (a === null ? null : Math.round((a - b) / 60_000));

function describe(inc: Incident, related: Incident[], teams: string[], now: number) {
  const brief = (i: Incident) => ({
    id: i.id,
    priority: PRIO_TEXT[i.priority],
    state: i.state,
    product: i.product,
    service: i.service,
    scenario: i.scenario,
    header: i.title,
    group: i.teamId,
    is_master: i.isMaster,
    is_double: i.isDouble,
    created_minutes_ago: Math.round((now - i.createdAt) / 60_000),
  });
  return {
    incident: {
      id: inc.id,
      priority: PRIO_TEXT[inc.priority],
      urgency: inc.urgency,
      impact: inc.impact,
      state: inc.state,
      product: inc.product,
      service: inc.service,
      scenario: inc.scenario,
      service_type: inc.serviceType,
      header: inc.title,
      description: inc.description,
      short_description: inc.shortDescription,
      channel: inc.channel,
      current_group: inc.teamId,
      on_coordinators: inc.onCoordinators,
      assignee: inc.assignee,
      is_master: inc.isMaster,
      is_double: inc.isDouble,
      is_cause_of_children: inc.isEffect,
      is_child: inc.isReason,
      minutes_since_created: Math.round((now - inc.createdAt) / 60_000),
      minutes_to_deadline: minutes(inc.slaDeadline, now),
      solution: inc.solution,
    },
    related_incidents: related.map(brief),
    groups: teams,
  };
}

/** Уточняет эвристический разбор ответом Claude. Бросает исключение при любой ошибке — вызывающий оставит эвристику. */
export async function refineWithClaude(inc: Incident, base: Insight, related: Incident[], teams: string[]): Promise<Insight> {
  if (!teams.length) throw new Error('Нет групп для подсказки');
  const started = Date.now();
  const payload = describe(inc, related, teams, started);
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(outputSchema(teams as [string, ...string[]])) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Эвристика уже оценила риск в ${base.risk.score}/100 (факторы: ${base.risk.factors
          .map((f) => `${f.label} ${f.weight > 0 ? '+' : ''}${f.weight}`)
          .join('; ')}) и предложила группы: ${base.teams.map((t) => `${t.teamId} (${Math.round(t.confidence * 100)}%)`).join(', ') || '—'}. Данные:\n${JSON.stringify(payload, null, 1)}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать');
  const out = response.parsed_output;
  if (!out) throw new Error('Пустой ответ модели');

  // Группа от Claude идёт первой, альтернативы эвристики остаются ниже.
  const list = [...base.teams];
  const idx = list.findIndex((t) => t.teamId === out.team_id);
  const topConf = Math.max(...list.map((t) => t.confidence), 0.5);
  const llmTeam = {
    teamId: out.team_id,
    confidence: Math.max(idx >= 0 ? list[idx].confidence : 0, Math.min(0.95, topConf + 0.05)),
    reasons: [`Claude: ${out.team_reason}`, ...(idx >= 0 ? list[idx].reasons : [])],
  };
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(llmTeam);

  const score = Math.round(0.5 * Math.max(0, Math.min(100, out.risk_score)) + 0.5 * base.risk.score);
  return {
    ...base,
    source: 'claude',
    model: response.model,
    summary: out.summary,
    cause: out.cause,
    nextSteps: out.next_steps.slice(0, 4),
    teams: list.slice(0, 3),
    risk: { ...base.risk, score, level: riskLevel(score), note: out.risk_note },
    generatedAt: Date.now(),
    latencyMs: Date.now() - started,
    pendingLlm: false,
  };
}

export function handleLlmError(err: unknown): void {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    disabledReason = 'Ключ Claude отклонён — работают эвристики';
  } else if (err instanceof Anthropic.NotFoundError) {
    disabledReason = `Модель ${MODEL} недоступна — работают эвристики`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[ai] Claude недоступен, остаёмся на эвристике: ${msg.slice(0, 200)}`);
}
