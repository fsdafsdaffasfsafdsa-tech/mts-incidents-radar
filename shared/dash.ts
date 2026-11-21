// Дашборд координатора (видеостена) по кейсу: четыре группы инцидентов, что требует действия,
// история передач, «команда не берёт», риск перерасти в критический. Чистые функции — их используют
// стена в браузере, Джарвис на сервере и тесты.
import type { Incident } from './types.ts';

const MIN = 60_000;

// ─── четыре группы кейса ───────────────────────────────────────────────────
export type DashGroup = 'crit' | 'coord' | 'high' | 'research';
export const DASH_GROUPS: { id: DashGroup; label: string; short: string; hint: string }[] = [
  { id: 'crit', label: 'Критические', short: 'Критич.', hint: 'уровень «Наивысший»: статус и срок решения' },
  { id: 'coord', label: 'На координаторах', short: 'На КЦ', hint: 'назначены на «КЦ ИТ Координаторы Массовых Инцидентов» — быстро передать в команду' },
  { id: 'high', label: 'Высокий приоритет', short: 'Высокий', hint: 'каждый может перерасти в критический' },
  { id: 'research', label: 'Исследование ситуации', short: 'Исслед.', hint: 'инцидент решён, идёт разбор причин — не пропустить назначение на координаторов' },
];
export const GROUP_NAME: Record<DashGroup, string> = Object.fromEntries(DASH_GROUPS.map((g) => [g.id, g.label])) as Record<DashGroup, string>;

export const isResearch = (i: Incident) => /исследован/i.test(i.stateText ?? '');
/** В какие группы входит инцидент. Один инцидент может быть сразу в нескольких. Решённые/закрытые — ни в какой. */
export function groupsOf(i: Incident): DashGroup[] {
  if (i.status === 'resolved') return [];
  const g: DashGroup[] = [];
  if (i.priority === 'P1') g.push('crit');
  if (i.status === 'coordinators') g.push('coord');
  if (i.priority === 'P2') g.push('high');
  if (isResearch(i)) g.push('research');
  return g;
}

// ─── история передач ───────────────────────────────────────────────────────
const ROUTED = /передано команде «([^»]+)»/;
export interface Hop {
  team: string;
  at: number;
}
/** Цепочка команд: откуда пришёл и куда передавали (по истории инцидента). */
export function transfers(i: Incident): Hop[] {
  const hops: Hop[] = [];
  for (const h of i.history) {
    const m = ROUTED.exec(h.text);
    if (m && hops.at(-1)?.team !== m[1]) hops.push({ team: m[1], at: h.at });
  }
  return hops;
}
/** Сколько раз инцидент передавали между командами. */
export const transferCount = (i: Incident) => Math.max(transfers(i).length, i.reassignCount ?? 0);
/** Команда получила инцидент и не берёт его в работу: сколько ждёт (мс) или null. */
export function waitingTake(i: Incident, now: number): number | null {
  if (i.status !== 'assigned') return null;
  return Math.max(0, now - (i.routedAt ?? i.createdAt));
}
export const NOT_TAKEN_MIN = 10;

// ─── риск перерасти в критический (0–100) ─────────────────────────────────
export function riskOf(i: Incident, now: number): { score: number; reasons: string[] } {
  if (i.status === 'resolved' || i.priority === 'P1') return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let s = i.priority === 'P2' ? 35 : i.priority === 'P3' ? 15 : 5;
  if (i.p1Proposal) ((s += 40), reasons.push('ИИ предлагает «Наивысший»'));
  const span = Math.max(MIN, i.slaDeadline - i.createdAt);
  const used = (now - i.createdAt) / span;
  if (used >= 1) ((s += 25), reasons.push('срок уже прошёл'));
  else if (used >= 0.7) ((s += 15), reasons.push(`прошло ${Math.round(used * 100)}% срока`));
  const t = transferCount(i);
  if (t >= 2) ((s += 10), reasons.push(`${t} передачи между командами`));
  const w = waitingTake(i, now);
  if (w !== null && w > NOT_TAKEN_MIN * MIN) ((s += 10), reasons.push('команда не берёт'));
  if ((i.complaints ?? 0) >= 100) ((s += 10), reasons.push(`${i.complaints} жалоб`));
  if (i.trend === 'growing') ((s += 8), reasons.push('жалоб становится больше'));
  if (i.ai?.risk) s = Math.max(s, Math.round(i.ai.risk * 0.9));
  return { score: Math.min(100, s), reasons };
}

