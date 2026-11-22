// Дашборд координатора — видеостена по кейсу. Видно с расстояния; блоки, стиль и поведение настраиваются
// в «Настройках дашборда» или голосом через Джарвиса. Прежняя стена — раскладка «Прежняя стена».
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Mic, Layers, AlarmClockOff, ArrowLeftRight, BellRing, CheckCircle2, Hand, Inbox, RotateCcw, Search, Timer, TrendingUp, Wrench, Zap, type LucideIcon, Expand, GripHorizontal, LayoutGrid, MonitorUp, Plus, Settings2, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { FeedEvent, Incident } from '../../../shared/types';
import { BLOCKS, BLOCK_NAME, DASH_GROUPS, GROUP_NAME, dashSnapshot, fmtShort, groupsOf, riskOf, transferCount, transfers, urgencyScore, waitingTake, type Attention, type BlockId, type DashGroup, type DashSnapshot } from '../../../shared/dash';
import type { DashStyle } from '../../../shared/dashStyles';
import { itsmLink, markSeen, openIncident, setTab, teamName, useStore } from '../../store';
import { heatFor } from '../../../shared/attention';
import { fmtClock } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { applyDashOp, currentStyle, dashEvent, dimsOf, getDash, openWallWindow, openWork, useDash, useDashEvents, type DashLayout } from '../../lib/dashLayout';
import { fit, free, type GridItem, type Rect } from '../../../shared/dashGrid';
import { BlockGallery, CharacterBlock, ClockBlock, CountersBlock, CustomBlock, ForgotBlock, GroupBlock, NoteBlock, RiskBlock, RouteBlock, TeamsBlock } from './blocks2';
import { BLOCK_OPTS } from './blockOpts';
import { Jarvis, jarvisBusyRecently, useJarvisWork } from '../Jarvis';
import { RFMap } from '../RFMap';
import { Spark } from '../kit';
import { WallPage } from '../WallPage';
import { DashSettings } from './DashSettings';
import { AttentionStrip, useAttention } from './attention';
import { UrgentShow } from './urgentShow';
import { NowBlock } from './blocks3';
import { DeadlinesBlock } from './deadlines';
import { FavsBlock2, oneLine, serviceIcon } from './wall2';
import { JarvisBlock } from './jarvisBlock';
import { TeamLoadBlock } from './teams';
import { CounterHeader } from './header';
import { MailBlock } from './mail';
import { QuestionsBlock } from './questions';
import { Stickers } from './stickers';
import { useBump, useFlip } from './anim';
import { Handover, HandoverCartoon } from './handover';
import { ShowPanel } from './showPanel';
import './dash.css';
import './dash-grid.css';
import './dash-fav.css';
import './dash-attention.css';
import './dash-visual.css';
import './dash-wall2.css';
import './dash-urgent.css';
import './dash-show.css';

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
  // срочное — на весь экран, пока не приняли (щелчок, Esc или «принял» голосом) или пока ситуация не разрешилась;
  // принятое уходит в полосу
  const urgentNow = att.urgent;
  const stripList = att.strip;
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
      className={`dash ${standalone || home ? 'standalone' : ''} ${home ? 'home' : ''} ${urgentNow.length ? 'dash-alarm' : ''}`}
      data-dark={style.dark ? '1' : '0'}
      data-card={style.card ?? 'solid'}
      data-font={style.font ?? 'sans'}
      data-glow={style.glow ? '1' : '0'}
      data-density={d.density}
      style={styleVars(style)}
    >
      {style.deco === 'snow' && <Snow />}
      {d.counters ? <CounterHeader snap={snap} now={now} d={d} home={home} /> : home && <span className="dash-work-float"><WorkButton /></span>}
      <AttentionStrip list={stripList} info={att.info} incidents={incidents} now={now} onClose={att.dismiss} onOpen={open} />
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
      <Stickers />
      <BlockPopup ctx={ctx} />
      {!editing.on && <ShowPanel />}
      <UrgentShow list={urgentNow} incidents={incidents} now={now} onAck={att.ack} />
      <Handover />
      <HandoverCartoon />
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
      return <FavsBlock2 ctx={ctx} />;
    case 'mail':
      return <MailBlock ctx={ctx} />;
    case 'questions':
      return <QuestionsBlock ctx={ctx} />;
    case 'teamload':
      return <TeamLoadBlock ctx={ctx} />;
    case 'custom':
      return it?.custom ? it.custom.kind === 'character' ? <CharacterBlock ctx={ctx} o={o} spec={it.custom} /> : <CustomBlock ctx={ctx} spec={it.custom} /> : null;
    case 'action':
      return <ActionBlock ctx={ctx} o={o} />;
    case 'now':
      return <NowBlock ctx={ctx} />;
    case 'deadlines':
      return <DeadlinesBlock ctx={ctx} />;
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
  const bump = useBump<HTMLSpanElement>(count); // число поменялось — короткий «прыжок»
  return (
    <div className="db-head">
      {icon}
      <h2>{title}</h2>
      {count !== undefined && (
        <span ref={bump} className="db-count num">
          {count}
        </span>
      )}
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

/** Почему требует внимания — значком и одним словом, вместо строки текста. */
const WHY: [RegExp, LucideIcon, string | null][] = [
  [/^Передать/, Inbox, 'распределить'],
  [/^Не при|^Не берут/, Hand, 'не берут'],
  [/^ИИ: поднять/, Zap, 'ИИ: наивысший'],
  [/^Срок близко/, Timer, 'срок'],
  [/^Просрочен/, AlarmClockOff, 'просрочен'],
  [/передач/, ArrowLeftRight, null],
  [/^Риск/, TrendingUp, null],
  [/^Снова жалобы/, RotateCcw, null],
  [/^В работе/, Wrench, 'в работе'],
  [/^Разбор/, Search, 'разбор'],
];
export function Why({ att }: { att?: Attention }) {
  if (!att) return null;
  const hit = WHY.find(([re]) => re.test(att.reason));
  if (!hit) return null;
  const [, Icon, word] = hit;
  return (
    <span className={`dc-why t-${att.tone}`} title={att.reason}>
      <Icon size={13} /> {word ?? att.reason.toLowerCase()}
    </span>
  );
}
/** Кто ведёт — коротко: команда (и исполнитель) или дежурный пункта. */
export const whoShort = (i: Incident) =>
  i.status === 'coordinators' ? (i.coordinatorName ? `ведёт ${i.coordinatorName.split(' ')[0]}` : 'никто не ведёт') : `${teamName(i.teamId)}${i.assigneeName ? ` · ${i.assigneeName.split(' ')[0]}` : ''}`;
/** Срок кольцом: заполняется по мере того, как время уходит; цвет — сколько осталось. */
export function Ring({ i, now, big }: { i: Incident; now: number; big?: boolean }) {
  const left = i.slaDeadline - now;
  const f = frac(i, now);
  const r = 16;
  const c = 2 * Math.PI * r;
  const tone = left <= 0 ? 'over' : left < 30 * MIN ? 'hot' : left < 2 * 60 * MIN ? 'warm' : 'ok';
  const m = Math.round(Math.abs(left) / MIN);
  const txt = m < 60 ? `${m}м` : m < 600 ? `${Math.floor(m / 60)}ч${String(m % 60).padStart(2, '0')}` : m < 2880 ? `${Math.floor(m / 60)}ч` : `${Math.floor(m / 1440)}д`;
  return (
    <span className={`dring t-${tone} ${big ? 'big' : ''}`} title={left > 0 ? `до срока ${fmtShort(left)}` : `просрочен на ${fmtShort(-left)}`}>
      <svg className="dring-c" viewBox="0 0 40 40" aria-hidden>
        <circle className="bg" cx="20" cy="20" r={r} />
        <circle className="fg" cx="20" cy="20" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - (left <= 0 ? 1 : f))} style={{ ['--c' as string]: c }} />
      </svg>
      <b className="num">{left <= 0 ? `−${txt}` : txt}</b>
    </span>
  );
}

