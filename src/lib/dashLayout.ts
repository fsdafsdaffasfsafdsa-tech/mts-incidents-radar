// Настройки дашборда (видеостены): блоки на свободном поле, стиль, тревоги, Джарвис. Хранятся в браузере
// и сразу доходят до окна стены, открытого отдельно (событие storage) — Джарвис в окне дежурного
// перестраивает стену на соседнем экране.
import { useEffect, useState } from 'react';
import type { AlertKind } from '../../shared/attention';
import { BLOCKS, PRESETS, type BlockId, type DashColumn, type DashGroup, type DashOp, type PresetId } from '../../shared/dash';
import { DASH_STYLE_IDS, dashStyleById, type DashStyle } from '../../shared/dashStyles';
import { DEFAULT_GRID, DEFAULT_SIZE, addItem, cleanDims, columnsToItems, newId, normalize, readingOrder, regrid, removeItem, swapItems, widen, type GridDims, type GridItem } from '../../shared/dashGrid';
import { cleanSpec } from '../../shared/dashCustom';

export interface DashLayout {
  preset: PresetId | 'custom';
  items: GridItem[]; // блоки на поле gridCols × gridRows
  gridCols: number; // клеток по горизонтали (12 — один экран 16:9, 36 — три экрана)
  gridRows: number; // клеток по вертикали
  counters: boolean; // полоса счётчиков сверху
  ticker: boolean; // бегущая строка снизу
  filter: DashGroup | null;
  style: string;
  density: 'normal' | 'large';
  rotateSec: number; // сменяемая панель
  pageSec: number; // листание длинных списков
  onlyFile: boolean; // только инциденты из файла ITSM (без инцидентов из жалоб)
  banners: boolean; // тревоги на стене
  sound: boolean; // звук тревоги
  jarvis: boolean; // шар Джарвиса на отдельном экране стены
  jarvisEdit: boolean; // Джарвис может перестраивать стену
  customStyles: DashStyle[]; // придуманные ChatGPT по описанию
  locked: boolean; // интерфейс закреплён: Джарвис и случайные нажатия ничего не меняют
  ver?: number; // версия раскладки по умолчанию: при новой базовой прежние один раз переводятся на неё
  stickers: Sticker[]; // персонажи ChatGPT поверх стены — где угодно, любого размера и поворота
}

/** Персонаж на прозрачном фоне поверх стены. x, y — центр в долях стены, w — ширина в долях, rot — градусы. */
export interface Sticker {
  id: string;
  src: string;
  name: string;
  x: number;
  y: number;
  w: number;
  rot: number;
  flip?: boolean;
}
export const MAX_STICKERS = 6;
function cleanStickers(x: unknown): Sticker[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((s): s is Sticker => !!s && typeof s === 'object' && typeof (s as Sticker).src === 'string' && (s as Sticker).src.startsWith('data:image/') && (s as Sticker).src.length < 400_000)
    .map((s) => ({
      id: typeof s.id === 'string' && s.id ? s.id : newId(),
      src: s.src,
      name: typeof s.name === 'string' ? s.name.slice(0, 40) : 'Персонаж',
      x: clamp(Number(s.x) || 0.5, 0, 1),
      y: clamp(Number(s.y) || 0.5, 0, 1),
      w: clamp(Number(s.w) || 0.15, 0.04, 0.8),
      rot: ((Number(s.rot) || 0) % 360 + 360) % 360,
      ...(s.flip ? { flip: true } : {}),
    }))
    .slice(-MAX_STICKERS);
}

const KEY = 'radar.dash.v1';
export const presetItems = (id: PresetId): GridItem[] => {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return [];
  if (p.grid) return p.grid.map((g, k) => ({ ...g, id: newId() + k, ...(g.opts ? { opts: { ...g.opts } } : {}) }));
  return columnsToItems(p.columns);
};
/** Новая базовая раскладка — один раз заменяет прежние у тех, кто её не закрепил. */
const LAYOUT_VER = 6;
export const DEFAULT_DASH: DashLayout = {
  ver: LAYOUT_VER,
  preset: 'base',
  items: presetItems('base'),
  gridCols: DEFAULT_GRID.cols,
  gridRows: DEFAULT_GRID.rows,
  counters: true,
  ticker: false, // бегущая строка мешает читать стену — по умолчанию выключена
  filter: null,
  style: 'focus',
  density: 'normal',
  rotateSec: 20,
  pageSec: 15,
  onlyFile: false,
  banners: true,
  sound: false, // звуковые эффекты стены — по умолчанию выключены: о событиях говорит Джарвис
  jarvis: true,
  jarvisEdit: true,
  customStyles: [],
  locked: false,
  stickers: [],
};

