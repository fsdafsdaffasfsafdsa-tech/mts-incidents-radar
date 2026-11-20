// Жалобы абонентов: фон по всей стране, сбои в регионах, детектор всплесков и правила повышения уровня.
// Детектор — без LLM: сравниваем число жалоб за 10 минут с нормой для пары «сервис × регион» (распределение Пуассона).
import type { Cluster, Complaint, EscalationRules, Priority } from '../shared/types.ts';
import { SERVICES, serviceDef } from './directory.ts';
import { REGIONS, TOTAL_WEIGHT, regionById } from './regions.ts';

const MIN = 60_000;
const rnd = Math.random;

/** Фон: жалоб в секунду по всей стране (в обычный вечер). */
export const BG_PER_SEC = 0.5;
const CHANNELS = ['Приложение Мой МТС', 'Звонок 0890', 'Чат поддержки', 'Соцсети', 'Сайт'];

function weighted<T>(items: T[], w: (t: T) => number): T {
  let x = rnd() * items.reduce((a, t) => a + w(t), 0);
  for (const t of items) {
    x -= w(t);
    if (x <= 0) return t;
  }
  return items[items.length - 1];
}

/** Точка жалобы: вокруг столицы региона, большие регионы — шире. */
function placeIn(regionId: string) {
  const r = regionById(regionId)!;
  const km = Math.pow(rnd(), 1.7) * (8 + r.weight * 14);
  const a = rnd() * Math.PI * 2;
  return { lat: r.lat + (km / 111) * Math.sin(a), lon: r.lon + (km / (111 * Math.cos((r.lat * Math.PI) / 180))) * Math.cos(a) };
}

let seq = 1;
export function makeComplaint(at: number, service: string, regionId: string): Complaint {
  const def = serviceDef(service)!;
  return {
    id: `C${(seq++).toString(36)}${Math.floor(rnd() * 1296).toString(36)}`,
    at,
    regionId,
    ...placeIn(regionId),
    service,
    channel: CHANNELS[Math.floor(rnd() * CHANNELS.length)],
    text: def.texts[Math.floor(rnd() * def.texts.length)],
    b2b: service === 'B2B-каналы' || rnd() < 0.08,
    incidentId: null,
  };
}

export interface Outage {
  id: string;
  service: string;
  regionIds: string[];
  start: number;
  end: number;
  perSec: number; // жалоб в секунду на регион
}

/** Генератор: фон + активные сбои. Вызывается раз в секунду. */
export class ComplaintStream {
  outages: Outage[] = [];
  private nextAuto = Date.now() + 40_000;
  auto = true;

  tick(now: number): Complaint[] {
    const out: Complaint[] = [];
    // Фон — Пуассон по стране.
    let n = poissonSample(BG_PER_SEC);
    while (n-- > 0) {
      const s = weighted(SERVICES, (x) => x.weight);
      const r = weighted(REGIONS, (x) => x.weight);
      out.push(makeComplaint(now, s.name, r.id));
    }
    this.outages = this.outages.filter((o) => o.end > now);
    for (const o of this.outages) {
      // Нарастание в первые 2 минуты, потом плато.
      const ramp = Math.min(1, (now - o.start) / (2 * MIN));
      for (const r of o.regionIds) {
        let k = poissonSample(o.perSec * ramp);
        while (k-- > 0) out.push(makeComplaint(now, o.service, r));
      }
    }
    if (this.auto && now >= this.nextAuto) {
      this.randomOutage(now);
      this.nextAuto = now + (3 + rnd() * 4) * MIN;
    }
    return out;
  }

  start(service: string, regionIds: string[], minutes: number, perSec: number, now = Date.now()) {
    const o: Outage = { id: `O${now}`, service, regionIds, start: now, end: now + minutes * MIN, perSec };
    this.outages.push(o);
    return o;
  }

  /** Случайный сбой: чаще региональный, иногда сразу в нескольких регионах (сбой платформы). */
  randomOutage(now: number) {
    const s = weighted(SERVICES, (x) => x.weight);
    const multi = !s.regional || rnd() < 0.15;
    const first = weighted(REGIONS, (x) => x.weight);
    const regions = multi ? [first.id, ...pickMore(first.id, 1 + Math.floor(rnd() * 3))] : [first.id];
    return this.start(s.name, regions, 3 + rnd() * 5, 0.12 + rnd() * 0.35, now);
  }
}

