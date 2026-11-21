import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Incident } from '../shared/types.ts';
import { attention, dashSnapshot, groupsOf, transferCount, transfers, type BlockId } from '../shared/dash.ts';
import { dashRules, toDashOp } from './jarvis-dash.ts';
import { contrast, toStyle } from './design.ts';
import { PERSONAS, personaById } from '../shared/personas.ts';
import { DASH_STYLES, findDashStyle } from '../shared/dashStyles.ts';
import { Point } from './point.ts';
import { RAW } from './catalog.ts';

const MIN = 60_000;
const now = 10_000_000_000;
let n = 0;
const inc = (o: Partial<Incident>) =>
  ({ id: `I${++n}`, title: 't', status: 'assigned', priority: 'P3', stateText: 'Назначен', createdAt: now - 60 * MIN, slaDeadline: now + 5 * 60 * MIN, history: [], reassignCount: 0, routedAt: now - MIN, origin: 'dataset', ...o }) as unknown as Incident;

test('группы кейса: один инцидент сразу в нескольких, решённые — ни в какой', () => {
  assert.deepEqual(groupsOf(inc({ priority: 'P1', status: 'coordinators' })), ['crit', 'coord']);
  assert.deepEqual(groupsOf(inc({ priority: 'P2', status: 'coordinators', stateText: 'Исследование ситуации' })), ['coord', 'high', 'research']);
  assert.deepEqual(groupsOf(inc({ priority: 'P2' })), ['high']);
  assert.deepEqual(groupsOf(inc({ priority: 'P1', status: 'resolved' })), []);
  assert.deepEqual(groupsOf(inc({ priority: 'P4' })), []);
});

test('порядок «требует действия»: критический на координаторах → критический ждёт → на координаторах → срок → не берут', () => {
  const list = [
    inc({ id: 'late', slaDeadline: now + 10 * MIN }),
    inc({ id: 'coord', status: 'coordinators' }),
    inc({ id: 'p1wait', priority: 'P1' }),
    inc({ id: 'p1coord', priority: 'P1', status: 'coordinators' }),
    inc({ id: 'nottaken', routedAt: now - 25 * MIN }),
    inc({ id: 'calm', priority: 'P4', status: 'in_progress' }),
  ];
  const s = dashSnapshot(list, now);
  assert.deepEqual(
    s.action.map((x) => x.inc.id),
    ['p1coord', 'p1wait', 'coord', 'late', 'nottaken'],
  );
  assert.equal(s.counts.crit, 2);
  assert.equal(s.counts.coord, 2);
  assert.equal(s.counts.notTaken, 1);
  assert.equal(attention(list[5], now), null, 'спокойный инцидент в работе действия не требует');
});

test('фильтр по группе и решённые критические видны 15 минут', () => {
  const list = [inc({ id: 'a', priority: 'P1' }), inc({ id: 'b', status: 'coordinators' }), inc({ id: 'c', priority: 'P1', status: 'resolved', resolvedAt: now - 3 * MIN }), inc({ id: 'd', priority: 'P1', status: 'resolved', resolvedAt: now - 40 * MIN })];
  const s = dashSnapshot(list, now, { filter: 'crit' });
  assert.deepEqual(s.action.map((x) => x.inc.id), ['a']);
  assert.deepEqual(s.resolvedCrit.map((i) => i.id), ['c']);
});

test('история передач: цепочка команд без повторов подряд', () => {
  const i = inc({
    history: [
      { at: 1, kind: 'coordinator', text: 'Иванов: передано команде «Биллинг L1»' },
      { at: 2, kind: 'system', text: 'ITSM: передано команде «Ядро сети»' },
      { at: 3, kind: 'coordinator', text: 'Иванов (автопилот): передано команде «Ядро сети»' },
      { at: 4, kind: 'coordinator', text: 'Петров: передано команде «Биллинг L2»' },
    ] as Incident['history'],
  });
  assert.deepEqual(transfers(i).map((h) => h.team), ['Биллинг L1', 'Ядро сети', 'Биллинг L2']);
  assert.equal(transferCount(i), 3);
});

test('правки файла ITSM: на координаторов, в другую команду, критический — стена видит сразу', () => {
  const p = new Point();
  p['seed']();
  const COORD = 'КЦ ИТ Координаторы Массовых Инцидентов';
  const base = RAW.find((r) => r.assignedGroupName !== COORD && r.stateId !== 7 && r.stateId !== 10 && r.priorityId < 4)!;
  const other = RAW.find((r) => r.assignedGroupName !== COORD && r.assignedGroupName !== base.assignedGroupName)!;
  p.ingest([base], true);
  p.ingest([{ ...base, assignedGroupName: COORD }], false);
  const inc = p.incidents.get(base.id)!;
  assert.equal(inc.status, 'coordinators');
  assert.ok(groupsOf(inc).includes('coord'));
  p.ingest([{ ...base, assignedGroupName: other.assignedGroupName }], false);
  assert.notEqual(inc.status, 'coordinators');
  assert.ok(transfers(inc).length >= 1, 'передача видна в истории');
  p.ingest([{ ...base, assignedGroupName: other.assignedGroupName, priorityId: 4 }], false);
  assert.equal(inc.priority, 'P1');
  assert.ok(groupsOf(inc).includes('crit'));
  p.stop();
});

