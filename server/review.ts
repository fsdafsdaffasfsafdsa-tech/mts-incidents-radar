// Разбор после решения: ИИ пишет черновик постмортема по истории инцидента — хронология, вероятная причина,
// что сделали, масштаб, что улучшить. Без ключа OpenRouter — по шаблону из тех же данных. Черновики кэшируются.
import type { Incident, Review } from '../shared/types.ts';
import { PRIORITY_TEXT } from '../shared/types.ts';
import type { Point } from './point.ts';
import { teamById } from './directory.ts';
import { regionById } from './regions.ts';
import { JARVIS_MODEL, key, openrouter } from './jarvis.ts';

const MIN = 60_000;

const cache = new Map<string, Review>();
const pending = new Map<string, Promise<Review>>();

const teamName = (id: string | null | undefined) => teamById(id)?.name ?? '—';
const regionsOf = (i: Incident) => (i.regionIds ?? []).map((r) => regionById(r)?.name).filter(Boolean).join(', ');

function facts(i: Incident): Review['facts'] {
  const end = i.resolvedAt ?? Date.now();
  return {
    level: PRIORITY_TEXT[i.priority],
    durationMin: Math.max(1, Math.round((end - i.createdAt) / MIN)),
    toTeamMin: i.routedAt ? Math.max(0, Math.round((i.routedAt - i.createdAt) / MIN)) : null,
    complaints: i.origin === 'complaints' ? i.complaints ?? 0 : null,
    regions: regionsOf(i),
    team: teamName(i.teamId),
    assignee: i.assigneeName,
  };
}

/** Ключевые события: появление, уровни, кто вёл, передачи, сигналы, решение — не больше 12. */
function timeline(i: Incident) {
  const items = i.history.filter((h) => !/^ИИ: \d+ жалоб/.test(h.text)).map((h) => ({ at: h.at, text: h.text.replace(/^ИИ:\s*/, 'ИИ: ') }));
  if (items.length <= 12) return items;
  return [...items.slice(0, 4), ...items.slice(-8)];
}

function byRules(i: Incident): Omit<Review, 'id' | 'title' | 'at' | 'facts' | 'timeline'> {
  const f = facts(i);
  const scale = f.complaints !== null ? `${f.complaints} жалоб абонентов${f.regions ? ` (${f.regions})` : ''}` : `инцидент из ITSM (${i.productName})`;
  return {
    by: 'rules',
    summary: `${i.title}. ${scale}. Решён за ${f.durationMin} мин командой «${f.team}»${f.assignee ? `, исполнитель ${f.assignee}` : ''}.`,
    cause: i.solution ? `По записи команды: ${i.solution}` : 'Причина в решении не указана — уточнить у команды.',
    actions: [f.toTeamMin !== null ? `Передан команде через ${f.toTeamMin} мин после появления.` : 'Решён без передачи команде.', i.solution ? `Решение: ${i.solution}` : ''].filter(Boolean).join(' '),
    impact: f.complaints !== null ? `${f.complaints} жалоб за время инцидента, уровень «${f.level}».` : `Уровень «${f.level}», продукт ${i.productName}.`,
    lessons: [f.toTeamMin !== null && f.toTeamMin > 10 ? 'Передать быстрее: инцидент ждал на пункте больше 10 минут.' : 'Передача команде — в норме.', 'Записать причину и решение в базу знаний команды.'],
  };
}

async function byAi(i: Incident): Promise<Omit<Review, 'id' | 'title' | 'at' | 'facts' | 'timeline'>> {
  const f = facts(i);
  const data = [
    `Инцидент: ${i.title}`,
    `Описание: ${(i.description || i.shortDescription || '').replace(/\s+/g, ' ').slice(0, 600)}`,
    `Сервис: ${i.service}; продукт: ${i.productName}; регионы: ${f.regions || '—'}`,
    `Уровень: ${f.level}; жалоб: ${f.complaints ?? '—'}; длительность: ${f.durationMin} мин; до передачи команде: ${f.toTeamMin ?? '—'} мин`,
    `Команда: ${f.team}; исполнитель: ${f.assignee ?? '—'}; решение команды: ${i.solution ?? '—'}`,
    'История:',
    ...timeline(i).map((h) => `${new Date(h.at).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })} ${h.text}`),
    ...(i.comments ?? []).slice(-6).map((c) => `переписка — ${c.author}: ${c.text}`),
  ].join('\n');
  const r = await openrouter(
    '/chat/completions',
    {
      model: JARVIS_MODEL(),
      max_tokens: 1400,
      temperature: 0.3,
      reasoning: { effort: 'low' },
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Ты пишешь черновик разбора (постмортема) инцидента для координирующего пункта ИТ телеком-оператора. Только по данным, ничего не выдумывай; если причины нет в данных — так и напиши «предположительно» и что уточнить. Пиши по-русски, коротко и по делу. Ответ — строго JSON: {"summary":"2 предложения","cause":"вероятная причина, 1–2 предложения","actions":"что сделали, 1–3 предложения","impact":"масштаб и влияние на абонентов, 1–2 предложения","lessons":["2–4 конкретных улучшения"]}',
        },
        { role: 'user', content: data },
      ],
    },
    40_000,
  );
  if (r.status !== 200) throw new Error(`разбор: ${r.status} ${r.buf.toString('utf8').slice(0, 160)}`);
  const msg = (JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] }).choices[0].message.content ?? '';
  const j = JSON.parse(msg.slice(msg.indexOf('{'), msg.lastIndexOf('}') + 1)) as { summary: string; cause: string; actions: string; impact: string; lessons: string[] };
  return { by: 'ai', summary: j.summary, cause: j.cause, actions: j.actions, impact: j.impact, lessons: (j.lessons ?? []).slice(0, 5) };
}

export async function reviewFor(point: Point, id: string, fresh = false): Promise<Review> {
  const inc = point.incidents.get(id);
  if (!inc) throw new Error('Инцидент не найден');
  if (inc.status !== 'resolved') throw new Error('Разбор пишется после решения');
  if (!fresh && cache.has(id)) return cache.get(id)!;
  if (!fresh && pending.has(id)) return pending.get(id)!;
  const job = (async () => {
    let body: Omit<Review, 'id' | 'title' | 'at' | 'facts' | 'timeline'>;
    try {
      body = key() ? await byAi(inc) : byRules(inc);
    } catch (err) {
      console.error('Разбор: ИИ недоступен, по шаблону —', err instanceof Error ? err.message : err);
      body = byRules(inc);
    }
    const rv: Review = { id, title: inc.title, at: Date.now(), facts: facts(inc), timeline: timeline(inc), ...body };
    cache.set(id, rv);
    return rv;
  })();
  pending.set(id, job);
  try {
    return await job;
  } finally {
    pending.delete(id);
  }
}

/** Список решённых за сутки с пометкой «разбор готов». */
export function reviewList(point: Point) {
  const from = Date.now() - 24 * 3_600_000;
  return [...point.incidents.values()]
    .filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, 60)
    .map((i) => ({ id: i.id, title: i.title, priority: i.priority, resolvedAt: i.resolvedAt, durationMin: Math.round(((i.resolvedAt ?? 0) - i.createdAt) / MIN), team: teamName(i.teamId), origin: i.origin, ready: cache.has(i.id), by: cache.get(i.id)?.by ?? null }));
}
