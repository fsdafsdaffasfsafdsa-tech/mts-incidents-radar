// Онлайн- и офлайн-центр координатора.
// Онлайн: проблемы | карточка | справа ИИ-подбор сотрудника (или статистика).
// Офлайн: слева сотрудники (а при выборе выезда — кого отправить) | карта ЮФО | справа выезды с описанием.
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronDown, Copy, ExternalLink, MapPin, Navigation, Sparkles, UserPlus, Wand2, X } from 'lucide-react';
import type { Incident, PlanItem, Worker, WorkerScore, WorkMode } from '../../shared/types';
import { act, applyPlan, fetchPlan, itsmLink, loadInsight, readLocal, select, useStore, writeLocal } from '../store';
import { urgency, fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { DEFAULT_CENTER_METRICS, type MetricCtx } from '../lib/metrics';
import { Deadline, Donut, Elapsed, Initials, MetricTiles, PRIO_COLORS, PrioDot, WorkerStatus } from './ui';
import { MapCanvas } from './MapCanvas';

type Tab = 'new' | 'work' | 'done';
/** Четыре группы из ТЗ: инцидент может попасть в несколько. */
type TzGroup = 'crit' | 'coord' | 'high' | 'research';
const DAY = 86_400_000;

const TZ_GROUPS: { id: TzGroup; label: string; test: (i: Incident, now: number) => boolean }[] = [
  { id: 'crit', label: 'Критические', test: (i, now) => i.priority === 'P1' && (i.status !== 'resolved' || (i.resolvedAt ?? 0) > now - DAY) },
  { id: 'coord', label: 'На координаторах', test: (i) => i.status !== 'resolved' && (i.status === 'coordinators' || /координатор/i.test(i.groupName)) },
  { id: 'high', label: 'Высокий', test: (i) => i.status !== 'resolved' && i.priority === 'P2' },
  { id: 'research', label: 'Исследование', test: (i) => i.status !== 'resolved' && /исследован/i.test(i.stateText) },
];

function useScope(mode: WorkMode) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);
  return useMemo(() => {
    const all = [...incidents.values()].filter((i) => i.mode === mode);
    const by = (l: Incident[]) => l.sort((a, b) => urgency(b, now) - urgency(a, now));
    return {
      all,
      now,
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
  const current = sel && sel.mode === 'online' ? sel : undefined;
  return (
    <div className="center c-online">
      <ProblemList scope={scope} mode="online" />
      {current ? <ProblemDetail inc={current} /> : <section className="panel empty-panel">Выберите проблему слева</section>}
      <RightPanel inc={current} scope={scope.all} />
    </div>
  );
}

export function OfflineCenter() {
  const scope = useScope('offline');
  const sel = useStore((s) => (s.selectedId ? s.incidents.get(s.selectedId) : undefined));
  const current = sel && sel.mode === 'offline' ? sel : undefined;
  return (
    <div className="center c-offline">
      {current && current.status !== 'resolved' ? <DispatchPanel inc={current} /> : <StaffPanel />}
      <div className="map-col">
        <MapCanvas filter={(i) => i.mode === 'offline' && i.status !== 'resolved'} showOffices />
        <div className="legend legend-in">
          <span>
            <i className="lg-office">МТС</i> офис
          </span>
          <span>
            <i className="lg-dot P2" /> выезд
          </span>
          <span>
            <Navigation size={12} className="lg-crew" /> в пути
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
  const [group, setGroup] = useState<TzGroup | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const selectedId = useStore((s) => s.selectedId);
  const g = TZ_GROUPS.find((x) => x.id === group);
  const list = g ? scope.all.filter((i) => g.test(i, scope.now)).sort((a, b) => urgency(b, scope.now) - urgency(a, scope.now)) : scope[tab];
  return (
    <section className="panel plist" aria-label="Проблемы">
      <header className="pl-head">
        <h2>{mode === 'online' ? 'Проблемы' : 'Выезды'}</h2>
        {scope.new.length >= 2 && (
          <button className="btn btn-sm btn-ai" onClick={() => setPlanOpen(true)} title="ИИ распределит всех новых: каждому по одной задаче, сумма баллов максимальна">
            <Wand2 size={14} /> Распределить <span className="num">{scope.new.length}</span>
          </button>
        )}
      </header>
      <div className="seg seg-sm pl-tabs">
        {(
          [
            ['new', 'Новые', scope.new.length],
            ['work', 'В работе', scope.work.length],
            ['done', 'Решены', scope.done.length],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            className={!group && tab === id ? 'on' : ''}
            onClick={() => {
              setTab(id);
              setGroup(null);
            }}
          >
            {label} <span className="num">{n}</span>
          </button>
        ))}
      </div>
      <div className="tz-chips" role="group" aria-label="Группы из ТЗ">
        {TZ_GROUPS.map((x) => {
          const n = scope.all.filter((i) => x.test(i, scope.now)).length;
          return (
            <button key={x.id} className={`tz-chip tz-${x.id} ${group === x.id ? 'on' : ''}`} onClick={() => setGroup(group === x.id ? null : x.id)} disabled={!n && group !== x.id}>
              {x.label} <span className="num">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="pl-rows">
        {list.length === 0 && <div className="empty">Пусто</div>}
        {list.slice(0, 80).map((inc) =>
          mode === 'offline' && inc.id === selectedId ? <OfflineExpanded key={inc.id} inc={inc} /> : <Row key={inc.id} inc={inc} mode={mode} selected={inc.id === selectedId} />,
        )}
      </div>
      {planOpen && <PlanModal mode={mode} onClose={() => setPlanOpen(false)} />}
    </section>
  );
}

function Row({ inc, mode, selected }: { inc: Incident; mode: WorkMode; selected: boolean }) {
  const fresh = useStore((s) => s.fresh.get(inc.id));
  const isFresh = fresh !== undefined && Date.now() - fresh < 6000;
  const research = /исследован/i.test(inc.stateText) && inc.status !== 'resolved';
  return (
    <div className={`prow p-${inc.priority} ${selected ? 'sel' : ''} ${isFresh ? 'fresh' : ''}`} role="button" tabIndex={0} onClick={() => select(inc.id)} onKeyDown={(e) => e.key === 'Enter' && select(inc.id)}>
      <PrioDot p={inc.priority} />
      <span className="pr-main">
        <span className="pr-title">{inc.title}</span>
        <span className="pr-meta">
          {mode === 'offline' ? inc.region : inc.productName}
          {research && <span className="pr-tag">исследование</span>}
          {inc.status === 'resolved' && inc.priority === 'P1' && <span className="pr-tag ok">решён</span>}
        </span>
      </span>
      <span className="pr-side">
        <Deadline inc={inc} />
        {inc.status === 'coordinators' ? (
          <span className="pr-wait" title="Ждёт сотрудника">
            <UserPlus size={14} />
          </span>
        ) : inc.assigneeName ? (
          <span className="pr-who" title={inc.assigneeName}>
            <Initials name={inc.assigneeName} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ─── ИИ-подбор сотрудника ──────────────────────────────────────────────────

function useRanking(inc: Incident) {
  const insight = useStore((s) => s.insights.get(inc.id));
  const workers = useStore((s) => s.workers);
  useEffect(() => {
    void loadInsight(inc.id);
    // Сотрудники двигаются и освобождаются — пересчитываем каждые 15 секунд.
    const t = setInterval(() => void loadInsight(inc.id), 15_000);
    return () => clearInterval(t);
  }, [inc.id, inc.status, inc.assignee]);
  return { ranked: insight?.workers ?? [], workers, source: insight?.source ?? 'heuristic' };
}

function fmtEta(min: number | null) {
  if (min === null) return '';
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

const FAR_MIN = 6 * 60; // дальше 6 часов езды — сворачиваем, чтобы не засорять список

function WorkerRanking({ inc, limit = 6 }: { inc: Incident; limit?: number }) {
  const { ranked, workers } = useRanking(inc);
  const [open, setOpen] = useState<string | null>(null);
  const [showFar, setShowFar] = useState(false);
  useEffect(() => setShowFar(false), [inc.id]);
  if (!ranked.length) return <div className="empty">Считаем…</div>;
  const top = ranked.find((r) => !r.blocked);
  const isFar = (r: WorkerScore) => r.etaMin !== null && r.etaMin > FAR_MIN && r.workerId !== top?.workerId;
  const far = ranked.filter(isFar);
  const shown = (showFar ? ranked : ranked.filter((r) => !isFar(r))).slice(0, showFar ? 99 : limit);
  return (
    <ol className="rank">
      {shown.map((r, k) => {
        const w = workers.find((x) => x.id === r.workerId);
        if (!w) return null;
        const mine = inc.assignee === w.id;
        return (
          <li key={r.workerId} className={`rk ${r.blocked ? 'blocked' : ''} ${top?.workerId === r.workerId ? 'best' : ''} ${mine ? 'mine' : ''}`}>
            <div className="rk-main" role="button" tabIndex={0} onClick={() => setOpen(open === r.workerId ? null : r.workerId)} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.workerId ? null : r.workerId)}>
              <span className="rk-n num">{k + 1}</span>
              <Initials name={w.name} />
              <span className="rk-who">
                <b>{w.name}</b>
                <span className="rk-why">{r.blocked ? r.blocked : r.reasons.join(' · ')}</span>
              </span>
              <span className="rk-score">
                <span className="num">{r.score}</span>
                <span className="rk-bar">
                  <i style={{ width: `${r.score}%` }} />
                </span>
              </span>
            </div>
            {open === r.workerId && <ScoreParts r={r} />}
            {!r.blocked && inc.status !== 'resolved' && (
              <div className="rk-act">
                {inc.mode === 'offline' && r.etaMin !== null && (
                  <span className="rk-eta">
                    <Navigation size={12} /> {fmtEta(r.etaMin)} · {r.km} км
                  </span>
                )}
                {mine ? (
                  <span className="rk-mine">назначен</span>
                ) : (
                  <button className={`btn btn-sm ${top?.workerId === r.workerId ? 'btn-ai' : ''}`} onClick={() => void act(inc.id, 'assign', { workerId: w.id })}>
                    {inc.mode === 'offline' ? 'Отправить' : 'Назначить'}
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
      {far.length > 0 && !showFar && (
        <li>
          <button className="rk-far" onClick={() => setShowFar(true)}>
            Далеко (больше 6 ч езды) — ещё {far.length}
          </button>
        </li>
      )}
    </ol>
  );
}

function ScoreParts({ r }: { r: WorkerScore }) {
  const max = Math.max(1, ...r.parts.map((p) => Math.abs(p.points)));
  return (
    <div className="rk-parts">
      {r.parts.map((p) => (
        <div key={p.label} className="rp">
          <span>{p.label}</span>
          <span className="rp-bar">
            <i className={p.points < 0 ? 'neg' : ''} style={{ width: `${(Math.abs(p.points) / max) * 100}%` }} />
          </span>
          <span className="num">{p.points > 0 ? `+${p.points}` : p.points}</span>
        </div>
      ))}
    </div>
  );
}

function RightPanel({ inc, scope }: { inc?: Incident; scope: Incident[] }) {
  const canRank = !!inc && inc.status !== 'resolved';
  const [tab, setTab] = useState<'ai' | 'stats'>('ai');
  const view = canRank && tab === 'ai' ? 'ai' : 'stats';
  return (
    <aside className="panel cmetrics right" aria-label="ИИ-подбор и статистика">
      <div className="seg seg-sm rp-tabs">
        <button className={view === 'ai' ? 'on' : ''} disabled={!canRank} onClick={() => setTab('ai')}>
          <Sparkles size={13} /> Кому отдать
        </button>
        <button className={view === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>
          Статистика
        </button>
      </div>
      {view === 'ai' && inc ? (
        <>
          <div className="rp-for">
            <PrioDot p={inc.priority} />
            <span className="rp-title">{inc.title}</span>
          </div>
          <WorkerRanking inc={inc} limit={7} />
          <p className="rp-note">Балл: опыт, профильная группа, занятость и усталость. Нажмите на сотрудника, чтобы увидеть разбор.</p>
        </>
      ) : (
        <CenterStats scope={scope} mode="online" />
      )}
    </aside>
  );
}

// ─── офлайн: кто где и кого отправить ──────────────────────────────────────

const PLACE_ORDER: Record<Worker['status'], number> = { enroute: 0, onsite: 1, free: 2, busy: 3, break: 4 };

function StaffPanel() {
  const workers = useStore((s) => s.workers);
  const incidents = useStore((s) => s.incidents);
  const now = useNow(5000);
  const field = workers.filter((w) => w.mode === 'offline').sort((a, b) => PLACE_ORDER[a.status] - PLACE_ORDER[b.status] || a.name.localeCompare(b.name));
  const free = field.filter((w) => w.status === 'free').length;
  return (
    <section className="panel staff" aria-label="Выездные сотрудники">
      <header className="pl-head">
        <h2>Сотрудники</h2>
        <span className="muted">
          свободно <b className="num">{free}</b> из {field.length}
        </span>
      </header>
      <div className="pl-rows">
        {field.map((w) => {
          const cur = w.currentId ? incidents.get(w.currentId) : undefined;
          const left = cur?.crew && !cur.crew.arrived ? Math.max(0, cur.crew.dispatchedAt + cur.crew.etaMs - now) : 0;
          const queue = [...incidents.values()].filter((i) => i.assignee === w.id && i.status === 'assigned').length;
          const hours = Math.floor((now - w.shiftStart) / 3_600_000);
          return (
            <div key={w.id} className={`st-row ws-${w.status}`} role="button" tabIndex={0} onClick={() => cur && select(cur.id)} onKeyDown={(e) => e.key === 'Enter' && cur && select(cur.id)}>
              <Initials name={w.name} />
              <span className="st-main">
                <span className="st-name">
                  <b>{w.name}</b>
                  <WorkerStatus w={w} />
                </span>
                <span className="st-place">
                  <MapPin size={12} /> {w.place}
                  {left > 0 && <> · ещё {Math.ceil(left / 60_000)} мин</>}
                </span>
                {cur && <span className="st-task">{cur.title}</span>}
              </span>
              <span className="st-side num" title="в очереди · выездов · часов на смене">
                {queue > 0 && <span className="st-q">+{queue}</span>}
                <span className="muted">
                  {w.trips} выезд. · {hours} ч
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DispatchPanel({ inc }: { inc: Incident }) {
  return (
    <section className="panel staff dispatch" aria-label="Кого отправить">
      <header className="pl-head">
        <button className="icon-btn" onClick={() => select(null)} aria-label="Ко всем сотрудникам" title="Ко всем сотрудникам">
          <ArrowLeft size={16} />
        </button>
        <h2>Кого отправить</h2>
        <Sparkles size={14} className="ai-ico" />
      </header>
      <div className="dp-for">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <b>{inc.region}</b>
        <span className="muted">{inc.title}</span>
      </div>
      <div className="pl-rows">
        <WorkerRanking inc={inc} limit={8} />
        <p className="rp-note">Учтено: время в пути от того места, где сотрудник сейчас, занятость, опыт, часы на смене. На перерыве и в конце смены — не предлагаем.</p>
      </div>
    </section>
  );
}

// ─── распределение пачкой ──────────────────────────────────────────────────

function PlanModal({ mode, onClose }: { mode: WorkMode; onClose: () => void }) {
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const incidents = useStore((s) => s.incidents);
  const workers = useStore((s) => s.workers);
  useEffect(() => {
    void fetchPlan(mode).then(setPlan);
  }, [mode]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const chosen = (plan ?? []).filter((p) => !off.has(p.incidentId));
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal plan" role="dialog" aria-label="Распределение" onClick={(e) => e.stopPropagation()}>
        <header>
          <Wand2 size={16} />
          <h3>ИИ распределит новые</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </header>
        <p className="muted plan-sub">Каждому — не больше одной задачи, сумма баллов максимальна. Снимите галочку, если не согласны.</p>
        <div className="plan-rows">
          {!plan && <div className="empty">Считаем…</div>}
          {plan && !plan.length && <div className="empty">Некого назначить: все на перерыве или в конце смены</div>}
          {plan?.map((p) => {
            const inc = incidents.get(p.incidentId);
            const w = workers.find((x) => x.id === p.workerId);
            if (!inc || !w) return null;
            const on = !off.has(p.incidentId);
            return (
              <label key={p.incidentId} className={`plan-row ${on ? '' : 'off'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const n = new Set(off);
                    if (on) n.add(p.incidentId);
                    else n.delete(p.incidentId);
                    setOff(n);
                  }}
                />
                <PrioDot p={inc.priority} />
                <span className="plan-inc">
                  <b>{inc.title}</b>
                  <span className="muted">{mode === 'offline' ? inc.region : inc.productName}</span>
                </span>
                <span className="plan-arrow">→</span>
                <span className="plan-w">
                  <Initials name={w.name} />
                  <span>
                    <b>{w.name}</b>
                    <span className="muted">
                      балл {p.score}
                      {p.etaMin !== null && ` · ${fmtEta(p.etaMin)}`}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            disabled={!chosen.length}
            onClick={() => {
              void applyPlan(chosen).then(onClose);
            }}
          >
            Назначить {chosen.length}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── выбор вручную ─────────────────────────────────────────────────────────

function AssignSelect({ inc, compact = false }: { inc: Incident; compact?: boolean }) {
  const workers = useStore((s) => s.workers);
  const { ranked } = useRanking(inc);
  const pool = workers.filter((w) => w.mode === inc.mode);
  const pos = (w: Worker) => {
    const k = ranked.findIndex((r) => r.workerId === w.id);
    return k < 0 ? 100 : k;
  };
  return (
    <label className={`assign ${compact ? 'compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      <UserPlus size={15} />
      <select value={inc.assignee ?? ''} onChange={(e) => e.target.value && void act(inc.id, 'assign', { workerId: e.target.value })}>
        <option value="">{compact ? 'Сотрудник' : 'Выбрать вручную'}</option>
        {[...pool]
          .sort((a, b) => pos(a) - pos(b))
          .map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {w.status === 'break' ? 'перерыв' : w.status === 'free' ? 'свободен' : 'занят'}
            </option>
          ))}
      </select>
      <ChevronDown size={14} />
    </label>
  );
}

function ItsmButton({ inc }: { inc: Incident }) {
  const link = itsmLink(inc.id);
  if (link)
    return (
      <a className="btn btn-sm" href={link} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={14} /> Открыть в ITSM
      </a>
    );
  return (
    <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(inc.id)} title="Адрес ITSM не задан (ITSM_URL) — скопировать номер">
      <Copy size={14} /> {inc.id}
    </button>
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
        <span className={`chip-state st-${inc.status}`}>{inc.status === 'coordinators' ? 'Ждёт сотрудника' : inc.stateText}</span>
        {inc.isMaster && <span className="chip-mass">массовый</span>}
        {inc.isDouble && <span className="chip-dbl">дубль</span>}
        <span className="pd-sp" />
        <ItsmButton inc={inc} />
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

      <p className="pd-short">{inc.shortDescription}</p>

      {inc.assigneeName && (
        <div className="pd-who">
          <Initials name={inc.assigneeName} /> {inc.assigneeName} <span className="muted">· {inc.groupName}</span>
        </div>
      )}
      {inc.status !== 'resolved' && (
        <div className="pd-actions">
          <AssignSelect inc={inc} />
          <button className="btn btn-ok" onClick={() => void act(inc.id, 'resolve')}>
            <CheckCircle2 size={15} /> Решено
          </button>
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
        {inc.solution && (
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

// ─── выезд: строка раскрывается в списке с описанием ───────────────────────

function OfflineExpanded({ inc }: { inc: Incident }) {
  const now = useNow(1000);
  const crewLeft = inc.crew && !inc.crew.arrived ? Math.max(0, inc.crew.dispatchedAt + inc.crew.etaMs - now) : 0;
  return (
    <div className={`prow-exp p-${inc.priority}`}>
      <div className="pe-top">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className={`chip-state st-${inc.status}`}>{inc.status === 'coordinators' ? 'Ждёт сотрудника' : inc.stateText}</span>
        <Deadline inc={inc} />
        <button className="icon-btn pe-close" onClick={() => select(null)} aria-label="Свернуть">
          <X size={14} />
        </button>
      </div>
      <div className="pe-title">{inc.title}</div>
      <div className="pe-city">
        <MapPin size={12} /> {inc.region}
      </div>
      <div className="pe-where">
        {inc.productName} › {inc.service} · {inc.component}
      </div>
      <p className="pe-desc">{inc.description}</p>
      {inc.crew && (
        <div className={`pe-crew ${inc.crew.arrived ? 'ok' : ''}`}>
          <Navigation size={14} /> {inc.assigneeName}: {inc.crew.arrived ? 'на месте' : `в пути, ${Math.ceil(crewLeft / 60_000)} мин`}
        </div>
      )}
      {!inc.crew && inc.assigneeName && (
        <div className="pe-crew">
          <Initials name={inc.assigneeName} /> {inc.assigneeName}: {inc.status === 'resolved' ? 'решил' : 'ещё не выехал'}
        </div>
      )}
      <div className="pe-actions">
        <ItsmButton inc={inc} />
        {inc.status !== 'resolved' && <AssignSelect inc={inc} compact />}
      </div>
    </div>
  );
}

// ─── статистика центра ─────────────────────────────────────────────────────

function CenterStats({ scope, mode }: { scope: Incident[]; mode: WorkMode }) {
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
    <>
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
          parts={(['P1', 'P2', 'P3', 'P4'] as const).map((p, k) => ({
            name: ['Наивысший', 'Высокий', 'Средний', 'Низкий'][k],
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
    </>
  );
}
