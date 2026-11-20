// Эвристический ИИ на наборе данных: кому назначить, риск, связанные инциденты, короткое резюме.
// Работает всегда, без ключей и сети.
import type { AiBrief, Incident, Insight, PlanItem, Priority, RiskFactor, RiskLevel, TeamScore, Worker, WorkerScore } from '../shared/types.ts';
import { distanceKm, experience, groupById, groupForService, officeById } from './catalog.ts';

export interface AiContext {
  now: number;
  incidents: Map<string, Incident>;
  workers: Worker[];
  load: Map<string, number>; // активных задач у сотрудника
}

export function buildContext(incidents: Map<string, Incident>, now: number, workers: Worker[] = []): AiContext {
  const load = new Map<string, number>();
  for (const i of incidents.values()) {
    if (i.status !== 'resolved' && i.assignee) load.set(i.assignee, (load.get(i.assignee) ?? 0) + 1);
  }
  return { now, incidents, workers, load };
}

const PRIO_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const MIN = 60_000;

// ─── кому назначить ────────────────────────────────────────────────────────
// Три слоя, как в docs/models-proposal.md: жёсткие фильтры → прозрачный скоринг → распределение пачкой.

const ROAD = 1.3; // извилистость дорог относительно прямой
const SPEED_KMH = 55; // средняя скорость выездной бригады по ЮФО
const SHIFT_LIMIT_H = 11.5; // после этого на новый выезд не ставим

export function workerPos(w: Worker, ctx: AiContext): { lat: number; lon: number } | null {
  const cur = w.currentId ? ctx.incidents.get(w.currentId) : undefined;
  if (cur?.crew && !cur.crew.arrived) {
    const k = Math.min(1, Math.max(0, (ctx.now - cur.crew.dispatchedAt) / cur.crew.etaMs));
    return { lat: cur.crew.from.lat + (cur.geo.lat - cur.crew.from.lat) * k, lon: cur.crew.from.lon + (cur.geo.lon - cur.crew.from.lon) * k };
  }
  if (w.lat !== null && w.lon !== null) return { lat: w.lat, lon: w.lon };
  const office = officeById(w.office);
  return office ? { lat: office.lat, lon: office.lon } : null;
}

export const etaMinutes = (km: number) => Math.round(((km * ROAD) / SPEED_KMH) * 60);

/** Похожие задачи: из выгрузки и решённые за смену. */
function similarDone(w: Worker, inc: Incident, ctx: AiContext) {
  const exp = experience(w.id, inc.productName, inc.service);
  let live = 0;
  for (const o of ctx.incidents.values()) if (o.assignee === w.id && o.status === 'resolved' && o.service === inc.service && o.origin === 'stream') live++;
  return { service: exp.sameService + live, product: exp.sameProduct };
}

export function rankWorkers(inc: Incident, ctx: AiContext, limit = 6): WorkerScore[] {
  const pool = ctx.workers.filter((w) => w.mode === inc.mode);
  if (!pool.length) return [];
  // Координаторы — диспетчерская группа, а не навык: её не засчитываем.
  const g0 = groupForService(inc.productName, inc.service);
  const group = g0 && !/координатор/i.test(groupById(g0)?.name ?? '') ? g0 : null;
  const scored = pool.map((w) => {
    const parts: { label: string; points: number }[] = [];
    const reasons: string[] = [];
    const add = (label: string, points: number) => parts.push({ label, points: Math.round(points) });
    const hours = Math.max(0, (ctx.now - w.shiftStart) / 3_600_000);
    let blocked: string | null = null;
    if (w.status === 'break') blocked = 'на перерыве';
    else if (hours >= SHIFT_LIMIT_H) blocked = 'смена кончается';

    // Опыт со сглаживанием: 1 из 1 не обгоняет того, кто закрыл 9 похожих.
    const sim = similarDone(w, inc, ctx);
    const expW = inc.mode === 'offline' ? 25 : 40;
    const xp = sim.service + 0.35 * sim.product;
    add('Опыт', (expW * xp) / (xp + 2));
    if (sim.service) reasons.push(`${sim.service} похожих закрыл`);
    else if (sim.product) reasons.push('знает продукт');

    // Навык: группа, которая решает этот сервис.
    const skillW = inc.mode === 'offline' ? 15 : 20;
    if (group && w.groups.includes(group)) {
      add('Навык', skillW);
      reasons.push('профильная группа');
    } else add('Навык', 0);

    // Занятость.
    const active = (ctx.load.get(w.id) ?? 0) - (inc.assignee === w.id ? 1 : 0);
    const loadW = inc.mode === 'offline' ? 20 : 30;
    if (active <= 0 && (w.status === 'free' || inc.assignee === w.id)) {
      add('Занятость', loadW);
      reasons.push('свободен');
    } else {
      add('Занятость', Math.max(-10, loadW * 0.75 - 7 * active));
      reasons.push(active > 0 ? `задач: ${active}` : 'занят');
    }

    // Дорога (выезд): время в пути от того места, где сотрудник сейчас.
    let km: number | null = null;
    let etaMin: number | null = null;
    if (inc.mode === 'offline') {
      const pos = workerPos(w, ctx);
      if (pos) {
        km = Math.round(distanceKm(pos, inc.geo));
        etaMin = etaMinutes(km);
        // Дальше двух часов — штраф растёт: на выезд не отправляем через полрегиона, если есть кто-то рядом.
        add('Дорога', 40 * (1 - Math.min(etaMin, 240) / 240) - Math.max(0, etaMin - 120) / 12);
        reasons.unshift(etaMin < 60 ? `${etaMin} мин езды` : `${Math.floor(etaMin / 60)} ч ${etaMin % 60} мин езды`);
      }
    }

    // Усталость: после 6 часов смены балл снижается.
    const tired = Math.max(0, hours - 6) * 3 + (inc.mode === 'offline' ? Math.max(0, w.trips - 3) * 2 : 0);
    add('Усталость', -tired);
    reasons.push(`${Math.floor(hours)} ч на смене`);

    const score = Math.max(0, Math.min(100, parts.reduce((a, p) => a + p.points, 0)));
    return { workerId: w.id, score: Math.round(score), parts, reasons: reasons.slice(0, 4), km, etaMin, blocked };
  });
  const ok = scored.filter((x) => !x.blocked);
  const max = Math.max(0, ...ok.map((x) => x.score));
  const exps = new Map(ok.map((x) => [x.workerId, Math.exp((x.score - max) / 10)]));
  const sum = [...exps.values()].reduce((a, b) => a + b, 0) || 1;
  return scored
    .map((x) => ({ ...x, confidence: x.blocked ? 0 : (exps.get(x.workerId) ?? 0) / sum }))
    .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || b.score - a.score)
    .slice(0, limit);
}

