// Пункт по вкладкам: каждая вкладка — один шаг работы. Полоса сверху показывает процесс и сколько ждёт на каждом шаге.
//   Дежурный: Жалобы → Входящие → У команд → Решено · Запросы · Сигналы · Смена пункта · ИИ-помощник · Справочник
//   Новые инциденты, которые никто не взял, распределяет ИИ; дежурные передают друг другу сами.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BellRing, BookUser, CheckCircle2, FileSearch, MousePointerClick, PartyPopper, ChevronDown, ChevronRight, CircleHelp, Inbox, LayoutDashboard, MessageSquareShare, MonitorPlay, MoreHorizontal, Sparkles, Workflow } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { openIncident, savedTab, select, setTab, teamName, useStore } from '../store';
import { fmtDur, urgency } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Deadline, Empty, PrioDot } from './ui';
import { RFMap } from './RFMap';
import { IncidentCard } from './IncidentCard';
import { Detector, IncidentRow, RequestCard, Signals } from './PointScreen';
import { Roster, Shift } from './CommanderScreen';
import { EscTimer, ForecastChip, heatClass, heatOf, heatStyle } from './kit';
import { AiPage } from './AiPage';
import { Replay } from './Replay';
import { Dashboard } from './dash/Dashboard';
import { hotNav } from '../lib/hotkeys';
import { MyShift } from './ShiftTools';
import { Directory } from './Directory';
import { Desk } from './Desk';
import { ReviewsPage } from './Reviews';

interface TabDef {
  id: string;
  label: string;
  icon: typeof Inbox;
  count?: number;
  tone?: 'warn' | 'hot';
  flow?: boolean; // шаг процесса (со стрелкой)
  more?: boolean; // в меню «Ещё»
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
    const common: TabDef[] = [
      { id: 'teams', label: 'У команд', icon: Workflow, count: atTeams.length, flow: true, hint: 'Инциденты, переданные командам: кто взял, на каком этапе, сколько до дедлайна. Нажмите строку — карточка справа.' },
      { id: 'done', label: 'Решено', icon: CheckCircle2, count: done.length, flow: true, hint: 'Решённые за последний час: кто решил и за сколько.' },
      { id: 'reviews', label: 'Разборы', icon: FileSearch, flow: true, hint: 'Разбор после решения: ИИ пишет черновик по истории инцидента — хронология, вероятная причина, что сделали, масштаб, что улучшить. Можно скопировать и озвучить.' },
      { id: 'requests', label: 'Запросы команд', icon: MessageSquareShare, count: req, tone: req ? 'warn' : undefined, hint: 'Команды пишут «это не наше — передайте» или «проблема у другой команды». ИИ уже сверил запрос со справочником.' },
      { id: 'signals', label: 'Сигналы', icon: BellRing, count: sig, tone: sig ? 'warn' : undefined, hint: 'Застрявшие инциденты и просьбы о помощи. «Указать руководителю» — и руководитель команды увидит это у себя.' },
    ];
    return [
      { id: 'desk', label: 'Мой стол', icon: LayoutDashboard, hint: 'Ваше рабочее место из блоков: входящие, карточка, карта, сигналы… «Настроить стол» — добавить, убрать, перетащить и растянуть. У каждого дежурного своя раскладка.' },
      { id: 'map', label: 'Жалобы', icon: Activity, count: stats?.flowPerMin, flow: true, hint: 'Жалобы абонентов приходят на карту. ИИ замечает всплески и сам собирает их в инциденты.' },
      { id: 'inbox', label: 'Входящие', icon: Inbox, count: inbox.length, tone: free.length ? 'warn' : undefined, flow: true, hint: 'Новые инциденты на пункте: ваши и без дежурного. Возьмите себе или передайте коллеге, затем — команде. ИИ подсказывает, кому подходит, решаете вы.' },
      ...common,
      { id: 'ai', label: 'ИИ-помощник', icon: Sparkles, count: ai, more: true, hint: 'Что ИИ делает за пункт и почему — по каждому действию.' },
      { id: 'wall', label: 'Видеостена', icon: MonitorPlay, more: true, hint: 'Экран для стены над рабочими местами: видно с расстояния. «На экран стены» откроет его отдельным окном, «На весь экран» — без рамок.' },
      { id: 'directory', label: 'Справочник', icon: BookUser, more: true, hint: 'Около 900 команд: направления, регионы, графики, кто сейчас работает.' },
    ];
  }, [me, incidents, requests, signals, stats, staff, now]);
}

const MENU_W = 320; // ширина меню «Ещё» (как в CSS)
const TIP_W = 340; // ширина подсказки «?»

