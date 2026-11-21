// Свой блок, придуманный ChatGPT по описанию: не код, а безопасное описание — что показать и как.
// Виды: список инцидентов, одно число, полосы по группировке, персонаж с репликами, заметка.
import type { Incident, Priority, Status } from './types.ts';
import { groupsOf, waitingTake, NOT_TAKEN_MIN, type DashGroup } from './dash.ts';

export type CustomKind = 'list' | 'counter' | 'bars' | 'character' | 'note';
export interface CustomFilter {
  priority?: Priority[];
  status?: Status[];
  group?: DashGroup;
  origin?: 'complaints' | 'dataset';
  overdue?: boolean;
  notTaken?: boolean;
  text?: string; // слова в названии, сервисе, продукте
}
export interface CustomSpec {
  title: string;
  kind: CustomKind;
  hint?: string; // что показывает — одной фразой
  filter?: CustomFilter;
  groupBy?: 'team' | 'service' | 'product' | 'priority' | 'status';
  sort?: 'deadline' | 'priority' | 'created' | 'complaints';
  limit?: number;
  note?: string;
  character?: { name: string; style: string; avatar?: string; color?: string; cut?: boolean }; // cut — фон картинки вырезан
}

const PRIOS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const STATUSES: Status[] = ['coordinators', 'assigned', 'in_progress', 'escalated', 'resolved'];
const GROUPS: DashGroup[] = ['crit', 'coord', 'high', 'research'];
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const COLOR = /^#[0-9a-f]{6}$/i;
/** Картинка персонажа: портрет из набора, эмодзи или уменьшенная картинка (только data:image/webp|png). */
function safeAvatar(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  if (/^(jarvis|nika|captain|frost)$/.test(v)) return v;
  if (/^data:image\/(webp|png|jpeg);base64,[a-z0-9+/=]+$/i.test(v) && v.length < 200_000) return v;
  if ([...v].length <= 4 && !/[<>"'`\\]/.test(v)) return v; // эмодзи
  return undefined;
}

/** Ответ модели (или сохранённое) → проверенное описание блока. Чего нельзя — отбрасываем. */
export function cleanSpec(o: unknown): CustomSpec | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const kind = (['list', 'counter', 'bars', 'character', 'note'] as const).find((k) => k === x.kind);
  if (!kind) return null;
  const f = (x.filter && typeof x.filter === 'object' ? x.filter : {}) as Record<string, unknown>;
  const filter: CustomFilter = {};
  if (Array.isArray(f.priority)) filter.priority = f.priority.filter((p): p is Priority => PRIOS.includes(p as Priority));
  if (Array.isArray(f.status)) filter.status = f.status.filter((p): p is Status => STATUSES.includes(p as Status));
  if (GROUPS.includes(f.group as DashGroup)) filter.group = f.group as DashGroup;
  if (f.origin === 'complaints' || f.origin === 'dataset') filter.origin = f.origin;
  if (f.overdue === true) filter.overdue = true;
  if (f.notTaken === true) filter.notTaken = true;
  if (str(f.text, 60)) filter.text = str(f.text, 60);
  const spec: CustomSpec = { title: str(x.title, 40) || 'Мой блок', kind };
  if (str(x.hint, 120)) spec.hint = str(x.hint, 120);
  if (Object.keys(filter).length) spec.filter = filter;
  if (['team', 'service', 'product', 'priority', 'status'].includes(String(x.groupBy))) spec.groupBy = x.groupBy as CustomSpec['groupBy'];
  if (['deadline', 'priority', 'created', 'complaints'].includes(String(x.sort))) spec.sort = x.sort as CustomSpec['sort'];
  if (typeof x.limit === 'number') spec.limit = Math.max(1, Math.min(20, Math.round(x.limit)));
  if (kind === 'note') spec.note = str(x.note, 600) || '…';
  if (kind === 'character') {
    const c = (x.character && typeof x.character === 'object' ? x.character : {}) as Record<string, unknown>;
    spec.character = { name: str(c.name, 30) || 'Персонаж', style: str(c.style, 200) || 'дружелюбно и коротко', avatar: safeAvatar(c.avatar), color: COLOR.test(String(c.color)) ? String(c.color) : undefined, ...(c.cut === true ? { cut: true } : {}) };
  }
  return spec;
}

/** Какие инциденты подходят под фильтр своего блока. */
export function applyFilter(all: Iterable<Incident>, f: CustomFilter | undefined, now: number, teamName: (id: string | null) => string): Incident[] {
  const words = (f?.text ?? '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  return [...all].filter((i) => {
    if (!f?.status?.length && i.status === 'resolved') return false;
    if (f?.priority?.length && !f.priority.includes(i.priority)) return false;
    if (f?.status?.length && !f.status.includes(i.status)) return false;
    if (f?.group && !groupsOf(i).includes(f.group)) return false;
    if (f?.origin === 'complaints' && i.origin !== 'complaints') return false;
    if (f?.origin === 'dataset' && i.origin === 'complaints') return false;
    if (f?.overdue && i.slaDeadline > now) return false;
    if (f?.notTaken && !((waitingTake(i, now) ?? 0) > NOT_TAKEN_MIN * 60_000)) return false;
    if (words.length) {
      const hay = `${i.title} ${i.service} ${i.productName} ${teamName(i.teamId)}`.toLowerCase();
      if (!words.every((w) => hay.includes(w.slice(0, Math.max(3, w.length - 2))))) return false;
    }
    return true;
  });
}
