import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Complaint, Incident } from '../shared/types.ts';
import { forecast, forecastChip } from '../shared/forecast.ts';
import { RULES } from './complaints.ts';

const MIN = 60_000;
const now = 10_000_000_000;
const inc = (p: Incident['priority'], regions = 1) => ({ id: 'X', origin: 'complaints', status: 'coordinators', priority: p, regionIds: Array.from({ length: regions }, (_, k) => `r${k}`), p1Proposal: null }) as unknown as Incident;
/** Жалобы с заданным темпом (в минуту) на каждом отрезке: [минут назад от, до, темп]. */
function stream(parts: [number, number, number][]): Complaint[] {
  const out: Complaint[] = [];
  for (const [from, to, rate] of parts) for (let t = from; t > to; t -= 1 / rate) out.push({ id: String(out.length), at: now - t * MIN, incidentId: 'X' } as Complaint);
  return out;
}

test('рост жалоб: прогноз называет ближайший порог и время до него', () => {
  // было 1/мин, стало 3/мин — уровень «Средний», порог «Высокого» 45 жалоб за 30 мин
  const f = forecast(inc('P3'), stream([[20, 10, 1], [10, 0, 3]]), RULES, now)!;
  assert.equal(f.trend, 'up');
  assert.ok(f.next, 'порог должен быть в пределах часа');
  assert.equal(f.next!.level, 'P2');
  assert.ok(f.next!.inMin > 0 && f.next!.inMin <= 15, `через ${f.next!.inMin} мин`);
  assert.match(forecastChip(f)!.text, /Высокий ~\d+ мин/);
});

test('спад жалоб: порог не наберётся, метки нет', () => {
  const f = forecast(inc('P3'), stream([[20, 10, 2], [10, 0, 0.3]]), RULES, now)!;
  assert.equal(f.trend, 'down');
  assert.equal(f.next, null);
  assert.equal(forecastChip(f), null);
});

test('«Наивысший» по темпу: метка горячая', () => {
  const f = forecast(inc('P2'), stream([[20, 10, 3], [10, 0, 6]]), RULES, now)!;
  assert.equal(f.next?.level, 'P1');
  assert.equal(forecastChip(f)?.hot, true);
});
