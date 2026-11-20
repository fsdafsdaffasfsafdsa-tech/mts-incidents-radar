// Главный экран: актуальная картина по четырём группам ТЗ. Инцидент может стоять сразу в нескольких колонках.
import { useMemo } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { select, setState, setView, teamName, useStore, type QueueFilter } from '../store';
import { GROUPS, matches, sortByUrgency } from '../lib/queue';
import { useNow } from '../lib/hooks';
import { Kpis } from './Kpis';
import { IncidentSheet } from './IncidentSheet';
import { Flags, Prio, SlaTimer } from './bits';

export function Board() {
  const selectedId = useStore((s) => s.selectedId);
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);

  const columns = useMemo(() => {
    const none = new Set<string>();
    return GROUPS.map((g) => ({ ...g, items: sortByUrgency([...incidents.values()].filter((i) => matches(i, g.id, none, now)), now) }));
  }, [incidents, now]);

  return (
    <div className={`page board-page ${selectedId ? 'with-sheet' : ''}`}>
      <div className="page-main board-main">
        <Kpis />
        <div className="board">
          {columns.map((c) => (
            <section key={c.id} className={`board-col tone-${c.tone}`} aria-label={c.label}>
              <header className="bc-head">
                <h2>{c.label}</h2>
                <span className="bc-count num">{c.items.length}</span>
                <button className="bc-all" onClick={() => openQueue(c.id)} title="Открыть в очереди">
                  все
                </button>
              </header>
              <p className="bc-hint">{c.hint}</p>
              <div className="bc-list">
                {c.items.map((inc) => (
                  <IncidentCard key={inc.id} inc={inc} selected={inc.id === selectedId} />
                ))}
                {c.items.length === 0 && <div className="empty">{EMPTY[c.id]}</div>}
              </div>
            </section>
          ))}
        </div>
      </div>
      {selectedId && (
        <div className="sheet-col">
          <IncidentSheet />
        </div>
      )}
    </div>
  );
}

const EMPTY: Record<string, string> = {
  critical: 'Критических инцидентов нет',
  coordinators: 'На координаторах пусто',
  high: 'Нет инцидентов с высоким приоритетом',
  research: 'Нет инцидентов на исследовании',
};

function openQueue(filter: QueueFilter) {
  setState({ filter, systemFilter: null, search: '' });
  setView('queue');
}

/** Карточка инцидента: приоритет, продукт, срок, заголовок, кто решает. */
export function IncidentCard({ inc, selected }: { inc: Incident; selected: boolean }) {
  const hoverId = useStore((s) => s.hoverId);
  const attention = useStore((s) => s.attention.includes(inc.id));
  const fresh = useStore((s) => s.fresh.get(inc.id));
  const isFresh = fresh !== undefined && Date.now() - fresh < 6000;
  const resolved = inc.status === 'resolved';
  return (
    <button
      className={`u-card p-${inc.priority} st-${inc.status} ${selected ? 'selected' : ''} ${inc.id === hoverId ? 'hovered' : ''} ${isFresh ? 'fresh' : ''} ${resolved ? 'done' : ''}`}
      onClick={() => select(inc.id)}
      onMouseEnter={() => setState({ hoverId: inc.id })}
      onMouseLeave={() => setState({ hoverId: null })}
    >
      <span className="u-top">
        <Prio p={inc.priority} />
        <span className="u-sys">{inc.product}</span>
        {attention && <span className="attn-dot" title="Новое для вас" />}
        <span className="grow" />
        {resolved ? (
          <span className="u-done">
            <CheckCircle2 size={13} /> решён
          </span>
        ) : (
          <SlaTimer inc={inc} />
        )}
      </span>
      <span className="u-title">{inc.title}</span>
      <span className="u-who">
        {inc.onCoordinators && !resolved ? (
          <>
            <span className="pill pill-coord">Координаторы</span>
            {inc.ai.teamId && (
              <span className="ai-suggest">
                <Sparkles size={11} /> {teamName(inc.ai.teamId)} · <span className="num">{Math.round(inc.ai.confidence * 100)}%</span>
              </span>
            )}
          </>
        ) : (
          <span className="u-team">
            {teamName(inc.teamId)} · {inc.state.toLowerCase()}
          </span>
        )}
        <Flags inc={inc} />
      </span>
    </button>
  );
}