// ─── что требует действия сейчас ───────────────────────────────────────────
export interface Attention {
  score: number;
  reason: string; // главная причина, коротко
  tone: 'crit' | 'warn' | 'info';
}
/** Насколько срочно координатору заняться инцидентом и почему. null — действия не требует. */
export function attention(i: Incident, now: number): Attention | null {
  if (i.status === 'resolved') return null;
  const left = i.slaDeadline - now;
  const w = waitingTake(i, now);
  const t = transferCount(i);
  if (i.priority === 'P1') {
    if (i.status === 'coordinators') return { score: 1000, reason: 'Передать в команду', tone: 'crit' };
    if (w !== null) return { score: 980, reason: `Не приняли ${fmtShort(w)}`, tone: 'crit' };
    return { score: 950, reason: 'В работе', tone: 'crit' };
  }
  if (i.status === 'coordinators') return { score: 800 + (i.priority === 'P2' ? 50 : 0) + (isResearch(i) ? 10 : 0), reason: 'Передать в команду', tone: 'warn' };
  if (i.p1Proposal) return { score: 760, reason: 'ИИ: поднять до «Наивысшего»', tone: 'warn' };
  if (left < 30 * MIN) return { score: 700 + Math.min(60, Math.round(-left / MIN)), reason: left > 0 ? 'Срок близко' : 'Просрочен', tone: 'warn' };
  if (w !== null && w > NOT_TAKEN_MIN * MIN) return { score: 600, reason: 'Не берут', tone: 'warn' };
  if (t >= 2) return { score: 500 + t, reason: `${t} передачи`, tone: 'warn' };
  if (i.priority === 'P2') {
    const r = riskOf(i, now);
    return { score: 400 + r.score, reason: r.score >= 60 ? `Риск ${r.score}%` : 'Высокий', tone: 'info' };
  }
  if (isResearch(i)) return { score: 300, reason: 'Разбор причин', tone: 'info' };
  return null;
}

