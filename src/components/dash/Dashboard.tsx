// Дашборд координатора — видеостена по кейсу. Видно с расстояния; блоки, стиль и поведение настраиваются
// в «Настройках дашборда» или голосом через Джарвиса. Прежняя стена — раскладка «Прежняя стена».
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, BellRing, Bot, CheckCircle2, Expand, GripHorizontal, LayoutGrid, MonitorUp, Plus, Settings2, SlidersHorizontal, Sparkles, Star, Trash2, X } from 'lucide-react';
import type { FeedEvent, Incident } from '../../../shared/types';
import { BLOCKS, BLOCK_NAME, DASH_GROUPS, GROUP_NAME, dashSnapshot, fmtShort, groupsOf, riskOf, transferCount, transfers, urgencyScore, waitingTake, type Attention, type BlockId, type DashGroup, type DashSnapshot } from '../../../shared/dash';
import type { DashStyle } from '../../../shared/dashStyles';
import { personaById } from '../../../shared/personas';
import { itsmLink, markSeen, openIncident, reopenIncident, setTab, takeAtPoint, teamName, useStore } from '../../store';
import { complaintsWord, heat } from '../../../shared/attention';
import { fmtClock } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { applyDashOp, currentStyle, dashEvent, getDash, openWallWindow, openWork, setDash, useDash, useDashEvents, type DashLayout } from '../../lib/dashLayout';
import { GRID_COLS, GRID_ROWS, fit, free, type GridItem, type Rect } from '../../../shared/dashGrid';
import { BlockGallery, CharacterBlock, ClockBlock, CountersBlock, CustomBlock, FavsBlock, ForgotBlock, GroupBlock, NoteBlock, RiskBlock, RouteBlock, TeamsBlock } from './blocks2';
import { openFav } from '../FavDialog';
import { BLOCK_OPTS } from './blockOpts';
import { Jarvis, jarvisAsk, jarvisPrefs, jarvisReady } from '../Jarvis';
import { RFMap } from '../RFMap';
import { Spark } from '../kit';
import { WallPage } from '../WallPage';
import { DashSettings } from './DashSettings';
import { AttentionStrip, UrgentOverlay, useAttention } from './attention';
import './dash.css';
import './dash-grid.css';
import './dash-fav.css';
import './dash-attention.css';

