// Дашборд координатора — видеостена по кейсу. Видно с расстояния; блоки, стиль и поведение настраиваются
// в «Настройках дашборда» или голосом через Джарвиса. Прежняя стена — раскладка «Прежняя стена».
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, BellRing, Bot, CheckCircle2, Expand, MonitorUp, Settings2, Sparkles, X } from 'lucide-react';
import type { FeedEvent, Incident } from '../../../shared/types';
import { BLOCK_NAME, DASH_GROUPS, GROUP_NAME, PRESET_NAME, dashSnapshot, fmtShort, groupsOf, riskOf, transferCount, transfers, waitingTake, type Attention, type BlockId, type DashGroup, type DashSnapshot } from '../../../shared/dash';
import { dashStyleById, type DashStyle } from '../../../shared/dashStyles';
import { openIncident, setTab, teamName, useStore } from '../../store';
import { fmtClock } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { openWallWindow, setDash, useDash, useDashEvents, type DashLayout } from '../../lib/dashLayout';
import { Jarvis, jarvisAsk, jarvisPrefs, jarvisReady } from '../Jarvis';
import { RFMap } from '../RFMap';
import { Spark } from '../kit';
import { WallPage } from '../WallPage';
import { DashSettings } from './DashSettings';
import './dash.css';

const MIN = 60_000;
const PRIO: Record<Incident['priority'], string> = { P1: 'Критический', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' };
const shortId = (id: string) => id.replace(/^INC0*/, 'INC ');
const who = (i: Incident) =>
  i.status === 'coordinators' ? `На координаторах${i.coordinatorName ? ` · ведёт ${i.coordinatorName}` : ''}` : `${teamName(i.teamId)}${i.assigneeName ? ` · ${i.assigneeName}` : ' · никто не взял'}`;
const frac = (i: Incident, now: number) => Math.min(1, Math.max(0, (now - i.createdAt) / Math.max(MIN, i.slaDeadline - i.createdAt)));
const leftText = (i: Incident, now: number) => (i.slaDeadline - now > 0 ? fmtShort(i.slaDeadline - now) : `−${fmtShort(now - i.slaDeadline)}`);

function styleVars(s: DashStyle): React.CSSProperties {
  const v: Record<string, string> = {
    '--d-bg': s.bg,
    '--d-panel': s.panel,
    '--d-panel2': s.panel2,
    '--d-line': s.line,
    '--d-text': s.text,
    '--d-muted': s.muted,
    '--d-accent': s.accent,
    '--d-crit': s.crit,
    '--d-high': s.high,
    '--d-mid': s.mid,
    '--d-low': s.low,
    '--d-ok': s.ok,
    '--d-warn': s.warn,
    '--d-radius': `${s.radius ?? 12}px`,
  };
  return v as React.CSSProperties;
}

/** Переход по клику: в ITSM, если адрес задан; иначе — карточка в приложении (или крупно на отдельной стене). */
function useOpen(standalone: boolean, focus: (id: string) => void) {
  const itsmUrl = useStore((s) => s.config?.itsmUrl ?? null);
  return useCallback(
    (i: Incident) => {
      if (itsmUrl) window.open(itsmUrl.replace('{id}', encodeURIComponent(i.id)), '_blank', 'noopener');
      else if (!standalone) {
        setTab(i.status === 'coordinators' ? 'inbox' : 'teams');
        openIncident(i.id);
      } else focus(i.id);
    },
    [itsmUrl, standalone, focus],
  );
}

/** Отдельное окно стены (адрес с ?wall): дашборд на весь экран и, если включено, Джарвис. */
export function StandaloneWall() {
  const d = useDash();
  return (
    <>
      <Dashboard standalone />
      {d.jarvis && <Jarvis />}
    </>
  );
}

export function Dashboard({ standalone = false }: { standalone?: boolean }) {
  const d = useDash();
  const [settings, setSettings] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  useDashEvents(
    useCallback((e) => {
      if (e.type === 'settings') setSettings(e.open);
      if (e.type === 'focus') setFocusId(e.id);
    }, []),
  );
  if (d.preset === 'legacy')
    return (
      <div className="dash-legacy">
        <WallPage standalone={standalone} />
        <button className="dash-gear legacy" onClick={() => setSettings(true)} title="Настройки дашборда">
          <Settings2 size={16} /> Дашборд
        </button>
        {settings && <DashSettings onClose={() => setSettings(false)} />}
      </div>
    );
  return <DashWall d={d} standalone={standalone} settings={settings} setSettings={setSettings} focusId={focusId} setFocusId={setFocusId} />;
}

function DashWall({ d, standalone, settings, setSettings, focusId, setFocusId }: { d: DashLayout; standalone: boolean; settings: boolean; setSettings: (v: boolean) => void; focusId: string | null; setFocusId: (v: string | null) => void }) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(1000);
  const style = dashStyleById(d.style);
  const snap = useMemo(() => dashSnapshot(incidents.values(), now, { filter: d.filter, onlyFile: d.onlyFile }), [incidents, now, d.filter, d.onlyFile]);
  const open = useOpen(standalone, setFocusId);
  const alerts = useAlerts(incidents, d);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (setFocusId(null), alerts.dismiss());
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [alerts, setFocusId]);
  const ctx: BlockCtx = { snap, now, d, style, open, standalone };
  const inWall = new Set(d.columns.map((c) => c.block));
  return (
    <div
      className={`dash ${standalone ? 'standalone' : ''} ${alerts.top?.kind === 'crit' ? 'dash-alarm' : ''}`}
      data-dark={style.dark ? '1' : '0'}
      data-card={style.card ?? 'solid'}
      data-font={style.font ?? 'sans'}
      data-glow={style.glow ? '1' : '0'}
      data-density={d.density}
      style={styleVars(style)}
    >
      {d.counters && <DashHeader snap={snap} now={now} d={d} />}
      <div className="dash-cols" style={{ gridTemplateColumns: d.columns.map((c) => `minmax(0, ${c.width}fr)`).join(' ') }}>
        {d.columns.map((c, k) => (
          <section key={`${k}-${c.block}`} className={`dash-col b-${c.block}`}>
            <Block id={c.block} ctx={ctx} skip={inWall} />
          </section>
        ))}
      </div>
      {d.ticker && <DashTicker />}
      {alerts.top && <Banner a={alerts.top} more={alerts.list.length - 1} now={now} onClose={alerts.dismiss} onOpen={() => setFocusId(alerts.top!.inc.id)} />}
      {focusId && <FocusCard id={focusId} now={now} onClose={() => setFocusId(null)} />}
      {settings && <DashSettings onClose={() => setSettings(false)} />}
      {!full && (
        <div className="dash-tools">
          <button onClick={() => setSettings(true)} title="Блоки, стиль, тревоги, Джарвис">
            <Settings2 size={15} /> Настройки дашборда
          </button>
          {!standalone && (
            <button onClick={openWallWindow} title="Открыть в отдельном окне — перенести на экран стены">
              <MonitorUp size={15} /> На экран стены
            </button>
          )}
          <button onClick={() => void document.documentElement.requestFullscreen?.()} title="На весь экран (Esc — выйти)">
            <Expand size={15} /> На весь экран
          </button>
        </div>
      )}
    </div>
  );
}

