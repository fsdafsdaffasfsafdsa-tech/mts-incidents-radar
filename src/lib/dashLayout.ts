// Настройки дашборда (видеостены): раскладка блоков, стиль, тревоги, Джарвис. Хранятся в браузере
// и сразу доходят до окна стены, открытого отдельно (событие storage) — Джарвис в окне дежурного
// перестраивает стену на соседнем экране.
import { useEffect, useState } from 'react';
import { BLOCKS, PRESETS, type BlockId, type DashColumn, type DashGroup, type DashOp, type PresetId } from '../../shared/dash';
import { DASH_STYLE_IDS } from '../../shared/dashStyles';

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
};

const blockIds = new Set(BLOCKS.map((b) => b.id));
function clean(x: Partial<DashLayout> | null): DashLayout {
  const d = { ...DEFAULT_DASH, ...(x ?? {}) };
  d.columns = (Array.isArray(d.columns) ? d.columns : DEFAULT_DASH.columns).filter((c) => blockIds.has(c.block)).map((c) => ({ block: c.block, width: clamp(Number(c.width) || 1, 0.6, 3) })).slice(0, MAX_COLS);
  if (!d.columns.length && d.preset !== 'legacy') d.columns = DEFAULT_DASH.columns.map((c) => ({ ...c }));
  if (!DASH_STYLE_IDS.includes(d.style)) d.style = DEFAULT_DASH.style;
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
type Ev = { type: 'focus'; id: string | null } | { type: 'settings'; open: boolean } | { type: 'test-alarm'; kind: 'crit' | 'resolved' | 'coord' };
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
      else cols[at] = { block: o.block, width: cols[at].width };
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
    case 'style':
      if (!DASH_STYLE_IDS.includes(o.style)) return 'нет такого стиля';
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

// ─── отдельное окно стены (на экране над рабочими местами) ───
let wallWin: Window | null = null;
export function openWallWindow() {
  wallWin = window.open('/?wall', 'radar-wall');
}
export const wallWindowOpen = () => !!wallWin && !wallWin.closed;

/** Коротко для Джарвиса: что сейчас на стене. */
export function dashSummary() {
  const d = state;
  return { preset: d.preset, columns: d.columns.map((c) => c.block as BlockId), style: d.style, filter: d.filter, density: d.density };
}