const MIN = 60_000;
export type Opts = Record<string, boolean | number | string> | undefined;
export const ob = (o: Opts, k: string, def = true) => (typeof o?.[k] === 'boolean' ? (o[k] as boolean) : def);
export const on = (o: Opts, k: string, def: number) => (typeof o?.[k] === 'number' ? (o[k] as number) : def);
export const os = (o: Opts, k: string, def: string) => (typeof o?.[k] === 'string' ? (o[k] as string) : def);
export const PRIO: Record<Incident['priority'], string> = { P1: 'Критический', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' };
const shortId = (id: string) => id.replace(/^INC0*/, 'INC ');
export const who = (i: Incident) =>
  i.status === 'coordinators' ? `На координаторах${i.coordinatorName ? ` · ведёт ${i.coordinatorName}` : ''}` : `${teamName(i.teamId)}${i.assigneeName ? ` · ${i.assigneeName}` : ' · никто не взял'}`;
export const frac = (i: Incident, now: number) => Math.min(1, Math.max(0, (now - i.createdAt) / Math.max(MIN, i.slaDeadline - i.createdAt)));
export const leftText = (i: Incident, now: number) => (i.slaDeadline - now > 0 ? fmtShort(i.slaDeadline - now) : `−${fmtShort(now - i.slaDeadline)}`);

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
/** Клик по инциденту на стене — переход в ITSM (как в кейсе); с Shift — карточка в рабочем месте Радара. */
function useOpen(standalone: boolean, focus: (id: string) => void) {
  return useCallback(
    (i: Incident, inRadar = false) => {
      markSeen(i.id);
      if (!inRadar) window.open(itsmLink(i.id), '_blank', 'noopener');
      else if (!standalone) {
        openWork();
        setTab(i.status === 'coordinators' ? 'inbox' : 'teams');
        openIncident(i.id);
      } else focus(i.id);
    },
    [standalone, focus],
  );
}
// Shift+клик по карточке — открыть в Радаре, а не в ITSM.
let shiftDown = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (shiftDown = e.shiftKey), true);
  window.addEventListener('keyup', (e) => (shiftDown = e.shiftKey), true);
  window.addEventListener('pointerdown', (e) => (shiftDown = e.shiftKey), true);
}
export const wantRadar = () => shiftDown;

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
  const [editing, setEditing] = useState<Editing>({ on: false, id: null });
  const [gallery, setGallery] = useState<{ open: boolean; at: { x: number; y: number } | null }>({ open: false, at: null });
  useDashEvents(
    useCallback((e) => {
      if (e.type === 'settings') setSettings(e.open);
      if (e.type === 'focus') setFocusId(e.id);
      if (e.type === 'designing') setDesigning(e.text);
      if (e.type === 'edit') setEditing({ on: e.on, id: e.id ?? null });
      if (e.type === 'gallery') setGallery({ open: e.open, at: e.at ?? null });
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
      <DashWall d={d} standalone={standalone} home={home} settings={settings} setSettings={setSettings} focusId={focusId} setFocusId={setFocusId} editing={d.locked ? { on: false, id: null } : editing} setEditing={setEditing} />
      {gallery.open && !d.locked && <BlockGallery at={gallery.at} onClose={() => setGallery({ open: false, at: null })} />}
      {designing && (
        <div className="dash-designing" role="status">
          <Sparkles size={16} /> {/^(ChatGPT|GPT)/.test(designing) ? designing : `ChatGPT придумывает оформление: «${designing.length > 70 ? `${designing.slice(0, 68)}…` : designing}»`}
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

function DashWall({ d, standalone, home, settings, setSettings, focusId, setFocusId, editing, setEditing }: { d: DashLayout; standalone: boolean; home: boolean; settings: boolean; setSettings: (v: boolean) => void; focusId: string | null; setFocusId: (v: string | null) => void; editing: Editing; setEditing: (v: Editing) => void }) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(1000);
  const style = currentStyle(d);
  const snap = useMemo(() => dashSnapshot(incidents.values(), now, { filter: d.filter, onlyFile: d.onlyFile }), [incidents, now, d.filter, d.onlyFile]);
  const openRaw = useOpen(standalone, setFocusId);
  const open = useCallback((i: Incident) => openRaw(i, wantRadar()), [openRaw]);
  const att = useAttention(incidents, d, standalone);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  useEffect(() => {
    // Esc: сначала «Принял» срочному на весь экран, потом закрыть остальное.
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (att.urgent.length) return att.ack();
      setFocusId(null);
      att.dismiss();
      setEditing({ on: false, id: null });
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [att, setFocusId, setEditing]);
  const ctx: BlockCtx = { snap, now, d, style, open, standalone };
  const inWall = new Set<BlockId>(d.items.map((c) => c.block));
  // Пока меняем блоки — шар помощника не закрывает правый нижний угол поля.
  useEffect(() => {
    document.body.classList.toggle('dash-editing', editing.on);
    return () => document.body.classList.remove('dash-editing');
  }, [editing.on]);
  return (
    <div
      className={`dash ${standalone || home ? 'standalone' : ''} ${home ? 'home' : ''} ${att.urgent.length ? 'dash-alarm' : ''}`}
      data-dark={style.dark ? '1' : '0'}
      data-card={style.card ?? 'solid'}
      data-font={style.font ?? 'sans'}
      data-glow={style.glow ? '1' : '0'}
      data-density={d.density}
      style={styleVars(style)}
    >
      {style.deco === 'snow' && <Snow />}
      {d.counters ? <DashHeader snap={snap} now={now} d={d} home={home} garland={style.deco === 'snow'} /> : home && <span className="dash-work-float"><WorkButton /></span>}
      <AttentionStrip list={att.strip} info={att.info} incidents={incidents} now={now} onClose={att.dismiss} onOpen={open} />
      {editing.on && (
        <div className="dash-editbar">
          <b>Свободное поле</b>
          <span>тяните блок за шапку · угол — размер · пустая клетка — добавить сюда · клик по блоку — его настройки</span>
          <span className="db-sp" />
          <button onClick={() => dashEvent({ type: 'gallery', open: true, at: null })}>+ Добавить блок</button>
          <button className="on" onClick={() => setEditing({ on: false, id: null })}>
            Готово
          </button>
        </div>
      )}
      <GridField d={d} ctx={ctx} inWall={inWall} editing={editing} setEditing={setEditing} />
      <UrgentOverlay list={att.urgent} incidents={incidents} now={now} onAck={att.ack} onOpen={open} />
      {d.ticker && <DashTicker />}
      {focusId && <FocusCard id={focusId} now={now} onClose={() => setFocusId(null)} />}
      {settings && <DashSettings onClose={() => setSettings(false)} />}
      {!full && (
        <div className="dash-tools">
          <button onClick={() => setSettings(true)} title="Блоки, стиль, тревоги, Джарвис">
            <Settings2 size={15} /> Настройки
          </button>
          <button className={editing.on ? 'on' : ''} disabled={d.locked} onClick={() => setEditing({ on: !editing.on, id: null })} title={d.locked ? 'Интерфейс закреплён — открепите в настройках' : 'Свободное поле: двигать, растягивать, добавлять блоки'}>
            <SlidersHorizontal size={15} /> Изменить блоки
          </button>
          <button disabled={d.locked} onClick={() => dashEvent({ type: 'gallery', open: true, at: null })} title="Выбрать и добавить блок на стену">
            <Plus size={15} /> Добавить блок
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
        {c.recur > 0 && (
          <span className="dh-mini hot" title="Решили, а жалобы снова идут — вернуть в работу">
            <b className="num">{c.recur}</b> снова жалобы
          </span>
        )}
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
export interface BlockCtx {
  snap: DashSnapshot;
  now: number;
  d: DashLayout;
  style: DashStyle;
  open: (i: Incident) => void;
  standalone: boolean;
}
function Block({ id, ctx, skip, o, it }: { id: BlockId; ctx: BlockCtx; skip: Set<BlockId>; o?: Opts; it?: GridItem }) {
  switch (id) {
    case 'clock':
      return <ClockBlock now={ctx.now} />;
    case 'counters':
      return <CountersBlock ctx={ctx} />;
    case 'group':
      return <GroupBlock ctx={ctx} o={o} />;
    case 'character':
      return <CharacterBlock ctx={ctx} o={o} spec={it?.custom} />;
    case 'risk':
      return <RiskBlock ctx={ctx} />;
    case 'route':
      return <RouteBlock ctx={ctx} />;
    case 'teams':
      return <TeamsBlock ctx={ctx} />;
    case 'note':
      return <NoteBlock o={o} />;
    case 'forgot':
      return <ForgotBlock ctx={ctx} />;
    case 'favs':
      return <FavsBlock ctx={ctx} />;
    case 'custom':
      return it?.custom ? it.custom.kind === 'character' ? <CharacterBlock ctx={ctx} o={o} spec={it.custom} /> : <CustomBlock ctx={ctx} spec={it.custom} /> : null;
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

export function BlockHead({ title, count, right, icon }: { title: string; count?: number; right?: React.ReactNode; icon?: React.ReactNode }) {
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

export function GroupTags({ i, skip }: { i: Incident; skip?: DashGroup }) {
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
function IncCard({ i, att, now, big, onClick, off, detail = false, above = false }: { i: Incident; att?: Attention; now: number; big?: boolean; onClick: () => void; off?: boolean; detail?: boolean; above?: boolean }) {
  const t = transferCount(i);
  const left = i.slaDeadline - now;
  const recur = i.status === 'resolved' && i.recur ? i.recur : null;
  const quick = recur ? { label: 'Вернуть в работу', run: () => void reopenIncident(i.id) } : i.status === 'coordinators' && !i.coordinatorId ? { label: 'Беру', run: () => void takeAtPoint(i.id) } : null;
  return (
    <button data-heat={heat(att?.score ?? urgencyScore(i, now))} className={`dc p-${i.priority} ${big ? 'big' : ''} ${recur ? 'recur' : ''} ${att ? `t-${att.tone}` : ''} ${off ? 'off' : ''}`} onClick={onClick} title={`${i.title}\n${i.productName || i.service} · возник ${fmtClock(i.createdAt)} · ${i.stateText}\n${who(i)}`} aria-hidden={off || undefined} tabIndex={off ? -1 : undefined}>
      <span className="dc-bar" />
      <span className="dc-main">
        <span className="dc-top">
          <span className={`dc-prio p-${i.priority}`}>{PRIO[i.priority]}</span>
          {above && <span className="dc-above">Важнее критического</span>}
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
          {recur ? (
            <>
              <b className="dc-who">решала {recur.team ?? 'команда'}</b> · решён {fmtShort(now - (i.resolvedAt ?? now))} назад · {i.productName || i.service}
            </>
          ) : (
            <>
              <b className="dc-who">{who(i)}</b> · {i.productName || i.service} · {fmtClock(i.createdAt)} · {i.stateText}
            </>
          )}
        </span>
        {detail && i.status === 'coordinators' && i.ai?.teamId && (
          <span className="dc-ai">
            <Sparkles size={12} /> ИИ: в «{teamName(i.ai.teamId)}»
          </span>
        )}
      </span>
      {quick && (
        <span
          role="button"
          tabIndex={-1}
          className="dc-quick"
          onClick={(e) => {
            e.stopPropagation();
            quick.run();
          }}
        >
          {quick.label}
        </span>
      )}
      <span
        role="button"
        tabIndex={-1}
        className={`dc-star ${i.pin ? 'on' : ''}`}
        title={i.pin ? `В избранном: ${i.pin.note || 'без заметки'}` : 'В избранное смены'}
        onClick={(e) => {
          e.stopPropagation();
          openFav(i.id);
        }}
      >
        <Star size={15} />
      </span>
      {recur ? (
        <span className="dc-sla hot">
          <b className="num">{recur.count}</b>
          <small>{complaintsWord(recur.count)} после решения</small>
        </span>
      ) : (
        <span className={`dc-sla ${left < 30 * MIN ? 'hot' : ''}`}>
          <b className="num">{left > 0 ? fmtShort(left) : `−${fmtShort(-left)}`}</b>
          <span className="dc-sla-bar">
            <i style={{ width: `${frac(i, now) * 100}%` }} />
          </span>
        </span>
      )}
    </button>
  );
}

/**
 * «Кому распределить» — главный блок дежурного, три зоны:
 *   «Распределить» — на пункте, команде ещё не переданы: кому передать (совет ИИ);
 *   «Закреплено» — критические, высокие, «снова жалобы», срочнее критического: стоят на месте, не листаются;
 *   «Остальное» — листается.
 */
function ActionBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now, d } = ctx;
  const isPinned = (x: { inc: Incident; att: Attention }) => x.inc.priority === 'P1' || x.inc.priority === 'P2' || x.inc.status === 'resolved' || (snap.topCrit > 0 && x.att.score > snap.topCrit);
  const toRoute = snap.action.filter((x) => x.inc.status === 'coordinators');
  const pinned = snap.action.filter((x) => x.inc.status !== 'coordinators' && isPinned(x));
  const rest = snap.action.filter((x) => x.inc.status !== 'coordinators' && !isPinned(x));
  const p = useFitPager(rest.length, on(o, 'page', d.pageSec));
  const detail = ob(o, 'ai', false);
  const above = (x: { inc: Incident; att: Attention }) => snap.topCrit > 0 && x.inc.priority !== 'P1' && x.att.score > snap.topCrit;
  const card = (x: { inc: Incident; att: Attention }, extra: { route?: boolean; off?: boolean } = {}) => (
    <IncCard key={x.inc.id} i={x.inc} att={x.att} now={now} big={x.inc.priority === 'P1' || x.inc.status === 'resolved'} detail={detail || !!extra.route} above={above(x)} off={extra.off} onClick={() => ctx.open(x.inc)} />
  );
  return (
    <div className={`db db-action ${ob(o, 'compact', false) ? 'compact' : ''}`}>
      <BlockHead title={d.filter ? GROUP_NAME[d.filter] : 'Кому распределить'} count={snap.action.length} icon={<BellRing size={18} />} />
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
      {!snap.action.length && !snap.resolvedCrit.length && <div className="db-empty">Распределять нечего — всё под контролем</div>}
      <div className="db-pin">
        {toRoute.length > 0 && (
          <>
            <div className="db-zone z-route">
              <b>Распределить</b>
              <span>на пункте — передать в команду</span>
              <i className="num">{toRoute.length}</i>
            </div>
            {toRoute.map((x) => card(x, { route: true }))}
          </>
        )}
        {pinned.length > 0 && (
          <>
            <div className="db-zone z-pin">
              <b>Закреплено</b>
              <span>критические и высокие — не листаются</span>
              <i className="num">{pinned.length}</i>
            </div>
            {pinned.map((x) => card(x))}
          </>
        )}
      </div>
      {rest.length > 0 && (
        <div className="db-zone z-rest">
          <b>Остальное</b>
          <span>листается</span>
          <i className="num">{rest.length}</i>
        </div>
      )}
      <div className="db-list" ref={p.box}>
        {rest.slice(p.start).map((x, k) => card(x, { off: k >= p.fit }))}
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
              data-heat={heat(urgencyScore(i, now))}
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
              <button key={i.id} data-heat={heat(urgencyScore(i, now))} className={`dg-row p-${i.priority}`} onClick={() => ctx.open(i)} title={`${i.productName || i.service} · ${i.stateText}`}>
                <span className="dc-bar" />
                <span>
                  <b>{i.title}</b>
                  <small>
                    {i.productName || i.service} · {fmtClock(i.createdAt)} · {who(i)} · {i.stateText}
                  </small>
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
        <img className={`da-fig ${busy ? 'busy' : ''}`} src={persona.cutout} alt={persona.name} draggable={false} onError={(e) => ((e.currentTarget.style.display = 'none'))} />
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

const KIND_TEXT: Partial<Record<FeedEvent['kind'], string>> = { p1: 'Критический', coordinators: 'На координаторах', resolved: 'Решён', routed: 'Передан', escalated: 'Эскалация', sla_breach: 'Срок прошёл', sla_warning: 'Срок близко', priority_up: 'Уровень выше', created: 'Новый', assigned: 'Назначен', in_progress: 'Взяли', recur: 'Снова жалобы', reopened: 'Возвращён в работу' };
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

// ─── «Изменить блоки»: панель колонки, граница-ползунок, настройки блока ───


/** Граница между колонками: тянешь мышью — колонки делят место. */


/** Настройки одного блока: что в нём, ширина, размер текста и его собственные переключатели. */
/** Настройки одного блока: что в нём, размер на поле, размер текста и его собственные переключатели. */
function BlockEditor({ it, onClose }: { it: GridItem; onClose: () => void }) {
  const set = (patch: Partial<GridItem>) => applyDashOp({ op: 'item', id: it.id, patch });
  const setOpt = (key: string, v: boolean | number | string) => set({ opts: { ...(it.opts ?? {}), [key]: v } });
  const scale = it.scale ?? 1;
  const tryRect = (r: Partial<GridItem>) => {
    const next = { ...it, ...r };
    if (free(getDash().items, next, it.id)) set(r);
  };
  return (
    <div className="dce dce-pop" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <header>
        <b>{it.custom?.title ?? BLOCK_NAME[it.block]}</b>
        <button onClick={onClose} aria-label="Закрыть">
          <X size={16} />
        </button>
      </header>
      {it.block !== 'custom' && (
        <label>
          Что в блоке
          <select value={it.block} onChange={(e) => set({ block: e.target.value as BlockId, opts: undefined })}>
            {BLOCKS.filter((b) => b.id !== 'custom').map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>
          Ширина <b className="num">{it.w} из 12</b>
        </span>
        <input type="range" min={2} max={12} step={1} value={it.w} onChange={(e) => tryRect({ w: +e.target.value, x: Math.min(it.x, 12 - +e.target.value) })} />
      </label>
      <label>
        <span>
          Высота <b className="num">{it.h} из 12</b>
        </span>
        <input type="range" min={2} max={12} step={1} value={it.h} onChange={(e) => tryRect({ h: +e.target.value, y: Math.min(it.y, 12 - +e.target.value) })} />
      </label>
      <label>
        <span>
          Размер текста <b className="num">{Math.round(scale * 100)}%</b>
        </span>
        <input type="range" min={0.7} max={1.6} step={0.05} value={scale} onChange={(e) => set({ scale: +e.target.value })} />
      </label>
      {(BLOCK_OPTS[it.block] ?? []).map((o) =>
        o.type === 'bool' ? (
          <label key={o.key} className="dce-check">
            <input type="checkbox" checked={ob(it.opts, o.key, o.def)} onChange={(e) => setOpt(o.key, e.target.checked)} /> {o.label}
          </label>
        ) : o.type === 'range' ? (
          <label key={o.key}>
            <span>
              {o.label}{' '}
              <b className="num">
                {on(it.opts, o.key, o.def)}
                {o.unit ?? ''}
              </b>
            </span>
            <input type="range" min={o.min} max={o.max} step={o.step ?? 1} value={on(it.opts, o.key, o.def)} onChange={(e) => setOpt(o.key, +e.target.value)} />
          </label>
        ) : o.type === 'choice' ? (
          <label key={o.key}>
            {o.label}
            <select value={os(it.opts, o.key, o.def)} onChange={(e) => setOpt(o.key, e.target.value)}>
              {o.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={o.key}>
            {o.label}
            <textarea rows={4} value={os(it.opts, o.key, o.def)} onChange={(e) => setOpt(o.key, e.target.value.slice(0, 1500))} />
          </label>
        ),
      )}
      <footer>
        <button onClick={() => set({ opts: undefined, scale: 1 })}>Сбросить</button>
        <button onClick={() => applyDashOp({ op: 'remove', id: it.id })}>Убрать</button>
        <button className="on" onClick={onClose}>
          Готово
        </button>
      </footer>
    </div>
  );
}

type Editing = { on: boolean; id: string | null };

/** Свободное поле 12×12: блоки где угодно; в режиме изменения — перенос, размер, добавление в пустую клетку. */
function GridField({ d, ctx, inWall, editing, setEditing }: { d: DashLayout; ctx: BlockCtx; inWall: Set<BlockId>; editing: Editing; setEditing: (v: Editing) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; r: Rect; ok: boolean } | null>(null);
  const cell = () => {
    const el = ref.current!;
    const box = el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    return { box, cw: (box.width + gap) / GRID_COLS, ch: (box.height + gap) / GRID_ROWS };
  };
  const start = (e: React.PointerEvent, it: GridItem, mode: 'move' | 'size') => {
    e.preventDefault();
    e.stopPropagation();
    const { cw, ch } = cell();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: { r: Rect; ok: boolean } | null = null;
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - x0) / cw);
      const dy = Math.round((ev.clientY - y0) / ch);
      const r = mode === 'move' ? fit({ x: it.x + dx, y: it.y + dy, w: it.w, h: it.h }) : fit({ x: it.x, y: it.y, w: it.w + dx, h: it.h + dy });
      const ok = free(getDash().items, r, it.id);
      last = { r, ok };
      setDrag({ id: it.id, r, ok });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dash-resizing');
      if (last?.ok) applyDashOp({ op: 'item', id: it.id, patch: last.r });
      setDrag(null);
    };
    document.body.classList.add(mode === 'move' ? 'dash-moving' : 'dash-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      document.body.classList.remove('dash-moving');
      up();
    }, { once: true });
  };
  const busy = new Set<number>();
  for (const it of d.items) for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) busy.add(y * GRID_COLS + x);
  const area = (r: Rect) => ({ gridColumn: `${r.x + 1} / span ${r.w}`, gridRow: `${r.y + 1} / span ${r.h}` });
  const sel = editing.on ? d.items.find((i) => i.id === editing.id) : undefined;
  return (
    <div ref={ref} className={`dash-grid ${editing.on ? 'editing' : ''}`}>
      {editing.on &&
        Array.from({ length: GRID_COLS * GRID_ROWS }, (_, k) =>
          busy.has(k) ? null : (
            <button key={`c${k}`} className="dg-cell" style={{ gridColumn: (k % GRID_COLS) + 1, gridRow: Math.floor(k / GRID_COLS) + 1 }} onClick={() => dashEvent({ type: 'gallery', open: true, at: { x: k % GRID_COLS, y: Math.floor(k / GRID_COLS) } })} title="Добавить блок сюда">
              <Plus size={14} />
            </button>
          ),
        )}
      {d.items.map((it) => (
        <section
          key={it.id}
          className={`dash-col b-${it.block} ${editing.on ? 'edit' : ''} ${editing.id === it.id ? 'sel' : ''} ${drag?.id === it.id ? 'dragging' : ''}`}
          style={{ ...area(it), ...(it.scale && it.scale !== 1 ? { fontSize: `${it.scale}em` } : {}) }}
          onClickCapture={
            editing.on
              ? (e) => {
                  if ((e.target as Element).closest('.dce')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing({ on: true, id: it.id });
                }
              : undefined
          }
        >
          <Block id={it.block} ctx={ctx} skip={inWall} o={it.opts} it={it} />
          {editing.on && (
            <>
              <div className="dce dce-bar" onPointerDown={(e) => start(e, it, 'move')} title="Тяните, чтобы переставить">
                <GripHorizontal size={14} />
                <span>{it.custom?.title ?? BLOCK_NAME[it.block]}</span>
                <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setEditing({ on: true, id: it.id })} aria-label="Настройки блока">
                  <Settings2 size={13} />
                </button>
                <button onPointerDown={(e) => e.stopPropagation()} onClick={() => applyDashOp({ op: 'remove', id: it.id })} aria-label="Убрать блок">
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="dce dce-size" onPointerDown={(e) => start(e, it, 'size')} title="Тяните, чтобы изменить размер" />
            </>
          )}
        </section>
      ))}
      {drag && <div className={`dg-ghost ${drag.ok ? 'ok' : 'bad'}`} style={area(drag.r)} />}
      {sel && (
        <div className="dce-pop-wrap" style={area({ x: sel.x + sel.w + 3 <= GRID_COLS ? sel.x + sel.w : Math.max(0, sel.x - 3), y: 0, w: 3, h: GRID_ROWS })}>
          <BlockEditor it={sel} onClose={() => setEditing({ on: true, id: null })} />
        </div>
      )}
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
