import { Copy, GitMerge, Link2, Repeat2, Wrench } from 'lucide-react';
import type { Incident, Priority, RiskLevel } from '../../shared/types';
import { PRIO_LABEL, fmtSla, slaState } from '../lib/format';
import { useNow } from '../lib/hooks';

export function Prio({ p, size = 'sm' }: { p: Priority; size?: 'sm' | 'lg' }) {
  return (
    <span className={`prio prio-${p} prio-${size}`} title={`Приоритет: ${PRIO_LABEL[p]}`}>
      {p}
    </span>
  );
}

export function SlaTimer({ inc, big = false }: { inc: Incident; big?: boolean }) {
  const now = useNow(1000);
  const st = slaState(inc, now);
  if (st === 'done' || st === 'none') {
    const text = st === 'none' ? 'без срока' : inc.status === 'research' ? 'разбор' : 'решён';
    return (
      <div className={`sla sla-${st === 'none' ? 'ok' : 'done'} ${inc.status === 'research' ? 'sla-research' : ''} ${big ? 'sla-big' : ''}`}>
        <span className="sla-time">{text}</span>
        <span className="sla-bar" aria-hidden>
          <span style={{ width: st === 'none' ? '0%' : '100%' }} />
        </span>
      </div>
    );
  }
  const total = Math.max(1, inc.slaDeadline! - inc.createdAt);
  const left = inc.slaDeadline! - now;
  const frac = Math.min(1, Math.max(0, 1 - left / total));
  return (
    <div className={`sla sla-${st} ${big ? 'sla-big' : ''}`} title="До дедлайна">
      <span className="sla-time num">{fmtSla(left)}</span>
      <span className="sla-bar" aria-hidden>
        <span style={{ width: `${frac * 100}%` }} />
      </span>
    </div>
  );
}

/** Признаки связей из выгрузки: мастер, дубль, причина, дочерний, нужно устранить последствия. */
export function Flags({ inc }: { inc: Incident }) {
  return (
    <>
      {inc.isMaster && (
        <span className="flag" title="Мастер-инцидент: к нему привязаны дубли">
          <GitMerge size={11} /> мастер
        </span>
      )}
      {inc.isDouble && (
        <span className="flag" title="Дубль: инцидент с такой причиной уже зарегистрирован">
          <Copy size={11} /> дубль
        </span>
      )}
      {inc.isEffect && (
        <span className="flag" title="Является причиной дочерних инцидентов">
          <Link2 size={11} /> причина
        </span>
      )}
      {inc.isReason && (
        <span className="flag" title="Дочерний инцидент">
          <Repeat2 size={11} /> дочерний
        </span>
      )}
      {inc.isNeedUp && (
        <span className="flag warn" title="После решения нужно устранить последствия">
          <Wrench size={11} /> последствия
        </span>
      )}
    </>
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
  const parts = name.replace(/\(.*?\)/g, '').replace('.', '').split(' ').filter(Boolean);
  const initials = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ ['--h' as string]: h }} aria-hidden>
      {initials}
    </span>
  );
}