/** Лучшие допущенные кандидаты (для автоназначения и подсказки в строке). */
export function recommendWorkers(inc: Incident, ctx: AiContext): WorkerScore[] {
  return rankWorkers(inc, ctx, 99)
    .filter((x) => !x.blocked)
    .slice(0, 3);
}

/**
 * Распределение пачкой: каждому сотруднику — не больше одной новой задачи, сумма баллов максимальна.
 * Венгерский алгоритм на матрице «инцидент × сотрудник».
 */
export function planBatch(incs: Incident[], ctx: AiContext): PlanItem[] {
  const PRIO = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
  const todo = [...incs].sort((a, b) => PRIO[a.priority] - PRIO[b.priority] || a.slaDeadline - b.slaDeadline);
  if (!todo.length) return [];
  const mode = todo[0].mode;
  const people = ctx.workers.filter((w) => w.mode === mode);
  const rows = todo.slice(0, people.length);
  if (!rows.length) return [];
  const scores = rows.map((inc) => {
    const r = new Map(rankWorkers(inc, ctx, 99).map((x) => [x.workerId, x]));
    return people.map((w) => r.get(w.id));
  });
  const BIG = 1e6;
  const cost = scores.map((row) => row.map((x) => (!x || x.blocked ? BIG : 100 - x.score)));
  const match = hungarian(cost);
  const out: PlanItem[] = [];
  match.forEach((j, i) => {
    const x = j >= 0 ? scores[i][j] : undefined;
    if (x && !x.blocked) out.push({ incidentId: rows[i].id, workerId: people[j].id, score: x.score, etaMin: x.etaMin });
  });
  return out;
}

