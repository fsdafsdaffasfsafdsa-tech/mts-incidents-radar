// Прогноз по темпу жалоб: когда инцидент наберёт порог следующего уровня («станет критическим»).
// Считается одинаково на сервере (для Джарвиса) и в браузере (строки, карточка, предупреждения).
//   темп = жалобы за последние 10 мин, с поправкой на рост/спад относительно предыдущих 10 мин;
//   в окне 30 мин через t минут = те жалобы, что ещё не выпадут из окна, + темп × t.
import type { Complaint, EscalationRules, Incident, Priority } from './types.ts';

const MIN = 60_000;
export interface Forecast {
  n30: number; // сейчас в окне
  rate: number; // жалоб в минуту (с поправкой на тренд)
  trend: 'up' | 'flat' | 'down';
  in15: number; // ожидается в окне через 15 мин
  next: { level: Priority; inMin: number; need: number } | null; // ближайший порог в пределах часа
}

const NEXT: Record<Priority, Priority | null> = { P4: 'P3', P3: 'P2', P2: 'P1', P1: null };

export function forecast(inc: Incident, complaints: Complaint[], rules: EscalationRules, now: number): Forecast | null {
  if (inc.origin !== 'complaints' || inc.status === 'resolved') return null;
  const W = rules.windowMin * MIN;
  const ats = complaints.filter((c) => c.incidentId === inc.id && c.at <= now).map((c) => c.at);
  const last10 = ats.filter((a) => now - a < 10 * MIN).length;
  const prev10 = ats.filter((a) => now - a >= 10 * MIN && now - a < 20 * MIN).length;
  const growth = prev10 ? last10 / prev10 : last10 ? 1.5 : 1;
  const trend = growth > 1.2 ? 'up' : growth < 0.8 ? 'down' : 'flat';
  const rate = (last10 / 10) * Math.min(1.5, Math.max(0.5, Math.sqrt(growth)));
  const at = (t: number) => ats.filter((a) => a > now + t * MIN - W).length + rate * Math.min(t, rules.windowMin);
  const n30 = ats.filter((a) => now - a < W).length;
  const regions = inc.regionIds?.length ?? 1;
  const need = (lvl: Priority) => (lvl === 'P3' ? rules.p3 : lvl === 'P2' ? (regions >= 2 ? rules.p2multi : rules.p2) : rules.p1);
  let next: Forecast['next'] = null;
  // Сначала ближайший уровень выше текущего, затем — «Наивысший» (он важнее всего для дежурного).
  for (let lvl = NEXT[inc.priority]; lvl && !next; lvl = NEXT[lvl]) {
    if (lvl === 'P1' && inc.p1Proposal) break; // уже предложено
    const n = need(lvl);
    if (n30 >= n) continue; // порог уже пройден — ждём автоматики
    for (let t = 1; t <= 60; t++)
      if (at(t) >= n) {
        next = { level: lvl, inMin: t, need: n };
        break;
      }
  }
  return { n30, rate: Math.round(rate * 10) / 10, trend, in15: Math.round(at(15)), next };
}

export const FORECAST_TEXT: Record<Priority, string> = { P1: '«Наивысший»', P2: '«Высокий»', P3: '«Средний»', P4: '«Низкий»' };
/** Короткая подпись для строки: «↑ Высокий ~12 мин». */
export function forecastChip(f: Forecast | null): { text: string; hot: boolean } | null {
  if (!f?.next || f.next.inMin > 45) return null;
  const name = f.next.level === 'P1' ? 'Наивысший' : f.next.level === 'P2' ? 'Высокий' : 'Средний';
  return { text: `↑ ${name} ~${f.next.inMin} мин`, hot: f.next.level === 'P1' };
}
