// Пункт по вкладкам: каждая вкладка — один шаг работы. Полоса сверху показывает процесс и сколько ждёт на каждом шаге.
//   Дежурный: Жалобы → Входящие → У команд → Решено · Запросы · Сигналы · ИИ-помощник · Справочник
//   Командир: Смена → Распределить → У команд → Решено · Запросы · Сигналы · Жалобы · ИИ-помощник · График · Справочник
import { useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, BookUser, CalendarClock, CheckCircle2, ChevronRight, Inbox, MessageSquareShare, RefreshCw, Sparkles, Users, Wand2, Workflow } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { applyPointPlan, fetchPointPlan, openIncident, savedTab, select, setTab, teamName, useStore } from '../store';
import { fmtDur, urgency } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Deadline, Initials, PrioDot } from './ui';
import { RFMap } from './RFMap';
import { IncidentCard, AiBadge } from './IncidentCard';
import { Detector, IncidentRow, RequestCard, Signals } from './PointScreen';
import { Roster, Shift } from './CommanderScreen';
import { isOn } from './kit';
import { AiPage } from './AiPage';
import { Directory } from './Directory';

interface TabDef {
  id: string;
  label: string;
  icon: typeof Inbox;
  count?: number;
  tone?: 'warn' | 'hot';
  flow?: boolean; // шаг процесса (со стрелкой)
  hint: string;
}

function useTabs(): TabDef[] {
  const me = useStore((s) => s.me)!;
  const incidents = useStore((s) => s.incidents);
  const requests = useStore((s) => s.requests);
  const signals = useStore((s) => s.signals);
  const stats = useStore((s) => s.stats);
  const staff = useStore((s) => s.staff);
  const now = useNow(15_000);
  return useMemo(() => {
    const all = [...incidents.values()];
    const atPoint = all.filter((i) => i.status === 'coordinators');
    const inbox = atPoint.filter((i) => i.coordinatorId === me.personId || !i.coordinatorId);
    const free = atPoint.filter((i) => !i.coordinatorId);
    const atTeams = all.filter((i) => i.status === 'assigned' || i.status === 'in_progress');
    const done = all.filter((i) => i.status === 'resolved' && i.resolvedAt && now - i.resolvedAt < 3_600_000);
    const req = [...requests.values()].filter((r) => r.status === 'pending').length;
    const sig = [...signals.values()].filter((s) => s.status === 'open').length;
    const ai = all.reduce((n, i) => n + i.history.filter((h) => h.kind === 'ai' && now - h.at < 3_600_000).length, 0);
    const duty = staff.filter((p) => p.role === 'coordinator' && isOn(p, now)).length;
    const common: TabDef[] = [
      { id: 'teams', label: 'У команд', icon: Workflow, count: atTeams.length, flow: true, hint: 'Инциденты, переданные командам: кто взял, на каком этапе, сколько до дедлайна. Нажмите строку — карточка справа.' },
      { id: 'done', label: 'Решено', icon: CheckCircle2, count: done.length, flow: true, hint: 'Решённые за последний час: кто решил и за сколько.' },
      { id: 'requests', label: 'Запросы команд', icon: MessageSquareShare, count: req, tone: req ? 'warn' : undefined, hint: 'Команды пишут «это не наше — передайте» или «проблема у другой команды». ИИ уже сверил запрос со справочником.' },
      { id: 'signals', label: 'Сигналы', icon: BellRing, count: sig, tone: sig ? 'hot' : undefined, hint: 'Застрявшие инциденты и просьбы о помощи. «Указать руководителю» — и руководитель команды увидит это у себя.' },
    ];
    if (me.role === 'commander')
      return [
        { id: 'shift', label: 'Смена', icon: Users, count: duty, flow: true, hint: 'Кто из дежурных на смене и что у каждого в работе.' },
        { id: 'distribute', label: 'Распределить', icon: Wand2, count: free.length, tone: free.length ? 'warn' : undefined, flow: true, hint: 'Новые инциденты без дежурного. ИИ предлагает, кому их отдать, — проверьте и назначьте.' },
        ...common,
        { id: 'map', label: 'Жалобы', icon: Activity, count: stats?.flowPerMin, hint: 'Жалобы абонентов на карте и подозрительные всплески.' },
        { id: 'ai', label: 'ИИ-помощник', icon: Sparkles, count: ai, hint: 'Что ИИ делает за пункт и почему — по каждому действию.' },
        { id: 'roster', label: 'График', icon: CalendarClock, hint: 'Смены пункта на сутки вперёд.' },
        { id: 'directory', label: 'Справочник', icon: BookUser, hint: 'Около 900 команд: направления, регионы, графики, кто сейчас работает.' },
      ];
    return [
      { id: 'map', label: 'Жалобы', icon: Activity, count: stats?.flowPerMin, flow: true, hint: 'Жалобы абонентов приходят на карту. ИИ замечает всплески и сам собирает их в инциденты.' },
      { id: 'inbox', label: 'Входящие', icon: Inbox, count: inbox.length, tone: free.length ? 'warn' : undefined, flow: true, hint: 'Новые инциденты на пункте: ваши и без дежурного. Возьмите и передайте команде — ИИ подскажет кому и почему.' },
      ...common,
      { id: 'ai', label: 'ИИ-помощник', icon: Sparkles, count: ai, hint: 'Что ИИ делает за пункт и почему — по каждому действию.' },
      { id: 'directory', label: 'Справочник', icon: BookUser, hint: 'Около 900 команд: направления, регионы, графики, кто сейчас работает.' },
    ];
  }, [me, incidents, requests, signals, stats, staff, now]);
}

