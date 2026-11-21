// Блок «Сроки» на стене — матрица риска четырьмя плитками: «горит», «важно, время есть», «мелкое, но срочно»,
// «спокойно». Срочно — до срока меньше 4 часов (или уже просрочен); серьёзно — по приоритету и числу жалоб.
// У плитки заголовок со словом и числом, под ним точки-инциденты цвета приоритета: внутри плитки правее — больше
// времени до срока, выше — серьёзнее. По всем открытым инцидентам (на пункте и у команд). Кнопок нет —
// подробности по щелчку на точку (для мыши) или голосом у Джарвиса.
import { useRef } from 'react';
import { CheckCircle2, Clock, Flame, Hourglass, Timer, type LucideIcon } from 'lucide-react';
import type { Incident, Priority } from '../../../shared/types';
import { BlockHead, type BlockCtx } from './Dashboard';
import { HOUR, cd, isStuck, xOf } from './scale';
import { useFlip } from './anim';

const URGENT = 4 * HOUR; // меньше — срочно
const IMPACT: Record<Priority, number> = { P1: 0.85, P2: 0.6, P3: 0.35, P4: 0.12 };
/** Серьёзность 0…100: приоритет и немного — число жалоб. */
const impactOf = (i: Incident) => (IMPACT[i.priority] + Math.min(0.12, (i.complaints ?? 0) / 800)) * 100;
/** Разнести близкие точки по вертикали, чтобы не слипались. */
const jitter = (id: string) => (([...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) % 9) - 4) * 1.6;

type Q = 'hot' | 'imp' | 'urg' | 'calm';
const Q_META: Record<Q, { word: string; icon: LucideIcon; cls: string }> = {
  hot: { word: 'горит', icon: Flame, cls: 'z-hot' },
  imp: { word: 'важно, время есть', icon: Clock, cls: 'z-ok' },
  urg: { word: 'мелкое, но срочно', icon: Hourglass, cls: 'z-warn' },
  calm: { word: 'спокойно', icon: CheckCircle2, cls: 'z-calm' },
};
const Q_ORDER: Q[] = ['hot', 'imp', 'urg', 'calm'];

export function DeadlinesBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  const all = [...new Map([...snap.action.map((x) => x.inc), ...snap.work].filter((i) => i.status !== 'resolved').map((i) => [i.id, i])).values()];
  const H4 = xOf(URGENT);
  const byQ: Record<Q, { i: Incident; x: number; y: number }[]> = { hot: [], imp: [], urg: [], calm: [] };
  for (const i of all) {
    const x = xOf(i.slaDeadline - now);
    const y = impactOf(i);
    const urgent = i.slaDeadline - now < URGENT;
    byQ[urgent ? (y >= 50 ? 'hot' : 'urg') : y >= 50 ? 'imp' : 'calm'].push({ i, x, y });
  }
  // место точки внутри своей плитки: по горизонтали — время до срока, по вертикали — серьёзность
  const local = (p: { i: Incident; x: number; y: number }, q: Q): React.CSSProperties => {
    const left = q === 'hot' || q === 'urg' ? (p.x / H4) * 100 : ((p.x - H4) / (100 - H4)) * 100;
    const bottom = (q === 'hot' || q === 'imp' ? ((p.y - 50) / 50) * 100 : (p.y / 50) * 100) + jitter(p.i.id);
    return { left: `${Math.max(6, Math.min(94, left))}%`, bottom: `${Math.max(12, Math.min(86, bottom))}%`, ['--sz' as string]: p.i.priority === 'P1' ? 1.3 : 1 };
  };
  const tiles = useRef<HTMLDivElement>(null);
  useFlip(tiles); // в плитке стало больше — вспышка цвета плитки
  return (
    <div className="db db-dl">
      <BlockHead title="Сроки" icon={<Timer size={18} />} />
      <div className="mx-tiles" ref={tiles}>
        {Q_ORDER.map((q) => {
          const M = Q_META[q];
          return (
            <div key={q} data-flip={q} data-level={byQ[q].length} className={`mx-tile ${M.cls} ${byQ[q].length ? 'on' : ''}`} title={byQ[q].map((p) => p.i.title).join('\n') || 'нет'}>
              <span className="mx-th">
                <M.icon />
                {M.word}
                <b className="num" key={byQ[q].length}>
                  {byQ[q].length}
                </b>
              </span>
              <div className="mx-tf">
                {byQ[q].map((p) => (
                  <div key={p.i.id} role="button" tabIndex={0} className={`dp-dot p-${p.i.priority} ${isStuck(p.i, now) ? 'stuck' : ''} ${p.i.slaDeadline <= now ? 'over' : ''}`} style={local(p, q)} onClick={() => ctx.open(p.i)} title={`${p.i.title} · ${p.i.slaDeadline <= now ? 'просрочен на' : 'до срока'} ${cd(p.i.slaDeadline - now).replace('−', '')}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
