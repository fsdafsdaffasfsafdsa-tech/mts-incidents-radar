// Общие элементы экранов пункта и команд: смена, график, команда, график жалоб, уровни.
import type { Incident, Person, Team } from '../../shared/types';
import { SCHEDULE_TEXT, dutySlots, fmtTz, nextChange, onDuty, shiftLabel } from '../../shared/schedule';
import { fmtClock } from '../lib/format';
import { Initials } from './ui';

export const isOn = (p: Person, now: number) => !p.away && onDuty(p.schedule, p.crew, p.tz, now);

export const ROLE_TEXT: Record<Person['role'], string> = {
  coordinator: 'дежурный пункта',
  commander: 'командир смены',
  engineer: 'инженер',
  lead: 'руководитель',
};

export function Duty({ on, away }: { on: boolean; away?: boolean }) {
  return <span className={`duty ${away ? 'away' : on ? 'on' : 'off'}`}>{away ? 'отошёл' : on ? 'на смене' : 'не на смене'}</span>;
}

/** Когда начнётся или закончится смена — «до 20:00» / «с 08:00». */
export function shiftHint(p: Person, now: number) {
  const on = isOn(p, now);
  const t = nextChange(p.schedule, p.crew, p.tz, now);
  return on ? `до ${fmtClock(t)}` : `с ${fmtDay(t, now)}`;
}

function fmtDay(t: number, now: number) {
  const d = new Date(t);
  const same = new Date(now).toDateString() === d.toDateString();
  const tomorrow = new Date(now + 86_400_000).toDateString() === d.toDateString();
  return `${same ? '' : tomorrow ? 'завтра ' : `${d.toLocaleDateString('ru-RU', { weekday: 'short' })} `}${fmtClock(t)}`;
}

/** Полоса на сутки вперёд: закрашено — на смене. */
export function ScheduleStrip({ p, now, hours = 24 }: { p: Pick<Person, 'schedule' | 'crew' | 'tz'>; now: number; hours?: number }) {
  const slots = dutySlots(p.schedule, p.crew, p.tz, now, hours);
  return (
    <span className="strip" title={`${shiftLabel(p.schedule, p.crew)} · местное время ${fmtTz(p.tz)}`}>
      {slots.map((on, i) => (
        <i key={i} className={on ? 'on' : ''} />
      ))}
    </span>
  );
}

export function PersonRow({ p, now, right, onClick, active }: { p: Person; now: number; right?: React.ReactNode; onClick?: () => void; active?: boolean }) {
  const on = isOn(p, now);
  return (
    <div className={`person ${on ? '' : 'dim'} ${active ? 'sel' : ''}`} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={(e) => onClick && e.key === 'Enter' && onClick()}>
      <Initials name={p.name} />
      <span className="person-main">
        <b>{p.name}</b>
        <span className="muted">
          {ROLE_TEXT[p.role]}
          {p.spec ? ` · ${p.spec}` : ''} · {shiftLabel(p.schedule, p.crew)}
        </span>
        <ScheduleStrip p={p} now={now} />
      </span>
      <span className="person-side">
        <Duty on={on} away={p.away} />
        <span className="muted">{shiftHint(p, now)}</span>
        {right}
      </span>
    </div>
  );
}

export function TeamLine({ t, onDutyCount, load, now }: { t: Team; onDutyCount?: number; load?: number; now: number }) {
  void now;
  return (
    <span className="teamline">
      <b>{t.name}</b>
      <span className="muted">
        {t.direction} · {SCHEDULE_TEXT[t.schedule]} · {fmtTz(t.tz)}
        {onDutyCount !== undefined && ` · на смене ${onDutyCount}`}
        {load ? ` · в работе ${load}` : ''}
      </span>
    </span>
  );
}

/** Жалобы по 5 минут за последний час. */
export function Spark({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values);
  const w = width / values.length;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Жалобы за час по 5 минут">
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * (height - 2));
        return <rect key={i} x={i * w + 1} y={height - h} width={w - 2} height={h} rx={1.5} className={i === values.length - 1 ? 'last' : ''} />;
      })}
    </svg>
  );
}

export function LevelLog({ inc }: { inc: Incident }) {
  const log = inc.levelLog ?? [];
  if (!log.length) return null;
  return (
    <ol className="levels">
      {log.map((l, i) => (
        <li key={i} className={l.auto ? 'auto' : 'hand'}>
          <span className="num">{fmtClock(l.at)}</span>
          <span>
            {l.from === l.to ? 'Создан' : `${l.from} → ${l.to}`} · {l.reason}
          </span>
          <span className="muted">{l.auto ? 'ИИ' : 'дежурный'}</span>
        </li>
      ))}
    </ol>
  );
}

export const STATUS_TEXT: Record<Incident['status'], string> = {
  coordinators: 'на пункте',
  assigned: 'передан команде',
  in_progress: 'в работе',
  escalated: 'эскалирован',
  resolved: 'решён',
};
