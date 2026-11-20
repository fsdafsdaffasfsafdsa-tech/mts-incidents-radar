// Онлайн- и офлайн-центр: список проблем, карточка, метрики и сотрудники.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Navigation, Sparkles, UserPlus } from 'lucide-react';
import type { Incident, Worker, WorkMode } from '../../shared/types';
import { act, loadInsight, readLocal, select, useStore, writeLocal } from '../store';
import { urgency, fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { DEFAULT_CENTER_METRICS, type MetricCtx } from '../lib/metrics';
import { Deadline, Donut, Elapsed, Initials, MetricTiles, PRIO_COLORS, PrioDot, WorkerStatus } from './ui';
import { MapCanvas } from './MapCanvas';

type Tab = 'new' | 'work' | 'done';

function useScope(mode: WorkMode) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);
  return useMemo(() => {
    const all = [...incidents.values()].filter((i) => i.mode === mode);
    const by = (l: Incident[]) => l.sort((a, b) => urgency(b, now) - urgency(a, now));
    return {
      all,
      new: by(all.filter((i) => i.status === 'coordinators')),
      work: by(all.filter((i) => i.status === 'assigned' || i.status === 'in_progress' || i.status === 'escalated')),
      done: all.filter((i) => i.status === 'resolved').sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
    };
  }, [incidents, mode, now]);
}

export function OnlineCenter() {
  const scope = useScope('online');
  const selectedId = useStore((s) => s.selectedId);
  const sel = useStore((s) => (s.selectedId ? s.incidents.get(s.selectedId) : undefined));
  const fallback = scope.new[0] ?? scope.work[0];
  useEffect(() => {
    if (!selectedId && fallback) select(fallback.id);
  }, [selectedId, fallback]);
  return (
    <div className="center c-online">
      <ProblemList scope={scope} mode="online" />
      {sel && sel.mode === 'online' ? <ProblemDetail inc={sel} /> : <section className="panel empty-panel">Выберите проблему слева</section>}
      <CenterMetrics scope={scope.all} mode="online" />
    </div>
  );
}

export function OfflineCenter() {
  const scope = useScope('offline');
  return (
    <div className="center c-offline">
      <div className="map-col">
        <MapCanvas filter={(i) => i.mode === 'offline' && i.status !== 'resolved'} showOffices />
        <div className="legend legend-in">
          <span>
            <i className="lg-office">МТС</i> офис
          </span>
          <span>
            <i className="lg-dot P2" /> проблема
          </span>
          <span>
            <Navigation size={12} className="lg-crew" /> выездной
          </span>
        </div>
      </div>
      <ProblemList scope={scope} mode="offline" />
    </div>
  );
}

// ─── список проблем ────────────────────────────────────────────────────────

