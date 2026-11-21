// Дашборд координатора — видеостена по кейсу. Видно с расстояния; блоки, стиль и поведение настраиваются
// в «Настройках дашборда» или голосом через Джарвиса. Прежняя стена — раскладка «Прежняя стена».
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ArrowRight, BellRing, Bot, CheckCircle2, Expand, LayoutGrid, MonitorUp, Settings2, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { FeedEvent, Incident } from '../../../shared/types';
import { BLOCKS, BLOCK_NAME, DASH_GROUPS, GROUP_NAME, dashSnapshot, type DashColumn, fmtShort, groupsOf, riskOf, transferCount, transfers, waitingTake, type Attention, type BlockId, type DashGroup, type DashSnapshot } from '../../../shared/dash';
import type { DashStyle } from '../../../shared/dashStyles';
import { personaById } from '../../../shared/personas';
import { openIncident, setTab, teamName, useStore } from '../../store';
import { fmtClock } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { applyDashOp, currentStyle, getDash, openWallWindow, openWork, setDash, useDash, useDashEvents, type DashLayout } from '../../lib/dashLayout';
import { BLOCK_OPTS } from './blockOpts';
import { Jarvis, jarvisAsk, jarvisPrefs, jarvisReady } from '../Jarvis';
import { RFMap } from '../RFMap';
import { Spark } from '../kit';
import { WallPage } from '../WallPage';
import { DashSettings } from './DashSettings';
import './dash.css';

const MIN = 60_000;
type Opts = Record<string, boolean | number> | undefined;
const ob = (o: Opts, k: string, def = true) => (typeof o?.[k] === 'boolean' ? (o[k] as boolean) : def);
const on = (o: Opts, k: string, def: number) => (typeof o?.[k] === 'number' ? (o[k] as number) : def);
const PRIO: Record<Incident['priority'], string> = { P1: 'Критический', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' };
const shortId = (id: string) => id.replace(/^INC0*/, 'INC ');
const who = (i: Incident) =>
  i.status === 'coordinators' ? `На координаторах${i.coordinatorName ? ` · ведёт ${i.coordinatorName}` : ''}` : `${teamName(i.teamId)}${i.assigneeName ? ` · ${i.assigneeName}` : ' · никто не взял'}`;
const frac = (i: Incident, now: number) => Math.min(1, Math.max(0, (now - i.createdAt) / Math.max(MIN, i.slaDeadline - i.createdAt)));
const leftText = (i: Incident, now: number) => (i.slaDeadline - now > 0 ? fmtShort(i.slaDeadline - now) : `−${fmtShort(now - i.slaDeadline)}`);

/** Текст на кнопке цвета акцента: тёмный на светлом акценте (золото, жёлтый), белый — на тёмном. */
function onColor(c: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(c) ?? null;
  const r = m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16)) : (/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c)?.slice(1, 4).map(Number) ?? [255, 49, 80]);
  const l = (0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]) / 255;
  return l > 0.62 ? '#14161a' : '#ffffff';
}
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
    '--d-on-accent': onColor(s.accent),
  };
  return v as React.CSSProperties;
}

/** Переход по клику: в ITSM, если адрес задан; иначе — карточка в приложении (или крупно на отдельной стене). */
function useOpen(standalone: boolean, focus: (id: string) => void) {
  // standalone — отдельное окно стены (рабочего места там нет); на главном экране клик открывает рабочее место.
  const itsmUrl = useStore((s) => s.config?.itsmUrl ?? null);
  return useCallback(
    (i: Incident) => {
      if (itsmUrl) window.open(itsmUrl.replace('{id}', encodeURIComponent(i.id)), '_blank', 'noopener');
      else if (!standalone) {
        openWork();
        setTab(i.status === 'coordinators' ? 'inbox' : 'teams');
        openIncident(i.id);
      } else focus(i.id);
    },
    [itsmUrl, standalone, focus],
  );
}