export function PointApp() {
  const me = useStore((s) => s.me)!;
  const tab = useStore((s) => s.tab);
  const tabs = useTabs();
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(savedTab(me.role) && tabs.some((t) => t.id === savedTab(me.role)) ? savedTab(me.role) : me.role === 'commander' ? 'shift' : 'inbox');
  }, [tab, tabs, me.role]);
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className="pointapp">
      <nav className="stagebar" aria-label="Шаги работы пункта">
        {tabs.map((t, k) => {
          const nextFlow = t.flow && tabs[k + 1]?.flow;
          return (
            <span key={t.id} className="stage-wrap">
              {!t.flow && tabs[k - 1]?.flow && <span className="stage-gap" />}
              <button className={`stab ${t.id === cur.id ? 'on' : ''} ${t.tone ?? ''}`} onClick={() => setTab(t.id)} aria-current={t.id === cur.id ? 'page' : undefined}>
                <t.icon size={15} />
                <span>{t.label}</span>
                {t.count !== undefined && <span className="stage-n num">{t.count}</span>}
              </button>
              {nextFlow && <ChevronRight size={15} className="stage-arrow" />}
            </span>
          );
        })}
      </nav>
      <div className="stage-hint">{cur.hint}</div>
      <div className="stage-body">
        {cur.id === 'map' && <MapPage />}
        {cur.id === 'inbox' && <InboxPage />}
        {cur.id === 'teams' && <TeamsPage />}
        {cur.id === 'done' && <DonePage />}
        {cur.id === 'requests' && <RequestsPage />}
        {cur.id === 'signals' && <SignalsPage />}
        {cur.id === 'ai' && <AiPage />}
        {cur.id === 'directory' && <Directory />}
        {cur.id === 'shift' && <ShiftPage />}
        {cur.id === 'distribute' && <DistributePage />}
        {cur.id === 'roster' && (
          <div className="page-one">
            <Roster />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── страницы ──────────────────────────────────────────────────────────────

function MapPage() {
  return (
    <div className="page-split map">
      <div className="map-col">
        <RFMap />
      </div>
      <Detector />
    </div>
  );
}

/** Список слева, карточка справа: общий каркас для «Входящих», «У команд», «Решено», «Распределить». */
function ListWithCard({ list, empty, header, row }: { list: Incident[]; empty: string; header?: React.ReactNode; row?: (i: Incident, sel: boolean) => React.ReactNode }) {
  const selectedId = useStore((s) => s.selectedId);
  const sel = list.find((i) => i.id === selectedId) ?? list[0];
  useEffect(() => {
    if (sel && sel.id !== selectedId) select(sel.id);
  }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page-split">
      <section className="panel plist">
        {header}
        <div className="pl-rows">
          {!list.length && <div className="empty">{empty}</div>}
          {list.slice(0, 100).map((i) => (row ? <div key={i.id}>{row(i, i.id === sel?.id)}</div> : <IncidentRow key={i.id} inc={i} sel={i.id === sel?.id} onClick={() => select(i.id)} />))}
        </div>
      </section>
      {sel ? <IncidentCard inc={sel} /> : <section className="panel empty-panel">{empty}</section>}
    </div>
  );
}

function Seg<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, string, number][] }) {
  return (
    <div className="seg seg-sm pl-tabs">
      {items.map(([id, label, n]) => (
        <button key={id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>
          {label} <span className="num">{n}</span>
        </button>
      ))}
    </div>
  );
}

function InboxPage() {
  const me = useStore((s) => s.me)!;
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);
  const [scope, setScope] = useState<'mine' | 'free' | 'all'>('mine');
  const at = [...incidents.values()].filter((i) => i.status === 'coordinators').sort((a, b) => urgency(b, now) - urgency(a, now));
  const mine = at.filter((i) => i.coordinatorId === me.personId);
  const free = at.filter((i) => !i.coordinatorId);
  const list = scope === 'mine' ? mine : scope === 'free' ? free : at;
  return (
    <ListWithCard
      list={list}
      empty={scope === 'mine' ? 'У вас нет новых инцидентов — командир распределит, или возьмите из «Без дежурного»' : 'Пусто'}
      header={
        <Seg
          value={scope}
          onChange={setScope}
          items={[
            ['mine', 'Мои', mine.length],
            ['free', 'Без дежурного', free.length],
            ['all', 'Все на пункте', at.length],
          ]}
        />
      }
    />
  );
}