// ─── шапка: часы и счётчики четырёх групп ─────────────────────────────────
function DashHeader({ snap, now, d }: { snap: DashSnapshot; now: number; d: DashLayout }) {
  const c = snap.counts;
  const chip = (g: DashGroup, tone: string) => (
    <button key={g} className={`dh-chip g-${g} ${tone} ${c[g] ? 'on' : ''} ${d.filter === g ? 'sel' : ''}`} onClick={() => setDash({ filter: d.filter === g ? null : g })} title={`${DASH_GROUPS.find((x) => x.id === g)!.hint}. Нажмите — показать только эту группу`}>
      <b className="num">{c[g]}</b>
      <span>{GROUP_NAME[g]}</span>
    </button>
  );
  return (
    <header className="dash-head">
      <div className="dh-title">
        <span className="dh-dot" />
        <div>
          <b>Координирующий пункт ИТ</b>
          <span>
            видеостена · {d.preset === 'custom' ? 'своя раскладка' : PRESET_NAME[d.preset]}
            {d.filter ? ` · только «${GROUP_NAME[d.filter]}»` : ''}
            {d.onlyFile ? ' · только выгрузка ITSM' : ''}
          </span>
        </div>
      </div>
      <div className="dh-chips">
        {chip('crit', c.crit ? 'hot' : '')}
        {chip('coord', c.coord ? 'warn' : '')}
        {chip('high', '')}
        {chip('research', '')}
        <span className="dh-sep" />
        <span className={`dh-mini ${c.threat ? 'warn' : ''}`}>
          <b className="num">{c.threat}</b> срок под угрозой
        </span>
        <span className={`dh-mini ${c.notTaken ? 'warn' : ''}`}>
          <b className="num">{c.notTaken}</b> не берут 10+ мин
        </span>
        <span className={`dh-mini ${c.pingpong ? 'warn' : ''}`}>
          <b className="num">{c.pingpong}</b> повторные передачи
        </span>
        <span className="dh-mini ok">
          <b className="num">{c.doneHour}</b> решено за час
        </span>
      </div>
      <div className="dh-clock">
        <b className="num">{fmtClock(now)}</b>
        <span>{new Date(now).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })} · МСК</span>
      </div>
    </header>
  );
}

