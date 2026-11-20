import type { Incident, Priority, RiskLevel, Status } from '../../shared/types';
import { AT_RISK_MIN, slaRunning } from '../../shared/types';

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function fmtUsers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '')} млн`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} тыс.`;
  return String(n);
}

const two = (n: number) => String(n).padStart(2, '0');

/** Таймер SLA: до часа — ММ:СС, дальше — «3 ч 12 м». */
export function fmtSla(ms: number): string {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let out: string;
  if (h >= 48) out = `${Math.floor(h / 24)} д ${h % 24} ч`;
  else if (h >= 1) out = `${h} ч ${two(m)} м`;
  else out = `${two(m)}:${two(sec)}`;
  return neg ? `−${out}` : out;
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${m % 60} мин назад`;
  return `${Math.floor(h / 24)} д назад`;
}

export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function fmtClockSec(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export const STATUS_LABEL: Record<Status, string> = {
  assigned: 'Назначен',
  in_progress: 'Выполняется',
  research: 'Исследование ситуации',
  resolved: 'Решён',
};

export function fmtDateTime(t: number): string {
  const d = new Date(t);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
  critical: 'критический',
};

/** Подписи приоритета как в выгрузке ITSM. Наивысший = критический. */
export const PRIO_LABEL: Record<Priority, string> = {
  P1: 'Наивысший',
  P2: 'Высокий',
  P3: 'Средний',
  P4: 'Низкий',
};

export type SlaState = 'ok' | 'soon' | 'risk' | 'breach' | 'done' | 'none';

export function slaState(inc: Incident, now: number): SlaState {
  if (!slaRunning(inc)) return 'done';
  if (inc.slaDeadline === null) return 'none';
  const rem = inc.slaDeadline - now;
  if (rem <= 0) return 'breach';
  if (rem <= 10 * 60_000) return 'risk';
  if (rem <= AT_RISK_MIN * 60_000) return 'soon';
  return 'ok';
}

const PRIO_BASE: Record<Priority, number> = { P1: 400, P2: 250, P3: 120, P4: 40 };
const SLA_WEIGHT: Record<Priority, number> = { P1: 1, P2: 0.85, P3: 0.45, P4: 0.3 };

/** Срочность для сортировки очереди: приоритет + близость дедлайна + ИИ-риск + «на координаторах». */
export function urgency(inc: Incident, now: number): number {
  if (inc.status === 'resolved') return -1000 + (inc.resolvedAt ?? 0) / 1e13;
  if (inc.status === 'research') return -400 + PRIO_BASE[inc.priority] / 4 + inc.ai.risk;
  const rem = inc.slaDeadline === null ? Infinity : (inc.slaDeadline - now) / 60_000;
  // Вес срыва SLA зависит от приоритета: горящий P1 важнее давно нарушенного P3.
  const k = SLA_WEIGHT[inc.priority];
  let sla = 0;
  if (rem <= 0) sla = 320 * k + Math.min(60, -rem);
  else if (rem <= 30) sla = (40 + 200 * (1 - rem / 30)) * k;
  else if (rem <= 120) sla = 40 * (1 - (rem - 30) / 90) * k;
  // Непросмотренный P1 всегда наверху: его ещё никто не видел.
  const unack = inc.acknowledged ? 0 : inc.priority === 'P1' ? 150 : inc.priority === 'P2' ? 50 : 20;
  return PRIO_BASE[inc.priority] + sla + inc.ai.risk * 1.2 + (inc.onCoordinators ? 60 : 0) + unack;
}
