// Свой блок от ChatGPT — красиво и по данным всего пункта, а не одноцветные полоски из двух строк:
//   bars  — полосы во всю высоту блока, цвет по уровню (или своим цветом на категорию), число крупно;
//   donut — кольцо: доли по группировке, итог крупно в центре, легенда;
//   hours — столбики по часам за период, слоями по уровню;
//   counter / list / note — как раньше.
// Данные — все инциденты пункта (за период — и решённые), а не только то, что стоит в других блоках.
import { useMemo } from 'react';
import { NotebookPen, Sparkles } from 'lucide-react';
import type { Incident, Priority } from '../../../shared/types';
import { applyFilter, periodStart, type CustomSpec } from '../../../shared/dashCustom';
import { teamName, useStore } from '../../store';
import { BlockHead, PRIO, type BlockCtx } from './Dashboard';

const PRIO_COLOR: Record<Priority, string> = { P1: 'var(--d-crit)', P2: 'var(--d-high)', P3: 'var(--d-warn)', P4: 'var(--d-accent)' };
const STATUS_NAME: Record<string, string> = { coordinators: 'на пункте', assigned: 'у команды', in_progress: 'в работе', escalated: 'эскалирован', resolved: 'решён' };
const STATUS_COLOR: Record<string, string> = { coordinators: 'var(--d-high)', assigned: 'var(--d-warn)', in_progress: 'var(--jv, #4e8cff)', escalated: 'var(--d-crit)', resolved: 'var(--d-ok)' };
// своя палитра для команд и сервисов — различимые, не «всё красное»
const PALETTE = ['#4e8cff', '#3ecf8e', '#ffb547', '#ff5269', '#b07cff', '#2ec5d3', '#f2d16b', '#ff8a5b'];
const PERIOD_NAME = { today: 'сегодня', hour: 'за час', shift: 'за смену' } as const;

type Row = { key: string; label: string; n: number; color: string };

function rowsOf(list: Incident[], spec: CustomSpec): Row[] {
  const by = spec.groupBy ?? (spec.kind === 'donut' ? 'priority' : 'team');
  const m = new Map<string, Row>();
  for (const i of list) {
    const key = by === 'priority' ? i.priority : by === 'status' ? i.status : by === 'team' ? i.teamId ?? '—' : by === 'service' ? i.service : i.productName || i.service;
    const label = by === 'priority' ? PRIO[i.priority] : by === 'status' ? STATUS_NAME[i.status] ?? i.stateText : by === 'team' ? (i.teamId ? teamName(i.teamId) : 'на пункте') : key;
    const cur = m.get(key) ?? { key, label, n: 0, color: '' };
    cur.n++;
    m.set(key, cur);
  }
  const order = { P1: 0, P2: 1, P3: 2, P4: 3 } as Record<string, number>;
  const rows = [...m.values()].sort((a, b) => (by === 'priority' ? order[a.key] - order[b.key] : b.n - a.n)).slice(0, spec.limit ?? 8);
  rows.forEach((r, k) => (r.color = by === 'priority' ? PRIO_COLOR[r.key as Priority] : by === 'status' ? STATUS_COLOR[r.key] ?? PALETTE[k % PALETTE.length] : PALETTE[k % PALETTE.length]));
  return rows;
}

