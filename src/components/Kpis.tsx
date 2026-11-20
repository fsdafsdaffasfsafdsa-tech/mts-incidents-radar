import { useMemo } from 'react';
import { AT_RISK_MIN } from '../../shared/types';
import { setState, useStore, type QueueFilter } from '../store';
import { useBump, useNow, useTween } from '../lib/hooks';
import { Sparkline } from './bits';

interface Tile {
  id: string;
  label: string;
  value: number;
  sub: string;
  tone: 'neutral' | 'p1' | 'warn' | 'coord' | 'ok' | 'breach';
  series?: number[];
  filter?: QueueFilter;
}

export function Kpis() {
  const incidents = useStore((s) => s.incidents);
  const stats = useStore((s) => s.stats);
  const filter = useStore((s) => s.filter);
  const now = useNow(5000);

  const c = useMemo(() => {
    let open = 0, p1 = 0, p2 = 0, risk = 0, breach = 0, coord = 0, coordNew = 0;
    for (const i of incidents.values()) {
      if (i.status === 'resolved') continue;
      open++;
      if (i.priority === 'P1') p1++;
      if (i.priority === 'P2') p2++;
      const r = i.slaDeadline - now;
      if (r <= 0) breach++;
      else if (r <= AT_RISK_MIN * 60_000) risk++;
      if (i.status === 'coordinators') {
        coord++;
        if (!i.acknowledged) coordNew++;
      }
    }
    return { open, p1, p2, risk, breach, coord, coordNew };
  }, [incidents, now]);

  const series = stats?.series ?? [];
  const tiles: Tile[] = [
    { id: 'open', label: 'Открыто', value: c.open, sub: stats ? `+${stats.createdLastHour} за час` : '—', tone: 'neutral', series: [...series.map((x) => x.open), c.open], filter: 'open' },
    { id: 'crit', label: 'Критичные P1 + P2', value: c.p1 + c.p2, sub: `P1: ${c.p1} · P2: ${c.p2}`, tone: 'p1', series: [...series.map((x) => x.critical), c.p1 + c.p2], filter: 'critical' },
    { id: 'risk', label: `SLA истекает < ${AT_RISK_MIN} мин`, value: c.risk, sub: 'нужно ускорить', tone: 'warn', series: [...series.map((x) => x.atRisk), c.risk], filter: 'risk' },
    { id: 'breach', label: 'SLA нарушен', value: c.breach, sub: stats ? `+${stats.breachedLastHour} за час` : '—', tone: 'breach', filter: 'breach' },
    { id: 'coord', label: 'На координаторах', value: c.coord, sub: c.coordNew ? `${c.coordNew} не просмотрены` : 'все просмотрены', tone: 'coord', filter: 'coordinators' },
    { id: 'done', label: 'Решено за час', value: stats?.resolvedLastHour ?? 0, sub: stats?.mttrMinutes != null ? `среднее время решения ${stats.mttrMinutes} мин` : '—', tone: 'ok', filter: 'resolved' },
  ];

  return (
    <section className="kpis" aria-label="Сводка">
      {tiles.map((t) => (
        <KpiTile key={t.id} t={t} active={filter === t.filter} />
      ))}
    </section>
  );
}

function KpiTile({ t, active }: { t: Tile; active: boolean }) {
  const shown = useTween(t.value);
  const bump = useBump(t.value);
  return (
    <button
      className={`kpi tone-${t.tone} ${active ? 'active' : ''}`}
      onClick={() => t.filter && setState({ filter: active ? 'open' : t.filter })}
      title="Показать в очереди"
    >
      <span key={bump} className={bump ? 'kpi-flash' : ''} aria-hidden />
      <span className="kpi-label">{t.label}</span>
      <span className="kpi-value num">{shown}</span>
      <span className="kpi-sub">{t.sub}</span>
      {t.series && <Sparkline values={t.series.slice(-40)} />}
    </button>
  );
}
