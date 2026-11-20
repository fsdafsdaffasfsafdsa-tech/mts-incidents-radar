import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Search, Sparkles, X } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { AT_RISK_MIN } from '../../shared/types';
import { select, setState, teamName, useStore, type QueueFilter } from '../store';
import { matches, useQueue } from '../lib/queue';
import { fmtAgo, plural } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Prio, RiskPill, SlaTimer } from './bits';
import { SysIcon } from './SysIcon';

const FILTERS: { id: QueueFilter; label: string }[] = [
  { id: 'open', label: 'Все' },
  { id: 'attention', label: 'Внимание' },
  { id: 'coordinators', label: 'Координаторы' },
  { id: 'critical', label: 'P1–P2' },
  { id: 'risk', label: `SLA < ${AT_RISK_MIN}′` },
  { id: 'breach', label: 'Нарушен' },
  { id: 'resolved', label: 'Решённые' },
];

const PAGE = 80;

export function Queue({ onRouting, searchRef }: { onRouting: () => void; searchRef: React.RefObject<HTMLInputElement> }) {
  const list = useQueue();
  const filter = useStore((s) => s.filter);
  const search = useStore((s) => s.search);
  const systemFilter = useStore((s) => s.systemFilter);
  const systems = useStore((s) => s.systems);
  const selectedId = useStore((s) => s.selectedId);
  const attention = useStore((s) => s.attention);
  const incidents = useStore((s) => s.incidents);
  const [limit, setLimit] = useState(PAGE);
  const now = useNow(10_000);
  const scroller = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const att = new Set(attention);
    const out = {} as Record<QueueFilter, number>;
    for (const f of FILTERS) out[f.id] = 0;
    for (const i of incidents.values()) for (const f of FILTERS) if (matches(i, f.id, att, now)) out[f.id]++;
    return out;
  }, [incidents, attention, now]);

  useEffect(() => setLimit(PAGE), [filter, systemFilter, search]);

  // Держим выбранную строку в поле зрения при навигации с клавиатуры.
  useEffect(() => {
    if (!selectedId || !scroller.current) return;
    const el = scroller.current.querySelector<HTMLElement>(`[data-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const att = useMemo(() => new Set(attention), [attention]);
  const sysName = systems.find((s) => s.id === systemFilter)?.short;

  return (
    <section className="panel queue" aria-label="Очередь инцидентов">
      <div className="panel-head">
        <h2>
          Очередь <span className="muted num">{list.length}</span>
        </h2>
        <span className="hint">по срочности: приоритет, SLA, ИИ-риск</span>
        <div className="grow" />
        {counts.coordinators > 0 && (
          <button className="btn btn-ai" onClick={onRouting} title="ИИ предложит команду для каждого инцидента на координаторах">
            <Sparkles size={15} />
            Разобрать с ИИ <span className="num">{counts.coordinators}</span>
          </button>
        )}
      </div>

      <div className="queue-tools">
        <div className="chips" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={`chip chip-${f.id} ${filter === f.id ? 'on' : ''}`}
              onClick={() => setState({ filter: f.id })}
            >
              {f.label} <span className="num">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={15} />
          <input
            ref={searchRef}
            value={search}
            placeholder="Поиск: INC, система, регион, команда  ( / )"
            onChange={(e) => setState({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setState({ search: '' });
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {search && (
            <button className="icon-btn" onClick={() => setState({ search: '' })} aria-label="Очистить поиск">
              <X size={14} />
            </button>
          )}
        </div>
        {sysName && (
          <button className="chip on chip-sys" onClick={() => setState({ systemFilter: null })}>
            Система: {sysName} <X size={12} />
          </button>
        )}
      </div>

      <div className="queue-list" ref={scroller}>
        {list.length === 0 && <div className="empty">Здесь пусто. {filter !== 'open' ? 'Попробуйте фильтр «Все открытые».' : ''}</div>}
        {list.slice(0, limit).map((inc) => (
          <Row key={inc.id} inc={inc} selected={inc.id === selectedId} attention={att.has(inc.id)} />
        ))}
        {list.length > limit && (
          <button className="more" onClick={() => setLimit((l) => l + PAGE)}>
            Показать ещё {Math.min(PAGE, list.length - limit)} из {list.length - limit}
          </button>
        )}
      </div>
    </section>
  );
}

const Row = memo(function Row({ inc, selected, attention }: { inc: Incident; selected: boolean; attention: boolean }) {
  const system = useStore((s) => s.systems.find((x) => x.id === inc.systemId));
  const fresh = useStore((s) => s.fresh.get(inc.id));
  const now = useNow(30_000);
  const isFresh = fresh !== undefined && Date.now() - fresh < 6000;
  const related = inc.relatedIds.length;

  return (
    <button
      data-id={inc.id}
      className={`row p-${inc.priority} st-${inc.status} ${selected ? 'selected' : ''} ${isFresh ? 'fresh' : ''} ${attention ? 'attn' : ''} ${!inc.acknowledged && inc.status !== 'resolved' ? 'unack' : ''}`}
      onClick={() => select(inc.id)}
    >
      <span className="row-bar" aria-hidden />
      <Prio p={inc.priority} />
      <span className="row-main">
        <span className="row-title">
          {attention && <span className="attn-dot" title="Требует внимания" />}
          <span className="row-title-text">{inc.title}</span>
          {related > 0 && (
            <span className="badge-link" title={`${related} ${plural(related, 'связанный инцидент', 'связанных инцидента', 'связанных инцидентов')}`}>
              <Link2 size={12} />
              {related}
            </span>
          )}
        </span>
        <span className="row-meta">
          <span className="row-sys">
            <SysIcon systemId={inc.systemId} size={13} />
            {system?.short}
          </span>
          <span className="sep">›</span>
          <span>{inc.service}</span>
          <span className="sep">·</span>
          <span>{inc.region}</span>
          <span className="sep">·</span>
          <span className="num">{inc.id}</span>
          <span className="sep">·</span>
          <span>{fmtAgo(now - inc.createdAt)}</span>
        </span>
      </span>
      <span className="row-who">
        {inc.status === 'coordinators' ? (
          <>
            <span className="pill pill-coord">Координаторы</span>
            {inc.ai.teamId && (
              <span className="ai-suggest" title="Подсказка ИИ">
                <Sparkles size={11} /> {teamName(inc.ai.teamId)} <span className="num">{Math.round(inc.ai.confidence * 100)}%</span>
              </span>
            )}
          </>
        ) : inc.status === 'resolved' ? (
          <>
            <span className="who-team">{teamName(inc.teamId)}</span>
            <span className="who-sub ok">решён</span>
          </>
        ) : (
          <>
            <span className="who-team">{teamName(inc.teamId)}</span>
            <span className={`who-sub ${inc.assignee ? '' : 'warn'}`}>
              {inc.status === 'escalated' ? `эскалирован · ${inc.assignee ?? ''}` : inc.assignee ?? 'ждёт исполнителя'}
            </span>
          </>
        )}
      </span>
      <RiskPill risk={inc.ai.risk} level={inc.ai.level} />
      <SlaTimer inc={inc} />
    </button>
  );
});
