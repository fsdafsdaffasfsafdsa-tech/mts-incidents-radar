// Работа дежурного за смену — одинаково для голосовой сводки Джарвиса и PDF-отчёта.
import type { Incident } from './types.ts';

const TOOK = /ведёт|на контроль/;
const ROUTED = /передано команде/;

/**
 * Сколько инцидентов дежурный взял и передал командам с момента `from`, и за сколько передавал.
 * Время до передачи считается с последнего момента, когда инцидент оказался у дежурного:
 * взял сам, вернулся после прошлой передачи или появился (но не раньше начала смены).
 */
export function myShiftWork(all: Iterable<Incident>, meName: string, from: number) {
  let taken = 0;
  const routeTimes: number[] = [];
  for (const i of all) {
    if (i.history.some((h) => h.at > from && h.actor === meName && TOOK.test(h.text))) taken++;
    const r = i.history.find((h) => h.at > from && h.actor === meName && ROUTED.test(h.text));
    if (!r) continue;
    let t0 = Math.max(i.createdAt, from);
    for (const h of i.history) {
      if (h === r || h.at > r.at) break;
      if ((h.actor === meName && TOOK.test(h.text)) || ROUTED.test(h.text)) t0 = Math.max(t0, h.at);
    }
    routeTimes.push(r.at - t0);
  }
  const avgRouteMs = routeTimes.length ? routeTimes.reduce((a, b) => a + b, 0) / routeTimes.length : null;
  return { taken, routed: routeTimes.length, avgRouteMs };
}