test('Джарвис без модели понимает команды стене', () => {
  const ctx = { preset: 'case', columns: ['rotate', 'action', 'work'] as BlockId[], style: 'graphite', filter: null, density: 'normal' as const };
  const said = (t: string) => {
    let got: Record<string, unknown> | null = null;
    const reply = dashRules(t.toLowerCase().replace(/ё/g, 'е'), ctx, (a) => ((got = a), 'ok'), true);
    return { reply, got: got as Record<string, unknown> | null };
  };
  assert.deepEqual(said('Покажи только критические').got, { op: 'filter', group: 'crit' });
  assert.deepEqual(said('поменяй местами левый и правый блоки').got, { op: 'swap', position: 'left', position2: 'right' });
  assert.deepEqual(said('добавь карту').got, { op: 'show', block: 'map' });
  assert.deepEqual(said('убери ленту событий').got, { op: 'hide', block: 'events' });
  assert.deepEqual(said('сделай стиль неон').got, { op: 'style', style: 'neon' });
  assert.deepEqual(said('покажи крупно самый срочный').got, { op: 'focus', id: 'top' });
  assert.deepEqual(said('раскладка четыре группы').got, { op: 'preset', preset: 'groups' });
  assert.deepEqual(said('верни прежнюю стену').got, { op: 'preset', preset: 'legacy' });
  assert.equal(said('кому передать этот инцидент').reply, null, 'обычные вопросы не перехватывает');
});

test('дизайн от ChatGPT: опасное отбрасывается, текст остаётся читаемым', () => {
  const st = toStyle({ name: 'Море', dark: true, bg: 'url(https://evil.example/x.png)', panel: '#0b2a3a', text: '#0c2b3b', accent: 'red;background:url(x)', crit: '#ff3344', snow: true, radius: 99 });
  assert.notEqual(st.bg.includes('url'), true, 'url() не пропускаем');
  assert.equal(st.accent.includes('url'), false);
  assert.equal(st.crit, '#ff3344');
  assert.ok((contrast(st.text, st.panel) ?? 0) >= 4.5, 'тёмный текст на тёмной панели заменён на читаемый');
  assert.equal(st.deco, 'snow');
  assert.equal(st.radius, 24);
  assert.ok(st.custom && st.id.startsWith('ai-'));
  const g = toStyle({ dark: false, bg: 'linear-gradient(135deg, #ffffff 0%, rgba(200,220,255,0.8) 100%)' });
  assert.ok(g.bg.startsWith('linear-gradient'), 'градиент из цветов можно');
});

test('персонажи: у каждого свой голос, имя для пробуждения и картинка', () => {
  assert.ok(PERSONAS.length >= 4);
  for (const p of PERSONAS) {
    assert.ok(p.voice && p.avatar.startsWith('/personas/') && p.wake.length, p.id);
  }
  assert.equal(new Set(PERSONAS.map((p) => p.voice)).size, PERSONAS.length, 'голоса разные');
  assert.equal(personaById('нет такого').id, 'jarvis');
});

test('закреплённую стену Джарвис не перестраивает', () => {
  const p = new Point();
  assert.throws(() => toDashOp({ op: 'style', style: 'neon' }, { preset: 'case', columns: ['action'], style: 'graphite', filter: null, density: 'normal', locked: true }, p), /закреплён/);
  assert.equal(toDashOp({ op: 'focus', id: '' }, { preset: 'case', columns: ['action'], style: 'graphite', filter: null, density: 'normal', locked: true }, p).cmd.op, 'focus');
});

test('стилей больше двадцати, у всех разные id, голосом находятся по названию', () => {
  assert.ok(DASH_STYLES.length > 20);
  assert.equal(new Set(DASH_STYLES.map((s) => s.id)).size, DASH_STYLES.length);
  assert.equal(findDashStyle('сделай стиль табло аэропорта')?.id, 'airport');
  assert.equal(findDashStyle('включи неон')?.id, 'neon');
  assert.equal(findDashStyle('оформление северное сияние')?.id, 'aurora');
  assert.equal(findDashStyle('стиль солнечный светлый')?.id, 'solar-light');
});
