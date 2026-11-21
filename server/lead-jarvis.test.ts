// Джарвис пишет руководителю команды: «напиши руководителю, что …» — сообщение в переписке инцидента,
// отметка «руководителю сообщили», открытый сигнал закрывается. Проверяем без модели — по правилам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Me } from '../shared/types.ts';
import { Point } from './point.ts';
import { ask, type JarvisAsk } from './jarvis.ts';

process.env.OPENROUTER_API_KEY = '';
const me: Me = { login: 'test', name: 'Тестов Тест', role: 'coordinator', personId: null, teamId: null };
const q = (text: string, focusId: string): JarvisAsk => ({ text, selectedId: null, focusId, tab: 'wall', mode: 'chat', history: [] });

function atTeam() {
  const p = new Point();
  p['seed']();
  const inc = p.fromCluster({ key: 'Мобильная связь|krd', service: 'Мобильная связь', regionId: 'krd', count: 8, expected: 0.5, pValue: 1e-6 }, 'тест');
  return { p, inc };
}

test('«напиши руководителю, что …» — сообщение руководителю в переписке инцидента', async () => {
  const { p, inc } = atTeam();
  p.route(inc.id, 'ran-krd', 'Дежурный');
  const r = await ask(p, me, q('Джарвис, напиши руководителю, что нужен срок восстановления к 15:00', inc.id));
  assert.match(r.reply, /Готово/);
  const c = inc.comments?.at(-1);
  assert.ok(c && /^Руководителю/.test(c.text), 'сообщение в переписке');
  assert.match(c!.text, /нужен срок восстановления к 15:00/);
  assert.ok(inc.leadNotifiedAt, 'отмечено, что руководителю сообщили');
  assert.ok(r.done.some((d) => /руководителю/i.test(d)));
});

test('без текста — Джарвис пишет сам: что случилось и срок', async () => {
  const { p, inc } = atTeam();
  p.route(inc.id, 'ran-krd', 'Дежурный');
  await ask(p, me, q('скажи руководителю команды', inc.id));
  assert.match(inc.comments?.at(-1)?.text ?? '', /Прошу ускорить работу/);
});

test('инцидент ещё на пункте — не пишет, просит сначала передать', async () => {
  const { p, inc } = atTeam();
  const r = await ask(p, me, q('напиши руководителю', inc.id));
  assert.match(r.reply, /Не вышло: инцидент ещё не у команды/);
  assert.ok(!inc.comments?.some((c) => /^Руководителю/.test(c.text)));
});