const STAGES = ['Передан', 'Взят', 'Решён'];
function stageOf(i: Incident) {
  return i.status === 'resolved' ? 2 : i.status === 'in_progress' ? 1 : 0;
}

function TeamsPage() {
  const me = useStore((s) => s.me)!;
  const incidents = useStore((s) => s.incidents);
  const signals = useStore((s) => s.signals);
  const now = useNow(10_000);
  const [scope, setScope] = useState<'mine' | 'all'>(me.role === 'coordinator' ? 'mine' : 'all');
  const at = [...incidents.values()].filter((i) => i.status === 'assigned' || i.status === 'in_progress').sort((a, b) => urgency(b, now) - urgency(a, now));
  const mine = at.filter((i) => i.coordinatorId === me.personId);
  const list = scope === 'mine' ? mine : at;
  const flagged = new Set([...signals.values()].filter((s) => s.status !== 'closed').map((s) => s.incidentId));
  return (
    <ListWithCard
      list={list}
      empty={scope === 'mine' ? 'Вы ещё ничего не передали командам' : 'У команд сейчас ничего нет'}
      header={
        me.role === 'coordinator' ? (
          <Seg
            value={scope}
            onChange={setScope}
            items={[
              ['mine', 'Мои', mine.length],
              ['all', 'Все', at.length],
            ]}
          />
        ) : undefined
      }
      row={(i, sel) => (
        <div className={`trow p-${i.priority} ${sel ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(i.id)} onKeyDown={(e) => e.key === 'Enter' && select(i.id)}>
          <PrioDot p={i.priority} />
          <span className="tr-main">
            <span className="pr-title">{i.title}</span>
            <span className="pr-meta">
              {teamName(i.teamId)}
              {i.assigneeName ? ` · ${i.assigneeName}` : ''}
              {flagged.has(i.id) && <span className="pr-tag warn">сигнал</span>}
            </span>
            <span className="stepper">
              {STAGES.map((s, k) => (
                <span key={s} className={k <= stageOf(i) ? 'on' : ''}>
                  {s}
                </span>
              ))}
            </span>
          </span>
          <Deadline inc={i} />
        </div>
      )}
    />
  );
}

function DonePage() {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(30_000);
  const list = [...incidents.values()].filter((i) => i.status === 'resolved' && i.resolvedAt && now - i.resolvedAt < 3 * 3_600_000).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  return (
    <ListWithCard
      list={list}
      empty="За последние три часа ничего не решено"
      row={(i, sel) => (
        <div className={`trow p-${i.priority} ${sel ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(i.id)} onKeyDown={(e) => e.key === 'Enter' && select(i.id)}>
          <CheckCircle2 size={15} className="ok-ico" />
          <span className="tr-main">
            <span className="pr-title">{i.title}</span>
            <span className="pr-meta">
              {teamName(i.teamId)} · решено за {fmtDur((i.resolvedAt ?? now) - i.createdAt)}
              {i.history.some((h) => h.kind === 'ai' && /Совпало/.test(h.text)) && <span className="pr-tag ai">команда по совету ИИ</span>}
            </span>
          </span>
        </div>
      )}
    />
  );
}

function RequestsPage() {
  const requests = useStore((s) => s.requests);
  const pending = [...requests.values()].filter((r) => r.status === 'pending').sort((a, b) => a.at - b.at);
  const done = [...requests.values()].filter((r) => r.status !== 'pending').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 20);
  return (
    <div className="page-cards">
      <section className="cards">
        {!pending.length && <div className="panel empty-panel">Новых запросов от команд нет</div>}
        {pending.map((r) => (
          <RequestCard key={r.id} r={r} />
        ))}
      </section>
      <aside className="panel side-list">
        <h3 className="cm-h">Обработанные</h3>
        {!done.length && <div className="empty sm">Пока нет</div>}
        {done.map((r) => (
          <button key={r.id} className="req done" onClick={() => r.incidentId && openIncident(r.incidentId)}>
            <b>{teamName(r.fromTeamId)}</b>
            <span className="muted">
              {r.status === 'approved' ? `передано в «${teamName(r.aiTeamId ?? r.toTeamId)}»` : 'отклонено'} · {r.doneBy}
            </span>
          </button>
        ))}
      </aside>
    </div>
  );
}

