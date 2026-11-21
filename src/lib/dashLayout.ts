// Настройки дашборда (видеостены): раскладка блоков, стиль, тревоги, Джарвис. Хранятся в браузере
// и сразу доходят до окна стены, открытого отдельно (событие storage) — Джарвис в окне дежурного
// перестраивает стену на соседнем экране.
import { useEffect, useState } from 'react';
import { BLOCKS, PRESETS, type BlockId, type DashColumn, type DashGroup, type DashOp, type PresetId } from '../../shared/dash';
import { DASH_STYLE_IDS, dashStyleById, type DashStyle } from '../../shared/dashStyles';

export interface DashLayout {
  preset: PresetId | 'custom';
  columns: DashColumn[];
  counters: boolean; // полоса счётчиков сверху
  ticker: boolean; // бегущая строка снизу
  filter: DashGroup | null;
  style: string;
  density: 'normal' | 'large';
  rotateSec: number; // сменяемая панель
  pageSec: number; // листание длинных списков
  onlyFile: boolean; // только инциденты из файла ITSM (без инцидентов из жалоб)
  banners: boolean; // тревоги баннером на всю стену
  sound: boolean; // звук тревоги
  jarvis: boolean; // шар Джарвиса на отдельном экране стены
  jarvisEdit: boolean; // Джарвис может перестраивать стену
  customStyles: DashStyle[]; // придуманные ChatGPT по описанию
  locked: boolean; // интерфейс закреплён: Джарвис и случайные нажатия ничего не меняют
}

const KEY = 'radar.dash.v1';
const MAX_COLS = 4;
export const DEFAULT_DASH: DashLayout = {
  preset: 'case',
  columns: PRESETS[0].columns.map((c) => ({ ...c })),
  counters: true,
  ticker: true,
  filter: null,
  style: 'graphite',
  density: 'normal',
  rotateSec: 20,
  pageSec: 15,
  onlyFile: false,
  banners: true,
  sound: true,
  jarvis: true,
  jarvisEdit: true,
  customStyles: [],
  locked: false,
};