const blockIds = new Set(BLOCKS.map((b) => b.id));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function cleanOpts(o: unknown) {
  if (!o || typeof o !== 'object') return undefined;
  const e = Object.entries(o as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 2000));
  return e.length ? (Object.fromEntries(e) as Record<string, boolean | number | string>) : undefined;
}
function clean(x: (Partial<DashLayout> & { columns?: DashColumn[] }) | null): DashLayout {
  const d = { ...DEFAULT_DASH, ...(x ?? {}) } as DashLayout & { columns?: DashColumn[] };
  // прежний формат — колонки: переводим в блоки на поле
  let items: GridItem[] = Array.isArray(d.items) && (x?.items?.length ?? 0) > 0 ? d.items : Array.isArray(x?.columns) && x!.columns!.length ? columnsToItems(x!.columns!.filter((c) => blockIds.has(c.block))) : DEFAULT_DASH.items;
  items = items
    .filter((i) => i && blockIds.has(i.block))
    .map((i) => {
      const it: GridItem = { id: typeof i.id === 'string' && i.id ? i.id : newId(), block: i.block, x: Number(i.x) || 0, y: Number(i.y) || 0, w: Number(i.w) || 4, h: Number(i.h) || 6 };
      if (i.scale) it.scale = clamp(Number(i.scale) || 1, 0.7, 1.6);
      const o = cleanOpts(i.opts);
      if (o) it.opts = o;
      if (i.custom) {
        const c = cleanSpec(i.custom);
        if (c) it.custom = c;
      }
      return it;
    })
    .slice(0, 48);
  const g = cleanDims({ cols: d.gridCols, rows: d.gridRows });
  d.gridCols = g.cols;
  d.gridRows = g.rows;
  d.items = normalize(items, g);
  if (!d.items.length && d.preset !== 'legacy') d.items = presetItems('base');
  if ((d.ver ?? 0) < LAYOUT_VER) {
    if ((d.ver ?? 0) < 2 && !d.locked) {
      d.preset = 'base';
      d.items = presetItems('base');
      d.filter = null;
    }
    if ((d.ver ?? 0) < 3) d.sound = false; // v3: звуковые эффекты выключены, о событиях говорит Джарвис
    // v4: редизайн по ChatGPT — новая базовая раскладка, стиль «Фокус», без бегущей строки (закреплённые не трогаем)
    if ((d.ver ?? 0) < 4 && !d.locked) {
      d.preset = 'base';
      d.items = presetItems('base');
      d.filter = null;
      d.style = 'focus';
      d.ticker = false;
      d.density = 'normal';
    }
    // v5: избранное смены ушло со стены — почта занимает его место (только базовая раскладка, закреплённые не трогаем)
    if ((d.ver ?? 0) < 5 && !d.locked && d.preset === 'base') d.items = presetItems('base');
    // v6: блок «Вопросы» (командам и руководителям) — под почтой в базовой раскладке
    if ((d.ver ?? 0) < 6 && !d.locked && d.preset === 'base') d.items = presetItems('base');
    d.ver = LAYOUT_VER;
  }
  delete d.columns;
  d.customStyles = (Array.isArray(d.customStyles) ? d.customStyles : []).filter((s) => s && typeof s.id === 'string' && s.custom).slice(-12);
  if (!DASH_STYLE_IDS.includes(d.style) && !d.customStyles.some((s) => s.id === d.style)) d.style = DEFAULT_DASH.style;
  d.rotateSec = clamp(d.rotateSec, 8, 120);
  d.pageSec = clamp(d.pageSec, 6, 60);
  d.stickers = cleanStickers(d.stickers);
  return d;
}

function read(): DashLayout {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DashLayout> | null);
  } catch {
    return clean(null);
  }
}
let state: DashLayout = read();
const subs = new Set<() => void>();
function emit() {
  subs.forEach((f) => f());
}
export const getDash = () => state;
export function setDash(patch: (Partial<DashLayout> & { columns?: DashColumn[] }) | ((d: DashLayout) => Partial<DashLayout>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = clean({ ...state, ...p });
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* приватное окно — живём без сохранения */
  }
  emit();
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    state = read();
    emit();
  });

