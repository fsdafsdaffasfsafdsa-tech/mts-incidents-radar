// ИИ-разбор через Claude. Если ключа нет или запрос упал — остаётся эвристика, демо не ломается.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import type { AiStatus, Incident, Insight } from '../shared/types.ts';
import { COORDINATORS_ID, TEAMS, systemById, teamById } from './catalog.ts';
import { riskLevel } from './ai-heuristic.ts';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const TEAM_IDS = TEAMS.filter((t) => t.id !== COORDINATORS_ID).map((t) => t.id) as [string, ...string[]];

const OutputSchema = z.object({
  summary: z.string().describe('2–3 предложения: что случилось, где, кого затронуло, что сейчас происходит'),
  cause: z.string().describe('Наиболее вероятная причина одной фразой'),
  next_steps: z.array(z.string()).describe('2–4 конкретных действия координатора, коротко, в повелительном наклонении'),
  team_id: z.enum(TEAM_IDS).describe('Команда, которой нужно передать инцидент'),
  team_reason: z.string().describe('Почему именно эта команда, одной фразой'),
  risk_score: z.number().describe('Риск, что инцидент станет критическим или нарушит SLA, 0–100'),
  risk_note: z.string().describe('Пояснение к риску одной фразой'),
});

const SYSTEM_PROMPT = `Ты — ассистент дежурного координатора IT-инцидентов крупного телеком-оператора.
Координатор следит за сотнями инцидентов и решает, какой команде отдать каждый. Ему некогда читать длинные тексты.
По данным инцидента:
1) кратко объясни, что произошло, простым языком без жаргона мониторинга;
2) выбери одну команду из списка, которой нужно передать инцидент; учитывай не только систему, но и суть проблемы (например, SMS-коды в приложении — это SMS-платформа, а аномальный трафик — ИБ);
3) оцени риск, что ситуация станет критической или нарушит SLA, учитывая приоритет, остаток SLA, число абонентов, тренд и связанные инциденты.
Если в данных есть вероятная первопричина (связанный инцидент в системе, от которой зависит эта), скажи об этом.
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

function describe(inc: Incident, related: Incident[], now: number) {
  const sys = systemById(inc.systemId);
  const brief = (i: Incident) => ({
    id: i.id,
    priority: i.priority,
    system: systemById(i.systemId).name,
    title: i.title,
    team: teamById(i.teamId)?.name ?? null,
    created_minutes_ago: Math.round((now - i.createdAt) / 60_000),
  });
  return {
    incident: {
      id: inc.id,
      priority: inc.priority,
      status: inc.status,
      system: sys.name,
      system_depends_on: sys.dependsOn.map((d) => systemById(d).name),
      service: inc.service,
      component: inc.component,
      region: inc.region,
      title: inc.title,
      description: inc.description,
      monitoring_signals: inc.signals,
      affected_subscribers: inc.affectedUsers,
      trend: inc.trend,
      current_team: teamById(inc.teamId)?.name ?? null,
      assignee: inc.assignee,
      reassign_count: inc.reassignCount,
      minutes_since_created: Math.round((now - inc.createdAt) / 60_000),
      minutes_to_sla_breach: Math.round((inc.slaDeadline - now) / 60_000),
      sla_total_minutes: inc.slaMinutes,
    },
    related_incidents: related.map(brief),
    teams: TEAMS.filter((t) => t.id !== COORDINATORS_ID).map((t) => ({ id: t.id, name: t.name, profile: t.keywords.slice(0, 8).join(', ') })),
  };
}

/** Уточняет эвристический разбор ответом Claude. Бросает исключение при любой ошибке — вызывающий оставит эвристику. */
export async function refineWithClaude(inc: Incident, base: Insight, related: Incident[]): Promise<Insight> {
  const started = Date.now();
  const payload = describe(inc, related, started);
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(OutputSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Эвристика уже оценила риск в ${base.risk.score}/100 (факторы: ${base.risk.factors
          .map((f) => `${f.label} ${f.weight > 0 ? '+' : ''}${f.weight}`)
          .join('; ')}). Данные:\n${JSON.stringify(payload, null, 1)}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать');
  const out = response.parsed_output;
  if (!out) throw new Error('Пустой ответ модели');

  // Команда от Claude идёт первой, альтернативы эвристики остаются ниже.
  const teams = [...base.teams];
  const idx = teams.findIndex((t) => t.teamId === out.team_id);
  const topConf = Math.max(...teams.map((t) => t.confidence), 0.5);
  const llmTeam = {
    teamId: out.team_id,
    confidence: Math.max(idx >= 0 ? teams[idx].confidence : 0, Math.min(0.95, topConf + 0.05)),
    reasons: [`Claude: ${out.team_reason}`, ...(idx >= 0 ? teams[idx].reasons : [])],
  };
  if (idx >= 0) teams.splice(idx, 1);
  teams.unshift(llmTeam);

  const score = Math.round(0.5 * Math.max(0, Math.min(100, out.risk_score)) + 0.5 * base.risk.score);
  return {
    ...base,
    source: 'claude',
    model: response.model,
    summary: out.summary,
    cause: out.cause,
    nextSteps: out.next_steps.slice(0, 4),
    teams: teams.slice(0, 3),
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