/** Главный экран дежурного после входа: дашборд на весь экран, рабочее место — по кнопке. */
export function DashHome() {
  return <Dashboard home />;
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

export function Dashboard({ standalone = false, home = false }: { standalone?: boolean; home?: boolean }) {
  const d = useDash();
  const [settings, setSettings] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [designing, setDesigning] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ on: boolean; k: number | null }>({ on: false, k: null });
  useDashEvents(
    useCallback((e) => {
      if (e.type === 'settings') setSettings(e.open);
      if (e.type === 'focus') setFocusId(e.id);
      if (e.type === 'designing') setDesigning(e.text);
      if (e.type === 'edit') setEditing({ on: e.on, k: e.k ?? null });
    }, []),
  );
  if (d.preset === 'legacy')
    return (
      <div className="dash-legacy">
        <WallPage standalone={standalone || home} />
        <span className="dash-gear-row">
          {home && <WorkButton />}
          <button className="dash-gear" onClick={() => setSettings(true)} title="Настройки дашборда">
            <Settings2 size={16} /> Дашборд
          </button>
        </span>
        {settings && <DashSettings onClose={() => setSettings(false)} />}
      </div>
    );
  return (
    <>
      <DashWall d={d} standalone={standalone} home={home} settings={settings} setSettings={setSettings} focusId={focusId} setFocusId={setFocusId} editing={d.locked ? { on: false, k: null } : editing} setEditing={setEditing} />
      {designing && (
        <div className="dash-designing" role="status">
          <Sparkles size={16} /> ChatGPT придумывает оформление: «{designing.length > 70 ? `${designing.slice(0, 68)}…` : designing}»
        </div>
      )}
    </>
  );
}

/** Открыть всё рабочее место: вкладки, карточки инцидентов, справочник, смену. */
function WorkButton() {
  return (
    <button className="dash-work" onClick={openWork} title="Вкладки, карточки инцидентов, справочник, смена — всё рабочее место">
      <LayoutGrid size={17} /> Рабочее место
    </button>
  );
}