function SignalsPage() {
  const signals = useStore((s) => s.signals);
  return (
    <div className="page-one narrow">
      <section className="panel">
        <Signals list={[...signals.values()]} />
      </section>
    </div>
  );
}

function ShiftPage() {
  return (
    <div className="page-one">
      <Shift />
    </div>
  );
}

/** Командир: ИИ предлагает распределение — галочки и «Назначить». Карточка выбранного справа. */
function DistributePage() {
  const incidents = useStore((s) => s.incidents);
  const staff = useStore((s) => s.staff);
  const selectedId = useStore((s) => s.selectedId);
  const free = [...incidents.values()].filter((i) => i.status === 'coordinators' && !i.coordinatorId);
  const [plan, setPlan] = useState<{ incidentId: string; personId: string; why: string }[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const key = free.map((i) => i.id).join(',');
  const refresh = () => void fetchPointPlan().then((p) => (setPlan(p), setOff(new Set())));
  useEffect(refresh, [key]);
  const chosen = plan.filter((p) => !off.has(p.incidentId) && free.some((i) => i.id === p.incidentId));
  const sel = (selectedId ? incidents.get(selectedId) : undefined) ?? free[0];
  return (
    <div className="page-split">
      <section className="panel plist">
        <header className="pl-head">
          <h2>
            <AiBadge /> План распределения
          </h2>
          <button className="icon-btn" onClick={refresh} title="Пересчитать">
            <RefreshCw size={15} />
          </button>
        </header>
        <p className="muted plan-sub pad-x">Только дежурные на смене, каждому не больше трёх новых, сначала по специализации. Снимите галочку, если не согласны.</p>
        <div className="pl-rows pad">
          {!free.length && <div className="empty">Все инциденты распределены</div>}
          {free.map((i) => {
            const p = plan.find((x) => x.incidentId === i.id);
            const who = p ? staff.find((s) => s.id === p.personId) : undefined;
            const on = !!p && !off.has(i.id);
            return (
              <label key={i.id} className={`plan-row v ${on ? '' : 'off'} ${sel?.id === i.id ? 'sel' : ''}`} onClick={() => select(i.id)}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!p}
                  onChange={() => {
                    const n = new Set(off);
                    if (on) n.add(i.id);
                    else n.delete(i.id);
                    setOff(n);
                  }}
                />
                <PrioDot p={i.priority} />
                <span className="plan-inc">
                  <b>{i.title}</b>
                  <span className="muted">
                    {who ? (
                      <>
                        → <Initials name={who.name} /> {who.name} · {p!.why}
                      </>
                    ) : (
                      'нет свободного дежурного на смене'
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <footer className="plan-foot">
          <button className="btn btn-primary" disabled={!chosen.length} onClick={() => void applyPointPlan(chosen).then(refresh)}>
            Назначить {chosen.length}
          </button>
        </footer>
      </section>
      {sel ? <IncidentCard inc={sel} /> : <section className="panel empty-panel">Нет нераспределённых инцидентов</section>}
    </div>
  );
}
