// Отдельные экраны: полная очередь, системы и команды, лента событий.
import { useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import type { Priority } from '../../shared/types';
import { setState, setView, useStore } from '../store';
import { plural } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Queue } from './Queue';
import { Feed } from './Feed';
import { Kpis } from './Kpis';
import { IncidentSheet } from './IncidentSheet';
import { SysIcon } from './SysIcon';

function WithSheet({ children, className }: { children: React.ReactNode; className: string }) {
  const selectedId = useStore((s) => s.selectedId);
  return (
    <div className={`page ${className} ${selectedId ? 'with-sheet' : ''}`}>
      <div className="page-main">{children}</div>
      {selectedId && (
        <div className="sheet-col">
          <IncidentSheet />
        </div>
      )}
    </div>
  );
}

export function QueueView({ onRouting, searchRef }: { onRouting: () => void; searchRef: React.RefObject<HTMLInputElement> }) {
  return (
    <WithSheet className="queue-page">
      <Queue onRouting={onRouting} searchRef={searchRef} />
    </WithSheet>
  );
}

export function FeedView() {
  return (
    <WithSheet className="feed-page">
      <Feed />
    </WithSheet>
  );
}

const PRIOS: Priority[] = ['P1', 'P2', 'P3', 'P4'];

export function SystemsView() {
  const systems = useStore((s) => s.systems);
  const teams = useStore((s) => s.teams);
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);

  const bySystem = useMemo(() => {
    const m = new Map<string, { P1: number; P2: number; P3: number; P4: number; total: number; coord: number; breach: number; worst: string | null }>();
    for (const s of systems) m.set(s.id, { P1: 0, P2: 0, P3: 0, P4: 0, total: 0, coord: 0, breach: 0, worst: null });
    const sorted = [...incidents.values()].filter((i) => i.status !== 'resolved').sort((a, b) => a.priority.localeCompare(b.priority) || a.slaDeadline - b.slaDeadline);
    for (const i of sorted) {
      const r = m.get(i.systemId);
      if (!r) continue;
      r[i.priority]++;
      r.total++;
      if (i.status === 'coordinators') r.coord++;
      if (i.slaDeadline <= now) r.breach++;
      if (!r.worst) r.worst = i.title;
    }
    return m;
  }, [systems, incidents, now]);

  const teamLoad = useMemo(() => {
    const load = new Map<string, { open: number; p12: number }>();
    for (const i of incidents.values()) {
      if (i.status === 'resolved' || !i.teamId) continue;
      const r = load.get(i.teamId) ?? { open: 0, p12: 0 };
      r.open++;
      if (i.priority <= 'P2') r.p12++;
      load.set(i.teamId, r);
    }
    return teams
      .filter((t) => !t.isCoordinators)
      .map((t) => ({ team: t, ...(load.get(t.id) ?? { open: 0, p12: 0 }) }))
      .sort((a, b) => b.open - a.open);
  }, [teams, incidents]);
  const maxLoad = Math.max(1, ...teamLoad.map((t) => t.open));

  const openQueue = (systemId: string) => {
    setState({ systemFilter: systemId, filter: 'open' });
    setView('queue');
  };

  return (
    <div className="page systems-page">
      <section className="sp-section">
        <h2 className="sp-title">Сводка смены</h2>
        <Kpis />
      </section>
      <div className="sp-grid">
        <section className="sp-section">
          <h2 className="sp-title">Системы</h2>
          <div className="sys-grid">
            {systems.map((s) => {
              const r = bySystem.get(s.id)!;
              const worst = PRIOS.find((p) => r[p] > 0) ?? 'none';
              return (
                <button key={s.id} className={`sys-card worst-${worst}`} onClick={() => openQueue(s.id)}>
                  <span className="sc-head">
                    <span className="sc-icon">
                      <SysIcon systemId={s.id} size={18} />
                    </span>
                    <span className="sc-name">{s.name}</span>
                    <ArrowRight size={14} className="sc-go" />
                  </span>
                  <span className="sc-nums">
                    <span className="sc-total num">{r.total}</span>
                    <span className="sc-sub">{plural(r.total, 'открытый', 'открытых', 'открытых')}</span>
                    {r.P1 > 0 && <span className="sc-tag t-p1 num">P1 · {r.P1}</span>}
                    {r.P2 > 0 && <span className="sc-tag t-p2 num">P2 · {r.P2}</span>}
                    {r.breach > 0 && <span className="sc-tag t-breach num">SLA · {r.breach}</span>}
                  </span>
                  <span className="sys-bar" aria-hidden>
                    {PRIOS.map((p) => (r[p] ? <span key={p} className={`seg-${p}`} style={{ flexGrow: r[p] }} /> : null))}
                  </span>
                  <span className="sc-worst">{r.worst ?? 'Всё спокойно'}</span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="sp-section">
          <h2 className="sp-title">Загрузка команд</h2>
          <div className="team-load">
            {teamLoad.map(({ team, open, p12 }) => (
              <div key={team.id} className="tl-row">
                <span className="tl-name">{team.name}</span>
                <span className="tl-bar">
                  <span className="tl-all" style={{ width: `${(open / maxLoad) * 100}%` }} />
                  <span className="tl-crit" style={{ width: `${(p12 / maxLoad) * 100}%` }} />
                </span>
                <span className="tl-num num">{open}</span>
              </div>
            ))}
            <p className="tl-legend">
              <i className="tl-crit-dot" /> из них P1–P2
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