/** Короткое время до срока: «40м», «5ч», «2д», просрочен — с минусом. */
const shortLeft = (left: number) => {
  const m = Math.round(Math.abs(left) / MIN);
  const t = m < 60 ? `${m}м` : m < 2880 ? `${Math.floor(m / 60)}ч` : `${Math.floor(m / 1440)}д`;
  return left < 0 ? `−${t}` : t;
};

/**
 * Строка списка: только инцидент — значок сервиса, «Сервис · Город» и сколько до срока (у «снова жалобы» — сколько жалоб).
 * Цвет строки — насколько горит: чем краснее, тем выше в списке. Без кнопок: на большом экране действует Джарвис.
 */
function FillRow({ i, att, h, now, onClick, off, focus = false }: { i: Incident; att?: Attention; h: number; now: number; onClick: () => void; off?: boolean; focus?: boolean }) {
  const recur = i.status === 'resolved' && i.recur ? i.recur : null;
  const Icon = serviceIcon(i);
  const left = i.slaDeadline - now;
  return (
    <div
      role="button"
      data-inc={i.id}
      data-flip={i.id}
      data-level={h}
      tabIndex={off ? -1 : 0}
      className={`dfr h-${h} p-${i.priority} ${off ? 'off' : ''} ${focus ? 'jv-focus' : ''}`}
      onClick={onClick}
      title={`${i.title}
${PRIO[i.priority]} · ${i.productName || i.service} · возник ${fmtClock(i.createdAt)} · ${i.stateText}
${who(i)}${att ? `
${att.reason}` : ''}`}
      aria-hidden={off || undefined}
    >
      <span className="dfr-ic">
        <Icon />
      </span>
      <b className="dfr-title">{oneLine(i)}</b>
      <span className="dfr-time num">
        {recur ? (
          <>
            <RotateCcw /> {recur.count}
          </>
        ) : (
          shortLeft(left)
        )}
      </span>
    </div>
  );
}

