// Эвристический ИИ: работает всегда, без ключей и сети.
// Три задачи кейса: кратко объяснить, что случилось; подсказать команду; оценить риск эскалации.
import type { AiBrief, Incident, Insight, Priority, RiskFactor, RiskLevel, TeamScore } from '../shared/types.ts';
import { COORDINATORS_ID, SYSTEMS, TEAMS, systemById, teamById } from './catalog.ts';

export interface AiContext {
  now: number;
  incidents: Map<string, Incident>;
  teamLoad: Record<string, number>;
}

export function buildContext(incidents: Map<string, Incident>, now: number): AiContext {
  const teamLoad: Record<string, number> = {};
  for (const inc of incidents.values()) {
    if (inc.status === 'resolved' || !inc.teamId) continue;
    teamLoad[inc.teamId] = (teamLoad[inc.teamId] ?? 0) + 1;
  }
  return { now, incidents, teamLoad };
}

// ─── Текст и ключевые слова ────────────────────────────────────────────────

const WORD = /[\p{L}\p{N}]/u;

function incidentText(inc: Incident): string {
  return `${inc.title}. ${inc.description} ${inc.signals.join('. ')} ${inc.service}`.toLowerCase().replace(/ё/g, 'е');
}

/** Ищет ключевое слово; короткие (до 3 символов) — только целым словом. Возвращает найденное слово из текста. */
function findKeyword(text: string, kw: string): string | null {
  const k = kw.toLowerCase().replace(/ё/g, 'е').trim();
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(k, from);
    if (i < 0) return null;
    const before = i > 0 ? text[i - 1] : ' ';
    const after = text[i + k.length] ?? ' ';
    const whole = !WORD.test(before) && !WORD.test(after);
    if (k.length > 3 || whole) {
      // Расширяем до целого слова, чтобы показать человеку, что именно совпало.
      let s = i;
      let e = i + k.length;
      while (s > 0 && WORD.test(text[s - 1])) s--;
      while (e < text.length && WORD.test(text[e])) e++;
      return text.slice(s, e);
    }
    from = i + 1;
  }
  return null;
}

// ─── Связанные инциденты ───────────────────────────────────────────────────

const PRIO_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const MIN = 60_000;

function dependsOn(a: string, b: string): boolean {
  return systemById(a).dependsOn.includes(b);
}

export type Relation = 'upstream' | 'downstream' | 'same' | 'region';

/**
 * Как инцидент b связан с инцидентом a.
 * upstream — b в системе, от которой зависит a, и случился раньше: кандидат в первопричину.
 * Причина не может быть позже следствия, а слабые P3/P4 не тянут за собой цепочки.
 */
export function relationOf(a: Incident, b: Incident): Relation | null {
  const pa = PRIO_RANK[a.priority];
  const pb = PRIO_RANK[b.priority];
  const dt = a.createdAt - b.createdAt; // > 0: b раньше
  // Причина возникла раньше следствия и не менее критична, чем оно.
  if (dependsOn(a.systemId, b.systemId) && dt >= 0 && dt <= 12 * MIN && pb <= 2 && pb <= pa && pa <= 3 && (pb === 1 || dt <= 6 * MIN))
    return 'upstream';
  if (dependsOn(b.systemId, a.systemId) && dt <= 0 && -dt <= 12 * MIN && pa <= 2 && pa <= pb && pb <= 3 && (pa === 1 || -dt <= 6 * MIN))
    return 'downstream';
  const adt = Math.abs(dt);
  if (a.systemId === b.systemId && adt <= 10 * MIN && pa <= 2 && pb <= 2) return 'same';
  if (a.region === b.region && adt <= 10 * MIN && pa <= 2 && pb <= 2 && (pa === 1 || pb === 1)) return 'region';
  return null;
}

