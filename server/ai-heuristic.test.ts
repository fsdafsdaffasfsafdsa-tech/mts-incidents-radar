import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { EMPLOYEES, OFFICES, PRODUCTS, RAW, REGION_BOUNDS, isOfflineRecord } from './catalog.ts';
import { assessRisk, hungarian, planBatch, rankWorkers, recommendWorkers } from './ai-heuristic.ts';
import { hashPassword, verifyPassword } from './auth.ts';
import { Persister, loadState, openDb } from './db.ts';

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
  assert.ok(top[0].reasons.length > 0 && top[0].parts.some((x) => x.label === 'Опыт'));
  assert.ok(top[0].score >= top[top.length - 1].score);
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

test('выезд: офисы и точки только в ЮФО, у каждого кандидата время в пути', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const [[w, s], [e, n]] = REGION_BOUNDS;
  const inside = (g: { lat: number; lon: number }) => g.lon > w && g.lon < e && g.lat > s && g.lat < n;
  assert.ok(OFFICES.every(inside), 'офисы в ЮФО');
  const field = [...sim.incidents.values()].filter((i) => i.mode === 'offline');
  assert.ok(field.every((i) => inside(i.geo)), 'точки выездов в ЮФО');
  assert.ok(field.every((i) => /БС \d{2}-\d{4}/.test(i.region)), 'у выезда есть площадка');
  const inc = sim.spawn({ mode: 'offline', priority: 'P2', quiet: true });
  const list = rankWorkers(inc, sim.ctx(), 99).filter((x) => !x.blocked);
  assert.ok(list.length > 0 && list.every((x) => x.etaMin !== null && x.km !== null));
  assert.ok(list[0].reasons[0].includes('езды'));
});

test('жёсткий фильтр: на перерыве не предлагаем, но показываем с причиной', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const inc = sim.spawn({ mode: 'online', quiet: true });
  const best = recommendWorkers(inc, sim.ctx())[0];
  sim.workerAct(best.workerId, { action: 'status', status: 'break' });
  const all = rankWorkers(inc, sim.ctx(), 99);
  assert.equal(all.find((x) => x.workerId === best.workerId)?.blocked, 'на перерыве');
  assert.notEqual(recommendWorkers(inc, sim.ctx())[0].workerId, best.workerId);
});

test('распределение пачкой: венгерский алгоритм, не больше одной задачи на человека', () => {
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const incs = [1, 2, 3, 4].map(() => sim.spawn({ mode: 'offline', quiet: true }));
  const plan = planBatch(incs, sim.ctx());
  assert.ok(plan.length > 0);
  assert.equal(new Set(plan.map((x) => x.workerId)).size, plan.length);
  assert.ok(plan.every((x) => sim.workers.find((w) => w.id === x.workerId)?.mode === 'offline'));
});

test('выгрузка ITSM: новый инцидент и смена статуса из файла', () => {
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const kinds: string[] = [];
  sim.onMessage((m) => {
    if (m.type === 'feed') kinds.push(m.data.kind);
  });
  const base = RAW.map((r) => ({ ...r }));
  sim.ingest(base, true);
  const now = new Date().toISOString();
  const fresh = {
    ...base[0],
    id: 'INC000999001',
    priorityId: 4,
    priority: 'Наивысший',
    submitDate: now,
    deadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    state: 'Назначен',
    stateId: 0,
    completionDate: null,
  };
  sim.ingest([...base, fresh], false);
  const inc = sim.incidents.get('INC000999001');
  assert.ok(inc && inc.priority === 'P1' && Math.abs(inc.createdAt - Date.now()) < 60_000);
  assert.ok(kinds.includes('p1'));
  sim.ingest([...base, { ...fresh, state: 'Завершен', stateId: 7, completionDate: now }], false);
  assert.equal(sim.incidents.get('INC000999001')!.status, 'resolved');
});

test('база и пароли: scrypt, состояние переживает перезапуск', () => {
  const h = hashPassword('секрет');
  assert.ok(verifyPassword('секрет', h) && !verifyPassword('другой', h));
  const db = openDb(':memory:');
  const sim = new Sim();
  (sim as unknown as { seed: () => void }).seed();
  const p = new Persister(db);
  p.saveAll(sim.incidents.values(), sim.workers, sim.feed);
  p.close();
  const saved = loadState(db)!;
  assert.equal(saved.incidents.length, sim.incidents.size);
  const again = new Sim();
  again.start(saved, sim.shift);
  again.stop();
  assert.equal(again.incidents.size, sim.incidents.size);
  assert.equal(again.workers.length, sim.workers.length);
  db.close();
});