/**
 * «Кому распределить»: все инциденты, требующие действия, одним списком — сверху самые красные (насколько горит:
 * уровень, срок, «снова жалобы»). Без прокрутки и листания: показываем, сколько помещается, а остальное —
 * одной строкой «ещё N · горит M» (их зачитает Джарвис). Внизу — вопрос Джарвиса.
 */
function ActionBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now, d } = ctx;
  // Распределить — это то, что ещё на пункте, и решённые, по которым снова жалобы (вернуть команде).
  // Переданные команде здесь не висят, даже если команда ещё не взяла: это видно в «Командах» и «Вопросах».
  const mine = snap.action.filter((x) => x.inc.status === 'coordinators' || x.inc.status === 'resolved');
  const list = mine
    .map((x) => ({ ...x, h: heatFor(x.inc, x.att.score) }))
    .sort((a, b) => b.h - a.h || b.att.score - a.att.score || a.inc.slaDeadline - b.inc.slaDeadline);
  // сколько строк помещается в блок (меряем по уже стоящим строкам)
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(list.length);
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
  useFlip(box); // строки плавно переезжают, когда меняется порядок; новые въезжают; стал горячее — вспышка
  const over = list.length > fit;
  const cut = over ? Math.max(1, fit - 1) : list.length;
  const rest = list.slice(cut);
  const restHot = rest.filter((x) => x.h >= 3).length;
  const work = useJarvisWork(); // о каком инциденте говорит Джарвис — подсвечиваем строку
  const jvFocus = jarvisBusyRecently(now) ? work.focusId : null;
  const toRoute = mine.filter((x) => x.inc.status === 'coordinators');
  const withAi = toRoute.filter((x) => x.inc.ai?.teamId).length;
  const recurN = mine.filter((x) => x.inc.status === 'resolved').length;
  const ask = withAi ? `«Передать ${withAi} по совету ИИ?»` : toRoute.length ? '«Подобрать команды?»' : recurN ? '«Вернуть в работу?»' : null;
  const row = (x: (typeof list)[number], off?: boolean) => <FillRow key={x.inc.id} i={x.inc} att={x.att} h={x.h} now={now} off={off} focus={jvFocus === x.inc.id} onClick={() => ctx.open(x.inc)} />;
  return (
    <div className={`db db-action ${ob(o, 'compact', false) ? 'compact' : ''}`}>
      <BlockHead title={d.filter ? GROUP_NAME[d.filter] : 'Кому распределить'} count={mine.length} icon={<BellRing size={18} />} />
      {!mine.length && (
        <div className="dn-calm">
          <CheckCircle2 />
        </div>
      )}
      <div className="db-list dfr-list" ref={box}>
        {list.slice(0, cut).map((x) => row(x))}
        {over && (
          <div className={`dfr dfr-more ${restHot ? 'hot' : ''}`} data-flip="more" data-level={restHot} title={rest.map((x) => x.inc.title).join('\n')}>
            <span className="dfr-ic">
              <Layers />
            </span>
            <b className="dfr-title">ещё {rest.length}</b>
            {restHot > 0 && <span className="dfr-time num">горит {restHot}</span>}
          </div>
        )}
        {rest.map((x) => row(x, true))}
      </div>
      {ask && (
        <div className="dn4-jv dfr-jv" title="Ответьте голосом — Джарвис сделает">
          <span className="dn4-mic">
            <Mic />
          </span>
          <b>{ask}</b>
        </div>
      )}
    </div>
  );
}