/** Внешние и физические сбои — атака, обрыв, перегрев, питание — сами себе первопричина. */
const PRIMARY_MARKERS = [
  'ddos', 'атак', 'обрыв', 'перегрев', 'отказ ибп', 'пропало питание', 'земляных работ', 'истёк сертификат',
  'после обновления', 'после релиза', 'после выкладки',
];
export function isPrimaryFailure(inc: Incident): boolean {
  const text = `${inc.title} ${inc.description}`.toLowerCase().replace(/ё/g, 'е');
  return PRIMARY_MARKERS.some((m) => text.includes(m.replace(/ё/g, 'е')));
}

const byImportance = (x: Incident, y: Incident) => PRIO_RANK[x.priority] - PRIO_RANK[y.priority] || x.createdAt - y.createdAt;

export function findCorrelation(inc: Incident, ctx: AiContext): Insight['correlation'] {
  const related: { other: Incident; rel: Relation | 'linked' }[] = [];
  for (const other of ctx.incidents.values()) {
    if (other.id === inc.id || other.status === 'resolved') continue;
    const rel = relationOf(inc, other);
    if (rel) related.push({ other, rel });
    else if (inc.relatedIds.includes(other.id) || other.id === inc.parentId || other.parentId === inc.id) related.push({ other, rel: 'linked' });
  }
  if (related.length === 0) return null;

  const parent = inc.parentId ? ctx.incidents.get(inc.parentId) : undefined;
  const primary = isPrimaryFailure(inc);
  // «Следом пошли»: зависимые системы или та же система, но позже.
  const followers = related.filter(
    (r) => r.rel === 'downstream' || r.other.parentId === inc.id || (r.rel === 'same' && r.other.createdAt >= inc.createdAt && PRIO_RANK[r.other.priority] >= PRIO_RANK[inc.priority]),
  );
  // Кандидаты в причину: раньше по времени и не слабее. Чем ближе по времени и региону, тем вероятнее.
  const causes = primary
    ? []
    : related
        .filter(
          (r) =>
            r.rel === 'upstream' ||
            ((r.rel === 'same' || r.rel === 'region') && r.other.createdAt <= inc.createdAt && PRIO_RANK[r.other.priority] <= PRIO_RANK[inc.priority]),
        )
        .map((r) => {
          const gap = (inc.createdAt - r.other.createdAt) / MIN;
          const score = gap + 4 * (PRIO_RANK[r.other.priority] - 1) + (r.rel === 'region' ? 0.5 : 0) - (r.other.region === inc.region ? 0.5 : 0);
          return { other: r.other, score };
        })
        .sort((a, b) => a.score - b.score);
  let root: Incident;
  if (parent) root = parent;
  else if (causes.length) root = causes[0].other;
  else if (followers.length || primary) root = inc;
  else root = [inc, ...related.map((r) => r.other)].sort(byImportance)[0];

  const ids = related.map((r) => r.other.id);
  const sys = systemById(inc.systemId);
  const rootSys = systemById(root.systemId);
  let text: string;
  if (root.id !== inc.id) {
    const why = dependsOn(inc.systemId, root.systemId)
      ? `«${sys.short}» зависит от «${rootSys.short}», сбой там начался ${agoBetween(root.createdAt, inc.createdAt)} раньше`
      : root.systemId === inc.systemId
        ? `та же система, сбой там начался ${agoBetween(root.createdAt, inc.createdAt)} раньше`
        : `тот же регион (${inc.region}) и одно время`;
    text = `Похоже на последствие ${root.id} (${rootSys.short}): ${why}. Лучше связать как дочерний и не дублировать работу команд.`;
  } else if (followers.length) {
    const names = [...new Set(followers.map((r) => systemById(r.other.systemId).short))].slice(0, 4).join(', ');
    text = `Вероятная первопричина: следом пошли ${followers.length} ${plural(followers.length, 'инцидент', 'инцидента', 'инцидентов')} (${names}). Вести как один массовый сбой.`;
  } else {
    text = `Рядом по времени ещё ${related.length} ${plural(related.length, 'инцидент', 'инцидента', 'инцидентов')} с тем же масштабом — возможен общий сбой.`;
  }
  return { rootId: root.id, ids, text };
}

