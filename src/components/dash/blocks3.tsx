// «Взять сейчас» (вариант 4д) и «Сроки». На большом экране кнопок нет — действует Джарвис голосом;
// дежурный на смене один, поэтому «кто ведёт» на пункте не показываем.
// «Взять сейчас»: две шкалы — срок и масштаб (жалобы), сервис, крупное время, шаги «пункт → команда → решено»
// и вопрос Джарвиса. «Сроки» — радар: зона просрочки с числом, три дорожки, точки (тесные — кластером).
import { useRef } from 'react';
import { CheckCircle2, Clock, Inbox, Mic, RotateCcw, Target, Users, type LucideIcon } from 'lucide-react';
import type { Incident } from '../../../shared/types';
import { complaintsWord, heatFor } from '../../../shared/attention';
import { teamName, useStore } from '../../store';
import { BlockHead, Ring, Why, frac, type BlockCtx } from './Dashboard';
import { TeamAvatar, oneLine, serviceIcon, shortPlace, splitTitle } from './wall2';
import { useFlip } from './anim';

const MIN = 60_000;

/** Одно главное действие — то, что дежурный сделал бы сейчас. */
/** Что спросит Джарвис — вместо кнопки: дежурный отвечает голосом. */
function jarvisQuestion(i: Incident, now: number): string {
  if (i.status === 'resolved' && i.recur) return '«Вернуть в работу?»';
  if (i.p1Proposal && i.priority !== 'P1') return '«Поднять до наивысшего?»';
  if (i.status === 'coordinators') return i.ai?.teamId ? `«Передать в «${teamName(i.ai.teamId).split(' · ')[0]}»?»` : '«Подобрать команду?»';
  if (i.status === 'assigned' && !i.assignee) return '«Напомнить команде?»';
  if (i.slaDeadline - now < 30 * MIN) return '«Уточнить у команды срок?»';
  return '«Что будем делать?»';
}

/** Масштаб по жалобам: доля от порога «Наивысшего» за окно и как меняется. */
function scaleOf(i: Incident, p1Threshold: number) {
  if (i.status === 'resolved' && i.recur) return { fill: Math.min(1, i.recur.count / Math.max(10, p1Threshold / 4)), n: i.recur.count, trend: 'up' as const, label: `снова ${i.recur.count} ${complaintsWord(i.recur.count)}` };
  const ser = i.complaintsSeries ?? [];
  if (i.origin !== 'complaints' || !ser.length) return null;
  const n30 = ser.slice(-6).reduce((a, b) => a + b, 0);
  const last = ser.slice(-3).reduce((a, b) => a + b, 0);
  const prev = ser.slice(-6, -3).reduce((a, b) => a + b, 0);
  const trend = last > prev * 1.2 ? ('up' as const) : last < prev * 0.8 ? ('down' as const) : ('flat' as const);
  const total = i.complaints ?? n30;
  return { fill: Math.min(1, n30 / Math.max(1, p1Threshold)), n: total, trend, label: `${total} ${complaintsWord(total)}${trend === 'up' ? ', растёт' : trend === 'down' ? ', спадает' : ''}` };
}

