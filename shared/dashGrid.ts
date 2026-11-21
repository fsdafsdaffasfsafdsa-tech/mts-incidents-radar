// Свободное поле стены: сетка 12×12, блоки ставятся куда угодно и любого размера, не налезая друг на друга.
// Чистые функции — их используют стена, настройки, Джарвис и тесты.
import type { BlockId, DashColumn } from './dash.ts';
import type { CustomSpec } from './dashCustom.ts';

export const GRID_COLS = 12;
export const GRID_ROWS = 12;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GridItem extends Rect {
  id: string;
  block: BlockId;
  scale?: number; // размер текста блока
  opts?: Record<string, boolean | number | string>; // собственные настройки блока
  custom?: CustomSpec; // свой блок или персонаж, придуманный ChatGPT
}

export const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clampI = (v: number, a: number, b: number) => Math.min(b, Math.max(a, Math.round(v)));

/** Прямоугольник внутри поля: не меньше 2×2, не выходит за края. */
export function fit(r: Rect): Rect {
  const w = clampI(r.w, 2, GRID_COLS);
  const h = clampI(r.h, 2, GRID_ROWS);
  return { x: clampI(r.x, 0, GRID_COLS - w), y: clampI(r.y, 0, GRID_ROWS - h), w, h };
}
export const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Можно ли поставить прямоугольник: в поле и ни на кого не налезает (кроме самого себя). */
export function free(items: GridItem[], r: Rect, except?: string): boolean {
  if (r.x < 0 || r.y < 0 || r.x + r.w > GRID_COLS || r.y + r.h > GRID_ROWS) return false;
  return !items.some((i) => i.id !== except && overlap(i, r));
}

/** Колонки прежних раскладок → блоки на всю высоту, ширина пропорционально. */
export function columnsToItems(cols: DashColumn[]): GridItem[] {
  const total = cols.reduce((s, c) => s + c.width, 0) || 1;
  let x = 0;
  return cols.map((c, k) => {
    const w = k === cols.length - 1 ? GRID_COLS - x : Math.max(2, Math.round((c.width / total) * GRID_COLS));
    const it: GridItem = { id: newId() + k, block: c.block, x, y: 0, w, h: GRID_ROWS, ...(c.scale ? { scale: c.scale } : {}), ...(c.opts ? { opts: { ...c.opts } } : {}) };
    x += w;
    return it;
  });
}

/** Порядок чтения: слева направо, сверху вниз — так их называет Джарвис («левый», «правый»). */
export const readingOrder = (items: GridItem[]) => [...items].sort((a, b) => a.x - b.x || a.y - b.y);

/** Самое большое свободное место, начиная с клетки (или где угодно), не больше want. */
export function findFree(items: GridItem[], want: { w: number; h: number }, at?: { x: number; y: number }): Rect | null {
  const tries: Rect[] = [];
  const starts = at ? [at] : Array.from({ length: GRID_ROWS * GRID_COLS }, (_, k) => ({ x: k % GRID_COLS, y: Math.floor(k / GRID_COLS) }));
  for (const s of starts) {
    for (let w = Math.min(want.w, GRID_COLS - s.x); w >= 2; w--)
      for (let h = Math.min(want.h, GRID_ROWS - s.y); h >= 2; h--) {
        const r = { x: s.x, y: s.y, w, h };
        if (free(items, r)) tries.push(r);
      }
  }
  if (!tries.length) return null;
  // больше площадь — лучше; при равной — ближе к желаемой форме
  tries.sort((a, b) => b.w * b.h - a.w * a.h || Math.abs(a.w - want.w) - Math.abs(b.w - want.w));
  return tries[0];
}

/** Добавить блок: в свободное место, а если места нет — делим пополам самый большой блок. */
export function addItem(items: GridItem[], item: Omit<GridItem, keyof Rect | 'id'> & Partial<Rect> & { id?: string }, want = { w: 4, h: 6 }): GridItem[] {
  const id = item.id ?? newId();
  const at = item.x !== undefined && item.y !== undefined ? { x: item.x, y: item.y } : undefined;
  let r = findFree(items, { w: item.w ?? want.w, h: item.h ?? want.h }, at) ?? (at ? findFree(items, { w: item.w ?? want.w, h: item.h ?? want.h }) : null);
  let next = items.map((i) => ({ ...i }));
  if (!r) {
    const big = [...next].sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!big || (big.w < 4 && big.h < 4)) return items;
    if (big.w >= big.h) {
      const half = Math.floor(big.w / 2);
      r = { x: big.x + big.w - half, y: big.y, w: half, h: big.h };
      big.w -= half;
    } else {
      const half = Math.floor(big.h / 2);
      r = { x: big.x, y: big.y + big.h - half, w: big.w, h: half };
      big.h -= half;
    }
    next = next.map((i) => (i.id === big.id ? big : i));
  }
  const { x: _x, y: _y, w: _w, h: _h, ...rest } = item;
  void _x, void _y, void _w, void _h;
  return [...next, { ...rest, id, ...r } as GridItem];
}

