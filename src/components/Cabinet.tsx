// Кабинет сотрудника: онлайн (решает удалённо) или офлайн (выезжает).
// Сам ставит порядок задач, отмечает, чем занят, и выбирает свои метрики.
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Coffee, MapPin, Navigation, Play, Undo2 } from 'lucide-react';
import type { Incident, Worker, WorkMode } from '../../shared/types';
import { readLocal, select, setCabinet, useStore, workerAct, writeLocal } from '../store';
import { fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { DEFAULT_WORKER_METRICS, type MetricCtx } from '../lib/metrics';
import { Deadline, Donut, Elapsed, Initials, MetricTiles, PRIO_COLORS, PrioDot, WorkerStatus } from './ui';

export function Cabinet() {
  const cabinet = useStore((s) => s.cabinet);
  const workers = useStore((s) => s.workers);
  const me = workers.find((w) => w.id === cabinet.workerId && w.mode === cabinet.mode);
  return (
    <div className="cabinet">
      <header className="cab-head">
        <div className="seg">
          {(['online', 'offline'] as WorkMode[]).map((m) => (
            <button key={m} className={cabinet.mode === m ? 'on' : ''} onClick={() => setCabinet({ mode: m, workerId: null })}>
              {m === 'online' ? 'Онлайн' : 'Выездной'}
            </button>
          ))}
        </div>
        {me && <MeBar me={me} />}
      </header>
      {me ? <Desk me={me} /> : <WhoAmI mode={cabinet.mode} workers={workers.filter((w) => w.mode === cabinet.mode)} />}
    </div>
  );
}

function WhoAmI({ mode, workers }: { mode: WorkMode; workers: Worker[] }) {
  const offices = useStore((s) => s.offices);
  return (
    <section className="whoami">
      <h2>Кто вы?</h2>
      <div className="who-grid">
        {workers.map((w) => (
          <button key={w.id} className="who-card" onClick={() => setCabinet({ mode, workerId: w.id })}>
            <Initials name={w.name} />
            <b>{w.name}</b>
            <span className="muted">{mode === 'offline' ? offices.find((o) => o.id === w.office)?.city : `@${w.id}`}</span>
            <WorkerStatus w={w} />
          </button>
        ))}
      </div>
    </section>
  );
}

function MeBar({ me }: { me: Worker }) {
  const [focus, setFocus] = useState(me.focus);
  useEffect(() => setFocus(me.focus), [me.id]);
  const offices = useStore((s) => s.offices);
  return (
    <div className="mebar">
      <Initials name={me.name} />
      <div className="me-id">
        <b>{me.name}</b>
        <span className="muted">{me.mode === 'offline' ? offices.find((o) => o.id === me.office)?.city : `@${me.id}`}</span>
      </div>
      <WorkerStatus w={me} />
      <input
        className="focus-in"
        value={focus}
        maxLength={80}
        placeholder="Чем занимаюсь…"
        onChange={(e) => setFocus(e.target.value)}
        onBlur={() => focus !== me.focus && void workerAct(me.id, { action: 'focus', focus })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button
        className={`btn btn-sm ${me.status === 'break' ? 'btn-ok' : ''}`}
        onClick={() => void workerAct(me.id, { action: 'status', status: me.status === 'break' ? 'free' : 'break' })}
      >
        <Coffee size={14} /> {me.status === 'break' ? 'Вернуться' : 'Перерыв'}
      </button>
      <button className="btn btn-sm" onClick={() => setCabinet({ mode: me.mode, workerId: null })}>
        Сменить
      </button>
    </div>
  );
}

function Desk({ me }: { me: Worker }) {
  const incidents = useStore((s) => s.incidents);
  const stats = useStore((s) => s.stats);
  const workers = useStore((s) => s.workers);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(5000);

  // Мои задачи в моём порядке; новые без порядка — по дедлайну.
  const mine = useMemo(() => {
    const list = [...incidents.values()].filter((i) => i.assignee === me.id && i.status !== 'resolved');
    const pos = (id: string) => {
      const k = me.queue.indexOf(id);
      return k < 0 ? 1e6 : k;
    };
    return list.sort((a, b) => pos(a.id) - pos(b.id) || a.slaDeadline - b.slaDeadline);
  }, [incidents, me.queue, me.id]);
  const scope = useMemo(() => [...incidents.values()].filter((i) => i.mode === me.mode), [incidents, me.mode]);
  const current = (selectedId && incidents.get(selectedId)?.assignee === me.id ? incidents.get(selectedId) : undefined) ?? (me.currentId ? incidents.get(me.currentId) : undefined) ?? mine[0];

  useEffect(() => {
    void workerAct(me.id, { action: 'claim' });
  }, [me.id]);

  const move = (id: string, d: -1 | 1) => {
    const ids = mine.map((i) => i.id);
    const k = ids.indexOf(id);
    const j = k + d;
    if (j < 0 || j >= ids.length) return;
    [ids[k], ids[j]] = [ids[j], ids[k]];
    void workerAct(me.id, { action: 'queue', queue: ids });
  };

  const key = `radar.metrics.worker.${me.id}`;
  const [ids, setIds] = useState<string[]>(() => readLocal(key, DEFAULT_WORKER_METRICS));
  useEffect(() => setIds(readLocal(key, DEFAULT_WORKER_METRICS)), [key]);
  const ctx: MetricCtx = { scope, mine, workers: workers.filter((w) => w.mode === me.mode), worker: me, stats, now };

  return (
    <div className="cab-grid">
      <section className="panel mylist" aria-label="Мои задачи">
        <header className="pl-head">
          <h2>Мои задачи</h2>
          <span className="muted">свой порядок ↑↓</span>
        </header>
        <div className="pl-rows">
          {mine.length === 0 && <div className="empty">Задач нет — координатор назначит</div>}
          {mine.map((inc, k) => (
            <div key={inc.id} className={`prow p-${inc.priority} ${current?.id === inc.id ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(inc.id)}>
              <span className="order num">{k + 1}</span>
              <PrioDot p={inc.priority} />
              <span className="pr-main">
                <span className="pr-title">{inc.title}</span>
                <span className="pr-meta">
                  {inc.status === 'in_progress' ? (me.mode === 'offline' ? (inc.crew?.arrived ? 'на месте' : 'в пути') : 'в работе') : 'взял'} · {inc.productName}
                </span>
              </span>
              <span className="pr-side">
                <Deadline inc={inc} />
                <span className="updown" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" onClick={() => move(inc.id, -1)} disabled={k === 0} aria-label="Выше">
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => move(inc.id, 1)} disabled={k === mine.length - 1} aria-label="Ниже">
                    <ArrowDown size={14} />
                  </button>
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {current ? <Task inc={current} me={me} /> : <section className="panel empty-panel">Выберите задачу</section>}

      <aside className="panel mymetrics" aria-label="Мои метрики">
        <div className="big3">
          <div className="b3 tone-coord">
            <span className="num">{mine.filter((i) => i.status === 'assigned').length}</span>Взял
          </div>
          <div className="b3 tone-ai">
            <span className="num">{mine.filter((i) => i.status === 'in_progress').length}</span>В работе
          </div>
          <div className="b3 tone-ok">
            <span className="num">{me.done}</span>Сделал
          </div>
        </div>
        <MetricTiles
          ids={ids}
          ctx={ctx}
          scope="worker"
          onChange={(next) => {
            setIds(next);
            writeLocal(key, next);
          }}
        />
        <Donut
          label="Мои по приоритету"
          parts={(['P1', 'P2', 'P3', 'P4'] as const).map((p, k) => ({
            name: ['Наивысший', 'Высокий', 'Средний', 'Низкий'][k],
            value: mine.filter((i) => i.priority === p).length,
            color: PRIO_COLORS[p],
          }))}
        />
      </aside>
    </div>
  );
}

function Task({ inc, me }: { inc: Incident; me: Worker }) {
  const now = useNow(1000);
  const crewLeft = inc.crew && !inc.crew.arrived ? Math.max(0, inc.crew.dispatchedAt + inc.crew.etaMs - now) : 0;
  const working = inc.status === 'in_progress';
  return (
    <section className={`panel pdetail p-${inc.priority}`} aria-label={inc.title}>
      <header className="pd-head">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className="pd-id num">{inc.id}</span>
        <span className={`chip-state st-${inc.status}`}>{inc.status === 'coordinators' ? 'Ждёт сотрудника' : inc.stateText}</span>
      </header>
      <h1 className="pd-title">{inc.title}</h1>
      <div className="pd-where">
        {inc.productName} › {inc.service} · {inc.component}
        {me.mode === 'offline' && (
          <>
            {' · '}
            <MapPin size={12} /> {inc.region}
          </>
        )}
      </div>
      <div className="tiles3">
        <div className="tile">
          <span className="t-lbl">Приоритет</span>
          <span className="t-val" style={{ color: PRIO_COLORS[inc.priority] }}>
            {inc.priorityText}
          </span>
        </div>
        <div className="tile">
          <span className="t-lbl">{working ? 'В работе' : 'С регистрации'}</span>
          <span className="t-val">
            <Elapsed from={working && inc.startedAt ? inc.startedAt : inc.createdAt} />
          </span>
        </div>
        <div className="tile">
          <span className="t-lbl">До дедлайна</span>
          <span className="t-val">
            <Deadline inc={inc} big />
          </span>
          <span className="t-sub">срок {fmtClock(inc.slaDeadline)}</span>
        </div>
      </div>
      <p className="pd-short">{inc.shortDescription}</p>

      {me.mode === 'offline' && inc.crew && (
        <div className={`pe-crew big ${inc.crew.arrived ? 'ok' : ''}`}>
          <Navigation size={16} /> {inc.crew.arrived ? 'На месте' : `В пути · ещё ${Math.ceil(crewLeft / 60_000)} мин`}
        </div>
      )}

      <div className="task-actions">
        {inc.status === 'assigned' && (
          <button className="btn btn-primary" onClick={() => void workerAct(me.id, { action: 'start', incidentId: inc.id })}>
            {me.mode === 'offline' ? <Navigation size={15} /> : <Play size={15} />} {me.mode === 'offline' ? 'Выехал' : 'Начать'}
          </button>
        )}
        {working && me.mode === 'offline' && inc.crew && !inc.crew.arrived && (
          <button className="btn" onClick={() => void workerAct(me.id, { action: 'onsite', incidentId: inc.id })}>
            <MapPin size={15} /> На месте
          </button>
        )}
        {working && (
          <button className="btn btn-ok" onClick={() => void workerAct(me.id, { action: 'done', incidentId: inc.id })}>
            <CheckCircle2 size={15} /> Сделал
          </button>
        )}
        <button className="btn" onClick={() => void workerAct(me.id, { action: 'release', incidentId: inc.id })}>
          <Undo2 size={15} /> Вернуть
        </button>
      </div>
    </section>
  );
}
