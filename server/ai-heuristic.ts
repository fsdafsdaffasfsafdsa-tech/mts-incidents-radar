// Эвристический ИИ на наборе данных: кому назначить, риск, связанные инциденты, короткое резюме.
// Работает всегда, без ключей и сети.
import type { AiBrief, Incident, Insight, Priority, RiskFactor, RiskLevel, TeamScore, Worker, WorkerScore } from '../shared/types.ts';
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

export function recommendWorkers(inc: Incident, ctx: AiContext): WorkerScore[] {
  const pool = ctx.workers.filter((w) => w.mode === inc.mode && w.status !== 'break');
  if (!pool.length) return [];
  const scored = pool.map((w) => {
    let s = 0;
    const reasons: string[] = [];
    const exp = experience(w.id, inc.productName, inc.service);
    if (exp.sameService) {
      s += 1.4 * Math.min(3, exp.sameService);
      reasons.push(`решал «${inc.service}»: ${exp.sameService}`);
    } else if (exp.sameProduct) {
      s += 0.6 * Math.min(3, exp.sameProduct);
      reasons.push(`знает продукт: ${exp.sameProduct}`);
    }
    const g = groupForService(inc.productName, inc.service);
    if (g && w.groups.includes(g)) {
      s += 0.8;
      reasons.push(`группа ${groupById(g)?.short ?? ''}`);
    }
    const active = ctx.load.get(w.id) ?? 0;
    if (active === 0 && w.status === 'free') {
      s += 0.8;
      reasons.push('свободен');
    } else {
      s -= 0.7 * active;
      reasons.push(`в работе: ${active}`);
    }
    if (inc.mode === 'offline') {
      const office = officeById(w.office);
      if (office) {
        const km = Math.round(distanceKm(office, inc.geo));
        s -= Math.min(3, km / 250);
        reasons.push(`до места ${km} км`);
      }
    }
    return { workerId: w.id, s, reasons };
  });
  const T = 0.8;
  const max = Math.max(...scored.map((x) => x.s));
  const exps = scored.map((x) => Math.exp((x.s - max) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  return scored
    .map((x, i) => ({ workerId: x.workerId, confidence: exps[i] / sum, reasons: x.reasons }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
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
  const workers = recommendWorkers(inc, ctx);
  const risk = assessRisk(inc, ctx);
  const corr = findCorrelation(inc, ctx);
  const top = ctx.workers.find((w) => w.id === workers[0]?.workerId);
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