// ─── блоки ────────────────────────────────────────────────────────────────
interface BlockCtx {
  snap: DashSnapshot;
  now: number;
  d: DashLayout;
  style: DashStyle;
  open: (i: Incident) => void;
  standalone: boolean;
}
function Block({ id, ctx, skip }: { id: BlockId; ctx: BlockCtx; skip: Set<BlockId> }) {
  switch (id) {
    case 'action':
      return <ActionBlock ctx={ctx} />;
    case 'work':
      return <WorkBlock ctx={ctx} />;
    case 'groups':
      return <GroupsBlock ctx={ctx} />;
    case 'assistant':
      return <AssistantBlock ctx={ctx} />;
    case 'transfers':
      return <TransfersBlock ctx={ctx} />;
    case 'stats':
      return <StatsBlock ctx={ctx} />;
    case 'events':
      return <EventsBlock />;
    case 'map':
      return (
        <div className="db db-map">
          <BlockHead title="Карта жалоб" />
          <div className="db-map-in">
            <RFMap forceTheme={ctx.style.dark ? 'dark' : 'light'} />
          </div>
        </div>
      );
    case 'rotate':
      return <RotateBlock ctx={ctx} skip={skip} />;
  }
}

function BlockHead({ title, count, right, icon }: { title: string; count?: number; right?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="db-head">
      {icon}
      <h2>{title}</h2>
      {count !== undefined && <span className="db-count num">{count}</span>}
      <span className="db-sp" />
      {right}
    </div>
  );
}

/** Сколько элементов списка помещается; если не все — листаем страницами. */
function useFitPager(total: number, sec: number) {
  const box = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(0);
  const [fit, setFit] = useState(total);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = el.clientHeight;
    let n = 0;
    for (const c of Array.from(el.children) as HTMLElement[]) {
      if (c.offsetTop + c.offsetHeight <= h + 2) n++;
      else break;
    }
    if (n !== fit) setFit(Math.max(1, n));
  });
  const pages = fit > 0 ? Math.ceil(total / fit) : 1;
  useEffect(() => {
    if (start >= total) setStart(0);
  }, [start, total]);
  useEffect(() => {
    if (total <= fit && start === 0) return;
    const t = setInterval(() => setStart((s) => (s + fit >= total ? 0 : s + fit)), sec * 1000);
    return () => clearInterval(t);
  }, [fit, total, sec, start]);
  const page = Math.floor(start / Math.max(1, fit));
  return { box, start, fit, pages, page, paged: total > fit };
}
function PagerFoot({ p, total, sec, label }: { p: ReturnType<typeof useFitPager>; total: number; sec: number; label: string }) {
  if (!p.paged) return null;
  return (
    <div className="db-foot">
      <span>
        {label} {p.start + 1}–{Math.min(total, p.start + p.fit)} из {total} · листается каждые {sec} с
      </span>
      <span className="db-dots">
        {Array.from({ length: Math.min(12, p.pages) }, (_, k) => (
          <i key={k} className={k === p.page ? 'on' : ''} />
        ))}
      </span>
    </div>
  );
}

function GroupTags({ i, skip }: { i: Incident; skip?: DashGroup }) {
  const g = groupsOf(i).filter((x) => x !== skip);
  if (!g.length) return null;
  return (
    <span className="dc-tags">
      {g.map((x) => (
        <span key={x} className={`dc-tag g-${x}`}>
          {DASH_GROUPS.find((y) => y.id === x)!.short}
        </span>
      ))}
    </span>
  );
}

/** Карточка инцидента: продукт, когда возник, кто решает, статус, срок — и почему требует внимания. */
function IncCard({ i, att, now, big, onClick, off }: { i: Incident; att?: Attention; now: number; big?: boolean; onClick: () => void; off?: boolean }) {
  const t = transferCount(i);
  const risk = i.priority === 'P2' ? riskOf(i, now) : null;
  const left = i.slaDeadline - now;
  return (
    <button className={`dc p-${i.priority} ${big ? 'big' : ''} ${att ? `t-${att.tone}` : ''} ${off ? 'off' : ''}`} onClick={onClick} title="Открыть в ITSM" aria-hidden={off || undefined} tabIndex={off ? -1 : undefined}>
      <span className="dc-bar" />
      <span className="dc-main">
        <span className="dc-top">
          <span className={`dc-prio p-${i.priority}`}>{PRIO[i.priority]}</span>
          <span className="dc-id num">{shortId(i.id)}</span>
          <GroupTags i={i} />
          {t > 0 && (
            <span className={`dc-tr ${t >= 2 ? 'warn' : ''}`} title="Передач между командами">
              <ArrowLeftRight size={12} /> {t}
            </span>
          )}
        </span>
        <b className="dc-title">{i.title}</b>
        <span className="dc-meta">
          <span>{i.productName || i.service}</span>
          <span>
            возник {fmtClock(i.createdAt)} · {fmtShort(now - i.createdAt)} назад
          </span>
        </span>
        <span className="dc-meta">
          <span className="dc-who">{who(i)}</span>
          <span className="dc-state">{i.stateText}</span>
        </span>
        {att && <span className={`dc-why t-${att.tone}`}>{att.reason}</span>}
        {i.status === 'coordinators' && i.ai?.teamId && (
          <span className="dc-ai">
            <Sparkles size={12} /> ИИ: передать в «{teamName(i.ai.teamId)}»
          </span>
        )}
        {risk && risk.score >= 55 && (
          <span className="dc-ai dc-risk">
            <Sparkles size={12} /> риск стать критическим {risk.score}%{risk.reasons[0] ? ` — ${risk.reasons[0]}` : ''}
          </span>
        )}
      </span>
      <span className={`dc-sla ${left < 30 * MIN ? 'hot' : ''}`}>
        <small>{left > 0 ? 'до срока' : 'срок прошёл'}</small>
        <b className="num">{left > 0 ? fmtShort(left) : fmtShort(-left)}</b>
        <span className="dc-sla-bar">
          <i style={{ width: `${frac(i, now) * 100}%` }} />
        </span>
      </span>
    </button>
  );
}

function ActionBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now, d } = ctx;
  const crit = snap.action.filter((x) => x.inc.priority === 'P1');
  const rest = snap.action.filter((x) => x.inc.priority !== 'P1');
  const p = useFitPager(rest.length, d.pageSec);
  return (
    <div className="db db-action">
      <BlockHead title={d.filter ? `Требует действия · ${GROUP_NAME[d.filter]}` : 'Требует действия сейчас'} count={snap.action.length} icon={<BellRing size={18} />} />
      {snap.resolvedCrit.map((i) => (
        <div key={i.id} className="dc-resolved">
          <CheckCircle2 size={18} />
          <span>
            <b>Критический решён</b> · {i.title} · за {fmtShort((i.resolvedAt ?? now) - i.createdAt)}
          </span>
          <span className="num">{fmtShort(now - (i.resolvedAt ?? now))} назад</span>
        </div>
      ))}
      {crit.length > 0 && (
        <div className="db-crit">
          {crit.map(({ inc, att }) => (
            <IncCard key={inc.id} i={inc} att={att} now={now} big onClick={() => ctx.open(inc)} />
          ))}
        </div>
      )}
      {!snap.action.length && !snap.resolvedCrit.length && <div className="db-empty">Ничего не требует действия — всё под контролем</div>}
      <div className="db-list" ref={p.box}>
        {rest.slice(p.start).map(({ inc, att }, k) => (
          <IncCard key={inc.id} i={inc} att={att} now={now} onClick={() => ctx.open(inc)} off={k >= p.fit} />
        ))}
      </div>
      <PagerFoot p={p} total={rest.length} sec={d.pageSec} label="показаны" />
    </div>
  );
}

function WorkBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now, d } = ctx;
  const p = useFitPager(snap.work.length, d.pageSec);
  return (
    <div className="db db-work">
      <BlockHead title="В работе у команд" count={snap.work.length} />
      <div className="dw-row dw-h">
        <span>Инцидент</span>
        <span>В работе</span>
        <span>До срока</span>
        <span>Передач</span>
        <span>Команда · статус</span>
      </div>
      <div className="db-list" ref={p.box}>
        {snap.work.slice(p.start).map((i, n) => {
          const w = waitingTake(i, now);
          const since = i.startedAt ?? i.routedAt ?? i.createdAt;
          const t = transferCount(i);
          const hops = transfers(i);
          return (
            <button key={i.id} className={`dw-row p-${i.priority} ${n >= p.fit ? 'off' : ''}`} onClick={() => ctx.open(i)} aria-hidden={n >= p.fit || undefined} tabIndex={n >= p.fit ? -1 : undefined}>
              <span className="dw-inc">
                <span className={`dw-p p-${i.priority}`}>{i.priority}</span>
                <span>
                  <b>{i.title}</b>
                  <small>{i.productName || i.service}</small>
                </span>
              </span>
              <span className={`dw-time ${w !== null && w > 10 * MIN ? 'warn' : ''}`}>
                <b className="num">{fmtShort(w ?? now - since)}</b>
                <small>{w !== null ? 'не взяли' : i.status === 'in_progress' ? 'в работе' : 'у команды'}</small>
              </span>
              <span className={`dw-sla ${i.slaDeadline - now < 30 * MIN ? 'hot' : ''}`}>
                <b className="num">{leftText(i, now)}</b>
                <span className="dc-sla-bar">
                  <i style={{ width: `${frac(i, now) * 100}%` }} />
                </span>
              </span>
              <span className={`num dw-tr ${t >= 2 ? 'warn' : ''}`}>
                <ArrowLeftRight size={13} /> {t}
              </span>
              <span className="dw-team">
                <b>{hops.at(-1)?.team ?? teamName(i.teamId)}</b>
                <small>{i.assigneeName ?? '—'} · {i.stateText}</small>
              </span>
            </button>
          );
        })}
        {!snap.work.length && <div className="db-empty">У команд сейчас ничего нет</div>}
      </div>
      <PagerFoot p={p} total={snap.work.length} sec={d.pageSec} label="показаны" />
    </div>
  );
}

function GroupsBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  return (
    <div className="db db-groups">
      {DASH_GROUPS.map((g) => (
        <div key={g.id} className={`dg g-${g.id}`}>
          <div className="dg-head">
            <b>{g.label}</b>
            <span className="num">{snap.byGroup[g.id].length}</span>
          </div>
          <small className="dg-hint">{g.hint}</small>
          <div className="dg-list">
            {g.id === 'crit' &&
              snap.resolvedCrit.map((i) => (
                <div key={i.id} className="dg-row resolved">
                  <CheckCircle2 size={14} />
                  <span>
                    <b>{i.title}</b>
                    <small>решён {fmtShort(now - (i.resolvedAt ?? now))} назад</small>
                  </span>
                </div>
              ))}
            {snap.byGroup[g.id].map((i) => (
              <button key={i.id} className={`dg-row p-${i.priority}`} onClick={() => ctx.open(i)}>
                <span className="dc-bar" />
                <span>
                  <b>{i.title}</b>
                  <small>
                    {i.productName || i.service} · {who(i)}
                  </small>
                  <small>
                    {i.stateText} · <GroupTags i={i} skip={g.id} />
                  </small>
                </span>
                <span className={`num dg-left ${i.slaDeadline - now < 30 * MIN ? 'hot' : ''}`}>{leftText(i, now)}</span>
              </button>
            ))}
            {!snap.byGroup[g.id].length && g.id !== 'crit' && <div className="db-empty small">пусто</div>}
            {!snap.byGroup.crit.length && !snap.resolvedCrit.length && g.id === 'crit' && <div className="db-empty small">критических нет</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── ИИ-помощник: главное сейчас, риск, кому передать и команды Джарвису ──
let briefCache: { at: number; text: string; llm: boolean } | null = null;
function useBrief() {
  const [b, setB] = useState(briefCache);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch('/api/dash/brief');
        if (r.ok) {
          const x = (await r.json()) as { text: string; llm: boolean };
          briefCache = { at: Date.now(), ...x };
          if (!dead) setB(briefCache);
        }
      } catch {
        /* покажем, что есть */
      }
    };
    if (!briefCache || Date.now() - briefCache.at > 40_000) void load();
    const t = setInterval(load, 45_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);
  return b;
}
// Разговор с помощником живёт вне блока: Джарвис может переставить сам блок, и разговор не должен пропасть.
let assistLog: { q: string; a: string }[] = [];
const HINTS = ['Покажи только критические', 'Поменяй местами левый и правый блоки', 'Покажи крупно самый срочный', 'Стиль «Центр управления»', 'Добавь карту', 'Раскладка «Четыре группы»'];
function AssistantBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  const brief = useBrief();
  const [text, setText] = useState('');
  const [log, setLogState] = useState(assistLog);
  const setLog = (f: (l: typeof assistLog) => typeof assistLog) => {
    assistLog = f(assistLog);
    setLogState(assistLog);
  };
  const [busy, setBusy] = useState(false);
  const ready = jarvisReady();
  const risks = useMemo(
    () =>
      snap.action
        .map((x) => x.inc)
        .filter((i) => i.priority !== 'P1')
        .map((i) => ({ i, r: riskOf(i, now) }))
        .filter((x) => x.r.score >= 45)
        .sort((a, b) => b.r.score - a.r.score)
        .slice(0, 3),
    [snap, now],
  );
  const route = snap.byGroup.coord.filter((i) => i.ai?.teamId).slice(0, 3);
  const send = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setText('');
    const a = await jarvisAsk(q, { quiet: true });
    setLog((l) => [...l.slice(-2), { q, a: a || 'Джарвис занят — повторите через секунду.' }]);
    setBusy(false);
  };
  return (
    <div className="db db-ai">
      <BlockHead title="ИИ-помощник" icon={<Bot size={18} />} right={<span className={`db-live ${ready && jarvisPrefs.control ? 'on' : ''}`}>{ready ? (jarvisPrefs.control ? 'Джарвис слушает' : 'Джарвис — по кнопке') : 'Джарвис выключен'}</span>} />
      <div className="da-brief">
        <small>
          <Sparkles size={12} /> Главное сейчас{brief?.llm ? ' · ИИ' : ''}
        </small>
        <p>{brief?.text ?? (snap.action[0] ? `Главное — «${snap.action[0].inc.title}»: ${snap.action[0].att.reason.toLowerCase()}.` : 'Срочного нет — всё под контролем.')}</p>
      </div>
      {risks.length > 0 && (
        <div className="da-sec">
          <small>Риск стать критическим</small>
          {risks.map(({ i, r }) => (
            <button key={i.id} className="da-row" onClick={() => ctx.open(i)}>
              <b className="num">{r.score}%</b>
              <span>
                {i.title}
                <small>{r.reasons.slice(0, 2).join(', ') || PRIO[i.priority]}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {route.length > 0 && (
        <div className="da-sec">
          <small>Кому передать (на координаторах)</small>
          {route.map((i) => (
            <button key={i.id} className="da-row" onClick={() => ctx.open(i)}>
              <b className="num">{Math.round((i.ai.confidence ?? 0) * 100)}%</b>
              <span>
                {i.title}
                <small>→ «{teamName(i.ai.teamId)}»</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {ready ? (
        <div className="da-ask">
          {log.map((x, k) => (
            <div key={k} className="da-log">
              <span className="q">{x.q}</span>
              <span className="a">{x.a}</span>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={busy ? 'Джарвис думает…' : 'Скажите «Джарвис, …» или напишите'} disabled={busy} />
          </form>
          <div className="da-hints">
            {HINTS.map((h) => (
              <button key={h} onClick={() => void send(h)} disabled={busy}>
                {h}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="db-empty small">Включите Джарвиса в настройках дашборда, чтобы управлять стеной голосом.</div>
      )}
    </div>
  );
}

function TransfersBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  const list = useMemo(
    () =>
      snap.action
        .map((x) => x.inc)
        .concat(snap.work)
        .filter((i, k, a) => a.indexOf(i) === k && transfers(i).length > 0)
        .sort((a, b) => transferCount(b) - transferCount(a) || Number(b.priority < a.priority) - Number(a.priority < b.priority))
        .slice(0, 6),
    [snap],
  );
  return (
    <div className="db db-tr">
      <BlockHead title="История передач" icon={<ArrowLeftRight size={18} />} />
      {!list.length && <div className="db-empty">Передач между командами пока не было</div>}
      {list.map((i) => {
        const hops = transfers(i);
        const seen = new Set<string>();
        return (
          <button key={i.id} className={`dt p-${i.priority}`} onClick={() => ctx.open(i)}>
            <span className="dt-top">
              <span className={`dc-prio p-${i.priority}`}>{PRIO[i.priority]}</span>
              <b>{i.title}</b>
              <span className={`dc-tr ${hops.length >= 2 ? 'warn' : ''}`}>
                <ArrowLeftRight size={12} /> {hops.length}
              </span>
            </span>
            <span className="dt-chain">
              <span className="dt-hop start">Пункт</span>
              {hops.map((h, k) => {
                const again = seen.has(h.team);
                seen.add(h.team);
                return (
                  <span key={k} className="dt-step">
                    <i>→</i>
                    <span className={`dt-hop ${again ? 'again' : ''} ${k === hops.length - 1 ? 'last' : ''}`}>
                      {h.team}
                      <small className="num">{fmtClock(h.at)}</small>
                    </span>
                  </span>
                );
              })}
            </span>
            <small className="dt-now">
              сейчас: {who(i)} · до срока {leftText(i, now)}
            </small>
          </button>
        );
      })}
    </div>
  );
}

function StatsBlock({ ctx }: { ctx: BlockCtx }) {
  const { snap, now } = ctx;
  const incidents = useStore((s) => s.incidents);
  const complaints = useStore((s) => s.complaints);
  const stats = useStore((s) => s.stats);
  const k = useMemo(() => {
    const all = [...incidents.values()];
    const from = now - 12 * 3_600_000;
    const done = all.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from);
    const inTime = done.filter((i) => (i.resolvedAt ?? 0) <= i.slaDeadline).length;
    const route: number[] = [];
    for (const i of all) {
      if (i.createdAt < from) continue;
      const h = transfers(i)[0];
      if (h) route.push(h.at - i.createdAt);
    }
    const series = new Array(12).fill(0);
    for (const c of complaints) {
      const b = Math.floor((now - c.at) / 300_000);
      if (b >= 0 && b < 12) series[11 - b]++;
    }
    return { done: done.length, inTime: done.length ? Math.round((inTime / done.length) * 100) : null, route: route.length ? route.reduce((a, b) => a + b, 0) / route.length : null, series };
  }, [incidents, complaints, now]);
  const c = snap.counts;
  const max = Math.max(1, c.crit, c.coord, c.high, c.research);
  return (
    <div className="db db-stats">
      <BlockHead title="Смена в цифрах" />
      <div className="ds-grid">
        <div className="ds-k">
          <b className="num">{c.open}</b>
          <span>открыто</span>
        </div>
        <div className="ds-k">
          <b className="num">{c.atTeams}</b>
          <span>у команд</span>
        </div>
        <div className="ds-k ok">
          <b className="num">{k.done}</b>
          <span>решено за 12 ч</span>
        </div>
        <div className="ds-k">
          <b className="num">{k.inTime === null ? '—' : `${k.inTime}%`}</b>
          <span>решено в срок</span>
        </div>
        <div className="ds-k">
          <b className="num">{k.route === null ? '—' : fmtShort(k.route)}</b>
          <span>в среднем до передачи</span>
        </div>
        <div className="ds-k">
          <b className="num">{stats?.flowPerMin ?? 0}</b>
          <span>жалоб в минуту</span>
        </div>
      </div>
      <div className="ds-spark">
        <small>Жалобы за час, по 5 минут</small>
        <Spark values={k.series} width={320} height={48} />
      </div>
      <div className="ds-bars">
        {DASH_GROUPS.map((g) => (
          <div key={g.id} className={`ds-bar g-${g.id}`}>
            <span>{g.label}</span>
            <i style={{ width: `${(c[g.id] / max) * 100}%` }} />
            <b className="num">{c[g.id]}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_TEXT: Partial<Record<FeedEvent['kind'], string>> = { p1: 'Критический', coordinators: 'На координаторах', resolved: 'Решён', routed: 'Передан', escalated: 'Эскалация', sla_breach: 'Срок прошёл', sla_warning: 'Срок близко', priority_up: 'Уровень выше', created: 'Новый', assigned: 'Назначен', in_progress: 'Взяли' };
function EventsBlock() {
  const feed = useStore((s) => s.feed);
  const incidents = useStore((s) => s.incidents);
  return (
    <div className="db db-events">
      <BlockHead title="Лента событий" />
      <div className="de-list">
        {feed.slice(0, 18).map((e) => (
          <div key={e.id} className={`de k-${e.kind}`}>
            <b className="num">{fmtClock(e.at)}</b>
            <span>
              <em>{KIND_TEXT[e.kind] ?? e.text}</em> {incidents.get(e.incidentId)?.title ?? ''}
              <small>{e.text}</small>
            </span>
          </div>
        ))}
        {!feed.length && <div className="db-empty">Событий пока нет</div>}
      </div>
    </div>
  );
}

const ROTATION: BlockId[] = ['assistant', 'transfers', 'stats', 'events'];
function RotateBlock({ ctx, skip }: { ctx: BlockCtx; skip: Set<BlockId> }) {
  const items = ROTATION.filter((b) => !skip.has(b));
  const list = items.length ? items : ROTATION;
  const [k, setK] = useState(0);
  // Пока на панель смотрят мышью или печатают Джарвису — не листаем.
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (hold) return;
    const t = setInterval(() => setK((x) => x + 1), ctx.d.rotateSec * 1000);
    return () => clearInterval(t);
  }, [ctx.d.rotateSec, hold]);
  const cur = list[k % list.length];
  return (
    <div
      className="db-rotate"
      onMouseEnter={() => setHold(true)}
      onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHold(false)}
    >
      <div className="dr-tabs">
        {list.map((b, n) => (
          <button key={b} className={b === cur ? 'on' : ''} onClick={() => setK(n)}>
            {BLOCK_NAME[b]}
          </button>
        ))}
      </div>
      <div className="dr-body" key={cur}>
        <Block id={cur} ctx={ctx} skip={skip} />
      </div>
    </div>
  );
}

function DashTicker() {
  const feed = useStore((s) => s.feed);
  const incidents = useStore((s) => s.incidents);
  const ticker = feed.slice(0, 14);
  if (!ticker.length) return null;
  return (
    <footer className="dash-ticker">
      <div className="dt-track">
        {[...ticker, ...ticker].map((e, n) => (
          <span key={`${e.id}${n}`} className={`dt-ev k-${e.kind}`}>
            <b className="num">{fmtClock(e.at)}</b> {e.text} <i>·</i> {incidents.get(e.incidentId)?.title ?? ''}
          </span>
        ))}
      </div>
    </footer>
  );
}

// ─── тревоги: новый критический, критический решён, назначен на координаторов ───
interface Alert {
  key: string;
  kind: 'crit' | 'resolved' | 'coord';
  inc: Incident;
  until: number;
  test?: boolean;
}
const ALERT_MS = { crit: 30_000, resolved: 45_000, coord: 20_000 };
const RANK = { crit: 0, resolved: 1, coord: 2 };
function chime(kind: Alert['kind']) {
  try {
    const ctx = new AudioContext();
    const notes = kind === 'crit' ? [880, 660, 880, 660] : kind === 'resolved' ? [523, 659, 784] : [660, 880];
    notes.forEach((f, k) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = kind === 'crit' ? 'square' : 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + k * 0.22);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + k * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + k * 0.22 + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + k * 0.22);
      o.stop(ctx.currentTime + k * 0.22 + 0.22);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    /* без звука */
  }
}
function useAlerts(incidents: Map<string, Incident>, d: DashLayout) {
  const prev = useRef<{ p1: Set<string>; coord: Set<string> } | null>(null);
  const [list, setList] = useState<Alert[]>([]);
  const dRef = useRef(d);
  dRef.current = d;
  const push = useCallback((a: Omit<Alert, 'until' | 'key'>) => {
    if (!dRef.current.banners) return;
    setList((l) => [...l.filter((x) => !(x.inc.id === a.inc.id && x.kind === a.kind)), { ...a, key: `${a.kind}-${a.inc.id}-${Date.now()}`, until: Date.now() + ALERT_MS[a.kind] }].sort((x, y) => RANK[x.kind] - RANK[y.kind]));
    if (dRef.current.sound) chime(a.kind);
  }, []);
  useEffect(() => {
    const all = [...incidents.values()].filter((i) => !dRef.current.onlyFile || i.origin !== 'complaints');
    const p1 = new Set(all.filter((i) => i.priority === 'P1' && i.status !== 'resolved').map((i) => i.id));
    const coord = new Set(all.filter((i) => i.status === 'coordinators').map((i) => i.id));
    if (prev.current) {
      for (const i of all) {
        if (p1.has(i.id) && !prev.current.p1.has(i.id)) push({ kind: 'crit', inc: i });
        else if (prev.current.p1.has(i.id) && i.status === 'resolved') push({ kind: 'resolved', inc: i });
        if (coord.has(i.id) && !prev.current.coord.has(i.id) && !p1.has(i.id)) push({ kind: 'coord', inc: i });
      }
    }
    prev.current = { p1, coord };
  }, [incidents, push]);
  useDashEvents(
    useCallback(
      (e) => {
        if (e.type !== 'test-alarm') return;
        const any = [...incidents.values()].find((i) => i.status !== 'resolved') ?? [...incidents.values()][0];
        if (any) push({ kind: e.kind, inc: any, test: true });
      },
      [incidents, push],
    ),
  );
  useEffect(() => {
    if (!list.length) return;
    const t = setInterval(() => setList((l) => l.filter((a) => a.until > Date.now())), 1000);
    return () => clearInterval(t);
  }, [list.length]);
  const dismiss = useCallback(() => setList((l) => l.slice(1)), []);
  return useMemo(() => ({ list, top: list[0] ?? null, dismiss }), [list, dismiss]);
}

function Banner({ a, more, now, onClose, onOpen }: { a: Alert; more: number; now: number; onClose: () => void; onOpen: () => void }) {
  const i = a.inc;
  const title = a.kind === 'crit' ? 'Новый критический инцидент' : a.kind === 'resolved' ? 'Критический инцидент решён' : 'Назначен на координаторов — передать в команду';
  return (
    <div className={`dash-banner k-${a.kind}`} role="alert">
      <div className="dbn-in" onClick={onOpen}>
        <span className="dbn-icon">{a.kind === 'resolved' ? <CheckCircle2 size={34} /> : <BellRing size={34} />}</span>
        <span className="dbn-text">
          <small>
            {title}
            {a.test ? ' · проверка' : ''}
          </small>
          <b>{i.title}</b>
          <span>
            {i.productName || i.service} · {a.kind === 'resolved' ? `решён за ${fmtShort((i.resolvedAt ?? now) - i.createdAt)}` : `${who(i)} · до срока ${leftText(i, now)}`}
            {a.kind === 'coord' && i.ai?.teamId ? ` · ИИ советует «${teamName(i.ai.teamId)}»` : ''}
          </span>
        </span>
        {more > 0 && <span className="dbn-more">ещё {more}</span>}
      </div>
      <button className="dbn-x" onClick={onClose} aria-label="Скрыть">
        <X size={20} />
      </button>
    </div>
  );
}

/** Крупно один инцидент — по команде Джарвиса «покажи крупно…» или по клику на отдельной стене. */
function FocusCard({ id, now, onClose }: { id: string; now: number; onClose: () => void }) {
  const inc = useStore((s) => s.incidents.get(id));
  useEffect(() => {
    const t = setTimeout(onClose, 45_000);
    return () => clearTimeout(t);
  }, [id, onClose]);
  if (!inc) return null;
  const hops = transfers(inc);
  const r = riskOf(inc, now);
  return (
    <div className="dash-focus" onClick={onClose}>
      <div className={`df-card p-${inc.priority}`} onClick={(e) => e.stopPropagation()}>
        <button className="dbn-x" onClick={onClose} aria-label="Закрыть">
          <X size={22} />
        </button>
        <span className="dc-top">
          <span className={`dc-prio p-${inc.priority}`}>{PRIO[inc.priority]}</span>
          <span className="dc-id num">{shortId(inc.id)}</span>
          <GroupTags i={inc} />
        </span>
        <h1>{inc.title}</h1>
        <p className="df-desc">{inc.shortDescription || inc.description}</p>
        <div className="df-grid">
          <div>
            <small>Продукт</small>
            <b>{inc.productName || inc.service}</b>
          </div>
          <div>
            <small>Возник</small>
            <b>
              {fmtClock(inc.createdAt)} · {fmtShort(now - inc.createdAt)} назад
            </b>
          </div>
          <div>
            <small>Кто решает</small>
            <b>{who(inc)}</b>
          </div>
          <div>
            <small>Статус</small>
            <b>{inc.status === 'resolved' ? 'Решён' : inc.stateText}</b>
          </div>
          <div className={inc.slaDeadline - now < 30 * MIN ? 'hot' : ''}>
            <small>До срока</small>
            <b className="num">{leftText(inc, now)}</b>
          </div>
          <div>
            <small>Передач</small>
            <b className="num">{transferCount(inc)}</b>
          </div>
        </div>
        {hops.length > 0 && (
          <div className="dt-chain big">
            <span className="dt-hop start">Пункт</span>
            {hops.map((h, k) => (
              <span key={k} className="dt-step">
                <i>→</i>
                <span className="dt-hop">
                  {h.team}
                  <small className="num">{fmtClock(h.at)}</small>
                </span>
              </span>
            ))}
          </div>
        )}
        {(inc.ai?.teamId || r.score > 0) && (
          <div className="df-ai">
            <Sparkles size={16} />
            {inc.ai?.teamId && inc.status === 'coordinators' ? `ИИ советует передать в «${teamName(inc.ai.teamId)}». ` : ''}
            {r.score > 0 ? `Риск стать критическим ${r.score}%${r.reasons.length ? `: ${r.reasons.join(', ')}` : ''}.` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