/** Венгерский алгоритм (строк ≤ столбцов): для каждой строки — столбец, минимизирующий общую стоимость. */
export function hungarian(a: number[][]): number[] {
  const n = a.length;
  const m = a[0]?.length ?? 0;
  if (!n || !m || n > m) return a.map(() => -1);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const res = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

export function recommendGroup(inc: Incident): TeamScore[] {
  const g = groupForService(inc.productName, inc.service);
  return g ? [{ teamId: g, confidence: 0.8, reasons: ['чаще всего решала этот сервис в данных'] }] : [];
}

// ─── риск ──────────────────────────────────────────────────────────────────

const PRIO_W: Record<Priority, number> = { P1: 1.6, P2: 1.0, P3: 0.2, P4: -0.6 };

export function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

export function assessRisk(inc: Incident, ctx: AiContext): Insight['risk'] {
  const factors: RiskFactor[] = [];
  const add = (label: string, w: number) => {
    if (Math.abs(w) >= 0.12) factors.push({ label, weight: Math.round(w * 100) / 100 });
    return w;
  };
  let z = -1.4;
  z += add(`Приоритет: ${inc.priorityText.toLowerCase()}`, PRIO_W[inc.priority]);
  const total = Math.max(1, inc.slaDeadline - inc.createdAt);
  const remaining = inc.slaDeadline - ctx.now;
  const f = (ctx.now - inc.createdAt) / total;
  if (remaining <= 0) z += add('Дедлайн прошёл', 2.4 + Math.min(0.8, (-remaining / 3_600_000) * 0.4));
  else z += add(`Прошло ${Math.round(f * 100)}% срока`, 2.4 * Math.pow(Math.min(1, Math.max(0, (f - 0.4) / 0.6)), 1.5));
  if (/наивысш/i.test(inc.impact)) z += add('Влияние наивысшее', 0.8);
  else if (/высок/i.test(inc.impact)) z += add('Влияние высокое', 0.4);
  if (/наивысш/i.test(inc.urgency)) z += add('Срочность наивысшая', 0.4);
  if (inc.serviceType === 'Клиентский') z += add('Затронуты клиенты', 0.5);
  else if (inc.serviceType === 'Пользовательский') z += add('Затронуты пользователи', 0.2);
  if (inc.isMaster) z += add('Массовый (есть дубли)', 0.6);
  if (!inc.assignee || inc.status === 'coordinators') z += add('Никто не назначен', 0.6);
  else if (inc.status === 'in_progress') z += add('Уже в работе', -0.4);
  const score = Math.round(100 / (1 + Math.exp(-z)));
  factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const minutesToBreach = Math.round(remaining / MIN);
  const level = riskLevel(score);
  const note =
    remaining <= 0
      ? 'Дедлайн прошёл — нужна эскалация.'
      : level === 'critical' || level === 'high'
        ? `До дедлайна ${fmtMin(minutesToBreach)}.`
        : 'Риск под контролем.';
  return { score, level, factors: factors.slice(0, 5), minutesToBreach, note };
}

// ─── связанные инциденты ───────────────────────────────────────────────────

export function findCorrelation(inc: Incident, ctx: AiContext): Insight['correlation'] {
  const related: Incident[] = [];
  for (const o of ctx.incidents.values()) {
    if (o.id === inc.id || o.status === 'resolved') continue;
    const sameService = o.productName === inc.productName && o.service === inc.service;
    if ((sameService && Math.abs(o.createdAt - inc.createdAt) <= 30 * MIN) || inc.relatedIds.includes(o.id) || o.id === inc.parentId || o.parentId === inc.id) {
      related.push(o);
    }
  }
  if (!related.length) return null;
  const group = [inc, ...related];
  const root =
    (inc.parentId && ctx.incidents.get(inc.parentId)) ||
    group.find((g) => g.isMaster || g.isEffect) ||
    [...group].sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || a.createdAt - b.createdAt)[0];
  const text =
    root.id === inc.id
      ? `Главный инцидент: рядом ещё ${related.length} по «${inc.service}».`
      : `Похоже на дубль ${root.id} — тот же сервис.`;
  return { rootId: root.id, ids: related.map((r) => r.id), text };
}

// ─── резюме ────────────────────────────────────────────────────────────────

export function heuristicInsight(inc: Incident, ctx: AiContext, started = Date.now()): Insight {
  const workers = rankWorkers(inc, ctx, 8);
  const risk = assessRisk(inc, ctx);
  const corr = findCorrelation(inc, ctx);
  const top = ctx.workers.find((w) => w.id === workers.find((x) => !x.blocked)?.workerId);
  const summary = `${inc.shortDescription} ${inc.productName} › ${inc.service}.`;
  const steps: string[] = [];
  if (!inc.assignee && top) steps.push(`Назначить: ${top.name}`);
  if (corr && corr.rootId !== inc.id) steps.push(`Связать с ${corr.rootId}`);
  if (risk.minutesToBreach !== null && risk.minutesToBreach <= 30 && inc.status !== 'resolved') steps.push('Эскалировать: дедлайн близко');
  if (inc.mode === 'offline' && inc.status !== 'resolved' && !inc.crew) steps.push('Отправить выездного');
  return {
    incidentId: inc.id,
    source: 'heuristic',
    summary,
    cause: corr && corr.rootId !== inc.id ? `Вероятно, дубль ${corr.rootId}` : null,
    nextSteps: steps.slice(0, 3),
    teams: recommendGroup(inc),
    workers,
    risk,
    correlation: corr,
    generatedAt: Date.now(),
    latencyMs: Date.now() - started,
  };
}

export function briefOf(inc: Incident, ctx: AiContext): AiBrief {
  const risk = assessRisk(inc, ctx);
  const w = recommendWorkers(inc, ctx)[0];
  const g = recommendGroup(inc)[0];
  return {
    risk: risk.score,
    level: risk.level,
    teamId: g?.teamId ?? null,
    confidence: g?.confidence ?? 0,
    workerId: w?.workerId ?? null,
    workerConfidence: w?.confidence ?? 0,
  };
}

// ─── форматирование ────────────────────────────────────────────────────────

export function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60 ? `${m % 60} мин` : ''}`.trim();
  return `${Math.round(h / 24)} дн`;
}