export function CustomViz({ ctx, spec }: { ctx: BlockCtx; spec: CustomSpec }) {
  const incidents = useStore((s) => s.incidents);
  const list = useMemo(() => {
    const f = applyFilter(incidents.values(), spec.filter, ctx.now, (id) => teamName(id));
    const sortBy = spec.sort ?? 'deadline';
    const rank = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
    return f.sort((a, b) => (sortBy === 'priority' ? rank[a.priority] - rank[b.priority] : sortBy === 'created' ? b.createdAt - a.createdAt : sortBy === 'complaints' ? (b.complaints ?? 0) - (a.complaints ?? 0) : a.slaDeadline - b.slaDeadline));
  }, [incidents, ctx.now, spec]);
  const period = spec.filter?.period;
  const head = <BlockHead title={spec.title} count={list.length || undefined} icon={<Sparkles size={16} />} right={period ? <small className="cv-period">{PERIOD_NAME[period]}</small> : undefined} />;

  if (spec.kind === 'note')
    return (
      <div className="db db-note">
        <BlockHead title={spec.title} icon={<NotebookPen size={18} />} />
        <p>{spec.note}</p>
      </div>
    );
  if (spec.kind === 'counter')
    return (
      <div className="db db-bigcount" title={spec.hint}>
        <b className="num">{list.length}</b>
        <span>{spec.title}</span>
      </div>
    );
  if (!list.length && spec.kind !== 'list')
    return (
      <div className="db cv" title={spec.hint}>
        {head}
        <div className="cv-empty">пока пусто{period ? ` ${PERIOD_NAME[period]}` : ''}</div>
      </div>
    );

  if (spec.kind === 'donut') {
    const rows = rowsOf(list, spec);
    const total = rows.reduce((s, r) => s + r.n, 0);
    const R = 40;
    const C = 2 * Math.PI * R;
    let acc = 0;
    return (
      <div className="db cv cv-donut" title={spec.hint}>
        {head}
        <div className="cv-donut-body">
          <svg viewBox="0 0 100 100" className="cv-ring" role="img" aria-label={spec.title}>
            <circle cx="50" cy="50" r={R} fill="none" stroke="var(--d-line)" strokeWidth="13" />
            {rows.map((r) => {
              const len = (r.n / total) * C;
              const el = <circle key={r.key} cx="50" cy="50" r={R} fill="none" stroke={r.color} strokeWidth="13" strokeDasharray={`${Math.max(0, len - 1.2)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 50 50)" className="cv-seg" />;
              acc += len;
              return el;
            })}
            <text x="50" y="49" textAnchor="middle" className="cv-total num">{total}</text>
            <text x="50" y="62" textAnchor="middle" className="cv-total-sub">всего</text>
          </svg>
          <ul className="cv-legend">
            {rows.map((r) => (
              <li key={r.key}>
                <i style={{ background: r.color }} />
                <span>{r.label}</span>
                <b className="num">{r.n}</b>
                <small className="num">{Math.round((r.n / total) * 100)}%</small>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (spec.kind === 'hours') {
    const from = periodStart(period ?? 'today', ctx.now);
    const H = 3_600_000;
    const start = Math.floor(from / H) * H;
    const n = Math.max(1, Math.min(24, Math.ceil((ctx.now - start) / H)));
    const cols = Array.from({ length: n }, (_, k) => ({ at: start + k * H, by: { P1: 0, P2: 0, P3: 0, P4: 0 } as Record<Priority, number> }));
    for (const i of list) {
      const k = Math.floor((i.createdAt - start) / H);
      if (k >= 0 && k < n) cols[k].by[i.priority]++;
    }
    const max = Math.max(1, ...cols.map((c) => c.by.P1 + c.by.P2 + c.by.P3 + c.by.P4));
    return (
      <div className="db cv cv-hours" title={spec.hint}>
        {head}
        <div className="cv-cols">
          {cols.map((c) => {
            const sum = c.by.P1 + c.by.P2 + c.by.P3 + c.by.P4;
            return (
              <div key={c.at} className="cv-col" title={`${new Date(c.at).getHours()}:00 — ${sum}`}>
                <div className="cv-stack" style={{ height: `${(sum / max) * 100}%` }}>
                  {(['P4', 'P3', 'P2', 'P1'] as Priority[]).map((p) => (c.by[p] ? <i key={p} style={{ flexGrow: c.by[p], background: PRIO_COLOR[p] }} /> : null))}
                </div>
                {sum > 0 && <b className="num">{sum}</b>}
                <small className="num">{new Date(c.at).getHours()}</small>
              </div>
            );
          })}
        </div>
        <div className="cv-keys">
          {(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((p) => (
            <span key={p}>
              <i style={{ background: PRIO_COLOR[p] }} />
              {PRIO[p]}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (spec.kind === 'bars') {
    const rows = rowsOf(list, spec);
    const max = Math.max(1, ...rows.map((r) => r.n));
    return (
      <div className="db cv cv-bars" title={spec.hint}>
        {head}
        <div className="cv-rows">
          {rows.map((r) => (
            <div key={r.key} className="cv-row">
              <span className="cv-label">{r.label}</span>
              <span className="cv-track">
                <i style={{ width: `${Math.max(4, (r.n / max) * 100)}%`, background: r.color }} />
              </span>
              <b className="num" style={{ color: r.color }}>
                {r.n}
              </b>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null; // list — старая отрисовка (CustomBlock)
}