/** «12 мин», «3 ч 40 мин», «2 дн» — для стены. */
export function fmtShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 10) return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  if (h < 48) return `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}

// ─── снимок для стены ──────────────────────────────────────────────────────
export interface DashSnapshot {
  counts: Record<DashGroup, number> & { threat: number; notTaken: number; pingpong: number; doneHour: number; open: number; atTeams: number };
  action: { inc: Incident; att: Attention }[]; // по убыванию срочности
  work: Incident[]; // у команд, по сроку
  byGroup: Record<DashGroup, Incident[]>;
  resolvedCrit: Incident[]; // критические, решённые за последние 15 минут — «сразу видно, что решён»
}
export function dashSnapshot(all: Iterable<Incident>, now: number, opts: { filter?: DashGroup | null; onlyFile?: boolean } = {}): DashSnapshot {
  const list = [...all].filter((i) => !opts.onlyFile || i.origin !== 'complaints');
  const open = list.filter((i) => i.status !== 'resolved');
  const byGroup: Record<DashGroup, Incident[]> = { crit: [], coord: [], high: [], research: [] };
  for (const i of open) for (const g of groupsOf(i)) byGroup[g].push(i);
  for (const g of Object.keys(byGroup) as DashGroup[]) byGroup[g].sort((a, b) => a.slaDeadline - b.slaDeadline);
  const inFilter = (i: Incident) => !opts.filter || groupsOf(i).includes(opts.filter);
  const action = open
    .filter(inFilter)
    .map((inc) => ({ inc, att: attention(inc, now) }))
    .filter((x): x is { inc: Incident; att: Attention } => !!x.att)
    .sort((a, b) => b.att.score - a.att.score || a.inc.slaDeadline - b.inc.slaDeadline);
  const work = open.filter((i) => i.status !== 'coordinators' && inFilter(i)).sort((a, b) => a.slaDeadline - b.slaDeadline);
  return {
    counts: {
      crit: byGroup.crit.length,
      coord: byGroup.coord.length,
      high: byGroup.high.length,
      research: byGroup.research.length,
      threat: open.filter((i) => i.slaDeadline - now < 30 * MIN).length,
      notTaken: open.filter((i) => (waitingTake(i, now) ?? 0) > NOT_TAKEN_MIN * MIN).length,
      pingpong: open.filter((i) => transferCount(i) >= 2).length,
      doneHour: list.filter((i) => i.status === 'resolved' && i.resolvedAt && now - i.resolvedAt < 3_600_000).length,
      open: open.length,
      atTeams: open.filter((i) => i.status !== 'coordinators').length,
    },
    action,
    work,
    byGroup,
    resolvedCrit: list.filter((i) => i.status === 'resolved' && i.priority === 'P1' && i.resolvedAt && now - i.resolvedAt < 15 * MIN).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
  };
}

// ─── блоки и раскладки (общие для стены и Джарвиса) ────────────────────────
export type BlockId = 'action' | 'work' | 'groups' | 'assistant' | 'transfers' | 'stats' | 'events' | 'map' | 'rotate' | 'clock' | 'counters' | 'group' | 'character' | 'risk' | 'route' | 'teams' | 'note' | 'custom';
export type BlockCat = 'incidents' | 'summary' | 'ai' | 'own';
export const BLOCK_CATS: { id: BlockCat; name: string }[] = [
  { id: 'incidents', name: 'Инциденты' },
  { id: 'summary', name: 'Сводка' },
  { id: 'ai', name: 'ИИ и персонажи' },
  { id: 'own', name: 'Своё' },
];
export const BLOCKS: { id: BlockId; name: string; hint: string; cat: BlockCat; icon: string }[] = [
  { id: 'action', name: 'Требует действия', hint: 'всё, чем заняться сейчас — по срочности', cat: 'incidents', icon: 'bell' },
  { id: 'work', name: 'В работе у команд', hint: 'таблица: сколько в работе, срок, передачи, команда', cat: 'incidents', icon: 'table' },
  { id: 'groups', name: 'Четыре группы', hint: 'группы кейса колонками', cat: 'incidents', icon: 'columns' },
  { id: 'group', name: 'Одна группа', hint: 'критические, на координаторах, высокий или исследование', cat: 'incidents', icon: 'list' },
  { id: 'risk', name: 'Риск стать критическим', hint: 'кто может перерасти в «Наивысший» и почему', cat: 'incidents', icon: 'flame' },
  { id: 'route', name: 'Кому передать', hint: 'что на координаторах и какую команду советует ИИ', cat: 'incidents', icon: 'send' },
  { id: 'transfers', name: 'История передач', hint: 'цепочки команд у тех, кого передают по кругу', cat: 'incidents', icon: 'swap' },
  { id: 'counters', name: 'Счётчики групп', hint: 'четыре группы крупными цифрами', cat: 'summary', icon: 'hash' },
  { id: 'stats', name: 'Смена в цифрах', hint: 'решено, сроки, время до передачи, поток жалоб', cat: 'summary', icon: 'chart' },
  { id: 'teams', name: 'Команды', hint: 'у каких команд больше всего открытых', cat: 'summary', icon: 'users' },
  { id: 'clock', name: 'Часы', hint: 'крупное время и дата', cat: 'summary', icon: 'clock' },
  { id: 'events', name: 'Лента событий', hint: 'что произошло только что', cat: 'summary', icon: 'activity' },
  { id: 'map', name: 'Карта жалоб', hint: 'карта России с инцидентами', cat: 'summary', icon: 'map' },
  { id: 'assistant', name: 'ИИ-помощник', hint: 'главное сейчас, риск, кому передать, команды Джарвису', cat: 'ai', icon: 'bot' },
  { id: 'character', name: 'Персонаж', hint: 'Джарвис, Ника, Капитан или Дед Мороз комментируют обстановку', cat: 'ai', icon: 'smile' },
  { id: 'rotate', name: 'Сменяемая панель', hint: 'по очереди: помощник, передачи, цифры, лента', cat: 'ai', icon: 'repeat' },
  { id: 'note', name: 'Заметка', hint: 'свой текст: дежурные телефоны, напоминание смене', cat: 'own', icon: 'note' },
  { id: 'custom', name: 'Свой блок', hint: 'придуманный ChatGPT по вашему описанию', cat: 'own', icon: 'sparkles' },
];
export const BLOCK_NAME: Record<BlockId, string> = Object.fromEntries(BLOCKS.map((b) => [b.id, b.name])) as Record<BlockId, string>;

export interface DashColumn {
  block: BlockId;
  width: number; // доля ширины, 1–3
  scale?: number; // размер текста блока, 0.7–1.6
  opts?: Record<string, boolean | number | string>; // собственные настройки блока
}
export type PresetId = 'case' | 'board' | 'groups' | 'ai' | 'critical' | 'night' | 'map' | 'legacy';
export const PRESETS: { id: PresetId; name: string; hint: string; columns: DashColumn[]; grid?: { block: BlockId; x: number; y: number; w: number; h: number; opts?: Record<string, boolean | number | string> }[]; filter?: DashGroup | null; density?: 'normal' | 'large' }[] = [
  { id: 'case', name: 'Кейс: три экрана', hint: 'слева сменяемая панель, в центре — что требует действия, справа — в работе у команд', columns: [{ block: 'rotate', width: 1 }, { block: 'action', width: 1.5 }, { block: 'work', width: 1.4 }] },
  {
    id: 'board',
    name: 'Свободное поле',
    hint: 'персонаж, риск, что требует действия, критические и работа команд — блоками на поле',
    columns: [],
    grid: [
      { block: 'character', x: 0, y: 0, w: 3, h: 5, opts: { persona: 'jarvis' } },
      { block: 'risk', x: 0, y: 5, w: 3, h: 7 },
      { block: 'action', x: 3, y: 0, w: 5, h: 12 },
      { block: 'group', x: 8, y: 0, w: 4, h: 5, opts: { group: 'coord' } },
      { block: 'work', x: 8, y: 5, w: 4, h: 7 },
    ],
  },
  { id: 'groups', name: 'Четыре группы', hint: 'группы кейса колонками и ИИ-помощник', columns: [{ block: 'groups', width: 3 }, { block: 'assistant', width: 1 }] },
  { id: 'ai', name: 'ИИ-центр', hint: 'помощник, действия и история передач', columns: [{ block: 'assistant', width: 1.1 }, { block: 'action', width: 1.5 }, { block: 'transfers', width: 1 }] },
  { id: 'critical', name: 'Только критичное', hint: 'критические крупно и их история', columns: [{ block: 'action', width: 2 }, { block: 'transfers', width: 1 }], filter: 'crit', density: 'large' },
  { id: 'night', name: 'Ночь, крупно', hint: 'две колонки крупным шрифтом — видно издалека', columns: [{ block: 'action', width: 1 }, { block: 'work', width: 1 }], density: 'large' },
  { id: 'map', name: 'С картой', hint: 'цифры, карта жалоб и что требует действия', columns: [{ block: 'stats', width: 1 }, { block: 'map', width: 1.8 }, { block: 'action', width: 1.2 }] },
  { id: 'legacy', name: 'Прежняя стена', hint: 'стена, которая была раньше: часы, карта, «горит сейчас»', columns: [] },
];
export const PRESET_NAME: Record<PresetId, string> = Object.fromEntries(PRESETS.map((p) => [p.id, p.name])) as Record<PresetId, string>;

/** Что Джарвис может сделать со стеной. */
export type DashOp =
  | { op: 'preset'; preset: PresetId }
  | { op: 'show'; block: BlockId; at?: number }
  | { op: 'hide'; block: BlockId }
  | { op: 'swap'; a: number; b: number }
  | { op: 'replace'; at: number; block: BlockId }
  | { op: 'wider'; block: BlockId; by: number }
  | { op: 'filter'; group: DashGroup | null }
  | { op: 'style'; style: string }
  | { op: 'density'; value: 'normal' | 'large' }
  | { op: 'focus'; id: string | null }
  | { op: 'toggle'; what: 'counters' | 'ticker' | 'onlyFile' | 'sound'; on: boolean }
  | { op: 'settings'; open: boolean }
  | { op: 'customStyle'; style: import('./dashStyles.ts').DashStyle; preset?: PresetId | null; density?: 'normal' | 'large' | null }
  | { op: 'removeStyle'; id: string }
  | { op: 'add'; block: BlockId; x?: number; y?: number; w?: number; h?: number; opts?: Record<string, boolean | number | string>; custom?: import('./dashCustom.ts').CustomSpec }
  | { op: 'item'; id: string; patch: Partial<import('./dashGrid.ts').GridItem> }
  | { op: 'remove'; id: string }
  | { op: 'reset' };
