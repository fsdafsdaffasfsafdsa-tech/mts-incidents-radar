import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Incident } from '../shared/types.ts';
import { myShiftWork } from '../shared/shift.ts';

const MIN = 60_000;
const H = 60 * MIN;
const now = 10_000_000_000;
const from = now - 12 * H;
const ME = 'Щербаков Ярослав';
type Item = Incident['history'][number];
const inc = (createdAt: number, history: Partial<Item>[]) => ({ id: 'X', createdAt, history: history.map((h) => ({ kind: 'coordinator', ...h })) }) as unknown as Incident;

test('время до передачи — с момента, когда инцидент попал к дежурному, а не с его создания', () => {
  const old = inc(now - 30 * H, [
    { at: now - 3 * H, actor: 'Другой', text: 'Другой: передано команде «А»' },
    { at: now - 2 * H, actor: ME, text: `${ME}: передано команде «Б»` }, // вернулся с эскалацией — 1 час у пункта
  ]);
  const taken = inc(now - 5 * H, [
    { at: now - 60 * MIN, actor: ME, text: `${ME}: ведёт ${ME}` },
    { at: now - 56 * MIN, actor: ME, text: `${ME}: передано команде «В»` }, // взял и передал за 4 мин
  ]);
  const r = myShiftWork([old, taken], ME, from);
  assert.equal(r.taken, 1);
  assert.equal(r.routed, 2);
  assert.equal(Math.round(r.avgRouteMs! / MIN), 32);
});

test('инцидент из прошлой смены считается не раньше начала этой', () => {
  const r = myShiftWork([inc(now - 40 * H, [{ at: from + 10 * MIN, actor: ME, text: `${ME}: передано команде «А»` }])], ME, from);
  assert.equal(Math.round(r.avgRouteMs! / MIN), 10);
  assert.equal(myShiftWork([], ME, from).avgRouteMs, null);
});
