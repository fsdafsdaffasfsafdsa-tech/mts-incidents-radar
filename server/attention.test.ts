import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Incident } from '../shared/types.ts';
import { detect, heat, levelOf, stillUrgent, voiceLine, type Sig } from '../shared/attention.ts';
import { attention, dashSnapshot, isRecurring } from '../shared/dash.ts';
import { Point } from './point.ts';
import { POINT_ID, SERVICES, TEAMS } from './directory.ts';
import { REGIONS } from './regions.ts';

const MIN = 60_000;
const now = 10_000_000_000;
let n = 0;
const inc = (o: Partial<Incident>) =>
  ({ id: `A${++n}`, title: 't', status: 'assigned', priority: 'P3', priorityText: 'Средний', stateText: 'Назначен', createdAt: now - 60 * MIN, slaDeadline: now + 5 * 60 * MIN, history: [], reassignCount: 0, routedAt: now - MIN, origin: 'dataset', groupName: 'Billing L2', ...o }) as unknown as Incident;

test('уровни: срочное — новый критический и «снова жалобы», внимание — срок близко, инфо — решён и передан', () => {
  assert.equal(levelOf('crit', inc({ priority: 'P1' })), 'urgent');
  assert.equal(levelOf('recur', inc({})), 'urgent');
  assert.equal(levelOf('coord', inc({ priority: 'P2' })), 'urgent', 'высокий на координаторах — срочно распределить');
  assert.equal(levelOf('coord', inc({ priority: 'P3' })), 'attention', 'средний на координаторах — полосой');
  assert.equal(levelOf('slaHigh', inc({})), 'attention');
  assert.equal(levelOf('resolved', inc({})), 'info');
  assert.equal(levelOf('routed', inc({})), 'info');
});

test('события: первый снимок молчит, дальше — новый критический, решён, передан, взяли в работу', () => {
  const fired = new Set<string>();
  const a = inc({ id: 'a', status: 'coordinators', priority: 'P3' });
  const b = inc({ id: 'b', status: 'assigned', priority: 'P3' });
  let r = detect(null, [a, b], now, fired);
  assert.deepEqual(r.found, [], 'то, что было до входа, — не новость');
  const prev: Map<string, Sig> = r.next;
  const p1 = inc({ id: 'p1', priority: 'P1', status: 'coordinators' });
  r = detect(prev, [{ ...a, status: 'assigned', groupName: 'Ядро сети' } as Incident, { ...b, status: 'in_progress', assigneeName: 'Иванов' } as Incident, p1], now, fired);
  const kinds = r.found.map((f) => `${f.kind}:${f.inc.id}`).sort();
  assert.deepEqual(kinds, ['crit:p1', 'routed:a', 'taken:b']);
  assert.equal(r.found.find((f) => f.kind === 'routed')!.text, 'Ядро сети');
  r = detect(r.next, [{ ...p1, status: 'resolved', resolvedAt: now } as Incident], now, fired);
  assert.deepEqual(r.found.map((f) => f.kind), ['resolvedCrit']);
});

test('состояния — один раз на инцидент: критический не берут, срок высокого близко', () => {
  const fired = new Set<string>();
  const stuck = inc({ id: 's', priority: 'P1', status: 'assigned', routedAt: now - 15 * MIN });
  const soon = inc({ id: 'h', priority: 'P2', status: 'in_progress', slaDeadline: now + 20 * MIN });
  let r = detect(null, [], now, fired);
  r = detect(r.next, [stuck, soon], now, fired);
  const kinds = r.found.map((f) => f.kind).sort();
  assert.ok(kinds.includes('critStuck'));
  assert.ok(kinds.includes('slaHigh'));
  r = detect(r.next, [stuck, soon], now + 30_000, fired);
  assert.ok(!r.found.some((f) => f.kind === 'critStuck' || f.kind === 'slaHigh'), 'повторно не зовём');
  assert.equal(stillUrgent('critStuck', { ...stuck, status: 'in_progress' } as Incident, now, null), false, 'взяли — срочное уходит');
});

test('решили, а жалобы снова: срочно, наверху «кому распределить», уходит после «вернуть в работу»', () => {
  const done = inc({ id: 'r', status: 'resolved', priority: 'P3', resolvedAt: now - 6 * MIN, recur: { count: 5, since: now - 4 * MIN, lastAt: now - 20_000, team: 'Billing L2', resolvedBy: 'Петров' } });
  assert.equal(isRecurring(done, now), true);
  const snap = dashSnapshot([done, inc({ id: 'x', priority: 'P1', status: 'in_progress' })], now);
  assert.equal(snap.action[0].inc.id, 'r', '«снова жалобы» срочнее даже критического в работе');
  assert.equal(attention(done, now)?.reason, 'Снова жалобы · 5');
  assert.equal(snap.counts.recur, 1);
  const prev = new Map<string, Sig>([['r', { st: 'resolved', pr: 'P3', p1: false, recur: false, ask: false }]]);
  const r = detect(prev, [done], now, new Set());
  assert.equal(r.found[0].kind, 'recur');
  assert.match(r.found[0].text!, /«Billing L2» решила 6 мин назад · снова 5 жалоб/);
  assert.match(voiceLine('recur', done, now), /Вернуть в работу\?/);
  assert.equal(stillUrgent('recur', { ...done, status: 'assigned', recur: null } as Incident, now, null), false);
});

test('ярче — важнее: 0 спокойный … 4 самый срочный', () => {
  assert.equal(heat(20), 0);
  assert.equal(heat(60), 1);
  assert.equal(heat(80), 2);
  assert.equal(heat(110), 3);
  assert.equal(heat(150), 4);
});

test('пункт: жалобы после решения поднимают сигнал, «вернуть в работу» отдаёт той же команде', () => {
  const p = new Point();
  const service = SERVICES[0].name;
  const region = REGIONS[0].id;
  const team = TEAMS.find((t) => t.id !== POINT_ID)!;
  const created = p.fromCluster({ key: `${service}|${region}`, service, regionId: region, count: 12, expected: 1, pValue: 0.0001 }, 'Иванов');
  p.route(created.id, team.id, 'Иванов');
  p.resolveAtPoint(created.id, 'Иванов');
  const id = created.id;
  assert.equal(p.incidents.get(id)!.status, 'resolved');
  // сбой продолжается: десятки жалоб за пару минут — заметно больше фона даже в Москве
  for (let k = 0; k < 60; k++) p.complain(service, region);
  const after = p.incidents.get(id)!;
  assert.ok((after.recur?.count ?? 0) >= 3, 'после решения снова жалобы — сигнал');
  assert.ok(after.history.some((h) => /после решения снова жалобы/.test(h.text)));
  assert.ok(p.feed.some((e) => e.kind === 'recur' && e.incidentId === id));
  const back = p.reopen(id, 'Петров');
  assert.equal(back.status, 'assigned');
  assert.equal(back.teamId, team.id, 'той же команде');
  assert.equal(back.recur, null);
  assert.equal(back.resolvedAt, null);
  assert.ok(back.history.at(-1)!.text.includes('вернул в работу'));
  p.stop();
});
