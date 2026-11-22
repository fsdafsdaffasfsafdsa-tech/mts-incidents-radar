import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Incident } from '../shared/types.ts';
import { attention, dashSnapshot, groupsOf, isImportant, lastAttention, transferCount, transfers, urgencyScore, type BlockId } from '../shared/dash.ts';
import { dashRules, toDashOp } from './jarvis-dash.ts';
import { contrast, toStyle } from './design.ts';
import { PERSONAS, personaById } from '../shared/personas.ts';
import { addItem, columnsToItems, free, normalize, overlap, removeItem, swapItems } from '../shared/dashGrid.ts';
import { applyFilter, cleanSpec } from '../shared/dashCustom.ts';
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

test('порядок «требует действия»: критический на координаторах → критический ждёт → срок через 10 минут → на координаторах → не берут', () => {
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
    ['p1coord', 'p1wait', 'late', 'coord', 'nottaken'],
  );
  assert.equal(s.counts.crit, 2);
  assert.equal(s.counts.coord, 2);
  assert.equal(s.counts.notTaken, 1);
  assert.equal(attention(list[5], now), null, 'спокойный инцидент в работе действия не требует');
});

test('кейс: высокий со сроком через 10 минут срочнее критического с запасом в 5 часов', () => {
  const list = [inc({ id: 'p1calm', priority: 'P1', status: 'in_progress' }), inc({ id: 'p2short', priority: 'P2', status: 'in_progress', slaDeadline: now + 10 * MIN })];
  const s = dashSnapshot(list, now);
  assert.equal(s.action[0].inc.id, 'p2short', 'короткий срок важнее уровня');
  assert.ok(s.action[0].att.score > s.topCrit, 'на стене встанет над критическими с пометкой «Важнее критического»');
  assert.equal(s.action[0].att.reason, 'Срок близко');
  // а критический со сроком через 10 минут всё равно выше такого же высокого
  const p1short = inc({ priority: 'P1', status: 'in_progress', slaDeadline: now + 10 * MIN });
  assert.ok(urgencyScore(p1short, now) > urgencyScore(list[1], now));
  // просроченный выше, чем срок через час
  assert.ok(urgencyScore(inc({ priority: 'P3', slaDeadline: now - MIN }), now) > urgencyScore(inc({ priority: 'P3', slaDeadline: now + 60 * MIN }), now));
});

test('«Не забыть»: важный некритический без внимания 20+ минут, пока не посмотрели', () => {
  const forgot = inc({ id: 'f', priority: 'P2', status: 'in_progress', createdAt: now - 60 * MIN });
  const fresh = inc({ id: 'g', priority: 'P2', status: 'in_progress', createdAt: now - 60 * MIN, attentionAt: now - 5 * MIN });
  const calm = inc({ id: 'h', priority: 'P4', status: 'in_progress', createdAt: now - 60 * MIN });
  const crit = inc({ id: 'k', priority: 'P1', status: 'in_progress', createdAt: now - 60 * MIN });
  assert.equal(isImportant(calm, now), false, 'низкий в работе с запасом — не важный');
  assert.equal(isImportant(crit, now), false, 'критические и так на виду');
  const s = dashSnapshot([forgot, fresh, calm, crit], now);
  assert.deepEqual(s.forgotten.map((x) => x.inc.id), ['f']);
  assert.equal(Math.round(s.forgotten[0].idle / MIN), 60);
  // действие дежурного в истории тоже считается вниманием
  const acted = inc({ priority: 'P2', status: 'in_progress', createdAt: now - 60 * MIN, history: [{ at: now - 3 * MIN, kind: 'coordinator', text: 'Иванов: передано команде «Биллинг»' }] as Incident['history'] });
  assert.equal(lastAttention(acted), now - 3 * MIN);
});

