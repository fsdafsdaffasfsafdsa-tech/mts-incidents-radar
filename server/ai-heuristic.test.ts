// Тесты координирующего пункта: справочник и графики, детектор жалоб, правила уровня, подбор команды, процессы, база.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onDuty } from '../shared/schedule.ts';
import type { Complaint } from '../shared/types.ts';
import { PEOPLE, POINT_ID, POINT_STAFF, TEAMS, isOn, membersOf, onShift, teamById } from './directory.ts';
import { RULES, findClusters, isIncidentCluster, makeComplaint, nextAutoLevel, poissonTail, targetLevel } from './complaints.ts';
import { planPoint, routeTeams } from './ai-point.ts';
import { Point } from './point.ts';
import { hashPassword, seedUsers, verifyPassword } from './auth.ts';
import { Persister, loadPoint, openDb } from './db.ts';

const H = 3_600_000;
// Понедельник 2026-11-16, 00:00 МСК.
const MONDAY = Date.UTC(2026, 10, 15, 21, 0, 0);

test('справочник: около 900 команд, уникальные логины, у пункта 4 смены', () => {
  assert.ok(TEAMS.length >= 850 && TEAMS.length <= 950, `команд ${TEAMS.length}`);
  assert.equal(new Set(PEOPLE.map((p) => p.id)).size, PEOPLE.length);
  assert.equal(POINT_STAFF.filter((p) => p.role === 'commander').length, 4);
  assert.equal(POINT_STAFF.filter((p) => p.role === 'coordinator').length, 12);
  assert.ok(TEAMS.some((t) => t.itsm), 'группы из выгрузки ITSM в справочнике');
});

test('графики: круглосуточные команды закрыты в любой час недели, 5/2 не работает в воскресенье', () => {
  const allDay = TEAMS.filter((t) => t.schedule === '24/7').slice(0, 40);
  for (let h = 0; h < 7 * 24; h++) {
    const at = MONDAY + h * H + 15 * 60_000;
    for (const t of allDay) assert.ok(onShift(t.id, at).some((p) => p.role !== 'lead'), `${t.name} пустая в час ${h}`);
    // Ровно одна дневная или ночная смена в каждый момент.
    assert.equal([0, 1, 2, 3].filter((c) => onDuty('24/7', c, 3, at)).length, 1);
  }
  const office = TEAMS.find((t) => t.schedule === '5/2' && t.tz === 3)!;
  const sunday = MONDAY + 6 * 24 * H + 12 * H;
  assert.equal(onShift(office.id, sunday).length, 0);
  assert.ok(onShift(office.id, MONDAY + 11 * H).length > 0);
});

test('детектор: всплеск в регионе — инцидент, единичные жалобы — нет', () => {
  assert.ok(poissonTail(10, 1) < 1e-6 && poissonTail(1, 1) > 0.6);
  const now = Date.now();
  const list: Complaint[] = [];
  for (let i = 0; i < 12; i++) list.push(makeComplaint(now - i * 20_000, 'Мобильный интернет', 'nsk'));
  list.push(makeComplaint(now, 'KION', 'tom'), makeComplaint(now, 'SMS', 'kir'));
  const clusters = findClusters(list, now);
  const nsk = clusters.find((c) => c.regionId === 'nsk');
  assert.ok(nsk && isIncidentCluster(nsk));
  assert.ok(!clusters.some((c) => c.regionId === 'tom'));
});

test('уровень по жалобам: только вверх, с паузой, сам — не выше «Высокого», «Наивысший» лишь предложение', () => {
  assert.equal(targetLevel(5, 1, true).level, 'P4');
  assert.equal(targetLevel(RULES.p3, 1, true).level, 'P3');
  assert.equal(targetLevel(RULES.p2multi, 2, false).level, 'P2');
  const t = targetLevel(500, 4, true);
  assert.equal(t.level, 'P2');
  assert.ok(t.p1);
  const now = Date.now();
  assert.equal(nextAutoLevel('P4', 'P2', null, now), 'P3', 'по одной ступени');
  assert.equal(nextAutoLevel('P3', 'P2', now - 60_000, now), null, 'пауза между повышениями');
  assert.equal(nextAutoLevel('P2', 'P1', null, now), null, 'автоматика не поднимает выше потолка');
  assert.equal(nextAutoLevel('P2', 'P3', null, now), null, 'не понижает');
});

