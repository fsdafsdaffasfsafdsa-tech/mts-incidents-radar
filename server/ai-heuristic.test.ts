import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { EMPLOYEES, PRODUCTS, RAW, isOfflineRecord } from './catalog.ts';
import { assessRisk, recommendWorkers } from './ai-heuristic.ts';

test('набор данных загружен целиком, статусы и режимы разложены', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  assert.equal(RAW.length, 44);
  assert.equal(sim.incidents.size, 44);
  const resolved = [...sim.incidents.values()].filter((i) => i.status === 'resolved').length;
  assert.equal(resolved, RAW.filter((r) => r.stateId === 7 || r.stateId === 10).length);
  const offline = [...sim.incidents.values()].filter((i) => i.mode === 'offline').length;
  assert.equal(offline, RAW.filter(isOfflineRecord).length);
  assert.ok(offline >= 9, `офлайн: ${offline}`);
});

test('выездные и онлайн-сотрудники выделены из данных', () => {
  const offline = EMPLOYEES.filter((e) => e.mode === 'offline');
  assert.ok(offline.length >= 5 && offline.length < EMPLOYEES.length, `выездных ${offline.length} из ${EMPLOYEES.length}`);
  assert.ok(offline.every((e) => e.office), 'у каждого выездного есть офис');
  assert.ok(EMPLOYEES.find((e) => e.id === 'koschei')?.mode === 'offline', 'дежурная смена ОГЭ — выездной');
});

test('ИИ советует того, кто уже решал этот сервис, и только сотрудника нужного режима', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const p = PRODUCTS.find((x) => x.name === 'Летающий ковер')!;
  const inc = sim.spawn({ product: p, service: 'Руль-пульт', mode: 'online', quiet: true });
  const top = recommendWorkers(inc, sim.ctx());
  assert.ok(top.length > 0);
  const modes = top.map((t) => sim.workers.find((w) => w.id === t.workerId)!.mode);
  assert.ok(modes.every((m) => m === 'online'));
  assert.ok(top[0].reasons.some((r) => /решал|знает|группа|свободен/.test(r)));
});

test('риск растёт к дедлайну', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const inc = sim.spawn({ priority: 'P3', mode: 'online', quiet: true });
  const ctx = sim.ctx();
  const fresh = assessRisk(inc, ctx).score;
  const late = assessRisk({ ...inc, createdAt: inc.createdAt - 690 * 60_000, slaDeadline: inc.slaDeadline - 690 * 60_000 }, ctx).score;
  const gone = assessRisk({ ...inc, createdAt: inc.createdAt - 800 * 60_000, slaDeadline: inc.slaDeadline - 800 * 60_000 }, ctx).score;
  assert.ok(fresh < late && late < gone, `${fresh} < ${late} < ${gone}`);
});

test('кабинет: свой порядок задач и «сделал»', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const w = sim.workers.find((x) => x.mode === 'online')!;
  const a = sim.spawn({ mode: 'online', quiet: true });
  const b = sim.spawn({ mode: 'online', quiet: true });
  sim.act(a.id, 'assign', { workerId: w.id });
  sim.act(b.id, 'assign', { workerId: w.id });
  sim.workerAct(w.id, { action: 'queue', queue: [b.id, a.id] });
  assert.equal(sim.ordered(w)[0].id, b.id);
  sim.workerAct(w.id, { action: 'start', incidentId: b.id });
  assert.equal(sim.incidents.get(b.id)!.status, 'in_progress');
  const before = w.done;
  sim.workerAct(w.id, { action: 'done', incidentId: b.id });
  assert.equal(sim.incidents.get(b.id)!.status, 'resolved');
  assert.equal(w.done, before + 1);
});
