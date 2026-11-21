// Показ по кнопкам: каждая ситуация создаёт настоящее состояние пункта; «очистить» — пустая смена; самотёк выключается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from './point.ts';
import { Mailbox } from './mail.ts';
import { clearAll, runShow, setShow, SHOW_KINDS } from './show.ts';

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