export function PointApp() {
  const me = useStore((s) => s.me)!;
  const tab = useStore((s) => s.tab);
  const tabs = useTabs();
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(savedTab(me.role) && tabs.some((t) => t.id === savedTab(me.role)) ? savedTab(me.role) : 'inbox');
  }, [tab, tabs, me.role]);
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0];
  hotNav.tabs = tabs.map((t) => t.id);
  const main = tabs.filter((t) => !t.more);
  const more = tabs.filter((t) => t.more);
  // Меню «Ещё» и подсказка «?» — поверх полосы вкладок (у неё своя прокрутка), поэтому позиция фиксированная.
  const moreBtn = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [help, setHelp] = useState<{ x: number; y: number } | null>(null);
  // Всплывашка не выходит за края окна: прижимается к правому краю, если кнопка близко к нему.
  const place = (el: HTMLElement | null, width: number, alignRight = false) => {
    const r = el!.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = Math.min(width, vw - 24);
    const x = alignRight ? r.right - w : r.left;
    return { x: Math.max(12, Math.min(x, vw - w - 12)), y: r.bottom + 6 };
  };
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('.more-menu, .stab-more')) setMenu(null);
    };
    const shut = () => setMenu(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('resize', shut);
    };
  }, [menu]);
  return (
    <div className="pointapp">
      <nav className="stagebar" aria-label="Шаги работы пункта">
        {main.map((t, k) => {
          const nextFlow = t.flow && main[k + 1]?.flow;
          return (
            <span key={t.id} className="stage-wrap">
              {!t.flow && main[k - 1]?.flow && <span className="stage-gap" />}
              <button data-tab={t.id} className={`stab ${t.id === cur.id ? 'on' : ''} ${t.tone ?? ''}`} onClick={() => setTab(t.id)} aria-current={t.id === cur.id ? 'page' : undefined}>
                <t.icon size={15} />
                <span>{t.label}</span>
                {t.count !== undefined && <span key={t.count} className="stage-n num pop">{t.count}</span>}
              </button>
              {nextFlow && <ChevronRight size={15} className="stage-arrow" />}
            </span>
          );
        })}
        <span className="stage-wrap">
          <button
            ref={moreBtn}
            data-tab={cur.more ? cur.id : 'more'}
            className={`stab stab-more ${cur.more ? 'on' : ''}`}
            onClick={() => setMenu((m) => (m ? null : place(moreBtn.current, MENU_W)))}
            aria-expanded={!!menu}
            aria-haspopup="menu"
          >
            {cur.more ? <cur.icon size={15} /> : <MoreHorizontal size={15} />}
            <span>{cur.more ? cur.label : 'Ещё'}</span>
            <ChevronDown size={14} />
          </button>
        </span>
        <span className="stage-sp" />
        <button
          ref={helpRef}
          className="stage-help"
          aria-label={`Что на этой вкладке: ${cur.hint}`}
          onMouseEnter={() => setHelp(place(helpRef.current, TIP_W, true))}
          onMouseLeave={() => setHelp(null)}
          onFocus={() => setHelp(place(helpRef.current, TIP_W, true))}
          onBlur={() => setHelp(null)}
        >
          <CircleHelp size={18} />
        </button>
      </nav>
      {menu && (
        <div className="more-menu" role="menu" style={{ left: menu.x, top: menu.y, maxHeight: `calc(100vh - ${menu.y + 12}px)` }}>
          {more.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              className={t.id === cur.id ? 'on' : ''}
              onClick={() => {
                setTab(t.id);
                setMenu(null);
              }}
            >
              <t.icon size={17} />
              <span className="mm-text">
                <b>{t.label}</b>
                <small>{t.hint.split('. ')[0].replace(/\.$/, '')}</small>
              </span>
              {t.count !== undefined && <span className="stage-n num">{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      {help && (
        <div className="stage-help-tip" role="tooltip" style={{ left: help.x, top: help.y }}>
          <b>{cur.label}</b>
          {cur.hint}
        </div>
      )}
      <div className="stage-body">
        {cur.id === 'desk' && <Desk />}
        {cur.id === 'map' && <MapPage />}
        {cur.id === 'inbox' && <InboxPage />}
        {cur.id === 'teams' && <TeamsPage />}
        {cur.id === 'done' && <DonePage />}
        {cur.id === 'reviews' && <ReviewsPage />}
        {cur.id === 'requests' && <RequestsPage />}
        {cur.id === 'signals' && <SignalsPage />}
        {cur.id === 'ai' && <AiPage />}
        {cur.id === 'directory' && <Directory />}
        {cur.id === 'shift' && <ShiftPage />}
        {cur.id === 'wall' && <Dashboard />}
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
        <Replay />
      </div>
      <Detector />
    </div>
  );
}

/** Список слева, карточка справа: общий каркас для «Входящих», «У команд», «Решено», «Распределить». */
function ListWithCard({ list, empty, emptyHint, emptyAction, header, row }: { list: Incident[]; empty: string; emptyHint?: string; emptyAction?: { label: string; run: () => void }; header?: React.ReactNode; row?: (i: Incident, sel: boolean) => React.ReactNode }) {
  const selectedId = useStore((s) => s.selectedId);
  const sel = list.find((i) => i.id === selectedId) ?? list[0];
  hotNav.list = list.slice(0, 100).map((i) => i.id);
  useEffect(() => {
    if (sel && sel.id !== selectedId) select(sel.id);
  }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page-split">
      <section className="panel plist">
        {header}
        <div className="pl-rows">
          {!list.length && <Empty icon={PartyPopper} title={empty} hint={emptyHint} action={emptyAction} />}
          {list.slice(0, 100).map((i) => (row ? <div key={i.id}>{row(i, i.id === sel?.id)}</div> : <IncidentRow key={i.id} inc={i} sel={i.id === sel?.id} onClick={() => select(i.id)} />))}
        </div>
      </section>
      {sel ? (
        <IncidentCard key={sel.id} inc={sel} />
      ) : (
        <section className="panel empty-panel">
          <Empty icon={MousePointerClick} title="Здесь откроется карточка инцидента" hint={list.length ? 'Выберите строку в списке слева' : 'Как только что-то появится в списке — откройте его, и здесь будут шаги: что случилось, что советует ИИ, ваше решение.'} />
        </section>
      )}
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

/**
 * Инцидент открыли извне (Джарвис, поиск, уведомление), а он не попадает в текущий фильтр — переключаем на «Все».
 * Делаем это ещё до отрисовки списка (иначе список успеет выбрать свою первую строку), и только когда сменился
 * выбранный инцидент — чтобы дежурный мог сам переключить фильтр обратно.
 */
function useScopeFollowsSelection(list: Incident[], all: Incident[], showAll: () => void) {
  const selectedId = useStore((s) => s.selectedId);
  const [seen, setSeen] = useState<string | null>(null);
  if (selectedId !== seen) {
    setSeen(selectedId);
    if (selectedId && !list.some((i) => i.id === selectedId) && all.some((i) => i.id === selectedId)) showAll();
  }
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
  useScopeFollowsSelection(list, at, () => setScope('all'));
  return (
    <ListWithCard
      list={list}
      empty={scope === 'mine' ? 'У вас нет новых инцидентов' : scope === 'free' ? 'Все инциденты разобраны' : 'На пункте пусто'}
      emptyHint={scope === 'mine' ? (free.length ? `Без дежурного ждут: ${free.length}` : 'Новые придут сюда, как только ИИ соберёт жалобы в инцидент') : 'Новые инциденты появятся здесь автоматически'}
      emptyAction={scope === 'mine' && free.length ? { label: 'Показать без дежурного', run: () => setScope('free') } : undefined}
      header={
        <>
          <Seg
            value={scope}
            onChange={setScope}
            items={[
              ['mine', 'Мои', mine.length],
              ['free', 'Без дежурного', free.length],
              ['all', 'Все на пункте', at.length],
            ]}
          />
        </>
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
  useScopeFollowsSelection(list, at, () => setScope('all'));
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
        <div className={`trow p-${i.priority} ${sel ? 'sel' : ''} ${now - i.updatedAt < 6000 ? 'is-new' : ''} ${heatClass(heatOf(i, now))}`} style={heatStyle(heatOf(i, now))} role="button" tabIndex={0} onClick={() => select(i.id)} onKeyDown={(e) => e.key === 'Enter' && select(i.id)}>
          <PrioDot p={i.priority} />
          <span className="tr-main">
            <span className="pr-title">{i.title}</span>
            <span className="pr-meta">
              {teamName(i.teamId)}
              {i.assigneeName ? ` · ${i.assigneeName}` : ''}
              {flagged.has(i.id) && <span className="pr-tag warn">сигнал</span>}
              <ForecastChip inc={i} now={now} />
            </span>
            <EscTimer inc={i} now={now} />
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
        {!pending.length && (
          <div className="panel empty-panel">
            <Empty icon={MessageSquareShare} title="Новых запросов от команд нет" hint="Здесь появятся просьбы команд «это не наше — передайте» — ИИ сразу сверит их со справочником." />
          </div>
        )}
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
    <div className="page-split shift-page">
      <div className="shift-col">
        <MyShift />
        <Shift />
      </div>
      <Roster />
    </div>
  );
}
