import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Incident, ServerMessage } from '../shared/types.ts';
import { assessRisk, buildContext, findCorrelation, heuristicInsight } from './ai-heuristic.ts';
import { FileSource, diffIncident, mapRecord, parseDate } from './source-file.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(root, 'data/incidents.sample.json');
const records = JSON.parse(fs.readFileSync(SAMPLE, 'utf8')) as Record<string, unknown>[];

function load(): Map<string, Incident> {
  return new Map(records.map((r) => mapRecord(r)!).map((i) => [i.id, i]));
}

test('выгрузка читается целиком, группы ТЗ считаются по полям файла', () => {
  const m = load();
  assert.equal(m.size, records.length);
  const all = [...m.values()];
  assert.equal(all.filter((i) => i.status === 'research').length, 5, 'исследование ситуации');
  assert.equal(all.filter((i) => i.onCoordinators).length, 2, 'на координаторах');
  assert.equal(all.filter((i) => i.priority === 'P2').length, 5, 'высокий приоритет');
  assert.equal(all.filter((i) => i.status === 'resolved').length, 15, 'завершён и закрыт');
  assert.equal(new Set(all.map((i) => i.systemId)).size, 5, 'пять продуктов без дублей');
});

test('даты в обоих форматах: ISO и «YYYY-MM-DD HH:MM:SS»; пустые — null', () => {
  assert.equal(parseDate('2026-11-08T12:02:29Z'), Date.UTC(2026, 10, 8, 12, 2, 29));
  assert.equal(parseDate('2026-11-08 12:02:29'), new Date(2026, 10, 8, 12, 2, 29).getTime());
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('0001-01-01T00:00:00'), null);
});

test('приоритет 4 «Наивысший» — критический, статус берётся по тексту', () => {
  const inc = mapRecord({ ...records[0], priorityId: 4, priority: 'Наивысший', stateId: 20, stateEnum: 'Research', state: 'Исследование ситуации' })!;
  assert.equal(inc.priority, 'P1');
  assert.equal(inc.status, 'research');
});

test('изменения в файле превращаются в события для координатора', () => {
  const base = mapRecord(records[1])!; // назначен не на координаторов, низкий приоритет
  const crit = mapRecord({ ...records[1], priorityId: 4, priority: 'Наивысший' })!;
  assert.deepEqual(diffIncident(base, crit).map((c) => c.kind), ['p1']);
  const coord = mapRecord({ ...records[1], assignedGroupName: 'КЦ ИТ Координаторы Массовых Инцидентов' })!;
  assert.deepEqual(diffIncident(base, coord).map((c) => c.kind), ['coordinators']);
  const done = mapRecord({ ...records[1], state: 'Завершен', stateEnum: 'Resolved', stateId: 7 })!;
  assert.deepEqual(diffIncident(base, done).map((c) => c.kind), ['resolved']);
  assert.deepEqual(diffIncident(undefined, crit).map((c) => c.kind), ['p1']);
});

test('риск растёт по мере приближения дедлайна и после него', () => {
  const m = load();
  const inc = [...m.values()].find((i) => i.status === 'assigned' && i.slaDeadline)!;
  const total = inc.slaDeadline! - inc.createdAt;
  const at = (k: number) => assessRisk(inc, buildContext(m, inc.createdAt + total * k)).score;
  assert.ok(at(0.1) < at(0.8), 'ближе к дедлайну риск выше');
  assert.ok(at(0.8) < at(1.2), 'после дедлайна ещё выше');
});

test('дубль и дочерний указывают на мастер-инцидент или причину раньше себя', () => {
  const m = load();
  const ctx = buildContext(m, Date.now());
  for (const inc of m.values()) {
    if (!inc.isDouble && !inc.isReason) continue;
    const corr = findCorrelation(inc, ctx);
    assert.ok(corr, `${inc.id}: нет разбора связей`);
    if (!corr!.rootId || corr!.rootId === inc.id) {
      assert.ok(inc.isMaster || inc.isEffect, `${inc.id}: нет первопричины`); // сам мастер, причины раньше нет
      continue;
    }
    const root = m.get(corr!.rootId!)!;
    assert.ok(root.createdAt <= inc.createdAt, `${inc.id}: причина позже следствия`);
    assert.ok(inc.isDouble ? root.isMaster : root.isEffect || root.isMaster);
  }
});

test('для инцидента на координаторах ИИ советует реальную группу из выгрузки', () => {
  const m = load();
  const ctx = buildContext(m, Date.now());
  const groups = new Set([...m.values()].map((i) => i.teamId));
  for (const inc of m.values()) {
    if (!inc.onCoordinators) continue;
    const top = heuristicInsight(inc, ctx).teams[0];
    assert.ok(top, `${inc.id}: нет подсказки`);
    assert.ok(groups.has(top.teamId) && !/координатор/i.test(top.teamId));
  }
});

test('правка файла доходит до потока: новый критический, ошибка JSON не роняет данные', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const file = path.join(dir, 'incidents.json');
  fs.writeFileSync(file, JSON.stringify(records));
  const src = new FileSource(file);
  const got: ServerMessage[] = [];
  src.onMessage((m) => got.push(m));
  src.reload(true);
  assert.equal(src.incidents.size, records.length);

  fs.writeFileSync(file, '[{ сломано');
  src.reload();
  assert.ok(src.status.error, 'ошибка показана');
  assert.equal(src.incidents.size, records.length, 'данные остались');

  const fresh = { ...records[0], id: 'INC999', priorityId: 4, priority: 'Наивысший', submitDate: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify([...records, fresh]));
  src.reload();
  assert.equal(src.status.error, null);
  assert.ok(src.incidents.has('INC999'));
  assert.ok(got.some((m) => m.type === 'feed' && m.data.kind === 'p1' && m.data.incidentId === 'INC999'));
  src.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