/** Убрать блок; соседи слева или справа на той же высоте забирают место, если могут. */
export function removeItem(items: GridItem[], id: string): GridItem[] {
  const gone = items.find((i) => i.id === id);
  if (!gone) return items;
  const rest = items.filter((i) => i.id !== id).map((i) => ({ ...i }));
  const left = rest.find((i) => i.x + i.w === gone.x && i.y === gone.y && i.h === gone.h);
  const right = rest.find((i) => i.x === gone.x + gone.w && i.y === gone.y && i.h === gone.h);
  const up = rest.find((i) => i.y + i.h === gone.y && i.x === gone.x && i.w === gone.w);
  if (left) left.w += gone.w;
  else if (right) ((right.x = gone.x), (right.w += gone.w));
  else if (up) up.h += gone.h;
  return rest;
}

/** Поменять местами два блока (их места на поле). */
export function swapItems(items: GridItem[], a: string, b: string): GridItem[] {
  const A = items.find((i) => i.id === a);
  const B = items.find((i) => i.id === b);
  if (!A || !B) return items;
  return items.map((i) => (i.id === a ? { ...i, x: B.x, y: B.y, w: B.w, h: B.h } : i.id === b ? { ...i, x: A.x, y: A.y, w: A.w, h: A.h } : i));
}

/** Шире/уже на n клеток: сначала в свободное место, иначе за счёт соседа справа или слева. */
export function widen(items: GridItem[], id: string, n: number): GridItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const next = items.map((i) => ({ ...i }));
  const me = next.find((i) => i.id === id)!;
  if (n < 0) {
    me.w = Math.max(2, me.w + n);
    return next;
  }
  for (let k = 0; k < n; k++) {
    const right = { x: me.x + me.w, y: me.y, w: 1, h: me.h };
    const left = { x: me.x - 1, y: me.y, w: 1, h: me.h };
    if (free(next, right, id)) me.w++;
    else if (free(next, left, id)) (me.x--, me.w++);
    else {
      const nb = next.find((i) => i.id !== id && i.x === me.x + me.w && i.w > 2 && i.y <= me.y && i.y + i.h >= me.y + me.h);
      const nl = next.find((i) => i.id !== id && i.x + i.w === me.x && i.w > 2 && i.y <= me.y && i.y + i.h >= me.y + me.h);
      if (nb) ((nb.x++, nb.w--), me.w++);
      else if (nl) (nl.w--, me.x--, me.w++);
      else break;
    }
  }
  return next;
}

/** Привести сохранённое к порядку: в поле, без наложений (налезающие ставим в свободное место). */
export function normalize(items: GridItem[]): GridItem[] {
  const out: GridItem[] = [];
  for (const raw of items) {
    const r = fit(raw);
    const it = { ...raw, ...r };
    if (free(out, it)) out.push(it);
    else {
      const spot = findFree(out, { w: it.w, h: it.h });
      if (spot) out.push({ ...it, ...spot });
    }
  }
  return out;
}

/** Размер по умолчанию для нового блока. */
export const DEFAULT_SIZE: Partial<Record<BlockId, { w: number; h: number }>> = {
  clock: { w: 3, h: 3 },
  counters: { w: 6, h: 3 },
  character: { w: 3, h: 5 },
  note: { w: 3, h: 4 },
  group: { w: 3, h: 6 },
  risk: { w: 3, h: 6 },
  route: { w: 3, h: 6 },
  teams: { w: 4, h: 6 },
  map: { w: 6, h: 8 },
  groups: { w: 8, h: 8 },
  custom: { w: 4, h: 6 },
  forgot: { w: 3, h: 5 },
  now: { w: 4, h: 6 },
  deadlines: { w: 5, h: 3 },
  favs: { w: 4, h: 4 },
};
