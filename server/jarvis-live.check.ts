// Живая проверка Джарвиса на настоящей модели: даём задачи словами, как дежурный голосом, и смотрим, изменилось ли
// состояние пункта на самом деле (а не только «готово, сэр»). Не входит в npm test — нужен ключ OpenRouter.
// Запуск: npx tsx --env-file=.env server/jarvis-live.check.ts
import type { Incident } from '../shared/types.ts';
import { Point } from './point.ts';
import { Mailbox } from './mail.ts';
import { ask, attachMailbox } from './jarvis.ts';
import { clearAll, runShow, setShow } from './show.ts';
import { POINT_STAFF } from './directory.ts';

const p = new Point();
p['seed']();
const box = new Mailbox(p, () => undefined, () => false);
setShow(p, box, true);
clearAll(p, box);
attachMailbox(box);
const coord = POINT_STAFF.find((x) => x.role === 'coordinator')!;
const me = { login: coord.id, name: coord.name, role: 'coordinator' as const, personId: coord.id, teamId: coord.teamId };

const inc = (id?: string) => p.incidents.get(id!) as Incident;
const crit = inc(runShow(p, box, 'crit', 'Коллега').id);
const coordInc = inc(runShow(p, box, 'coord', 'Коллега').id);
const recur = inc(runShow(p, box, 'recur', 'Коллега').id);
const stuck = inc(runShow(p, box, 'stuck', 'Коллега').id);
const p1 = inc(runShow(p, box, 'p1ask', 'Коллега').id);
runShow(p, box, 'mailCrit', 'Коллега');
const mailBefore = p.incidents.size;
const fromMail = () => [...p.incidents.values()].find((i) => i.channel === 'Почта');

const steps: { say: string; ok: () => boolean }[] = [
  { say: 'что сейчас горит?', ok: () => true },
  { say: 'передай критический команде', ok: () => crit.status !== 'coordinators' },
  { say: 'подними инцидент по домашнему интернету в краснодаре до наивысшего', ok: () => coordInc.priority === 'P1' },
  { say: 'а теперь передай его команде', ok: () => coordInc.status !== 'coordinators' },
  { say: 'верни в работу инцидент по кион', ok: () => recur.status !== 'resolved' },
  { say: 'напиши руководителю, что по мой мтс в питере срок горит', ok: () => !!stuck.leadNotifiedAt },
  { say: 'заведи инцидент по письму', ok: () => p.incidents.size > mailBefore },
  { say: 'возьми его на меня', ok: () => fromMail()?.coordinatorId === me.personId },
  { say: 'подтверди наивысший по мобильному интернету в новосибирске', ok: () => p1.priority === 'P1' && !p1.p1Proposal },
  { say: 'покажи четыре группы на весь экран', ok: () => true },
];

const history: { role: 'user' | 'assistant'; content: string }[] = [];
let focus: string | null = null;
let fails = 0;
for (const s of steps) {
  const t0 = Date.now();
  const r = await ask(p, me, { text: s.say, selectedId: null, focusId: focus, tab: 'wall', mode: 'control', history: history.slice(-8), dash: null });
  const ms = Date.now() - t0;
  history.push({ role: 'user', content: s.say }, { role: 'assistant', content: r.done?.length ? `${r.reply} (Сделано: ${r.done.join('; ')})` : r.reply });
  if (r.focus) focus = r.focus;
  const pass = s.ok();
  if (!pass) fails++;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${String(ms).padStart(6)} мс  «${s.say}»\n       → ${r.reply.replace(/\s+/g, ' ').slice(0, 170)}${r.done?.length ? `\n       сделано: ${r.done.join('; ')}` : ''}${r.llm ? '' : '  [по правилам]'}`);
}
console.log(`\nитог: ${steps.length - fails}/${steps.length}`);
process.exit(fails ? 1 : 0);