export function timerText(left: number) {
  const a = Math.abs(left);
  const h = Math.floor(a / 3_600_000);
  const m = Math.floor((a % 3_600_000) / MIN);
  const s = Math.floor((a % MIN) / 1000);
  const t = h >= 48 ? `${Math.floor(h / 24)} дн` : h > 0 ? `${h} ч ${String(m).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return left < 0 ? `−${t}` : t;
}

/** Где инцидент сейчас: 0 — на пункте, 1 — у команды, 2 — решён. */
/** Где инцидент сейчас: 0 — на пункте, 1 — у команды, 2 — решён. */
const STEPS: { icon: LucideIcon; name: string }[] = [
  { icon: Inbox, name: 'Пункт' },
  { icon: Users, name: 'Команда' },
  { icon: CheckCircle2, name: 'Решено' },
];

/** «Взять сейчас», вариант 4д: шкала срока и шкала масштаба, сервис, время, шаги и вопрос Джарвиса. Без кнопок. */
export function NowBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  const next = useRef<HTMLDivElement>(null);
  useFlip(next); // очередь «следующие» переезжает плавно, новый въезжает
  const p1Threshold = useStore((s) => s.config?.rules.p1 ?? 120);
  // сначала то, что ждёт решения дежурного; потом — остальное по срочности
  const mine = (i: Incident) => i.status === 'coordinators' || i.status === 'resolved' || (!!i.p1Proposal && i.priority !== 'P1');
  const order = [...snap.action.filter((x) => mine(x.inc)), ...snap.action.filter((x) => !mine(x.inc))];
  const top = order[0];
  if (!top)
    return (
      <div className="db db-now calm">
        <BlockHead title="Взять сейчас" icon={<Target size={18} />} />
        <div className="dn-calm">
          <CheckCircle2 />
        </div>
      </div>
    );
  const i = top.inc;
  const Icon = serviceIcon(i);
  const { name, place } = splitTitle(i);
  const left = i.slaDeadline - now;
  const recur = i.status === 'resolved' && i.recur ? i.recur : null;
  const tone = recur || left <= 0 ? 'over' : left < 30 * MIN ? 'hot' : left < 2 * 60 * MIN ? 'warm' : 'ok';
  const timeFill = recur || left <= 0 ? 1 : frac(i, now);
  const scale = scaleOf(i, p1Threshold);
  const step = i.status === 'coordinators' ? 0 : i.status === 'resolved' ? 2 : 1;
  const waitTeam = i.status === 'assigned' && !i.assignee;
  return (
    <div className="db db-now" data-heat={heatFor(i, top.att.score)}>
      <BlockHead title="Взять сейчас" icon={<Target size={18} />} right={<Why att={top.att} />} />
      <div key={i.id} data-inc={i.id} className={`dn-card dn4 p-${i.priority}`} onClick={() => ctx.open(i)} title={`${i.title}\n${i.productName || i.service}`}>
        <span className="dn4-scales">
          <span className={`dn4-scale t-${tone}`} title={recur ? 'решён, но жалобы снова' : left > 0 ? `прошло ${Math.round(timeFill * 100)}% времени до срока` : 'срок прошёл'}>
            <span className="dn4-bar">
              <i style={{ height: `${Math.round(timeFill * 100)}%` }} />
            </span>
            <Clock />
          </span>
          <span className={`dn4-scale s-${scale ? scale.trend : 'none'}`} title={scale ? `жалобы: ${scale.label}` : 'по этому инциденту жалоб абонентов нет'}>
            <span className="dn4-bar">
              <i style={{ height: `${Math.round((scale?.fill ?? 0) * 100)}%` }} />
            </span>
            <Users />
          </span>
        </span>
        <span className="dn4-main">
          <span className="dn4-title">
            <Icon className="dn4-ic" />
            <b className="dn-title">{name}</b>
          </span>
          {place && <span className="dn4-place">{shortPlace(place)}</span>}
          <span className={`dn4-time t-${tone}`}>
            {recur ? (
              <>
                <RotateCcw /> решён
              </>
            ) : (
              <b className="num">{timerText(left)}</b>
            )}
          </span>
          {scale && <span className={`dn4-scaletext s-${scale.trend}`}>{scale.label}</span>}
          <span className={`dn3-steps dn4-steps at-${step} ${recur ? 'bad' : ''} ${waitTeam ? 'wait' : ''}`} aria-label={`Сейчас: ${STEPS[step].name}`}>
            {STEPS.map((x, k) => {
              const SI = recur && k === 2 ? RotateCcw : x.icon;
              return (
                <span key={x.name} className="dn3-stepwrap">
                  {k > 0 && (
                    <span className="dn3-line">
                      <i style={{ width: step >= k ? '100%' : '0%' }} />
                    </span>
                  )}
                  <span className={`dn3-step ${k < step ? 'done' : k === step ? 'now' : 'todo'}`} title={x.name}>
                    <SI />
                  </span>
                </span>
              );
            })}
          </span>
          {i.status !== 'coordinators' && i.teamId && !recur && (
            <span className={`dn4-team ${waitTeam ? 'warn' : ''}`}>
              <TeamAvatar i={i} /> {teamName(i.teamId).split(' · ')[0]}
              {i.assigneeName ? ` · ${i.assigneeName.split(' ')[0]}` : ' · ещё не взяли'}
            </span>
          )}
        </span>
      </div>
      <div className="dn4-jv" title="Ответьте голосом — Джарвис сделает">
        <span className="dn4-mic">
          <Mic />
        </span>
        <b>{jarvisQuestion(i, now)}</b>
      </div>
      <div className="dn-next" ref={next}>
        {order.slice(1, 4).map((x) => {
          const NI = serviceIcon(x.inc);
          return (
            <div key={x.inc.id} data-flip={x.inc.id} data-level={heatFor(x.inc, x.att.score)} className={`dn-row dn3-row p-${x.inc.priority}`} data-heat={heatFor(x.inc, x.att.score)} onClick={() => ctx.open(x.inc)} title={x.inc.title}>
              <NI className="dn-row-ic" />
              <b>{oneLine(x.inc)}</b>
              {x.inc.status === 'resolved' && x.inc.recur ? (
                <span className="dring t-over">
                  <RotateCcw size={12} />
                </span>
              ) : (
                <Ring i={x.inc} now={now} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