test('избранное смены: закрепить с заметкой и напоминанием, «посмотрел», убрать', () => {
  const p = new Point();
  p['seed']();
  const target = [...p.incidents.values()].find((i) => i.status !== 'resolved' && i.priority !== 'P1')!;
  p.pin(target.id, 'Иванов Иван', 'жду ответа Billing', 30);
  const inc1 = p.incidents.get(target.id)!;
  assert.equal(inc1.pin?.note, 'жду ответа Billing');
  assert.equal(inc1.pin?.by, 'Иванов Иван');
  assert.ok(inc1.pin?.remindAt && Math.round((inc1.pin.remindAt - Date.now()) / MIN) === 30);
  assert.ok(inc1.attentionAt, 'закрепил — значит, посмотрел');
  const snap = dashSnapshot(p.incidents.values(), Date.now());
  assert.ok(snap.pinned.some((i) => i.id === target.id));
  assert.ok(!snap.forgotten.some((x) => x.inc.id === target.id), 'закреплённый не попадает в «Не забыть»');
  assert.equal(transfers(inc1).length, transfers({ ...inc1, history: inc1.history.slice(0, -1) }).length, 'запись об избранном не считается передачей');
  p.unpin(target.id, 'Иванов Иван');
  assert.equal(p.incidents.get(target.id)!.pin, null);
  const before = p.incidents.get(target.id)!.attentionAt;
  p.seen(target.id, 'Петров');
  assert.equal(p.incidents.get(target.id)!.attentionAt, before, '«посмотрел» не чаще раза в минуту');
  p.stop();
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
  assert.deepEqual(said('добавь блок избранное').got, { op: 'show', block: 'favs' });
  assert.deepEqual(said('добавь блок не забыть').got, { op: 'show', block: 'forgot' });
  // четыре группы окном поверх стены — раскладку не трогаем
  assert.deepEqual(said('покажи четыре группы').got, { op: 'popup', block: 'groups', value: 'normal' });
  assert.deepEqual(said('четыре группы на весь экран').got, { op: 'popup', block: 'groups', value: 'large' });
  assert.deepEqual(said('закрой окно').got, { op: 'popup', on: false });
  assert.equal(said('что в избранном').reply, null, 'вопрос об избранном — не команда стене');
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

test('свободное поле: колонки → блоки, добавление в пустое место или делением, без наложений', () => {
  const cols = columnsToItems([{ block: 'rotate', width: 1 }, { block: 'action', width: 1.5 }, { block: 'work', width: 1.4 }]);
  assert.equal(cols.reduce((s, i) => s + i.w, 0), 12, 'колонки занимают всю ширину');
  assert.ok(cols.every((i) => i.y === 0 && i.h === 12));
  // поле занято целиком — новый блок делит самый большой пополам
  const more = addItem(cols, { block: 'clock' }, { w: 3, h: 3 });
  assert.equal(more.length, 4);
  for (const a of more) for (const b of more) if (a !== b) assert.equal(overlap(a, b), false, `${a.block} и ${b.block} не налезают`);
  // в пустую клетку — туда и ставится
  const half = [{ id: 'a', block: 'action' as const, x: 0, y: 0, w: 6, h: 12 }];
  const put = addItem(half, { block: 'note', x: 8, y: 2 }, { w: 3, h: 4 });
  const note = put.find((i) => i.block === 'note')!;
  assert.deepEqual([note.x, note.y], [8, 2]);
  // убрали — сосед забрал место; поменяли местами — поменялись прямоугольники
  const two = [{ id: 'l', block: 'action' as const, x: 0, y: 0, w: 6, h: 12 }, { id: 'r', block: 'work' as const, x: 6, y: 0, w: 6, h: 12 }];
  assert.equal(removeItem(two, 'r')[0].w, 12);
  const sw = swapItems(two, 'l', 'r');
  assert.equal(sw.find((i) => i.id === 'l')!.x, 6);
  // налезающее при загрузке — переносится в свободное место
  const fixed = normalize([{ id: '1', block: 'action', x: 0, y: 0, w: 6, h: 6 }, { id: '2', block: 'work', x: 3, y: 3, w: 6, h: 6 }]);
  assert.equal(overlap(fixed[0], fixed[1]), false);
  assert.equal(free(fixed, { x: 0, y: 0, w: 2, h: 2 }), false);
});

test('свой блок от ChatGPT: опасное отбрасывается, фильтр работает', () => {
  assert.equal(cleanSpec({ kind: 'script', title: 'x' }), null, 'неизвестный вид — нет');
  const s = cleanSpec({ kind: 'list', title: 'Просроченные высокие', filter: { priority: ['P2', 'P9'], overdue: true, status: ['hack'] }, limit: 999 })!;
  assert.deepEqual(s.filter, { priority: ['P2'], overdue: true, status: [] });
  assert.equal(s.limit, 20);
  const ch = cleanSpec({ kind: 'character', character: { name: 'Кот', style: 'строго', avatar: '<img src=x>', color: 'red' } })!;
  assert.equal(ch.character!.avatar, undefined, 'вместо картинки — только портрет из набора, эмодзи или data:image');
  assert.equal(cleanSpec({ kind: 'character', character: { name: 'Кот', avatar: '🐱' } })!.character!.avatar, '🐱');
  const list = [inc({ id: 'x', priority: 'P2', slaDeadline: now - MIN }), inc({ id: 'y', priority: 'P2' }), inc({ id: 'z', priority: 'P3', slaDeadline: now - MIN })];
  assert.deepEqual(applyFilter(list, s.filter, now, () => '').map((i) => i.id), ['x']);
});

test('стилей больше двадцати, у всех разные id, голосом находятся по названию', () => {
  assert.ok(DASH_STYLES.length > 20);
  assert.equal(new Set(DASH_STYLES.map((s) => s.id)).size, DASH_STYLES.length);
  assert.equal(findDashStyle('сделай стиль табло аэропорта')?.id, 'airport');
  assert.equal(findDashStyle('включи неон')?.id, 'neon');
  assert.equal(findDashStyle('оформление северное сияние')?.id, 'aurora');
  assert.equal(findDashStyle('стиль солнечный светлый')?.id, 'solar-light');
});
