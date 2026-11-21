// Мелкие общие элементы центров и кабинетов.
import { useState } from 'react';
import { Settings2, X, ChevronUp, ChevronDown, Inbox, type LucideIcon } from 'lucide-react';
import type { Incident, Priority, Worker } from '../../shared/types';
import { fmtDur, fmtSla } from '../lib/format';
import { useNow } from '../lib/hooks';
import { METRICS, metricById, type MetricCtx, type MetricScope } from '../lib/metrics';

export function PrioDot({ p, text }: { p: Priority; text?: string }) {
  return (
    <span className={`pdot p-${p}`} title={text}>
      <i />
      {text && <span>{text}</span>}
    </span>
  );
}

export function Deadline({ inc, big = false }: { inc: Incident; big?: boolean }) {
  const now = useNow(1000);
  if (inc.status === 'resolved') return <span className={`dl dl-done ${big ? 'big' : ''}`}>решено</span>;
  const left = inc.slaDeadline - now;
  const cls = left <= 0 ? 'dl-over' : left <= 10 * 60_000 ? 'dl-risk' : left <= 30 * 60_000 ? 'dl-soon' : 'dl-ok';
  return <span className={`dl ${cls} num ${big ? 'big' : ''}`}>{left > 3_600_000 ? fmtDur(left) : fmtSla(left)}</span>;
}

export function Elapsed({ from, to }: { from: number; to?: number | null }) {
  const now = useNow(1000);
  return <span className="num">{fmtDur((to ?? now) - from)}</span>;
}

const STATUS_TEXT: Record<Worker['status'], string> = {
  free: 'свободен',
  busy: 'работает',
  break: 'перерыв',
  enroute: 'в пути',
  onsite: 'на месте',
};

export function WorkerStatus({ w }: { w: Worker }) {
  return (
    <span className={`wstat ws-${w.status}`}>
      <i />
      {STATUS_TEXT[w.status]}
    </span>
  );
}

export function Initials({ name }: { name: string }) {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  const ini = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ ['--h' as string]: h }} aria-hidden>
      {ini}
    </span>
  );
}

/** Кольцевая диаграмма: сегменты по долям, число в центре. */
export function Donut({ parts, label }: { parts: { name: string; value: number; color: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = 34;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <figure className="donut">
      <svg viewBox="0 0 90 90" aria-label={label}>
        <circle cx="45" cy="45" r={r} className="donut-track" />
        {total > 0 &&
          parts.map((p) => {
            const len = (p.value / total) * c;
            const el = (
              <circle
                key={p.name}
                cx="45"
                cy="45"
                r={r}
                fill="none"
                stroke={p.color}
                strokeWidth="11"
                strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`}
                strokeDashoffset={-acc}
                transform="rotate(-90 45 45)"
              />
            );
            acc += len;
            return el;
          })}
        <text x="45" y="50" textAnchor="middle" className="donut-total num">
          {total}
        </text>
      </svg>
      <figcaption>
        <b>{label}</b>
        {parts.map((p) => (
          <span key={p.name}>
            <i style={{ background: p.color }} />
            {p.name} <em className="num">{p.value}</em>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Плитки метрик, которые человек выбирает сам (кнопка ⚙). */
export function MetricTiles({ ids, ctx, scope, onChange }: { ids: string[]; ctx: MetricCtx; scope: MetricScope; onChange: (ids: string[]) => void }) {
  const [edit, setEdit] = useState(false);
  return (
    <div className="mtiles">
      <div className="mtiles-grid">
        {ids
          .map((id) => metricById(id))
          .filter(Boolean)
          .map((m) => (
            <div key={m!.id} className={`mtile tone-${m!.tone}`}>
              <span className="mt-val num">{m!.compute(ctx)}</span>
              <span className="mt-lbl">{m!.label}</span>
            </div>
          ))}
        <button className="mtile mtile-add" onClick={() => setEdit(true)} title="Выбрать метрики">
          <Settings2 size={16} />
          <span className="mt-lbl">Метрики</span>
        </button>
      </div>
      {edit && <MetricPicker ids={ids} scope={scope} onClose={() => setEdit(false)} onChange={onChange} />}
    </div>
  );
}

function MetricPicker({ ids, scope, onClose, onChange }: { ids: string[]; scope: MetricScope; onClose: () => void; onChange: (ids: string[]) => void }) {
  const avail = METRICS.filter((m) => m.scope === scope || (scope === 'worker' && m.scope === 'center' && m.id === 'resolvedHour'));
  const move = (id: string, d: -1 | 1) => {
    const k = ids.indexOf(id);
    const j = k + d;
    if (k < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[k], next[j]] = [next[j], next[k]];
    onChange(next);
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm" role="dialog" aria-label="Мои метрики">
        <header className="modal-head">
          <div>
            <h2>Мои метрики</h2>
            <p>Отметьте нужные и расставьте порядок.</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <ul className="picker">
          {[...ids.map((id) => avail.find((m) => m.id === id)).filter(Boolean), ...avail.filter((m) => !ids.includes(m.id))].map((m) => {
            const on = ids.includes(m!.id);
            return (
              <li key={m!.id} className={on ? 'on' : ''}>
                <label>
                  <input type="checkbox" checked={on} onChange={() => onChange(on ? ids.filter((x) => x !== m!.id) : [...ids, m!.id])} />
                  <i className={`tone-dot tone-${m!.tone}`} />
                  {m!.label}
                </label>
                {on && (
                  <span className="picker-move">
                    <button className="icon-btn" onClick={() => move(m!.id, -1)} aria-label="Выше">
                      <ChevronUp size={15} />
                    </button>
                    <button className="icon-btn" onClick={() => move(m!.id, 1)} aria-label="Ниже">
                      <ChevronDown size={15} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export const PRIO_COLORS: Record<Priority, string> = {
  P1: 'var(--p1)',
  P2: 'var(--p2)',
  P3: 'var(--p3)',
  P4: 'var(--p4)',
};

/** Пустой экран: значок, что здесь будет и что сделать. */
export function Empty({ icon: Icon = Inbox, title, hint, action, small }: { icon?: LucideIcon; title: string; hint?: string; action?: { label: string; run: () => void }; small?: boolean }) {
  return (
    <div className={`empty-state ${small ? 'sm' : ''}`}>
      <span className="es-ico">
        <Icon size={small ? 20 : 26} />
      </span>
      <b>{title}</b>
      {hint && <span className="es-hint">{hint}</span>}
      {action && (
        <button className="btn btn-sm" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
