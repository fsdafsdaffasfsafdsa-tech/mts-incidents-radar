// Блок «Команды» на стене — отсчёт полосами: у самых загруженных команд по три ближайших срока.
// Полоса — от «сейчас» до срока: чем короче, тем сильнее горит; просроченные — красной полосой влево.
// Цвет — приоритет инцидента. Шкала растянута у «сейчас» (сейчас · 1ч · 4ч · 1д · 3д · 7д): сроки бывают
// и через час, и через неделю. Полосы укорачиваются в реальном времени. Кнопок нет — подробности по щелчку
// на полосу (для мыши) или голосом у Джарвиса.
import { CheckCircle2, Users } from 'lucide-react';
import type { Incident, Priority } from '../../../shared/types';
import { teamName } from '../../store';
import { BlockHead, type BlockCtx } from './Dashboard';
import { TeamAvatar } from './wall2';
import { NOW_X, TICKS, cd, isStuck, xOf } from './scale';

const WEIGHT: Record<Priority, number> = { P1: 8, P2: 4, P3: 2, P4: 1 };
const TEAMS = 3; // сколько команд помещается в блок
const BARS = 3; // и сколько сроков у каждой

type Team = { id: string; list: Incident[]; score: number };
/** Команды по тяжести: приоритеты, не взятые и просроченные; у каждой — инциденты по сроку. */
function teamsOf(work: Incident[], now: number): Team[] {
  const m = new Map<string, Incident[]>();
  for (const i of work) if (i.teamId) m.set(i.teamId, [...(m.get(i.teamId) ?? []), i]);
  return [...m.entries()]
    .map(([id, list]) => ({
      id,
      list: [...list].sort((a, b) => a.slaDeadline - b.slaDeadline),
      score: list.reduce((s, i) => s + WEIGHT[i.priority] + (isStuck(i, now) ? 3 : 0) + (i.slaDeadline < now ? 3 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);
}

export function TeamLoadBlock({ ctx }: { ctx: BlockCtx }) {
  const { now } = ctx;
  const teams = teamsOf(ctx.snap.work, now).slice(0, TEAMS);
  return (
    <div className="db db-tl">
      <BlockHead title="Команды" count={ctx.snap.work.length} icon={<Users size={18} />} />
      {teams.length ? (
        <div className="tm-rows">
          {teams.map((t) => (
            <div key={t.id} className="tm-row" title={teamName(t.id)}>
              <span className="tm-who">
                <TeamAvatar i={t.list[0]} />
                <b>{teamName(t.id).split(' · ')[0]}</b>
              </span>
              <span className="tm-bars">
                <i className="tm-now" />
                {t.list.slice(0, BARS).map((i) => {
                  const left = i.slaDeadline - now;
                  const x = xOf(left);
                  return (
                    <span key={i.id} role="button" tabIndex={0} className={`tm-cd p-${i.priority} ${left < 0 ? 'over' : ''} ${isStuck(i, now) ? 'stuck' : ''}`} onClick={() => ctx.open(i)} title={`${i.title} · ${left < 0 ? 'просрочен на' : 'до срока'} ${cd(left).replace('−', '')}`}>
                      <i style={left < 0 ? { left: 0, width: `${NOW_X}%` } : { left: `${NOW_X}%`, width: `${x - NOW_X}%` }} />
                      <b className="num" style={{ left: `${left < 0 ? NOW_X : x}%` }}>
                        {cd(left)}
                      </b>
                    </span>
                  );
                })}
                {t.list.length > BARS && <small className="num tm-more">+{t.list.length - BARS}</small>}
              </span>
            </div>
          ))}
          <div className="tm-row tm-axis" aria-hidden>
            <span />
            <span className="tm-axis-s">
              {TICKS.map(([tx, at]) => (
                <small key={tx} style={{ left: `${xOf(at)}%` }}>
                  {tx}
                </small>
              ))}
            </span>
          </div>
        </div>
      ) : (
        <CheckCircle2 className="tl-calm" />
      )}
    </div>
  );
}