const blockIds = new Set(BLOCKS.map((b) => b.id));
function clean(x: Partial<DashLayout> | null): DashLayout {
  const d = { ...DEFAULT_DASH, ...(x ?? {}) };
  d.columns = (Array.isArray(d.columns) ? d.columns : DEFAULT_DASH.columns).filter((c) => blockIds.has(c.block)).map((c) => ({ block: c.block, width: clamp(Number(c.width) || 1, 0.6, 3), ...(c.scale ? { scale: clamp(Number(c.scale) || 1, 0.7, 1.6) } : {}), ...(c.opts && typeof c.opts === 'object' ? { opts: Object.fromEntries(Object.entries(c.opts).filter(([, v]) => typeof v === 'boolean' || typeof v === 'number')) } : {}) })).slice(0, MAX_COLS);
  if (!d.columns.length && d.preset !== 'legacy') d.columns = DEFAULT_DASH.columns.map((c) => ({ ...c }));
  d.customStyles = (Array.isArray(d.customStyles) ? d.customStyles : []).filter((s) => s && typeof s.id === 'string' && s.custom).slice(-12);
  if (!DASH_STYLE_IDS.includes(d.style) && !d.customStyles.some((s) => s.id === d.style)) d.style = DEFAULT_DASH.style;
  d.rotateSec = clamp(d.rotateSec, 8, 120);
  d.pageSec = clamp(d.pageSec, 6, 60);
  return d;
}
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function read(): DashLayout {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DashLayout> | null);
  } catch {
    return { ...DEFAULT_DASH };
  }
}
let state: DashLayout = read();
const subs = new Set<() => void>();
function emit() {
  subs.forEach((f) => f());
}
export const getDash = () => state;
export function setDash(patch: Partial<DashLayout> | ((d: DashLayout) => Partial<DashLayout>)) {
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
type Ev = { type: 'focus'; id: string | null } | { type: 'settings'; open: boolean } | { type: 'test-alarm'; kind: 'crit' | 'resolved' | 'coord' } | { type: 'designing'; text: string | null } | { type: 'edit'; on: boolean; k?: number | null };
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

/** Применить действие (от Джарвиса или из настроек). Возвращает, что получилось, — человеческим языком. */
export function applyDashOp(o: DashOp): string {
  const d = state;
  if (d.locked && o.op !== 'focus' && o.op !== 'settings') return 'интерфейс закреплён — сначала открепите его в настройках дашборда';
  const cols = d.columns.map((c) => ({ ...c }));
  const custom = (columns: DashColumn[], extra: Partial<DashLayout> = {}) => setDash({ preset: 'custom', columns, ...extra });
  switch (o.op) {
    case 'preset': {
      const p = PRESETS.find((x) => x.id === o.preset);
      if (!p) return 'нет такой раскладки';
      setDash({ preset: p.id, columns: p.columns.length ? p.columns.map((c) => ({ ...c })) : d.columns, filter: p.filter ?? null, density: p.density ?? 'normal' });
      return `раскладка «${p.name}»`;
    }
    case 'show': {
      if (cols.some((c) => c.block === o.block)) return 'уже на стене';
      if (cols.length >= MAX_COLS) cols[cols.length - 1] = { block: o.block, width: 1 };
      else cols.splice(o.at ?? cols.length, 0, { block: o.block, width: 1 });
      custom(cols);
      return 'добавил блок';
    }
    case 'hide': {
      const next = cols.filter((c) => c.block !== o.block);
      if (!next.length) return 'последний блок не убрать';
      custom(next);
      return 'убрал блок';
    }
    case 'swap': {
      const a = o.a < 0 ? cols.length + o.a : o.a;
      const b = o.b < 0 ? cols.length + o.b : o.b;
      if (!cols[a] || !cols[b]) return 'нет таких колонок';
      [cols[a], cols[b]] = [cols[b], cols[a]];
      custom(cols);
      return 'поменял местами';
    }
    case 'replace': {
      const at = o.at < 0 ? cols.length + o.at : o.at;
      if (!cols[at]) return 'нет такой колонки';
      const dup = cols.findIndex((c) => c.block === o.block);
      if (dup >= 0 && dup !== at) [cols[dup], cols[at]] = [cols[at], cols[dup]];
      else cols[at] = { block: o.block, width: cols[at].width, scale: cols[at].scale };
      custom(cols);
      return 'заменил блок';
    }
    case 'wider': {
      const c = cols.find((x) => x.block === o.block);
      if (!c) return 'этого блока нет на стене';
      c.width = clamp(c.width + o.by, 0.6, 3);
      custom(cols);
      return o.by > 0 ? 'сделал шире' : 'сделал уже';
    }
    case 'filter':
      setDash({ filter: o.group });
      return o.group ? 'фильтр по группе' : 'показываю все группы';
    case 'customStyle': {
      const list = [...d.customStyles.filter((s) => s.id !== o.style.id), { ...o.style, custom: true }].slice(-12);
      setDash({ customStyles: list, style: o.style.id, ...(o.preset ? (() => { const p = PRESETS.find((x) => x.id === o.preset); return p && p.columns.length ? { preset: p.id, columns: p.columns.map((c) => ({ ...c })) } : {}; })() : {}), ...(o.density ? { density: o.density } : {}) });
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
      setDash({ ...DEFAULT_DASH, columns: DEFAULT_DASH.columns.map((c) => ({ ...c })), style: d.style });
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

/** Коротко для Джарвиса: что сейчас на стене. */
export function dashSummary() {
  const d = state;
  return { preset: d.preset, columns: d.columns.map((c) => c.block as BlockId), style: d.style, filter: d.filter, density: d.density, locked: d.locked };
}
