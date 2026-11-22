// Показ по кнопкам: каждая ситуация создаёт настоящее состояние пункта; «очистить» — пустая смена; самотёк выключается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from './point.ts';
import { Mailbox } from './mail.ts';
import { clearAll, runShow, setShow, SHOW_KINDS } from './show.ts';
import { PEOPLE, isOn, personById, teamById } from './directory.ts';
import { detect, questionsOf, sigOf, voiceLine, type Sig } from '../shared/attention.ts';

function setup() {
  const p = new Point();
  p['seed']();
  const box = new Mailbox(p, () => undefined, () => false);
  setShow(p, box, true);
  clearAll(p, box);
  return { p, box };
}

test('режим показа: самотёк выключен, очистка — пустая смена', () => {
  const { p, box } = setup();
  assert.equal(p.show, true);
  assert.equal(p.stream.auto, false);
  assert.equal(box.demo, false);
  assert.equal(p.incidents.size, 0);
  assert.equal(p.complaints.length, 0);
  assert.equal(box.items.length, 0);
  setShow(p, box, false);
  assert.equal(p.stream.auto, true);
  assert.equal(box.demo, true);
});

test('режим показа: ящик сам не кладёт демо-письма; смена вечная — никого «не на смене»', () => {
  const p = new Point();
  const box = new Mailbox(p, () => undefined, () => true);
  box.demo = false;
  box.start();
  box.stop();
  assert.equal(box.items.length, 0);
  const at = Date.UTC(2026, 10, 22, 3, 0); // ночь воскресенья — по графикам почти все не на смене
  assert.ok(PEOPLE.every((x) => x.away || isOn(x, at)));
});

test('вопросы команд: «не наше» и «нужна помощь» видны стене, передача снимает вопрос', () => {
  const { p, box } = setup();
  const before = new Map<string, Sig>();
  const ask = p.incidents.get(runShow(p, box, 'teamNotOurs', 'Коллега').id!)!;
  assert.equal(ask.teamAsk?.kind, 'transfer');
  assert.ok([...p.requests.values()].some((r) => r.incidentId === ask.id && r.status === 'pending'));
  const help = p.incidents.get(runShow(p, box, 'teamHelp', 'Коллега').id!)!;
  assert.equal(help.teamAsk?.kind, 'help');
  // стена: новые инциденты с вопросом команды — событие «Вопрос команды», и Джарвис спрашивает, передать ли
  const { found } = detect(before, [...p.incidents.values()], Date.now(), new Set());
  assert.equal(found.filter((f) => f.kind === 'teamAsk').length, 2);
  assert.match(voiceLine('teamAsk', ask, Date.now()), /просит передать/);
  assert.match(voiceLine('teamAsk', help, Date.now()), /просит помощи/);
  // передали в другую команду — вопрос снят, запрос выполнен
  const other = [...p.incidents.values()].find((i) => i.id !== ask.id && i.teamId && i.teamId !== ask.teamId)?.teamId ?? ask.ai?.teamId;
  p.route(ask.id, other!, 'Дежурный');
  assert.equal(ask.teamAsk, null);
  assert.ok([...p.requests.values()].every((r) => r.incidentId !== ask.id || r.status === 'approved'));
});

test('ИИ распределяет сам: низкие — когда горит критический, средний — когда до срока столько, сколько нужно команде', () => {
  const { p, box } = setup();
  runShow(p, box, 'lows', 'Коллега');
  const t0 = Date.now() + 10_000;
  assert.equal(p.autoRoute(t0).length, 0, 'без критического ИИ не вмешивается');
  runShow(p, box, 'crit', 'Коллега');
  const first = p.autoRoute(t0);
  assert.equal(first.filter((i) => i.priority === 'P4').length, 2, 'низкие — сразу');
  assert.equal(first.filter((i) => i.priority === 'P3').length, 0, 'средний — ещё рано: до срока больше, чем нужно команде');
  assert.ok(first.every((i) => i.status === 'assigned' && i.autoRouted?.why));
  const later = p.autoRoute(Date.now() + 3 * 60_000);
  assert.equal(later.length, 1);
  assert.equal(later[0].priority, 'P3');
  assert.match(later[0].autoRouted!.why, /средний/);
  // стена: «ИИ передал сам» — и Джарвис скажет почему
  assert.match(voiceLine('auto', later[0], Date.now()), /передал/);
});