function DashWall({ d, standalone, home, settings, setSettings, focusId, setFocusId, editing, setEditing }: { d: DashLayout; standalone: boolean; home: boolean; settings: boolean; setSettings: (v: boolean) => void; focusId: string | null; setFocusId: (v: string | null) => void; editing: { on: boolean; k: number | null }; setEditing: (v: { on: boolean; k: number | null }) => void }) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(1000);
  const style = currentStyle(d);
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
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (setFocusId(null), alerts.dismiss(), setEditing({ on: false, k: null }));
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [alerts, setFocusId, setEditing]);
  const ctx: BlockCtx = { snap, now, d, style, open, standalone };
  const inWall = new Set(d.columns.map((c) => c.block));
  const colsRef = useRef<HTMLDivElement>(null);
  return (
    <div
      className={`dash ${standalone || home ? 'standalone' : ''} ${home ? 'home' : ''} ${alerts.top?.kind === 'crit' ? 'dash-alarm' : ''}`}
      data-dark={style.dark ? '1' : '0'}
      data-card={style.card ?? 'solid'}
      data-font={style.font ?? 'sans'}
      data-glow={style.glow ? '1' : '0'}
      data-density={d.density}
      style={styleVars(style)}
    >
      {style.deco === 'snow' && <Snow />}
      {d.counters ? <DashHeader snap={snap} now={now} d={d} home={home} garland={style.deco === 'snow'} /> : home && <span className="dash-work-float"><WorkButton /></span>}
      {alerts.list.length > 0 && <AlertStrip list={alerts.list} now={now} onClose={alerts.dismiss} onOpen={(id) => setFocusId(id)} />}
      {editing.on && (
        <div className="dash-editbar">
          <b>Изменение блоков</b>
          <span>тяните границу между блоками · нажмите на блок — его настройки</span>
          <span className="db-sp" />
          <button disabled={d.columns.length >= 4} onClick={() => setDash({ preset: 'custom', columns: [...d.columns, { block: (['events', 'transfers', 'stats', 'assistant', 'map', 'groups', 'work', 'action'] as BlockId[]).find((b) => !inWall.has(b)) ?? 'events', width: 1 }] })}>
            + Колонка
          </button>
          <button className="on" onClick={() => setEditing({ on: false, k: null })}>
            Готово
          </button>
        </div>
      )}
      <div ref={colsRef} className={`dash-cols ${editing.on ? 'editing' : ''}`} style={{ gridTemplateColumns: d.columns.map((c) => `minmax(0, ${c.width}fr)`).join(' ') }}>
        {d.columns.map((c, k) => (
          <section
            key={`${k}-${c.block}`}
            className={`dash-col b-${c.block} ${editing.on ? 'edit' : ''} ${editing.k === k ? 'sel' : ''}`}
            style={c.scale && c.scale !== 1 ? { fontSize: `${c.scale}em` } : undefined}
            onClickCapture={
              editing.on
                ? (e) => {
                    if ((e.target as Element).closest('.dce')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setEditing({ on: true, k });
                  }
                : undefined
            }
          >
            <Block id={c.block} ctx={ctx} skip={inWall} o={c.opts} />
            {editing.on && <ColBar k={k} n={d.columns.length} c={c} onEdit={() => setEditing({ on: true, k })} />}
            {editing.on && k < d.columns.length - 1 && <Splitter k={k} colsRef={colsRef} />}
            {editing.on && editing.k === k && <BlockEditor k={k} c={c} onClose={() => setEditing({ on: true, k: null })} />}
          </section>
        ))}
      </div>
      {d.ticker && <DashTicker />}
      {focusId && <FocusCard id={focusId} now={now} onClose={() => setFocusId(null)} />}
      {settings && <DashSettings onClose={() => setSettings(false)} />}
      {!full && (
        <div className="dash-tools">
          <button onClick={() => setSettings(true)} title="Блоки, стиль, тревоги, Джарвис">
            <Settings2 size={15} /> Настройки
          </button>
          <button className={editing.on ? 'on' : ''} disabled={d.locked} onClick={() => setEditing({ on: !editing.on, k: null })} title={d.locked ? 'Интерфейс закреплён — открепите в настройках' : 'Тянуть границы между блоками, настраивать каждый блок'}>
            <SlidersHorizontal size={15} /> Изменить блоки
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

/** Новогодняя тема: тихий снег поверх стены (не мешает читать и кликать). */
const FLAKES = Array.from({ length: 46 }, (_, k) => ({ left: (k * 37) % 100, size: 3 + ((k * 13) % 6), dur: 9 + ((k * 7) % 11), delay: -((k * 1.7) % 18), drift: ((k % 5) - 2) * 18 }));
function Snow() {
  return (
    <div className="dash-snow" aria-hidden>
      {FLAKES.map((f, k) => (
        <i key={k} style={{ left: `${f.left}%`, width: f.size, height: f.size, animationDuration: `${f.dur}s`, animationDelay: `${f.delay}s`, ['--drift' as string]: `${f.drift}px` }} />
      ))}
    </div>
  );
}

// ─── шапка: часы и счётчики четырёх групп ─────────────────────────────────
function DashHeader({ snap, now, d, home, garland }: { snap: DashSnapshot; now: number; d: DashLayout; home?: boolean; garland?: boolean }) {
  const c = snap.counts;
  const chip = (g: DashGroup, tone: string) => (
    <button key={g} className={`dh-chip g-${g} ${tone} ${c[g] ? 'on' : ''} ${d.filter === g ? 'sel' : ''}`} onClick={() => setDash({ filter: d.filter === g ? null : g })} title={`${DASH_GROUPS.find((x) => x.id === g)!.hint}. Нажмите — показать только эту группу`}>
      <b className="num">{c[g]}</b>
      <span>{GROUP_NAME[g]}</span>
    </button>
  );
  return (
    <header className="dash-head">
      {garland && (
        <span className="dh-garland" aria-hidden>
          {Array.from({ length: 28 }, (_, k) => (
            <i key={k} style={{ animationDelay: `${(k % 7) * 0.35}s` }} />
          ))}
        </span>
      )}
      <div className="dh-title">
        <span className="dh-dot" />
        <div>
          <b>Координирующий пункт</b>
          {(d.filter || d.onlyFile) && (
            <span>
              {d.filter ? `только «${GROUP_NAME[d.filter]}»` : ''}
              {d.filter && d.onlyFile ? ' · ' : ''}
              {d.onlyFile ? 'только ITSM' : ''}
            </span>
          )}
        </div>
      </div>
      <div className="dh-chips">
        {chip('crit', c.crit ? 'hot' : '')}
        {chip('coord', c.coord ? 'warn' : '')}
        {chip('high', '')}
        {chip('research', '')}
        <span className="dh-sep" />
        <span className={`dh-mini ${c.threat ? 'warn' : ''}`} title="Срок под угрозой: меньше 30 минут или уже прошёл">
          <b className="num">{c.threat}</b> срок
        </span>
        <span className={`dh-mini ${c.notTaken ? 'warn' : ''}`} title="Команда не берёт больше 10 минут">
          <b className="num">{c.notTaken}</b> не берут
        </span>
        <span className="dh-mini ok" title="Решено за последний час">
          <b className="num">{c.doneHour}</b> решено
        </span>
      </div>
      <div className="dh-clock">
        <b className="num">{fmtClock(now)}</b>
        <span>{new Date(now).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })} · МСК</span>
      </div>
      {home && <WorkButton />}
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
function Block({ id, ctx, skip, o }: { id: BlockId; ctx: BlockCtx; skip: Set<BlockId>; o?: Opts }) {
  switch (id) {
    case 'action':
      return <ActionBlock ctx={ctx} o={o} />;
    case 'work':
      return <WorkBlock ctx={ctx} o={o} />;
    case 'groups':
      return <GroupsBlock ctx={ctx} o={o} />;
    case 'assistant':
      return <AssistantBlock ctx={ctx} o={o} />;
    case 'transfers':
      return <TransfersBlock ctx={ctx} o={o} />;
    case 'stats':
      return <StatsBlock ctx={ctx} o={o} />;
    case 'events':
      return <EventsBlock o={o} />;
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
      return <RotateBlock ctx={ctx} skip={skip} o={o} />;
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
function PagerFoot({ p, total }: { p: ReturnType<typeof useFitPager>; total: number; sec?: number; label?: string }) {
  if (!p.paged) return null;
  return (
    <div className="db-foot">
      <span className="num">
        {p.start + 1}–{Math.min(total, p.start + p.fit)} из {total}
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
function IncCard({ i, att, now, big, onClick, off, detail = false }: { i: Incident; att?: Attention; now: number; big?: boolean; onClick: () => void; off?: boolean; detail?: boolean }) {
  const t = transferCount(i);
  const left = i.slaDeadline - now;
  return (
    <button className={`dc p-${i.priority} ${big ? 'big' : ''} ${att ? `t-${att.tone}` : ''} ${off ? 'off' : ''}`} onClick={onClick} title={`${i.title}\n${i.productName || i.service} · возник ${fmtClock(i.createdAt)} · ${i.stateText}\n${who(i)}`} aria-hidden={off || undefined} tabIndex={off ? -1 : undefined}>
      <span className="dc-bar" />
      <span className="dc-main">
        <span className="dc-top">
          <span className={`dc-prio p-${i.priority}`}>{PRIO[i.priority]}</span>
          {att && <span className={`dc-why t-${att.tone}`}>{att.reason}</span>}
          <GroupTags i={i} />
          {t >= 2 && (
            <span className="dc-tr warn" title="Передач между командами">
              <ArrowLeftRight size={12} /> {t}
            </span>
          )}
        </span>
        <b className="dc-title">{i.title}</b>
        <span className="dc-line">
          <b className="dc-who">{who(i)}</b> · {i.productName || i.service} · {fmtClock(i.createdAt)} · {i.stateText}
        </span>
        {detail && i.status === 'coordinators' && i.ai?.teamId && (
          <span className="dc-ai">
            <Sparkles size={12} /> ИИ: в «{teamName(i.ai.teamId)}»
          </span>
        )}
      </span>
      <span className={`dc-sla ${left < 30 * MIN ? 'hot' : ''}`}>
        <b className="num">{left > 0 ? fmtShort(left) : `−${fmtShort(-left)}`}</b>
        <span className="dc-sla-bar">
          <i style={{ width: `${frac(i, now) * 100}%` }} />
        </span>
      </span>
    </button>
  );
}

function ActionBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now, d } = ctx;
  const crit = snap.action.filter((x) => x.inc.priority === 'P1');
  const rest = snap.action.filter((x) => x.inc.priority !== 'P1');
  const p = useFitPager(rest.length, on(o, 'page', d.pageSec));
  const detail = ob(o, 'ai', false);
  return (
    <div className={`db db-action ${ob(o, 'compact', false) ? 'compact' : ''}`}>
      <BlockHead title={d.filter ? GROUP_NAME[d.filter] : 'Требует действия'} count={snap.action.length} icon={<BellRing size={18} />} />
      {ob(o, 'resolved') &&
        snap.resolvedCrit.map((i) => (
          <div key={i.id} className="dc-resolved">
            <CheckCircle2 size={18} />
            <span>
              <b>Решён</b> · {i.title}
            </span>
            <span className="num">за {fmtShort((i.resolvedAt ?? now) - i.createdAt)}</span>
          </div>
        ))}
      {crit.length > 0 && (
        <div className="db-crit">
          {crit.map(({ inc, att }) => (
            <IncCard key={inc.id} i={inc} att={att} now={now} big detail={detail} onClick={() => ctx.open(inc)} />
          ))}
        </div>
      )}
      {!snap.action.length && !snap.resolvedCrit.length && <div className="db-empty">Всё под контролем</div>}
      <div className="db-list" ref={p.box}>
        {rest.slice(p.start).map(({ inc, att }, k) => (
          <IncCard key={inc.id} i={inc} att={att} now={now} detail={detail} onClick={() => ctx.open(inc)} off={k >= p.fit} />
        ))}
      </div>
      <PagerFoot p={p} total={rest.length} />
    </div>
  );
}

function WorkBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now, d } = ctx;
  const p = useFitPager(snap.work.length, on(o, 'page', d.pageSec));
  const c = { time: ob(o, 'cTime'), sla: ob(o, 'cSla'), tr: ob(o, 'cTr'), team: ob(o, 'cTeam') };
  const tpl = ['minmax(0, 2.4fr)', c.time && '5.4em', c.sla && '7em', c.tr && '3em', c.team && 'minmax(0, 1.4fr)'].filter(Boolean).join(' ');
  return (
    <div className="db db-work">
      <BlockHead title="В работе у команд" count={snap.work.length} />
      <div className="dw-row dw-h" style={{ gridTemplateColumns: tpl }}>
        <span>Инцидент</span>
        {c.time && <span>В работе</span>}
        {c.sla && <span>До срока</span>}
        {c.tr && <span title="Передач между командами">⇄</span>}
        {c.team && <span>Команда</span>}
      </div>
      <div className="db-list" ref={p.box}>
        {snap.work.slice(p.start).map((i, n) => {
          const w = waitingTake(i, now);
          const since = i.startedAt ?? i.routedAt ?? i.createdAt;
          const t = transferCount(i);
          const hops = transfers(i);
          return (
            <button
              key={i.id}
              className={`dw-row p-${i.priority} ${n >= p.fit ? 'off' : ''}`}
              style={{ gridTemplateColumns: tpl }}
              onClick={() => ctx.open(i)}
              title={`${i.title}\n${i.productName || i.service} · ${i.stateText}\n${i.assigneeName ?? 'исполнитель не назначен'}`}
              aria-hidden={n >= p.fit || undefined}
              tabIndex={n >= p.fit ? -1 : undefined}
            >
              <span className="dw-inc">
                <span className={`dw-p p-${i.priority}`}>{i.priority}</span>
                <b>{i.title}</b>
              </span>
              {c.time && (
                <span className={`dw-time num ${w !== null && w > 10 * MIN ? 'warn' : ''}`} title={w !== null ? 'команда ещё не взяла' : 'в работе'}>
                  {fmtShort(w ?? now - since)}
                </span>
              )}
              {c.sla && (
                <span className={`dw-sla ${i.slaDeadline - now < 30 * MIN ? 'hot' : ''}`}>
                  <b className="num">{leftText(i, now)}</b>
                  <span className="dc-sla-bar">
                    <i style={{ width: `${frac(i, now) * 100}%` }} />
                  </span>
                </span>
              )}
              {c.tr && <span className={`num dw-tr ${t >= 2 ? 'warn' : ''}`}>{t}</span>}
              {c.team && <b className="dw-team">{hops.at(-1)?.team ?? teamName(i.teamId)}</b>}
            </button>
          );
        })}
        {!snap.work.length && <div className="db-empty">У команд пусто</div>}
      </div>
      <PagerFoot p={p} total={snap.work.length} />
    </div>
  );
}

function GroupsBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now } = ctx;
  return (
    <div className="db db-groups">
      {DASH_GROUPS.filter((g) => ob(o, `g_${g.id}`)).map((g) => (
        <div key={g.id} className={`dg g-${g.id}`} title={g.hint}>
          <div className="dg-head">
            <b>{g.label}</b>
            <span className="num">{snap.byGroup[g.id].length}</span>
          </div>
          <div className="dg-list">
            {g.id === 'crit' &&
              snap.resolvedCrit.map((i) => (
                <div key={i.id} className="dg-row resolved">
                  <CheckCircle2 size={14} />
                  <span>
                    <b>{i.title}</b>
                    <small>решён</small>
                  </span>
                </div>
              ))}
            {snap.byGroup[g.id].map((i) => (
              <button key={i.id} className={`dg-row p-${i.priority}`} onClick={() => ctx.open(i)} title={`${i.productName || i.service} · ${i.stateText}`}>
                <span className="dc-bar" />
                <span>
                  <b>{i.title}</b>
                  <small>{who(i)}</small>
                </span>
                <span className={`num dg-left ${i.slaDeadline - now < 30 * MIN ? 'hot' : ''}`}>{leftText(i, now)}</span>
              </button>
            ))}
            {!snap.byGroup[g.id].length && !(g.id === 'crit' && snap.resolvedCrit.length) && <div className="db-empty small">нет</div>}
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
let assistBusy = false;
const assistSubs = new Set<() => void>();
const assistEmit = () => assistSubs.forEach((f) => f());
const HINTS = ['Покажи только критические', 'Поменяй местами левый и правый блоки', 'Покажи крупно самый срочный', 'Стиль «Центр управления»', 'Добавь карту', 'Раскладка «Четыре группы»', 'Сделай новогоднее оформление с золотом'];
function AssistantBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now } = ctx;
  const brief = useBrief();
  const [text, setText] = useState('');
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    assistSubs.add(f);
    return () => void assistSubs.delete(f);
  }, []);
  const log = assistLog;
  const busy = assistBusy;
  const setLog = (f: (l: typeof assistLog) => typeof assistLog) => {
    assistLog = f(assistLog);
    assistEmit();
  };
  const setBusy = (v: boolean) => {
    assistBusy = v;
    assistEmit();
  };
  const ready = jarvisReady();
  const persona = personaById(jarvisPrefs.persona);
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
      <BlockHead title={`${persona.name} · ИИ-помощник`} icon={<Bot size={18} />} right={<span className={`db-live ${ready && jarvisPrefs.control ? 'on' : ''}`}>{ready ? (jarvisPrefs.control ? 'слушает' : 'по кнопке') : 'выключен'}</span>} />
      <div className="da-brief da-char" style={{ ['--pc' as string]: persona.color }}>
        <img className={`da-ava ${busy ? 'busy' : ''}`} src={persona.avatar} alt={persona.name} onError={(e) => ((e.currentTarget.style.display = 'none'))} />
        <div className="da-bubble">
          <small>
            <Sparkles size={12} /> Главное сейчас{brief?.llm ? ' · ИИ' : ''}
          </small>
          <p>{brief?.text ?? (snap.action[0] ? `Главное — «${snap.action[0].inc.title}»: ${snap.action[0].att.reason.toLowerCase()}.` : 'Срочного нет — всё под контролем.')}</p>
        </div>
      </div>
      {ob(o, 'risks') && risks.length > 0 && (
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
      {ob(o, 'route') && route.length > 0 && (
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
      {!ob(o, 'ask') ? null : ready ? (
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

function TransfersBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap } = ctx;
  const count = on(o, 'count', 6);
  const list = useMemo(
    () =>
      snap.action
        .map((x) => x.inc)
        .concat(snap.work)
        .filter((i, k, a) => a.indexOf(i) === k && transfers(i).length > 0)
        .sort((a, b) => transferCount(b) - transferCount(a) || Number(b.priority < a.priority) - Number(a.priority < b.priority))
        .slice(0, count),
    [snap, count],
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
                    <span className={`dt-hop ${again ? 'again' : ''} ${k === hops.length - 1 ? 'last' : ''}`} title={fmtClock(h.at)}>
                      {h.team}
                    </span>
                  </span>
                );
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StatsBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
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
      {ob(o, 'tiles') && (
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
      )}
      {ob(o, 'spark') && (
        <div className="ds-spark" title="Жалобы за час, по 5 минут">
          <Spark values={k.series} width={320} height={48} />
        </div>
      )}
      {ob(o, 'bars') && (
      <div className="ds-bars">
        {DASH_GROUPS.map((g) => (
          <div key={g.id} className={`ds-bar g-${g.id}`}>
            <span>{g.label}</span>
            <i style={{ width: `${(c[g.id] / max) * 100}%` }} />
            <b className="num">{c[g.id]}</b>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

const KIND_TEXT: Partial<Record<FeedEvent['kind'], string>> = { p1: 'Критический', coordinators: 'На координаторах', resolved: 'Решён', routed: 'Передан', escalated: 'Эскалация', sla_breach: 'Срок прошёл', sla_warning: 'Срок близко', priority_up: 'Уровень выше', created: 'Новый', assigned: 'Назначен', in_progress: 'Взяли' };
function EventsBlock({ o }: { o?: Opts }) {
  const feed = useStore((s) => s.feed);
  const incidents = useStore((s) => s.incidents);
  return (
    <div className="db db-events">
      <BlockHead title="Лента событий" />
      <div className="de-list">
        {feed.slice(0, on(o, 'count', 18)).map((e) => (
          <div key={e.id} className={`de k-${e.kind}`} title={e.text}>
            <b className="num">{fmtClock(e.at)}</b>
            <span>
              <em>{KIND_TEXT[e.kind] ?? 'Событие'}</em> {incidents.get(e.incidentId)?.title ?? e.text}
            </span>
          </div>
        ))}
        {!feed.length && <div className="db-empty">Событий нет</div>}
      </div>
    </div>
  );
}

const ROTATION: BlockId[] = ['assistant', 'transfers', 'stats', 'events'];
function RotateBlock({ ctx, skip, o }: { ctx: BlockCtx; skip: Set<BlockId>; o?: Opts }) {
  const items = ROTATION.filter((b) => !skip.has(b) && ob(o, `r_${b}`));
  const sec = on(o, 'sec', ctx.d.rotateSec);
  const list = items.length ? items : ROTATION;
  const [k, setK] = useState(0);
  // Пока на панель смотрят мышью или печатают Джарвису — не листаем.
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (hold) return;
    const t = setInterval(() => setK((x) => x + 1), sec * 1000);
    return () => clearInterval(t);
  }, [sec, hold]);
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
  const dismiss = useCallback((key?: string) => setList((l) => (key ? l.filter((a) => a.key !== key) : l.slice(1))), []);
  return useMemo(() => ({ list, top: list[0] ?? null, dismiss }), [list, dismiss]);
}

/** Уведомления стены — полосой между шапкой и блоками: ничего не закрывают, до трёх сразу, сами уходят. */
const ALERT_TITLE = { crit: 'Новый критический', resolved: 'Критический решён', coord: 'Передать в команду' };
function AlertStrip({ list, now, onClose, onOpen }: { list: Alert[]; now: number; onClose: (key?: string) => void; onOpen: (id: string) => void }) {
  return (
    <div className="dash-alerts" role="alert">
      {list.slice(0, 3).map((a) => {
        const i = a.inc;
        return (
          <div key={a.key} className={`dal k-${a.kind}`}>
            <button className="dal-in" onClick={() => onOpen(i.id)} title="Показать крупно">
              {a.kind === 'resolved' ? <CheckCircle2 size={20} /> : <BellRing size={20} />}
              <span className="dal-t">
                <small>
                  {ALERT_TITLE[a.kind]}
                  {a.test ? ' · проверка' : ''}
                </small>
                <b>{i.title}</b>
              </span>
              <span className="dal-r num">{a.kind === 'resolved' ? `за ${fmtShort((i.resolvedAt ?? now) - i.createdAt)}` : leftText(i, now)}</span>
            </button>
            <button className="dal-x" onClick={() => onClose(a.key)} aria-label="Скрыть">
              <X size={15} />
            </button>
            <i className="dal-life" style={{ animationDuration: `${ALERT_MS[a.kind]}ms` }} />
          </div>
        );
      })}
      {list.length > 3 && <span className="dal-more">ещё {list.length - 3}</span>}
    </div>
  );
}

// ─── «Изменить блоки»: панель колонки, граница-ползунок, настройки блока ───
function ColBar({ k, n, c, onEdit }: { k: number; n: number; c: DashColumn; onEdit: () => void }) {
  return (
    <div className="dce dce-bar">
      <button className="dce-name" onClick={onEdit} title="Настройки этого блока">
        <SlidersHorizontal size={14} /> {BLOCK_NAME[c.block]}
      </button>
      <button disabled={k === 0} onClick={() => applyDashOp({ op: 'swap', a: k, b: k - 1 })} aria-label="Левее">
        <ArrowLeft size={14} />
      </button>
      <button disabled={k === n - 1} onClick={() => applyDashOp({ op: 'swap', a: k, b: k + 1 })} aria-label="Правее">
        <ArrowRight size={14} />
      </button>
      <button disabled={n <= 1} onClick={() => setDash((d) => ({ preset: 'custom', columns: d.columns.filter((_, x) => x !== k) }))} aria-label="Убрать блок">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/** Граница между колонками: тянешь мышью — колонки делят место. */
function Splitter({ k, colsRef }: { k: number; colsRef: React.RefObject<HTMLDivElement | null> }) {
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const secs = colsRef.current?.querySelectorAll<HTMLElement>(':scope > .dash-col');
    if (!secs || !secs[k + 1]) return;
    const a = secs[k].getBoundingClientRect().width;
    const b = secs[k + 1].getBoundingClientRect().width;
    const start = getDash().columns.map((c) => ({ ...c }));
    const fa = start[k].width;
    const fb = start[k + 1].width;
    const x0 = e.clientX;
    let raf = 0;
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dx = Math.max(-a + 140, Math.min(b - 140, ev.clientX - x0));
        const total = fa + fb;
        let na = (total * (a + dx)) / (a + b);
        na = Math.max(0.6, Math.min(3, Math.min(total - 0.6, na)));
        const cols = start.map((c, x) => (x === k ? { ...c, width: +na.toFixed(2) } : x === k + 1 ? { ...c, width: +(total - na).toFixed(2) } : c));
        setDash({ preset: 'custom', columns: cols });
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dash-resizing');
    };
    document.body.classList.add('dash-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="dce dce-split" onPointerDown={down} title="Тяните, чтобы поменять ширину" role="separator" aria-orientation="vertical" />;
}

/** Настройки одного блока: что в нём, ширина, размер текста и его собственные переключатели. */
function BlockEditor({ k, c, onClose }: { k: number; c: DashColumn; onClose: () => void }) {
  const set = (patch: Partial<DashColumn>) => setDash((d) => ({ preset: 'custom', columns: d.columns.map((x, n) => (n === k ? { ...x, ...patch } : x)) }));
  const setOpt = (key: string, v: boolean | number) => set({ opts: { ...(c.opts ?? {}), [key]: v } });
  const scale = c.scale ?? 1;
  return (
    <div className="dce dce-pop" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <b>{BLOCK_NAME[c.block]}</b>
        <button onClick={onClose} aria-label="Закрыть">
          <X size={16} />
        </button>
      </header>
      <label>
        Что в блоке
        <select value={c.block} onChange={(e) => applyDashOp({ op: 'replace', at: k, block: e.target.value as BlockId })}>
          {BLOCKS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>
          Ширина <b className="num">{c.width.toFixed(1)}</b>
        </span>
        <input type="range" min={0.6} max={3} step={0.05} value={c.width} onChange={(e) => set({ width: +e.target.value })} />
      </label>
      <label>
        <span>
          Размер текста <b className="num">{Math.round(scale * 100)}%</b>
        </span>
        <input type="range" min={0.7} max={1.6} step={0.05} value={scale} onChange={(e) => set({ scale: +e.target.value })} />
      </label>
      {(BLOCK_OPTS[c.block] ?? []).map((o) =>
        o.type === 'bool' ? (
          <label key={o.key} className="dce-check">
            <input type="checkbox" checked={ob(c.opts, o.key, o.def as boolean)} onChange={(e) => setOpt(o.key, e.target.checked)} /> {o.label}
          </label>
        ) : (
          <label key={o.key}>
            <span>
              {o.label}{' '}
              <b className="num">
                {on(c.opts, o.key, o.def as number)}
                {o.unit ?? ''}
              </b>
            </span>
            <input type="range" min={o.min} max={o.max} step={o.step ?? 1} value={on(c.opts, o.key, o.def as number)} onChange={(e) => setOpt(o.key, +e.target.value)} />
          </label>
        ),
      )}
      <footer>
        <button onClick={() => set({ opts: undefined, scale: 1 })}>Сбросить блок</button>
        <button className="on" onClick={onClose}>
          Готово
        </button>
      </footer>
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
