// Джарвис и почта: «прочитай письмо», «заведи инцидент по письму», «да» в ответ на объявление о срочном письме.
// Проверяем без модели — по правилам (ключа OpenRouter в тестах нет).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailItem, Me } from '../shared/types.ts';
import { Point } from './point.ts';
import { Mailbox } from './mail.ts';
import { ask, attachMailbox, type JarvisAsk } from './jarvis.ts';

process.env.OPENROUTER_API_KEY = '';
const MIN = 60_000;
const me: Me = { login: 'test', name: 'Тестов Тест', role: 'coordinator', personId: null, teamId: null };
const q = (text: string, history: JarvisAsk['history'] = []): JarvisAsk => ({ text, selectedId: null, focusId: null, tab: 'wall', mode: 'chat', history });

function letter(id: string, over: Partial<MailItem> & { kind: NonNullable<MailItem['analysis']>['kind']; urgency: NonNullable<MailItem['analysis']>['urgency']; summary: string }): MailItem {
  const now = Date.now();
  const { kind, urgency, summary, ...rest } = over;
  return {
    id,
    at: now - 5 * MIN,
    from: 'x@corp.local',
    fromName: 'Отправитель',
    subject: summary,
    body: `Текст письма: ${summary}`,
    source: 'demo',
    read: false,
    incidentCreated: null,
    analysis: { kind, urgency, summary, action: 'Ответить и проверить', incidentId: null, service: null, llm: false, at: now },
    ...rest,
  };
}

function setup(items: MailItem[]) {
  const point = new Point();
  const box = new Mailbox(point, () => undefined, () => false);
  box.restore(items);
  attachMailbox(box);
  return { point, box };
}

test('«прочитай письмо» — Джарвис пересказывает самое важное и отмечает его прочитанным', async () => {
  const { point, box } = setup([
    letter('M1', { kind: 'update', urgency: 'normal', summary: 'Команда восстановит за 30 минут', fromName: 'Руководитель группы' }),
    letter('M2', { kind: 'complaint', urgency: 'high', summary: 'Повторный отказ ТВ в Воронеже', fromName: 'ООО Ромашка' }),
  ]);
  const r = await ask(point, me, q('Джарвис, прочитай письмо'));
  assert.match(r.reply, /ООО Ромашка/);
  assert.match(r.reply, /Повторный отказ ТВ в Воронеже/);
  assert.equal(box.get('M2')!.read, true, 'срочное письмо прочитано');
  assert.equal(box.get('M1')!.read, false, 'остальные не тронуты');
});

test('«заведи инцидент по письму» — инцидент на пункте, письмо связано с ним', async () => {
  const { point, box } = setup([letter('M3', { kind: 'incident', urgency: 'high', summary: 'Рост ошибок 5xx на API-GW', fromName: 'Zabbix' })]);
  const before = point.incidents.size;
  const r = await ask(point, me, q('заведи инцидент по письму'));
  assert.equal(point.incidents.size, before + 1);
  const m = box.get('M3')!;
  assert.ok(m.incidentCreated && point.incidents.get(m.incidentCreated)?.status === 'coordinators');
  assert.equal(m.analysis!.incidentId, m.incidentCreated);
  assert.ok(r.done.some((d) => /по письму/.test(d)));
});

test('«да» после «срочное письмо… Прочитать?» — читает письмо', async () => {
  const { point, box } = setup([letter('M4', { kind: 'request', urgency: 'high', summary: 'Просят переназначить инцидент', fromName: 'Группа L2' })]);
  const r = await ask(point, me, q('да', [{ role: 'assistant', content: 'Сэр, срочное письмо: просят переназначить инцидент. Прочитать?' }]));
  assert.match(r.reply, /Группа L2/);
  assert.equal(box.get('M4')!.read, true);
});

test('нет важных писем — так и говорит, ничего не меняет', async () => {
  const { point } = setup([letter('M5', { kind: 'noise', urgency: 'low', summary: 'Дайджест новостей' })]);
  const r = await ask(point, me, q('прочитай письмо'));
  assert.match(r.reply, /нет/i);
});