test('вопрос руководителю: в блоке «Вопросы» ждёт ответа, ответ команды — «ответили» и событие для Джарвиса', () => {
  const { p, box } = setup();
  const inc = p.incidents.get(runShow(p, box, 'leadQ', 'Коллега').id!)!;
  const before = new Map([[inc.id, sigOf(inc, Date.now())]]);
  let q = questionsOf(p.incidents.values(), Date.now()).find((x) => x.inc.id === inc.id)!;
  assert.equal(q.dir, 'out');
  assert.equal(q.answer, null);
  assert.match(q.who, /руководитель/);
  const lead = personById(teamById(inc.teamId)?.leadId);
  p.comment(inc.id, { name: lead?.name ?? 'Руководитель', personId: lead?.id ?? null, side: 'team', teamId: inc.teamId }, 'Восстановим за 20 минут');
  q = questionsOf(p.incidents.values(), Date.now()).find((x) => x.inc.id === inc.id)!;
  assert.equal(q.answer, 'Восстановим за 20 минут');
  const { found } = detect(before, [inc], Date.now(), new Set());
  assert.ok(found.some((f) => f.kind === 'answer'));
});

test('новый инцидент сразу с предложением ИИ — одно событие «Наивысший», а не ещё и «на распределение»', () => {
  const { p, box } = setup();
  runShow(p, box, 'p1ask', 'Коллега');
  const { found } = detect(new Map(), [...p.incidents.values()], Date.now(), new Set());
  assert.deepEqual(found.map((f) => f.kind), ['p1ask']);
});

test('«завести инцидент?» — «да», а ИИ уже собрал жалобы сам: тот же инцидент, а не «всплеск не актуален»', () => {
  const { p } = setup();
  const inc = p.scenarioIncident({ service: 'МТС Банк', regionId: 'sam', n: 12, priority: 'P3' });
  // всплеска как кластера уже нет — жалобы в инциденте
  p.complaints.length = 0;
  const again = p.createFromCluster('МТС Банк|sam', 'Дежурный');
  assert.equal(again.id, inc.id);
  assert.throws(() => p.createFromCluster('KION|tom', 'Дежурный'), /не актуален/);
});

test('новый критический — P1 на пункте с советом ИИ', () => {
  const { p, box } = setup();
  const r = runShow(p, box, 'crit', 'Ведущий');
  const inc = p.incidents.get(r.id!)!;
  assert.equal(inc.priority, 'P1');
  assert.equal(inc.status, 'coordinators');
  assert.ok(inc.ai?.teamId, 'ИИ советует команду');
  assert.ok((inc.complaints ?? 0) > 20);
});

test('решили, а жалобы снова — инцидент решён командой, сбой продолжается', () => {
  const { p, box } = setup();
  const r = runShow(p, box, 'recur', 'Ведущий');
  const inc = p.incidents.get(r.id!)!;
  assert.equal(inc.status, 'resolved');
  assert.ok(p.stream.outages.some((o) => o.service === 'KION'));
});

test('команда не берёт — передан давно, есть эскалация', () => {
  const { p, box } = setup();
  const r = runShow(p, box, 'stuck', 'Ведущий');
  const inc = p.incidents.get(r.id!)!;
  assert.equal(inc.status, 'assigned');
  assert.ok((inc.escalation ?? 0) >= 1 || [...p.signals.values()].some((s) => s.incidentId === inc.id));
});

test('срок горит, по кругу, «Наивысший», важнее критического, письма — всё создаётся', () => {
  const { p, box } = setup();
  const sla = p.incidents.get(runShow(p, box, 'sla', 'Ведущий').id!)!;
  assert.ok(sla.slaDeadline - Date.now() < 15 * 60_000);
  const pp = p.incidents.get(runShow(p, box, 'pingpong', 'Ведущий').id!)!;
  assert.ok(pp.reassignCount >= 1);
  const p1 = p.incidents.get(runShow(p, box, 'p1ask', 'Ведущий').id!)!;
  assert.ok(p1.p1Proposal);
  runShow(p, box, 'above', 'Ведущий');
  assert.ok([...p.incidents.values()].some((i) => i.priority === 'P1'));
  runShow(p, box, 'mailCrit', 'Ведущий');
  runShow(p, box, 'mailAsk', 'Ведущий');
  assert.equal(box.items.length, 2);
  assert.ok(SHOW_KINDS.length >= 10);
});