/** В работе у команд: название, кто и сколько в работе — второй строкой; срок кольцом. Узкие колонки не режут названия. */
function WorkBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now, d } = ctx;
  const p = useFitPager(snap.work.length, on(o, 'page', d.pageSec));
  return (
    <div className="db db-work">
      <BlockHead title="В работе у команд" count={snap.work.length} icon={<Wrench size={17} />} />
      <div className="db-list" ref={p.box}>
        {snap.work.slice(p.start).map((i, n) => {
          const w = waitingTake(i, now);
          const since = i.startedAt ?? i.routedAt ?? i.createdAt;
          const t = transferCount(i);
          return (
            <button
              key={i.id}
              data-heat={heatFor(i, urgencyScore(i, now))}
              className={`dw2 p-${i.priority} ${n >= p.fit ? 'off' : ''}`}
              onClick={() => ctx.open(i)}
              title={`${i.title}\n${i.productName || i.service} · ${i.stateText}\n${i.assigneeName ?? 'исполнитель не назначен'}`}
              aria-hidden={n >= p.fit || undefined}
              tabIndex={n >= p.fit ? -1 : undefined}
            >
              <span className="dc-bar" />
              <span className="dw2-main">
                <b>{i.title}</b>
                <small>
                  {w !== null ? (
                    <span className={w > 10 * MIN ? 'warn' : ''}>
                      <Hand size={11} /> не взяли {fmtShort(w)}
                    </span>
                  ) : (
                    <span>
                      <Wrench size={11} /> {fmtShort(now - since)}
                    </span>
                  )}
                  {t >= 2 && (
                    <span className="warn">
                      <ArrowLeftRight size={11} /> {t}
                    </span>
                  )}
                  <span className="dw2-team">{whoShort(i)}</span>
                </small>
              </span>
              <Ring i={i} now={now} />
            </button>
          );
        })}
        {!snap.work.length && <div className="db-empty">У команд пусто</div>}
      </div>
      <PagerFoot p={p} total={snap.work.length} />
    </div>
  );
}

/** Четыре группы кейса. Узкий блок — 2×2, а не четыре тонкие колонки; узкая колонка — короткое название, число всегда видно. */
function GroupsBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const { snap, now } = ctx;
  return (
    <div className="db db-groups">
      <div className="dg-grid">
      {DASH_GROUPS.filter((g) => ob(o, `g_${g.id}`)).map((g) => (
        <div key={g.id} className={`dg g-${g.id} ${snap.byGroup[g.id].length ? '' : 'zero'}`} title={g.hint}>
          <div className="dg-head">
            <b>
              <span className="dg-long">{g.label}</span>
              <span className="dg-short">{g.short}</span>
            </b>
            <span className="num" key={snap.byGroup[g.id].length}>
              {snap.byGroup[g.id].length}
            </span>
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
              <button key={i.id} data-heat={heatFor(i, urgencyScore(i, now))} className={`dg-row p-${i.priority}`} onClick={() => ctx.open(i)} title={`${i.productName || i.service} · ${i.stateText}`}>
                <span className="dc-bar" />
                <span>
                  <b>{i.title}</b>
                  <small>{whoShort(i)}</small>
                </span>
                <span className={`num dg-left ${i.slaDeadline - now < 30 * MIN ? 'hot' : ''}`}>{leftText(i, now)}</span>
              </button>
            ))}
            {!snap.byGroup[g.id].length && !(g.id === 'crit' && snap.resolvedCrit.length) && (
              <div className="dg-calm" title="Пусто">
                <CheckCircle2 />
              </div>
            )}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}