test('подбор команды: регион — команда филиала, платформа — L2, ночью — дежурная замена', () => {
  const p = new Point();
  const ctx = { now: MONDAY + 12 * H, load: new Map<string, number>() };
  const regional = { ...p['blank']({ id: 'X1', title: 't', priority: 'P3', status: 'coordinators', createdAt: ctx.now, slaDeadline: ctx.now + H, origin: 'complaints' }), service: 'Мобильный интернет', regionId: 'nsk', regionIds: ['nsk'] };
  assert.equal(routeTeams(regional, ctx)[0].teamId, 'ran-nsk');
  const platform = { ...regional, service: 'Мой МТС', regionIds: ['msk', 'spb'] };
  assert.match(teamById(routeTeams(platform, ctx)[0].teamId)!.name, /Мой МТС/);
  // Домашний интернет в 23:30 по местному времени — команда 08–22 не работает, лучше центр управления сетью.
  const night = { now: MONDAY + 23.5 * H, load: new Map<string, number>() };
  const home = { ...regional, service: 'Домашний интернет', regionId: 'krd', regionIds: ['krd'] };
  const picks = routeTeams(home, night);
  assert.equal(picks[0].teamId, 'noc-yufo');
  assert.ok(picks.some((x) => x.teamId === 'fix-krd' && !x.onDuty));
});

test('пункт: распределение между дежурными на смене, не больше трёх каждому', () => {
  const p = new Point();
  const now = Date.now();
  const incs = Array.from({ length: 12 }, (_, i) => p['blank']({ id: `T${i}`, title: 't', priority: i < 2 ? 'P2' : 'P4', status: 'coordinators', createdAt: now, slaDeadline: now + H, origin: 'complaints', service: 'Мобильный интернет' }));
  const plan = planPoint(incs, POINT_STAFF, new Map(), now);
  const duty = POINT_STAFF.filter((x) => x.role === 'coordinator' && isOn(x, now));
  assert.equal(plan.length, Math.min(12, duty.length * 3));
  assert.ok(plan.every((x) => duty.some((d) => d.id === x.personId)));
  const per = new Map<string, number>();
  for (const x of plan) per.set(x.personId, (per.get(x.personId) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 3));
});

test('процесс: передача команде, «не наше» через пункт, сигнал руководителю', () => {
  const p = new Point();
  p['seed']();
  const now = Date.now();
  const inc = p.fromCluster({ key: 'Мобильный интернет|rnd', service: 'Мобильный интернет', regionId: 'rnd', count: 8, expected: 0.5, pValue: 1e-6 }, 'тест');
  assert.equal(inc.status, 'coordinators');
  p.route(inc.id, 'ran-rnd', 'Дежурный');
  assert.equal(inc.status, 'assigned');
  const eng = onShift('ran-rnd', now).find((x) => x.role === 'engineer')!;
  const off = membersOf('ran-rnd').find((x) => x.role === 'engineer' && !isOn(x, now))!;
  assert.throws(() => p.take(inc.id, off.id), /не на смене/);
  p.take(inc.id, eng.id);
  assert.equal(inc.assignee, eng.id);
  const req = p.requestTransfer(inc.id, eng.id, 'core-yufo', 'Проблема в ядре, не в радиосети');
  assert.equal(req.status, 'pending');
  assert.ok(req.aiNote.length > 0);
  p.resolveRequest(req.id, true, 'Дежурный', 'core-yufo');
  assert.equal(inc.teamId, 'core-yufo');
  const eng2 = onShift('core-yufo', Date.now()).find((x) => x.role === 'engineer')!;
  p.take(inc.id, eng2.id);
  const s = p.help(inc.id, eng2.id, 'Нет доступа к PGW');
  p.notifyLead(s.id, 'Дежурный');
  assert.equal(p.signals.get(s.id)!.status, 'notified');
  assert.ok(inc.leadNotifiedAt);
  p.resolveByTeam(inc.id, eng2.id, 'Перезапущен PGW');
  assert.equal(inc.status, 'resolved');
  assert.equal(p.signals.get(s.id)!.status, 'closed');
  assert.notEqual(POINT_ID, inc.teamId);
});

test('база: состояние пункта переживает перезапуск, смена пароля — всем', () => {
  const db = openDb(':memory:');
  const p = new Point();
  p['seed']();
  const per = new Persister(db);
  per.saveAll(p.incidents.values(), [], p.feed, p.complaints);
  per.close();
  const saved = loadPoint(db)!;
  assert.equal(saved.incidents.length, p.incidents.size);
  assert.ok(saved.complaints.length > 0);
  const again = new Point();
  again.start(saved, p.shift);
  again.stop();
  assert.equal(again.incidents.size, p.incidents.size);

  const h = hashPassword('секрет');
  assert.ok(verifyPassword('секрет', h) && !verifyPassword('другой', h));
  const accounts = PEOPLE.slice(0, 50).map((x) => ({ login: x.id, name: x.name, role: x.role, teamId: x.teamId }));
  seedUsers(db, accounts, 'старый');
  seedUsers(db, accounts, '1234');
  const rows = db.prepare('SELECT pass_hash FROM users').all() as { pass_hash: string }[];
  assert.equal(rows.length, 50);
  assert.ok(rows.every((r) => verifyPassword('1234', r.pass_hash)));
  db.close();
});