/** Подписка на любые изменения настроек стены (для сохранения в учётной записи). */
export function subscribeDash(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

export function useDash(): DashLayout {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return state;
}

// ─── что-то разовое: крупно показать инцидент, открыть настройки, проверить тревогу ───
type Ev =
  | { type: 'focus'; id: string | null }
  | { type: 'settings'; open: boolean }
  | { type: 'test-alarm'; kind: AlertKind }
  | { type: 'designing'; text: string | null }
  | { type: 'sticker'; id: string } // появился персонаж — выделить его, чтобы сразу двигать
  | { type: 'popup'; block: BlockId | null; full: boolean } // блок окном поверх стены
  | { type: 'edit'; on: boolean; id?: string | null }
  | { type: 'gallery'; open: boolean; at?: { x: number; y: number } | null };
const evSubs = new Set<(e: Ev) => void>();
const CH = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('radar.dash') : null;
CH?.addEventListener('message', (m) => evSubs.forEach((f) => f(m.data as Ev)));
export function dashEvent(e: Ev) {
  evSubs.forEach((f) => f(e));
  CH?.postMessage(e); // и в отдельное окно стены
}
export function useDashEvents(f: (e: Ev) => void) {
  useEffect(() => {
    evSubs.add(f);
    return () => void evSubs.delete(f);
  }, [f]);
}

const sizeOf = (b: BlockId) => DEFAULT_SIZE[b] ?? { w: 4, h: 6 };
/** Размер поля стены. */
export const dimsOf = (d: DashLayout): GridDims => ({ cols: d.gridCols, rows: d.gridRows });
/** Готовая раскладка рассчитана на поле 12×12: на большем поле она встаёт в угол блоками того же размера. */
const presetOn = (id: PresetId, g: GridDims) => regrid(presetItems(id), DEFAULT_GRID, g);
/** Применить действие (от Джарвиса, из настроек или с поля). Возвращает, что получилось, — человеческим языком. */
export function applyDashOp(o: DashOp): string {
  const d = state;
  if (d.locked && o.op !== 'focus' && o.op !== 'settings') return 'интерфейс закреплён — сначала открепите его в настройках дашборда';
  const g = dimsOf(d);
  const ordered = readingOrder(d.items);
  const at = (k: number) => ordered[k < 0 ? ordered.length + k : k];
  const put = (items: GridItem[], extra: Partial<DashLayout> = {}) => setDash({ preset: 'custom', items, ...extra });
  switch (o.op) {
    case 'grid': {
      const to = cleanDims({ cols: o.cols ?? d.gridCols, rows: o.rows ?? d.gridRows });
      if (to.cols === g.cols && to.rows === g.rows) return `сетка уже ${to.cols}×${to.rows}`;
      setDash({ gridCols: to.cols, gridRows: to.rows, items: regrid(d.items, g, to) });
      return `сетка ${to.cols}×${to.rows}`;
    }
    case 'preset': {
      const p = PRESETS.find((x) => x.id === o.preset);
      if (!p) return 'нет такой раскладки';
      setDash({ preset: p.id, items: p.columns.length || p.grid ? presetOn(p.id, g) : d.items, filter: p.filter ?? null, density: p.density ?? 'normal' });
      return `раскладка «${p.name}»`;
    }
    case 'show':
    case 'add': {
      if (o.op === 'show' && d.items.some((i) => i.block === o.block)) return 'уже на стене';
      const size = sizeOf(o.block);
      const extra = o.op === 'add' ? { opts: o.opts, custom: o.custom, ...(o.x !== undefined ? { x: o.x, y: o.y } : {}), w: o.w ?? size.w, h: o.h ?? size.h } : { w: size.w, h: size.h };
      const next = addItem(d.items, { block: o.block, ...extra }, size, g);
      if (next.length === d.items.length) return 'на поле нет места — уменьшите или уберите блок';
      put(next);
      return 'добавил блок';
    }
    case 'hide': {
      const it = d.items.find((i) => i.block === o.block);
      if (!it) return 'этого блока нет на стене';
      if (d.items.length <= 1) return 'последний блок не убрать';
      put(removeItem(d.items, it.id));
      return 'убрал блок';
    }
    case 'remove':
      if (d.items.length <= 1) return 'последний блок не убрать';
      put(removeItem(d.items, o.id));
      return 'убрал блок';
    case 'item':
      put(d.items.map((i) => (i.id === o.id ? { ...i, ...o.patch, id: i.id } : i)));
      return 'изменил блок';
    case 'swap': {
      const A = at(o.a);
      const B = at(o.b);
      if (!A || !B || A === B) return 'нет таких блоков';
      put(swapItems(d.items, A.id, B.id));
      return 'поменял местами';
    }
    case 'replace': {
      const T = at(o.at);
      if (!T) return 'нет такого блока';
      const dup = d.items.find((i) => i.block === o.block && i.id !== T.id);
      put(dup ? swapItems(d.items, dup.id, T.id) : d.items.map((i) => (i.id === T.id ? { id: i.id, block: o.block, x: i.x, y: i.y, w: i.w, h: i.h, scale: i.scale } : i)));
      return 'заменил блок';
    }
    case 'wider': {
      const it = d.items.find((i) => i.block === o.block);
      if (!it) return 'этого блока нет на стене';
      put(widen(d.items, it.id, Math.round(o.by * 3) || (o.by > 0 ? 1 : -1), g));
      return o.by > 0 ? 'сделал шире' : 'сделал уже';
    }
    case 'filter':
      setDash({ filter: o.group });
      return o.group ? 'фильтр по группе' : 'показываю все группы';
    case 'popup':
      // окно поверх стены: раскладку не трогаем — блок показывается крупно и закрывается щелчком мимо или Esc
      dashEvent({ type: 'popup', block: o.block, full: !!o.full });
      return o.block ? 'показал окном' : 'закрыл окно';
    case 'customStyle': {
      const list = [...d.customStyles.filter((s) => s.id !== o.style.id), { ...o.style, custom: true }].slice(-12);
      const p = o.preset ? PRESETS.find((x) => x.id === o.preset) : undefined;
      setDash({ customStyles: list, style: o.style.id, ...(p && (p.columns.length || p.grid) ? { preset: p.id, items: presetOn(p.id, g) } : {}), ...(o.density ? { density: o.density } : {}) });
      return `свой стиль «${o.style.name}»`;
    }
    case 'removeStyle':
      setDash({ customStyles: d.customStyles.filter((s) => s.id !== o.id), ...(d.style === o.id ? { style: DEFAULT_DASH.style } : {}) });
      return 'убрал стиль';
    case 'style':
      if (!DASH_STYLE_IDS.includes(o.style) && !d.customStyles.some((s) => s.id === o.style)) return 'нет такого стиля';
      setDash({ style: o.style });
      return 'сменил стиль';
    case 'density':
      setDash({ density: o.value });
      return o.value === 'large' ? 'крупно' : 'обычный размер';
    case 'toggle':
      setDash({ [o.what]: o.on } as Partial<DashLayout>);
      return o.on ? 'включил' : 'выключил';
    case 'focus':
      dashEvent({ type: 'focus', id: o.id });
      return o.id ? 'показываю крупно' : 'убрал';
    case 'settings':
      dashEvent({ type: 'settings', open: o.open });
      return o.open ? 'открыл настройки дашборда' : 'закрыл настройки';
    case 'reset':
      // экраны те же — размер сетки сохраняем
      setDash({ ...DEFAULT_DASH, items: presetOn('case', g), gridCols: g.cols, gridRows: g.rows, style: d.style, customStyles: d.customStyles });
      return 'вернул раскладку по умолчанию';
  }
}

// ─── главный экран: после входа — дашборд, рабочее место открывается по кнопке ───
let workOpen = false;
const workSubs = new Set<() => void>();
export const isWorkOpen = () => workOpen;
export function setWorkOpen(v: boolean) {
  if (workOpen === v) return;
  workOpen = v;
  workSubs.forEach((f) => f());
}
export const openWork = () => setWorkOpen(true);
export const closeWork = () => setWorkOpen(false);
export function useWorkOpen() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    workSubs.add(f);
    return () => void workSubs.delete(f);
  }, []);
  return workOpen;
}

// ─── отдельное окно стены (на экране над рабочими местами) ───
let wallWin: Window | null = null;
export function openWallWindow() {
  wallWin = window.open('/?wall', 'radar-wall');
}
export const wallWindowOpen = () => !!wallWin && !wallWin.closed;

/** Стиль стены: готовый или придуманный ChatGPT. */
export const currentStyle = (d: DashLayout) => d.customStyles.find((s) => s.id === d.style) ?? dashStyleById(d.style);

/** Коротко для Джарвиса: что сейчас на стене (блоки в порядке чтения: слева направо). */
export function dashSummary() {
  const d = state;
  return { preset: d.preset, columns: readingOrder(d.items).map((i) => i.block), style: d.style, filter: d.filter, density: d.density, locked: d.locked, grid: { cols: d.gridCols, rows: d.gridRows } };
}