function pickMore(except: string, n: number) {
  const out: string[] = [];
  while (out.length < n) {
    const r = weighted(REGIONS, (x) => x.weight).id;
    if (r !== except && !out.includes(r)) out.push(r);
  }
  return out;
}

function poissonSample(lambda: number) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rnd();
  } while (p > L);
  return k - 1;
}

/** P(X ≥ n) для Пуассона с параметром λ. */
export function poissonTail(n: number, lambda: number) {
  if (n <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let k = 1; k < n; k++) {
    term *= lambda / k;
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

/** Норма жалоб за `minutes` для пары «сервис × регион». */
export function expected(service: string, regionId: string, minutes: number) {
  const s = serviceDef(service);
  const r = regionById(regionId);
  if (!s || !r) return 0.5;
  return BG_PER_SEC * 60 * minutes * s.weight * (r.weight / TOTAL_WEIGHT);
}

// ─── детектор ──────────────────────────────────────────────────────────────

export const DETECT = { windowMin: 10, minCount: 6, pValue: 0.001, suggestP: 0.02, suggestMin: 3 };

/** Кластеры непривязанных жалоб за окно: какие уже тянут на инцидент, какие — просто подозрительные. */
export function findClusters(complaints: Complaint[], now: number): Cluster[] {
  const from = now - DETECT.windowMin * MIN;
  const by = new Map<string, number>();
  for (const c of complaints) {
    if (c.at < from || c.incidentId) continue;
    const key = `${c.service}|${c.regionId}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  const out: Cluster[] = [];
  for (const [key, count] of by) {
    if (count < DETECT.suggestMin) continue;
    const [service, regionId] = key.split('|');
    const lambda = Math.max(0.3, expected(service, regionId, DETECT.windowMin));
    const p = poissonTail(count, lambda);
    if (p <= DETECT.suggestP) out.push({ key, service, regionId, count, expected: Math.round(lambda * 10) / 10, pValue: p });
  }
  return out.sort((a, b) => a.pValue - b.pValue);
}

export const isIncidentCluster = (c: Cluster) => c.count >= DETECT.minCount && c.pValue <= DETECT.pValue;

// ─── уровень инцидента по жалобам ──────────────────────────────────────────
// «В пределах разумного»: только вверх, не чаще раза в gapMin минут, автоматически не выше «Высокого».
// «Наивысший» ИИ только предлагает — подтверждает дежурный.

export const RULES: EscalationRules = { windowMin: 30, p3: 15, p2: 45, p2multi: 25, p1: 120, p1regions: 3, ceiling: 'P2', gapMin: 3 };

const RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
export const higher = (a: Priority, b: Priority) => RANK[a] < RANK[b];

export function targetLevel(n30: number, regions: number, critical: boolean): { level: Priority; reason: string; p1: boolean } {
  const base = `жалоб за ${RULES.windowMin} мин: ${n30}${regions > 1 ? `, регионов: ${regions}` : ''}`;
  const p1 = critical && (n30 >= RULES.p1 || regions >= RULES.p1regions);
  if (n30 >= RULES.p2 || (regions >= 2 && n30 >= RULES.p2multi)) return { level: 'P2', reason: base, p1 };
  if (n30 >= RULES.p3) return { level: 'P3', reason: base, p1 };
  return { level: 'P4', reason: base, p1 };
}

/** Следующий шаг: на одну ступень вверх, если цель выше текущего и выдержана пауза. */
export function nextAutoLevel(current: Priority, target: Priority, lastAutoAt: number | null, now: number): Priority | null {
  if (!higher(target, current)) return null;
  if (!higher(RULES.ceiling, current)) return null; // уже на потолке автоматики
  if (lastAutoAt && now - lastAutoAt < RULES.gapMin * MIN) return null;
  const order: Priority[] = ['P4', 'P3', 'P2', 'P1'];
  return order[order.indexOf(current) + 1];
}

/** Короткая сводка по жалобам инцидента — вместо ручного чтения сотен сообщений. */
export function summarize(list: Complaint[]) {
  const texts = new Map<string, number>();
  const channels = new Map<string, number>();
  let b2b = 0;
  for (const c of list) {
    texts.set(c.text, (texts.get(c.text) ?? 0) + 1);
    channels.set(c.channel, (channels.get(c.channel) ?? 0) + 1);
    if (c.b2b) b2b++;
  }
  const top = [...texts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const ch = [...channels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    top: top.map(([t, n]) => `«${t.toLowerCase()}» — ${n}`),
    channels: ch.map(([t, n]) => `${t}: ${n}`).join(', '),
    b2b,
  };
}