function ProblemList({ scope, mode }: { scope: ReturnType<typeof useScope>; mode: WorkMode }) {
  const [tab, setTab] = useState<Tab>(() => (scope.new.length ? 'new' : 'work'));
  const selectedId = useStore((s) => s.selectedId);
  const list = scope[tab];
  return (
    <section className="panel plist" aria-label="Проблемы">
      <header className="pl-head">
        <h2>{mode === 'online' ? 'Проблемы' : 'Выезды'}</h2>
        <div className="seg seg-sm">
          {(
            [
              ['new', 'Новые', scope.new.length],
              ['work', 'В работе', scope.work.length],
              ['done', 'Решены', scope.done.length],
            ] as const
          ).map(([id, label, n]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label} <span className="num">{n}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="pl-rows">
        {list.length === 0 && <div className="empty">Пусто</div>}
        {list.slice(0, 60).map((inc) =>
          mode === 'offline' && inc.id === selectedId ? <OfflineExpanded key={inc.id} inc={inc} /> : <Row key={inc.id} inc={inc} mode={mode} selected={inc.id === selectedId} />,
        )}
      </div>
    </section>
  );
}

function Row({ inc, mode, selected }: { inc: Incident; mode: WorkMode; selected: boolean }) {
  const fresh = useStore((s) => s.fresh.get(inc.id));
  const isFresh = fresh !== undefined && Date.now() - fresh < 6000;
  return (
    <div className={`prow p-${inc.priority} ${selected ? 'sel' : ''} ${isFresh ? 'fresh' : ''}`} role="button" tabIndex={0} onClick={() => select(inc.id)} onKeyDown={(e) => e.key === 'Enter' && select(inc.id)}>
      <PrioDot p={inc.priority} />
      <span className="pr-main">
        <span className="pr-title">{inc.title}</span>
        <span className="pr-meta">
          {inc.productName}
          {mode === 'offline' && ` · ${inc.region}`}
        </span>
      </span>
      <span className="pr-side">
        <Deadline inc={inc} />
        {inc.status === 'coordinators' ? (
          inc.takenAt ? (
            <span className="taken">взята</span>
          ) : (
            <button
              className="btn-take"
              onClick={(e) => {
                e.stopPropagation();
                select(inc.id);
                void act(inc.id, 'take');
              }}
            >
              Взять
            </button>
          )
        ) : inc.assigneeName ? (
          <span className="pr-who" title={inc.assigneeName}>
            <Initials name={inc.assigneeName} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ─── выбор сотрудника ──────────────────────────────────────────────────────

function useCandidates(inc: Incident) {
  const workers = useStore((s) => s.workers);
  const insight = useStore((s) => s.insights.get(inc.id));
  const incidents = useStore((s) => s.incidents);
  useEffect(() => {
    void loadInsight(inc.id);
  }, [inc.id, inc.status, inc.assignee]);
  const load = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of incidents.values()) if (i.status !== 'resolved' && i.assignee) m.set(i.assignee, (m.get(i.assignee) ?? 0) + 1);
    return m;
  }, [incidents]);
  const ranked = insight?.workers ?? [];
  const pool = workers.filter((w) => w.mode === inc.mode);
  const order = (w: Worker) => {
    const k = ranked.findIndex((r) => r.workerId === w.id);
    return k < 0 ? 100 + (load.get(w.id) ?? 0) : k;
  };
  return { list: [...pool].sort((a, b) => order(a) - order(b)), top: ranked[0], load, workers };
}

function AssignSelect({ inc, compact = false }: { inc: Incident; compact?: boolean }) {
  const { list, load } = useCandidates(inc);
  return (
    <label className={`assign ${compact ? 'compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      <UserPlus size={15} />
      <select value={inc.assignee ?? ''} onChange={(e) => e.target.value && void act(inc.id, 'assign', { workerId: e.target.value })}>
        <option value="">{compact ? 'Сотрудник' : 'Выбрать сотрудника'}</option>
        {list.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · {w.status === 'break' ? 'перерыв' : `${load.get(w.id) ?? 0} в работе`}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}

function AiPick({ inc }: { inc: Incident }) {
  const { top, workers } = useCandidates(inc);
  if (!top || inc.status === 'resolved') return null;
  const w = workers.find((x) => x.id === top.workerId);
  if (!w || inc.assignee === w.id) return null;
  return (
    <div className="aipick">
      <Sparkles size={15} />
      <span className="ap-name">{w.name}</span>
      <span className="ap-why">{top.reasons.slice(0, 2).join(' · ')}</span>
      <button className="btn btn-sm btn-ai" onClick={() => void act(inc.id, 'assign', { workerId: w.id })}>
        Назначить
      </button>
    </div>
  );
}

// ─── карточка (онлайн) ─────────────────────────────────────────────────────

function ProblemDetail({ inc }: { inc: Incident }) {
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [inc.id]);
  return (
    <section className={`panel pdetail p-${inc.priority}`} aria-label={inc.title}>
      <header className="pd-head">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className="pd-id num">{inc.id}</span>
        <span className={`chip-state st-${inc.status}`}>{inc.status === 'coordinators' ? 'Ждёт сотрудника' : inc.stateText}</span>
        {inc.isMaster && <span className="chip-mass">массовый</span>}
        {inc.isDouble && <span className="chip-dbl">дубль</span>}
      </header>
      <h1 className="pd-title">{inc.title}</h1>
      <div className="pd-where">
        {inc.productName} › {inc.service} · {inc.component}
      </div>

      <div className="tiles3">
        <div className="tile">
          <span className="t-lbl">Приоритет</span>
          <span className="t-val" style={{ color: PRIO_COLORS[inc.priority] }}>
            {inc.priorityText}
          </span>
          <span className="t-sub">
            влияние {inc.impact.toLowerCase()} · срочность {inc.urgency.toLowerCase()}
          </span>
        </div>
        <div className="tile">
          <span className="t-lbl">Время решения</span>
          <span className="t-val">
            <Elapsed from={inc.createdAt} to={inc.resolvedAt} />
          </span>
          <span className="t-sub">с {fmtClock(inc.createdAt)}</span>
        </div>
        <div className="tile">
          <span className="t-lbl">До дедлайна</span>
          <span className="t-val">
            <Deadline inc={inc} big />
          </span>
          <span className="t-sub">срок {fmtClock(inc.slaDeadline)}</span>
        </div>
      </div>

      {inc.status !== 'resolved' && (
        <>
          <AiPick inc={inc} />
          <div className="pd-actions">
            <AssignSelect inc={inc} />
            {inc.status === 'coordinators' && !inc.takenAt && (
              <button className="btn" onClick={() => void act(inc.id, 'take')}>
                Взять
              </button>
            )}
            <button className="btn btn-ok" onClick={() => void act(inc.id, 'resolve')}>
              <CheckCircle2 size={15} /> Решено
            </button>
          </div>
        </>
      )}
      {inc.assigneeName && (
        <div className="pd-who">
          <Initials name={inc.assigneeName} /> {inc.assigneeName} <span className="muted">· {inc.groupName}</span>
        </div>
      )}

      <button className="more-toggle" onClick={() => setMore((v) => !v)} aria-expanded={more}>
        Подробнее <ChevronDown size={14} className={more ? 'rot' : ''} />
      </button>
      {more && <Details inc={inc} />}
    </section>
  );
}

function Details({ inc }: { inc: Incident }) {
  return (
    <div className="pd-more">
      <p>{inc.description}</p>
      <dl className="kv">
        <dt>Канал</dt>
        <dd>{inc.channel}</dd>
        <dt>Тип сервиса</dt>
        <dd>{inc.serviceType}</dd>
        <dt>Группа</dt>
        <dd>{inc.groupName}</dd>
        {inc.solution && inc.status === 'resolved' && (
          <>
            <dt>Решение</dt>
            <dd>{inc.solution}</dd>
          </>
        )}
      </dl>
      <ol className="timeline">
        {[...inc.history].reverse().slice(0, 8).map((h, i) => (
          <li key={i}>
            <span className="tl-time num">{fmtClock(h.at)}</span>
            <span className="tl-text">{h.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── выезд: строка раскрывается прямо в списке ─────────────────────────────

function OfflineExpanded({ inc }: { inc: Incident }) {
  const now = useNow(1000);
  const crewLeft = inc.crew && !inc.crew.arrived ? Math.max(0, inc.crew.dispatchedAt + inc.crew.etaMs - now) : 0;
  return (
    <div className={`prow-exp p-${inc.priority}`}>
      <div className="pe-top">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className="pe-city">{inc.region}</span>
        <Deadline inc={inc} />
      </div>
      <div className="pe-title">{inc.title}</div>
      <div className="pe-where">
        {inc.productName} › {inc.service}
      </div>
      {inc.crew && (
        <div className={`pe-crew ${inc.crew.arrived ? 'ok' : ''}`}>
          <Navigation size={14} /> {inc.assigneeName}: {inc.crew.arrived ? 'на месте' : `в пути, ${Math.ceil(crewLeft / 60_000)} мин`}
        </div>
      )}
      {inc.status !== 'resolved' && (
        <>
          <AiPick inc={inc} />
          <div className="pe-actions">
            {inc.status === 'coordinators' && !inc.takenAt && (
              <button className="btn btn-sm" onClick={() => void act(inc.id, 'take')}>
                Взять
              </button>
            )}
            <AssignSelect inc={inc} compact />
          </div>
        </>
      )}
    </div>
  );
}

// ─── метрики центра ────────────────────────────────────────────────────────

function CenterMetrics({ scope, mode }: { scope: Incident[]; mode: WorkMode }) {
  const workers = useStore((s) => s.workers);
  const stats = useStore((s) => s.stats);
  const now = useNow(5000);
  const key = `radar.metrics.center.${mode}`;
  const [ids, setIds] = useState<string[]>(() => readLocal(key, DEFAULT_CENTER_METRICS));
  const pool = workers.filter((w) => w.mode === mode);
  const ctx: MetricCtx = { scope, mine: [], workers: pool, worker: null, stats, now };
  const open = scope.filter((i) => i.status !== 'resolved');
  const count = (f: (i: Incident) => boolean) => scope.filter(f).length;
  const per = (w: Worker) => {
    const mine = scope.filter((i) => i.assignee === w.id);
    return { taken: mine.filter((i) => i.status === 'assigned').length, work: mine.filter((i) => i.status === 'in_progress').length };
  };
  return (
    <aside className="panel cmetrics" aria-label="Метрики">
      <MetricTiles
        ids={ids}
        ctx={ctx}
        scope="center"
        onChange={(next) => {
          setIds(next);
          writeLocal(key, next);
        }}
      />
      <div className="donuts">
        <Donut
          label="Статусы"
          parts={[
            { name: 'Новые', value: count((i) => i.status === 'coordinators'), color: 'var(--coord)' },
            { name: 'Назначены', value: count((i) => i.status === 'assigned'), color: 'var(--p4)' },
            { name: 'В работе', value: count((i) => i.status === 'in_progress' || i.status === 'escalated'), color: 'var(--ai)' },
            { name: 'Решены', value: count((i) => i.status === 'resolved'), color: 'var(--ok)' },
          ]}
        />
        <Donut
          label="Приоритеты"
          parts={(['P1', 'P2', 'P3', 'P4'] as const).map((p) => ({
            name: ['Наивысший', 'Высокий', 'Средний', 'Низкий'][['P1', 'P2', 'P3', 'P4'].indexOf(p)],
            value: open.filter((i) => i.priority === p).length,
            color: PRIO_COLORS[p],
          }))}
        />
      </div>
      <h3 className="cm-h">Сотрудники</h3>
      <div className="wtable">
        <div className="wt-head">
          <span />
          <span>Взял</span>
          <span>В работе</span>
          <span>Сделал</span>
        </div>
        {pool.map((w) => {
          const p = per(w);
          return (
            <div key={w.id} className="wt-row">
              <span className="wt-name">
                <Initials name={w.name} />
                <span>
                  <b>{w.name}</b>
                  <WorkerStatus w={w} />
                </span>
              </span>
              <span className="num">{p.taken}</span>
              <span className="num">{p.work}</span>
              <span className="num">{w.done}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
