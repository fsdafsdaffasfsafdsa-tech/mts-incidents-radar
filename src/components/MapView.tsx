// Главный экран: карта во весь экран и только самое нужное поверх неё.
import { useMemo } from 'react';
import { ArrowRight, Navigation, Sparkles } from 'lucide-react';
import { AT_RISK_MIN } from '../../shared/types';
import { select, setState, setView, teamName, useStore, type QueueFilter } from '../store';
import { matches, useQueue } from '../lib/queue';
import { fmtAgo } from '../lib/format';
import { useNow, useTween } from '../lib/hooks';
import { MapCanvas } from './MapCanvas';
import { IncidentSheet } from './IncidentSheet';
import { Prio, SlaTimer } from './bits';
import { SysIcon } from './SysIcon';

export function MapView({ onRouting }: { onRouting?: () => void }) {
  const selectedId = useStore((s) => s.selectedId);
  return (
    <div className={`map-view ${selectedId ? 'has-sheet' : ''}`}>
      <MapCanvas />
      <FilterPills />
      <UrgentPanel onRouting={onRouting} />
      <Ticker />
      <Legend />
      {selectedId && (
        <div className="sheet-float">
          <IncidentSheet />
        </div>
      )}
    </div>
  );
}

const PILLS: { id: QueueFilter; label: string; tone: string }[] = [
  { id: 'open', label: 'Все', tone: 'neutral' },
  { id: 'critical', label: 'P1–P2', tone: 'p1' },
  { id: 'risk', label: `SLA < ${AT_RISK_MIN} мин`, tone: 'warn' },
  { id: 'breach', label: 'SLA нарушен', tone: 'breach' },
  { id: 'coordinators', label: 'На координаторах', tone: 'coord' },
];

function FilterPills() {
  const incidents = useStore((s) => s.incidents);
  const attention = useStore((s) => s.attention);
  const filter = useStore((s) => s.filter);
  const now = useNow(5000);
  const counts = useMemo(() => {
    const att = new Set(attention);
    const out: Record<string, number> = {};
    for (const p of PILLS) out[p.id] = 0;
    for (const i of incidents.values()) for (const p of PILLS) if (matches(i, p.id, att, now)) out[p.id]++;
    return out;
  }, [incidents, attention, now]);
  return (
    <div className="pills" role="tablist" aria-label="Что показывать на карте">
      {PILLS.map((p) => (
        <Pill key={p.id} label={p.label} tone={p.tone} value={counts[p.id]} on={filter === p.id} onClick={() => setState({ filter: p.id })} />
      ))}
    </div>
  );
}

function Pill({ label, tone, value, on, onClick }: { label: string; tone: string; value: number; on: boolean; onClick: () => void }) {
  const shown = useTween(value);
  return (
    <button role="tab" aria-selected={on} className={`pill-f tone-${tone} ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="pf-value num">{shown}</span>
      <span className="pf-label">{label}</span>
    </button>
  );
}

function UrgentPanel({ onRouting }: { onRouting?: () => void }) {
  const queue = useQueue();
  const selectedId = useStore((s) => s.selectedId);
  const hoverId = useStore((s) => s.hoverId);
  const attention = useStore((s) => s.attention);
  const coordCount = useStore((s) => [...s.incidents.values()].filter((i) => i.onCoordinators && i.status !== 'resolved').length);
  const open = queue.filter((i) => i.status !== 'resolved');
  const top = open.slice(0, 7);
  const att = new Set(attention);

  return (
    <aside className="float-panel urgent" aria-label="Требуют решения">
      <header className="fp-head">
        <h2>Требуют решения</h2>
        <span className="muted">по срочности</span>
      </header>
      <div className="urgent-list">
        {top.map((inc) => (
          <button
            key={inc.id}
            className={`u-card p-${inc.priority} ${inc.id === selectedId ? 'selected' : ''} ${inc.id === hoverId ? 'hovered' : ''}`}
            onClick={() => select(inc.id)}
            onMouseEnter={() => setState({ hoverId: inc.id })}
            onMouseLeave={() => setState({ hoverId: null })}
          >
            <span className="u-top">
              <Prio p={inc.priority} />
              <span className="u-sys">
                <SysIcon systemId={inc.systemId} size={13} /> {inc.region}
              </span>
              {att.has(inc.id) && <span className="attn-dot" title="Новое для вас" />}
              <span className="grow" />
              <SlaTimer inc={inc} />
            </span>
            <span className="u-title">{inc.title}</span>
            <span className="u-who">
              {inc.onCoordinators ? (
                inc.ai.teamId && (
                  <span className="ai-suggest">
                    <Sparkles size={11} /> ИИ советует: {teamName(inc.ai.teamId)} · <span className="num">{Math.round(inc.ai.confidence * 100)}%</span>
                  </span>
                )
              ) : (
                <span className="u-team">
                  {teamName(inc.teamId)} · {inc.assignee ?? 'ждёт исполнителя'}
                </span>
              )}
              {inc.crew && (
                <span className="u-crew">
                  <Navigation size={11} /> {inc.crew.arrived ? 'бригада на месте' : 'бригада в пути'}
                </span>
              )}
            </span>
          </button>
        ))}
        {top.length === 0 && <div className="empty">По этому фильтру ничего нет</div>}
      </div>
      <footer className="fp-foot">
        <button className="btn btn-sm" onClick={() => setView('queue')}>
          Вся очередь <span className="num">{open.length}</span> <ArrowRight size={14} />
        </button>
        {onRouting && coordCount > 0 && (
          <button className="btn btn-sm btn-ai" onClick={onRouting}>
            <Sparkles size={14} /> Разобрать с ИИ <span className="num">{coordCount}</span>
          </button>
        )}
      </footer>
    </aside>
  );
}

function Ticker() {
  const feed = useStore((s) => s.feed);
  const now = useNow(5000);
  const items = feed.filter((e) => e.kind !== 'created' && e.kind !== 'in_progress').slice(0, 3);
  return (
    <button className="float-panel ticker" onClick={() => setView('feed')} title="Открыть ленту событий">
      <span className="ticker-head">
        <span className="live-dot" /> Лента событий <ArrowRight size={13} />
      </span>
      {items.map((e) => (
        <span key={e.id} className={`tk-item k-${e.kind}`}>
          <span className={`prio-text p-${e.priority}`}>{e.priority}</span>
          <span className="tk-text">{e.text}</span>
          <span className="tk-ago">{fmtAgo(now - e.at)}</span>
        </span>
      ))}
    </button>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="lg-dot P1" /> P1
      </span>
      <span>
        <i className="lg-dot P2" /> P2
      </span>
      <span>
        <i className="lg-dot P3" /> P3
      </span>
      <span>
        <i className="lg-dot P4" /> P4
      </span>
      <span>
        <i className="lg-ring" /> на координаторах
      </span>
      <span>
        <Navigation size={12} className="lg-crew" /> бригада
      </span>
    </div>
  );
}