/** Блок окном поверх стены — по просьбе Джарвису («покажи четыре группы», «…на весь экран») или щелчком по плашке. */
function BlockPopup({ ctx }: { ctx: BlockCtx }) {
  const [p, setP] = useState<{ block: BlockId; full: boolean } | null>(null);
  useDashEvents(
    useCallback((e) => {
      if (e.type === 'popup') setP(e.block ? { block: e.block, full: e.full } : null);
    }, []),
  );
  useEffect(() => {
    if (!p) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setP(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [p]);
  if (!p) return null;
  return (
    <div className={`bp-wrap ${p.full ? 'full' : ''}`} onClick={() => setP(null)}>
      <div className="bp" onClick={(e) => e.stopPropagation()}>
        <span className="bp-x" role="button" tabIndex={0} onClick={() => setP(null)} title="Закрыть (Esc или «Джарвис, закрой окно»)">
          <X />
        </span>
        <Block id={p.block} ctx={ctx} skip={new Set()} />
      </div>
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
/** ИИ-помощник на стене — персонаж с состояниями и одной фразой (подробности — голосом и в рабочем месте). */
function AssistantBlock({ ctx }: { ctx: BlockCtx; o?: Opts }) {
  const brief = useBrief();
  return <JarvisBlock ctx={ctx} brief={brief?.text ?? null} />;
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
  useJarvisWork();
  const cur = jarvisBusyRecently(ctx.now) && list.includes('assistant') ? 'assistant' : list[k % list.length];
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
  const g = dimsOf(getDash());
  const tryRect = (r: Partial<GridItem>) => {
    const next = { ...it, ...r };
    if (free(getDash().items, next, it.id, g)) set(r);
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
          Ширина <b className="num">{it.w} из {g.cols}</b>
        </span>
        <input type="range" min={2} max={g.cols} step={1} value={it.w} onChange={(e) => tryRect({ w: +e.target.value, x: Math.min(it.x, g.cols - +e.target.value) })} />
      </label>
      <label>
        <span>
          Высота <b className="num">{it.h} из {g.rows}</b>
        </span>
        <input type="range" min={2} max={g.rows} step={1} value={it.h} onChange={(e) => tryRect({ h: +e.target.value, y: Math.min(it.y, g.rows - +e.target.value) })} />
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

/** Свободное поле (12×12 или своё — d.gridCols × d.gridRows): блоки где угодно; в режиме изменения — перенос,
 *  размер, добавление в пустую клетку. Блоки задаются в клетках: поле больше — блоки того же вида, места больше. */
function GridField({ d, ctx, inWall, editing, setEditing }: { d: DashLayout; ctx: BlockCtx; inWall: Set<BlockId>; editing: Editing; setEditing: (v: Editing) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; r: Rect; ok: boolean } | null>(null);
  const g = dimsOf(d);
  const cell = () => {
    const el = ref.current!;
    const box = el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    return { box, cw: (box.width + gap) / g.cols, ch: (box.height + gap) / g.rows };
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
      const r = mode === 'move' ? fit({ x: it.x + dx, y: it.y + dy, w: it.w, h: it.h }, g) : fit({ x: it.x, y: it.y, w: it.w + dx, h: it.h + dy }, g);
      const ok = free(getDash().items, r, it.id, g);
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
  for (const it of d.items) for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) busy.add(y * g.cols + x);
  const area = (r: Rect) => ({ gridColumn: `${r.x + 1} / span ${r.w}`, gridRow: `${r.y + 1} / span ${r.h}` });
  const sel = editing.on ? d.items.find((i) => i.id === editing.id) : undefined;
  return (
    <div ref={ref} className={`dash-grid ${editing.on ? 'editing' : ''}`} style={{ '--dg-cols': g.cols, '--dg-rows': g.rows } as React.CSSProperties}>
      {editing.on &&
        Array.from({ length: g.cols * g.rows }, (_, k) =>
          busy.has(k) ? null : (
            <button key={`c${k}`} className="dg-cell" style={{ gridColumn: (k % g.cols) + 1, gridRow: Math.floor(k / g.cols) + 1 }} onClick={() => dashEvent({ type: 'gallery', open: true, at: { x: k % g.cols, y: Math.floor(k / g.cols) } })} title="Добавить блок сюда">
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
        <div className="dce-pop-wrap" style={area({ x: sel.x + sel.w + 3 <= g.cols ? sel.x + sel.w : Math.max(0, sel.x - 3), y: 0, w: 3, h: g.rows })}>
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
