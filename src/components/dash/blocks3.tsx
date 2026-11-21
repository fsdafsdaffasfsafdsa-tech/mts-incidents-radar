// Блоки «по-человечески»: что взять сейчас — одной карточкой с одной кнопкой, и сроки — шкалой с точками вместо текста.
import { CheckCircle2, ExternalLink, RotateCcw, Send, Siren, Target, Timer, UserCheck } from 'lucide-react';
import type { Incident } from '../../../shared/types';
import { heatFor } from '../../../shared/attention';
import { fmtShort } from '../../../shared/dash';
import { answerP1, reopenIncident, routeTo, takeAtPoint, teamName } from '../../store';
import { BlockHead, PRIO, Ring, Why, whoShort, type BlockCtx } from './Dashboard';

const MIN = 60_000;

/** Одно главное действие по инциденту — то, что дежурный сделал бы сейчас. */
function mainAction(i: Incident, open: () => void): { label: string; icon: React.ReactNode; run: () => void } {
  if (i.status === 'resolved' && i.recur) return { label: 'Вернуть в работу', icon: <RotateCcw size={20} />, run: () => void reopenIncident(i.id) };
  if (i.p1Proposal && i.priority !== 'P1') return { label: 'Поднять до «Наивысшего»', icon: <Siren size={20} />, run: () => void answerP1(i.id, true) };
  if (i.status === 'coordinators' && i.ai?.teamId) return { label: `Передать в «${teamName(i.ai.teamId)}»`, icon: <Send size={20} />, run: () => void routeTo(i.id, i.ai.teamId!) };
  if (i.status === 'coordinators' && !i.coordinatorId) return { label: 'Беру на себя', icon: <UserCheck size={20} />, run: () => void takeAtPoint(i.id) };
  return { label: 'Открыть', icon: <ExternalLink size={20} />, run: open };
}

/** «Взять сейчас»: самое срочное — крупно, с одной кнопкой; ниже — следующие три. */
export function NowBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  // Сначала то, что ждёт действия самого дежурного: распределить, вернуть в работу, решить про «Наивысший»; потом — остальное по срочности.
  const mine = (i: Incident) => i.status === 'coordinators' || i.status === 'resolved' || (!!i.p1Proposal && i.priority !== 'P1');
  const order = [...snap.action.filter((x) => mine(x.inc)), ...snap.action.filter((x) => !mine(x.inc))];
  const top = order[0];
  if (!top)
    return (
      <div className="db db-now calm">
        <BlockHead title="Взять сейчас" icon={<Target size={18} />} />
        <div className="dn-calm">
          <CheckCircle2 size={44} />
          <b>Всё под контролем</b>
        </div>
      </div>
    );
  const i = top.inc;
  const act = mainAction(i, () => ctx.open(i));
  const next = order.slice(1, 4);
  return (
    <div className="db db-now" data-heat={heatFor(top.inc, top.att.score)}>
      <BlockHead title="Взять сейчас" icon={<Target size={18} />} />
      <button className={`dn-card p-${i.priority}`} onClick={() => ctx.open(i)} title={`${i.title}\n${i.productName || i.service}`}>
        <span className="dn-text">
          <span className="dn-top">
            <span className="dn-prio">{i.status === 'resolved' ? 'Снова жалобы' : PRIO[i.priority]}</span>
            <Why att={top.att} />
          </span>
          <b className="dn-title">{i.title}</b>
          <span className="dn-who">{whoShort(i)}</span>
        </span>
        {i.status === 'resolved' && i.recur ? (
          <span className="dring t-over big">
            <RotateCcw size={18} />
            <b className="num">{i.recur.count}</b>
          </span>
        ) : (
          <Ring i={i} now={now} big />
        )}
      </button>
      <button className="dn-act" onClick={act.run}>
        {act.icon} {act.label}
      </button>
      {next.length > 0 && (
        <div className="dn-next">
          {next.map((x) => (
            <button key={x.inc.id} className={`dn-row p-${x.inc.priority}`} data-heat={heatFor(x.inc, x.att.score)} onClick={() => ctx.open(x.inc)} title={x.inc.title}>
              <span className="dc-bar" />
              <b>{x.inc.title}</b>
              <Why att={x.att} />
              <Ring i={x.inc} now={now} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SPAN = 4 * 60 * MIN; // шкала — на 4 часа вперёд
const pos = (left: number) => Math.sqrt(Math.min(1, Math.max(0, left / SPAN))) * 100; // ближайшее — крупнее
const TICKS = [
  { at: 15 * MIN, t: '15м' },
  { at: 30 * MIN, t: '30м' },
  { at: 60 * MIN, t: '1ч' },
  { at: 2 * 60 * MIN, t: '2ч' },
  { at: 4 * 60 * MIN, t: '4ч' },
];
const LANES: { id: string; name: string; test: (i: Incident) => boolean }[] = [
  { id: 'P1', name: 'Крит', test: (i) => i.priority === 'P1' },
  { id: 'P2', name: 'Выс', test: (i) => i.priority === 'P2' },
  { id: 'rest', name: 'Др.', test: (i) => i.priority !== 'P1' && i.priority !== 'P2' },
];

/** «Сроки»: шкала от «просрочено» до +4 часов, инциденты — точками (цвет и размер — важность). Видно, что горит следующим. */
export function DeadlinesBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  const all = [...new Map([...snap.action.map((x) => x.inc), ...snap.work].filter((i) => i.status !== 'resolved').map((i) => [i.id, i])).values()];
  const overdue = all.filter((i) => i.slaDeadline <= now);
  const soon = all.filter((i) => i.slaDeadline > now && i.slaDeadline - now <= SPAN);
  const later = all.length - overdue.length - soon.length;
  const score = new Map(snap.action.map((x) => [x.inc.id, x.att.score]));
  const next = [...soon].sort((a, b) => a.slaDeadline - b.slaDeadline)[0];
  return (
    <div className="db db-dl">
      <BlockHead title="Сроки" icon={<Timer size={17} />} right={later > 0 ? <span className="dl-later">позже: {later}</span> : undefined} />
      <div className="dl-body">
        <div className={`dl-over ${overdue.length ? 'on' : ''}`} title={overdue.map((i) => i.title).join('\n') || 'Просроченных нет'}>
          <b className="num">{overdue.length}</b>
          <small>просрочено</small>
        </div>
        <div className="dl-chart">
          {LANES.map((l) => (
            <div key={l.id} className={`dl-lane l-${l.id}`}>
              <span className="dl-lname">{l.name}</span>
              <div className="dl-track">
                {soon.filter(l.test).map((i) => (
                  <button
                    key={i.id}
                    className={`dl-dot p-${i.priority}`}
                    data-heat={heatFor(i, score.get(i.id) ?? 0)}
                    style={{ left: `${pos(i.slaDeadline - now)}%` }}
                    title={`${i.title}\nдо срока ${fmtShort(i.slaDeadline - now)}`}
                    onClick={() => ctx.open(i)}
                    aria-label={i.title}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="dl-ticks">
            <span style={{ left: '0%' }}>сейчас</span>
            {TICKS.map((t) => (
              <span key={t.t} style={{ left: `${pos(t.at)}%` }}>
                {t.t}
              </span>
            ))}
          </div>
        </div>
      </div>
      {next && (
        <button className="dl-next" onClick={() => ctx.open(next)} title={next.title}>
          <Timer size={13} /> следующий срок — через {fmtShort(next.slaDeadline - now)}: <b>{next.title}</b>
        </button>
      )}
    </div>
  );
}
