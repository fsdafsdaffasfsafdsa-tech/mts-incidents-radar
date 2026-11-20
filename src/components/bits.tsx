import type { Incident, Priority, RiskLevel } from '../../shared/types';
import { fmtSla, slaState } from '../lib/format';
import { useNow } from '../lib/hooks';

export function Prio({ p, size = 'sm' }: { p: Priority; size?: 'sm' | 'lg' }) {
  return <span className={`prio prio-${p} prio-${size}`}>{p}</span>;
}

export function SlaTimer({ inc, big = false }: { inc: Incident; big?: boolean }) {
  const now = useNow(1000);
  const st = slaState(inc, now);
  const total = inc.slaDeadline - inc.createdAt;
  const left = inc.slaDeadline - now;
  const frac = inc.status === 'resolved' ? 1 : Math.min(1, Math.max(0, 1 - left / total));
  return (
    <div className={`sla sla-${st} ${big ? 'sla-big' : ''}`}>
      <span className="sla-time num">{st === 'done' ? 'решён' : fmtSla(left)}</span>
      <span className="sla-bar" aria-hidden>
        <span style={{ width: `${frac * 100}%` }} />
      </span>
    </div>
  );
}

export function RiskPill({ risk, level }: { risk: number; level: RiskLevel }) {
  return (
    <span className={`risk risk-${level}`} title={`ИИ-риск эскалации: ${risk}%`}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
        <circle cx="10" cy="10" r="8" className="risk-track" />
        <circle
          cx="10"
          cy="10"
          r="8"
          className="risk-arc"
          strokeDasharray={`${(risk / 100) * 50.3} 50.3`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className="num">{risk}</span>
    </span>
  );
}

export function Sparkline({ values, className = '' }: { values: number[]; className?: string }) {
  if (values.length < 2) return <svg className={`spark ${className}`} viewBox="0 0 100 28" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 25 - ((v - min) / span) * 20] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg className={`spark ${className}`} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L100,28 L0,28 Z`} className="spark-fill" />
      <path d={d} className="spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="1.6" className="spark-dot" />
    </svg>
  );
}

export function Avatar({ name }: { name: string }) {
  const parts = name.replace('.', '').split(' ').filter(Boolean);
  const initials = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ ['--h' as string]: h }} aria-hidden>
      {initials}
    </span>
  );
}
