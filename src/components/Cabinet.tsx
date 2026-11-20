// Кабинет сотрудника после входа: онлайн (решает удалённо) или выездной (едет на площадку).
// Сам ставит порядок задач, берёт свободные из очереди центра, отмечает, чем занят, выбирает свои метрики.
// Выездному удобно с телефона: крупные кнопки внизу, маршрут в Яндекс Картах.
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Coffee, Hand, MapPin, Navigation, Play, Route, Undo2 } from 'lucide-react';
import type { Incident, Worker } from '../../shared/types';
import { myWorker, readLocal, select, useStore, workerAct, writeLocal } from '../store';
import { fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { DEFAULT_WORKER_METRICS, type MetricCtx } from '../lib/metrics';
import { Deadline, Donut, Elapsed, MetricTiles, PRIO_COLORS, PrioDot, WorkerStatus } from './ui';

const R = 6371;
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const etaText = (d: number) => {
  const m = Math.round(((d * 1.3) / 55) * 60);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};

export function Cabinet() {
  const me = useStore(myWorker);
  if (!me) return <div className="boot">Профиль сотрудника не найден — обратитесь к координатору</div>;
  return (
    <div className={`cabinet cab-${me.mode}`}>
      <MeBar me={me} />
      <Desk me={me} />
    </div>
  );
}

function MeBar({ me }: { me: Worker }) {
  const [focus, setFocus] = useState(me.focus);
  useEffect(() => setFocus(me.focus), [me.id, me.focus]);
  const now = useNow(30_000);
  const hours = Math.floor((now - me.shiftStart) / 3_600_000);
  return (
    <header className="mebar">
      <div className="me-id">
        <WorkerStatus w={me} />
        <span className="muted">
          {me.mode === 'offline' ? (
            <>
              <MapPin size={12} /> {me.place} ·{' '}
            </>
          ) : null}
          смена {hours} ч · сделано <b className="num">{me.done}</b>
          {me.mode === 'offline' && ` · выездов ${me.trips}`}
        </span>
      </div>
      <input
        className="focus-in"
        value={focus}
        maxLength={80}
        placeholder="Чем занимаюсь (видит координатор)…"
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
    </header>
  );
}

function Desk({ me }: { me: Worker }) {
  const incidents = useStore((s) => s.incidents);
  const stats = useStore((s) => s.stats);
  const workers = useStore((s) => s.workers);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(5000);
  const [tab, setTab] = useState<'mine' | 'pool'>('mine');

  // Мои задачи в моём порядке; новые без порядка — по дедлайну.
  const mine = useMemo(() => {
    const list = [...incidents.values()].filter((i) => i.assignee === me.id && i.status !== 'resolved');
    const pos = (id: string) => {
      const k = me.queue.indexOf(id);
      return k < 0 ? 1e6 : k;
    };
    return list.sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress') || pos(a.id) - pos(b.id) || a.slaDeadline - b.slaDeadline);
  }, [incidents, me.queue, me.id]);
  // Свободные задачи центра: выездному — ближние выше.
  const here = me.lat !== null && me.lon !== null ? { lat: me.lat, lon: me.lon } : null;
  const pool = useMemo(() => {
    const list = [...incidents.values()].filter((i) => i.mode === me.mode && i.status === 'coordinators');
    const prio = { P1: 0, P2: 1, P3: 2, P4: 3 };
    return list.sort((a, b) => prio[a.priority] - prio[b.priority] || (here ? km(here, a.geo) - km(here, b.geo) : a.slaDeadline - b.slaDeadline));
  }, [incidents, me.mode, here?.lat, here?.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  const scope = useMemo(() => [...incidents.values()].filter((i) => i.mode === me.mode), [incidents, me.mode]);
  const sel = selectedId ? incidents.get(selectedId) : undefined;
  const current = (sel && (sel.assignee === me.id || sel.status === 'coordinators') && sel.mode === me.mode ? sel : undefined) ?? (me.currentId ? incidents.get(me.currentId) : undefined) ?? mine[0];

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
      <section className="panel mylist" aria-label="Задачи">
        <div className="seg seg-sm cab-tabs">
          <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
            Мои <span className="num">{mine.length}</span>
          </button>
          <button className={tab === 'pool' ? 'on' : ''} onClick={() => setTab('pool')}>
            Свободные <span className="num">{pool.length}</span>
          </button>
        </div>
        <div className="pl-rows">
          {tab === 'mine' && mine.length === 0 && (
            <div className="empty">
              Задач нет.{' '}
              {pool.length > 0 && (
                <button className="link" onClick={() => setTab('pool')}>
                  Взять из свободных
                </button>
              )}
            </div>
          )}
          {tab === 'mine' &&
            mine.map((inc, k) => (
              <div key={inc.id} className={`prow p-${inc.priority} ${current?.id === inc.id ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(inc.id)} onKeyDown={(e) => e.key === 'Enter' && select(inc.id)}>
                <span className="order num">{k + 1}</span>
                <PrioDot p={inc.priority} />
                <span className="pr-main">
                  <span className="pr-title">{inc.title}</span>
                  <span className="pr-meta">
                    {inc.status === 'in_progress' ? (me.mode === 'offline' ? (inc.crew?.arrived ? 'на месте' : 'в пути') : 'в работе') : 'ждёт'} · {me.mode === 'offline' ? inc.region : inc.productName}
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
          {tab === 'pool' && pool.length === 0 && <div className="empty">Свободных задач нет</div>}
          {tab === 'pool' &&
            pool.map((inc) => (
              <div key={inc.id} className={`prow p-${inc.priority} ${current?.id === inc.id ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(inc.id)} onKeyDown={(e) => e.key === 'Enter' && select(inc.id)}>
                <PrioDot p={inc.priority} />
                <span className="pr-main">
                  <span className="pr-title">{inc.title}</span>
                  <span className="pr-meta">
                    {me.mode === 'offline' ? `${inc.region}${here ? ` · ${km(here, inc.geo)} км` : ''}` : `${inc.productName} › ${inc.service}`}
                  </span>
                </span>
                <span className="pr-side">
                  <Deadline inc={inc} />
                  <button
                    className="btn-take"
                    onClick={(e) => {
                      e.stopPropagation();
                      void workerAct(me.id, { action: 'grab', incidentId: inc.id }).then(() => {
                        setTab('mine');
                        select(inc.id);
                      });
                    }}
                  >
                    Взять
                  </button>
                </span>
              </div>
            ))}
        </div>
      </section>

      {current ? <Task inc={current} me={me} here={here} /> : <section className="panel empty-panel">Выберите задачу</section>}

      <aside className="panel mymetrics" aria-label="Мои метрики">
        <div className="big3">
          <div className="b3 tone-coord">
            <span className="num">{mine.filter((i) => i.status === 'assigned').length}</span>Ждут
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

function Task({ inc, me, here }: { inc: Incident; me: Worker; here: { lat: number; lon: number } | null }) {
  const now = useNow(1000);
  const crewLeft = inc.crew && !inc.crew.arrived ? Math.max(0, inc.crew.dispatchedAt + inc.crew.etaMs - now) : 0;
  const working = inc.status === 'in_progress';
  const mineTask = inc.assignee === me.id;
  const dist = here ? km(here, inc.geo) : null;
  const from = inc.crew && !inc.crew.arrived ? inc.crew.from : here;
  const route = `https://yandex.ru/maps/?rtext=${from ? `${from.lat.toFixed(5)},${from.lon.toFixed(5)}` : ''}~${inc.geo.lat.toFixed(5)},${inc.geo.lon.toFixed(5)}&rtt=auto`;
  return (
    <section className={`panel pdetail task p-${inc.priority}`} aria-label={inc.title}>
      <header className="pd-head">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className={`chip-state st-${inc.status}`}>{inc.status === 'coordinators' ? 'Свободна' : inc.stateText}</span>
        <span className="pd-sp" />
        <span className="pd-id num">{inc.id}</span>
      </header>
      <h1 className="pd-title">{inc.title}</h1>
      {inc.mode === 'offline' ? (
        <div className="task-where">
          <MapPin size={16} />
          <span>
            <b>{inc.region}</b>
            <span className="muted">
              {inc.crew?.arrived || (dist !== null && dist < 1) ? 'вы на месте' : dist !== null ? `${dist} км · ≈ ${etaText(dist)} по дороге` : inc.productName}
            </span>
          </span>
          <a className="btn btn-sm" href={route} target="_blank" rel="noopener noreferrer">
            <Route size={14} /> Маршрут
          </a>
        </div>
      ) : (
        <div className="pd-where">
          {inc.productName} › {inc.service} · {inc.component}
        </div>
      )}
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
      <p className="task-desc">{inc.description}</p>

      {inc.mode === 'offline' && inc.crew && (
        <div className={`pe-crew big ${inc.crew.arrived ? 'ok' : ''}`}>
          <Navigation size={16} /> {inc.crew.arrived ? 'На месте' : `В пути · ещё ${Math.ceil(crewLeft / 60_000)} мин`}
        </div>
      )}

      <div className="task-actions">
        {inc.status === 'coordinators' && (
          <button className="btn btn-primary" onClick={() => void workerAct(me.id, { action: 'grab', incidentId: inc.id })}>
            <Hand size={16} /> Взять себе
          </button>
        )}
        {mineTask && inc.status === 'assigned' && (
          <button className="btn btn-primary" onClick={() => void workerAct(me.id, { action: 'start', incidentId: inc.id })}>
            {me.mode === 'offline' ? <Navigation size={16} /> : <Play size={16} />} {me.mode === 'offline' ? 'Выехал' : 'Начать'}
          </button>
        )}
        {mineTask && working && me.mode === 'offline' && inc.crew && !inc.crew.arrived && (
          <button className="btn btn-primary" onClick={() => void workerAct(me.id, { action: 'onsite', incidentId: inc.id })}>
            <MapPin size={16} /> На месте
          </button>
        )}
        {mineTask && working && (me.mode === 'online' || !inc.crew || inc.crew.arrived) && (
          <button className="btn btn-ok" onClick={() => void workerAct(me.id, { action: 'done', incidentId: inc.id })}>
            <CheckCircle2 size={16} /> Сделал
          </button>
        )}
        {mineTask && (
          <button className="btn btn-ghost" onClick={() => void workerAct(me.id, { action: 'release', incidentId: inc.id })} title="Вернуть координатору">
            <Undo2 size={15} /> Вернуть
          </button>
        )}
      </div>
    </section>
  );
}