// ─── Подсказка команды ─────────────────────────────────────────────────────

export function recommendTeams(inc: Incident, ctx: AiContext, corr = findCorrelation(inc, ctx)): TeamScore[] {
  const text = incidentText(inc);
  const sys = systemById(inc.systemId);
  const root = corr?.rootId && corr.rootId !== inc.id ? ctx.incidents.get(corr.rootId) : undefined;
  const rootTeam = root
    ? root.teamId && root.teamId !== COORDINATORS_ID
      ? root.teamId
      : recommendTeams(root, ctx, null)[0]?.teamId
    : undefined;

  const scored = TEAMS.filter((t) => t.id !== COORDINATORS_ID).map((team) => {
    let s = 0;
    const reasons: string[] = [];
    const ownerIdx = sys.owners.indexOf(team.id);
    if (ownerIdx === 0) {
      s += 1.0;
      reasons.push(`Владеет системой «${sys.short}»`);
    } else if (ownerIdx > 0) {
      s += 0.5;
      reasons.push(`Совладелец системы «${sys.short}»`);
    }
    const hits: string[] = [];
    for (const kw of team.keywords) {
      const w = findKeyword(text, kw);
      if (w && !hits.includes(w)) hits.push(w);
      if (hits.length >= 3) break;
    }
    if (hits.length) {
      s += 0.9 * hits.length;
      reasons.push(`В описании: ${hits.map((h) => `«${h}»`).join(', ')}`);
    }
    if (rootTeam === team.id) {
      s += 0.8;
      reasons.push(root!.teamId === team.id ? `Первопричина ${root!.id} уже у этой команды` : `Профиль первопричины ${root!.id}`);
    }
    const load = ctx.teamLoad[team.id] ?? 0;
    const ratio = load / team.capacity;
    if (ratio > 1) {
      // Загрузка — повод показать альтернативу, но не перебить профиль команды.
      s -= Math.min(0.35, (ratio - 1) * 0.3);
      reasons.push(`Перегружена: ${load} в работе при норме ${team.capacity}`);
    } else if (s > 0) {
      reasons.push(`Загрузка ${load} из ${team.capacity}`);
    }
    return { teamId: team.id, s, reasons };
  });

  const T = 0.75;
  const max = Math.max(...scored.map((x) => x.s));
  const exps = scored.map((x) => Math.exp((x.s - max) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  return scored
    .map((x, i) => ({ teamId: x.teamId, confidence: exps[i] / sum, reasons: x.reasons }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .filter((t, i) => i === 0 || t.confidence >= 0.04);
}

// ─── Риск эскалации ────────────────────────────────────────────────────────

const PRIO_W: Record<Priority, number> = { P1: 1.4, P2: 0.7, P3: -0.1, P4: -0.8 };

export function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

export function assessRisk(inc: Incident, ctx: AiContext, corr = findCorrelation(inc, ctx)): Insight['risk'] {
  const factors: RiskFactor[] = [];
  const add = (label: string, weight: number) => {
    if (Math.abs(weight) >= 0.12) factors.push({ label, weight: Math.round(weight * 100) / 100 });
    return weight;
  };
  let z = -1.6;
  z += add(`Приоритет ${inc.priority}`, PRIO_W[inc.priority]);

  const total = inc.slaDeadline - inc.createdAt;
  const remaining = inc.slaDeadline - ctx.now;
  const f = (ctx.now - inc.createdAt) / total;
  if (remaining <= 0) z += add('SLA уже нарушен', 2.4 + Math.min(0.8, (-remaining / 3_600_000) * 0.8));
  else {
    const c = 2.4 * Math.pow(Math.min(1, Math.max(0, (f - 0.4) / 0.6)), 1.5);
    z += add(`Прошло ${Math.round(f * 100)}% времени SLA`, c);
  }

  if (inc.affectedUsers > 0) {
    const c = Math.max(-0.6, Math.min(1.2, 0.55 * Math.log10(inc.affectedUsers / 10_000)));
    z += add(`Затронуто ≈ ${fmtUsers(inc.affectedUsers)} абонентов`, c);
  } else {
    const dependents = SYSTEMS.filter((s) => s.dependsOn.includes(inc.systemId)).length;
    z += add(`От системы зависят ещё ${dependents} ${plural(dependents, 'сервис', 'сервиса', 'сервисов')}`, Math.min(1.4, 0.35 * dependents));
  }

  if (inc.trend === 'growing') z += add('Метрики ухудшаются', 0.8);
  if (inc.trend === 'declining') z += add('Метрики восстанавливаются', -0.7);

  if (inc.status === 'coordinators') z += add('Никто не назначен — ждёт координатора', 0.6);
  else if (inc.status === 'assigned') z += add('Команда ещё не взяла в работу', 0.3);
  else if (inc.status === 'in_progress') z += add('Исполнитель уже работает', -0.4);
  else if (inc.status === 'escalated') z += add('Под контролем руководителя смены', -0.2);

  if (inc.reassignCount > 0) z += add(`Переназначался ${inc.reassignCount} раз`, Math.min(1.2, 0.4 * inc.reassignCount));
  const relatedCount = corr?.ids.length ?? 0;
  if (relatedCount > 0) z += add(`${relatedCount} ${plural(relatedCount, 'связанный инцидент', 'связанных инцидента', 'связанных инцидентов')} рядом`, 0.35 * Math.min(4, relatedCount));

  const score = Math.round(100 / (1 + Math.exp(-z)));
  const level = riskLevel(score);
  factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const minutesToBreach = Math.round(remaining / 60_000);

  let note: string;
  if (remaining <= 0) note = `SLA нарушен ${fmtMin(-minutesToBreach)} назад. Нужна эскалация руководителю смены.`;
  else if ((level === 'critical' || level === 'high') && inc.priority !== 'P1' && inc.trend === 'growing')
    note = `Метрики ухудшаются: вероятно повышение до ${higher(inc.priority)} в ближайшие ${fmtMin(Math.min(minutesToBreach, 30))}.`;
  else if (level === 'critical' || level === 'high') note = `До нарушения SLA ${fmtMin(minutesToBreach)}. Держать на контроле.`;
  else if (level === 'medium') note = 'Ситуация под контролем, проверить статус через 15 минут.';
  else note = 'Риск низкий, обычный порядок работы.';

  return { score, level, factors: factors.slice(0, 6), minutesToBreach, note };
}

// ─── Резюме ────────────────────────────────────────────────────────────────

export function heuristicInsight(inc: Incident, ctx: AiContext, started = Date.now()): Insight {
  const corr = findCorrelation(inc, ctx);
  const teams = recommendTeams(inc, ctx, corr);
  const risk = assessRisk(inc, ctx, corr);
  const sys = systemById(inc.systemId);
  const top = teamById(teams[0]?.teamId);
  const team = teamById(inc.teamId);

  const firstSentence = inc.description.split(/(?<=[.!?])\s/)[0] ?? inc.description;
  const parts: string[] = [];
  parts.push(`В системе «${sys.short}» (${inc.service}, ${inc.region}): ${lowerFirst(firstSentence)}`);
  const dependents = SYSTEMS.filter((s) => s.dependsOn.includes(inc.systemId)).map((s) => s.short);
  const impact =
    inc.affectedUsers > 0
      ? `Затронуто ≈ ${fmtUsers(inc.affectedUsers)} абонентов`
      : dependents.length
        ? `Абоненты напрямую не затронуты, но от «${sys.short}» зависят ${dependents.slice(0, 3).join(', ')}`
        : 'Абоненты напрямую не затронуты';
  const trend = inc.trend === 'growing' ? ', ситуация ухудшается' : inc.trend === 'declining' ? ', метрики восстанавливаются' : '';
  parts.push(`${impact}${trend}.`);
  const who =
    inc.status === 'coordinators'
      ? 'Инцидент ждёт решения координатора'
      : inc.status === 'resolved'
        ? 'Инцидент решён'
        : inc.assignee
          ? `Решает ${inc.assignee} (${team?.short ?? '—'})`
          : `Передан команде «${team?.short ?? '—'}», исполнитель ещё не назначен`;
  const sla =
    inc.status === 'resolved' ? '' : risk.minutesToBreach! > 0 ? `; до нарушения SLA ${fmtMin(risk.minutesToBreach!)}` : '; SLA уже нарушен';
  parts.push(`${who}${sla}.`);

  const rootInc = corr?.rootId && corr.rootId !== inc.id ? ctx.incidents.get(corr.rootId) : undefined;
  const cause = rootInc
    ? `Вероятно, следствие ${rootInc.id}: «${rootInc.title}».`
    : inc.signals[0]
      ? `Первичный сигнал мониторинга: ${inc.signals[0]}.`
      : null;

  const steps: string[] = [];
  if (inc.status === 'coordinators' && top) steps.push(`Передать команде «${top.name}» (уверенность ${Math.round(teams[0].confidence * 100)}%)`);
  if (inc.teamId && inc.teamId !== COORDINATORS_ID && top && top.id !== inc.teamId && teams[0].confidence > 0.6)
    steps.push(`Проверить маршрут: профильнее команда «${top.short}»`);
  if (rootInc && inc.parentId !== rootInc.id) steps.push(`Связать с ${rootInc.id} как дочерний`);
  if (corr && corr.rootId === inc.id && corr.ids.length >= 2) steps.push(`Объявить массовый сбой и связать ${corr.ids.length} инцидента`);
  if ((risk.level === 'high' || risk.level === 'critical') && inc.priority !== 'P1' && inc.trend === 'growing')
    steps.push(`Рассмотреть повышение до ${higher(inc.priority)}`);
  if (risk.minutesToBreach !== null && risk.minutesToBreach <= 30 && inc.status !== 'escalated' && inc.status !== 'resolved')
    steps.push(risk.minutesToBreach <= 0 ? 'Эскалировать руководителю смены: SLA нарушен' : `Предупредить руководителя смены: SLA через ${fmtMin(risk.minutesToBreach)}`);
  if (inc.affectedUsers >= 100_000 && PRIO_RANK[inc.priority] <= 2) steps.push('Дать контакт-центру готовый ответ для абонентов');
  if (inc.status === 'assigned' && ctx.now - inc.updatedAt > 8 * 60_000) steps.push('Напомнить команде: инцидент ещё не взят в работу');
  if (inc.status === 'in_progress' && inc.assignee) steps.push(`Запросить у ${inc.assignee} оценку времени решения`);

  return {
    incidentId: inc.id,
    source: 'heuristic',
    summary: parts.join(' '),
    cause,
    nextSteps: steps.slice(0, 4),
    teams,
    risk,
    correlation: corr,
    generatedAt: Date.now(),
    latencyMs: Date.now() - started,
  };
}

export function briefOf(inc: Incident, ctx: AiContext): AiBrief {
  const corr = findCorrelation(inc, ctx);
  const risk = assessRisk(inc, ctx, corr);
  const teams = recommendTeams(inc, ctx, corr);
  return { risk: risk.score, level: risk.level, teamId: teams[0]?.teamId ?? null, confidence: teams[0]?.confidence ?? 0 };
}

// ─── Форматирование ────────────────────────────────────────────────────────

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function fmtUsers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '')} млн`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} тыс.`;
  return String(n);
}

export function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

function agoBetween(a: number, b: number): string {
  const sec = Math.round(Math.abs(a - b) / 1000);
  return sec < 60 ? `на ${Math.max(1, sec)} с` : `на ${Math.round(sec / 60)} мин`;
}


function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

export function higher(p: Priority): Priority {
  return p === 'P4' ? 'P3' : p === 'P3' ? 'P2' : 'P1';
}
