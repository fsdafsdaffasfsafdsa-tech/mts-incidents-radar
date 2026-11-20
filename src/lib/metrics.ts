// Метрики, из которых координатор и сотрудник сами собирают свою панель.
import type { Incident, Stats, Worker } from '../../shared/types';
import { AT_RISK_MIN } from '../../shared/types';
import { fmtDur } from './format';

export type MetricTone = 'neutral' | 'p1' | 'warn' | 'coord' | 'ok' | 'ai';
export type MetricScope = 'center' | 'worker';

export interface MetricCtx {
  scope: Incident[]; // инциденты центра (онлайн или офлайн)
  mine: Incident[]; // задачи сотрудника (в кабинете)
  workers: Worker[];
  worker: Worker | null;
  stats: Stats | null;
  now: number;
}

export interface MetricDef {
  id: string;
  label: string;
  tone: MetricTone;
  scope: MetricScope;
  compute: (c: MetricCtx) => string;
}

const open = (l: Incident[]) => l.filter((i) => i.status !== 'resolved');
const soon = (i: Incident, now: number) => i.slaDeadline - now > 0 && i.slaDeadline - now <= AT_RISK_MIN * 60_000;

export const METRICS: MetricDef[] = [
  { id: 'open', label: 'Открыто', tone: 'neutral', scope: 'center', compute: (c) => String(open(c.scope).length) },
  { id: 'new', label: 'Без сотрудника', tone: 'coord', scope: 'center', compute: (c) => String(c.scope.filter((i) => i.status === 'coordinators').length) },
  { id: 'inwork', label: 'В работе', tone: 'ai', scope: 'center', compute: (c) => String(c.scope.filter((i) => i.status === 'in_progress').length) },
  { id: 'soon', label: 'Дедлайн < 30 мин', tone: 'warn', scope: 'center', compute: (c) => String(open(c.scope).filter((i) => soon(i, c.now)).length) },
  { id: 'overdue', label: 'Просрочено', tone: 'p1', scope: 'center', compute: (c) => String(open(c.scope).filter((i) => i.slaDeadline <= c.now).length) },
  { id: 'high', label: 'Высокий и выше', tone: 'p1', scope: 'center', compute: (c) => String(open(c.scope).filter((i) => i.priority <= 'P2').length) },
  { id: 'clients', label: 'Клиентские', tone: 'warn', scope: 'center', compute: (c) => String(open(c.scope).filter((i) => i.serviceType === 'Клиентский').length) },
  { id: 'mass', label: 'Массовые', tone: 'p1', scope: 'center', compute: (c) => String(open(c.scope).filter((i) => i.isMaster).length) },
  { id: 'resolvedHour', label: 'Решено за час', tone: 'ok', scope: 'center', compute: (c) => String(c.stats?.resolvedLastHour ?? 0) },
  { id: 'mttr', label: 'Время решения', tone: 'ok', scope: 'center', compute: (c) => (c.stats?.mttrMinutes != null ? fmtDur(c.stats.mttrMinutes * 60_000) : '—') },
  { id: 'free', label: 'Свободно людей', tone: 'ok', scope: 'center', compute: (c) => String(c.workers.filter((w) => w.status === 'free').length) },
  { id: 'enroute', label: 'В пути', tone: 'ai', scope: 'center', compute: (c) => String(c.workers.filter((w) => w.status === 'enroute').length) },

  { id: 'my-taken', label: 'Взял', tone: 'coord', scope: 'worker', compute: (c) => String(c.mine.filter((i) => i.status === 'assigned').length) },
  { id: 'my-inwork', label: 'В работе', tone: 'ai', scope: 'worker', compute: (c) => String(c.mine.filter((i) => i.status === 'in_progress').length) },
  { id: 'my-done', label: 'Сделал', tone: 'ok', scope: 'worker', compute: (c) => String(c.worker?.done ?? 0) },
  { id: 'my-overdue', label: 'Просрочено', tone: 'p1', scope: 'worker', compute: (c) => String(open(c.mine).filter((i) => i.slaDeadline <= c.now).length) },
  {
    id: 'my-next', label: 'Ближайший дедлайн', tone: 'warn', scope: 'worker',
    compute: (c) => {
      const next = open(c.mine).map((i) => i.slaDeadline - c.now).filter((x) => x > 0).sort((a, b) => a - b)[0];
      return next === undefined ? '—' : fmtDur(next);
    },
  },
  { id: 'my-high', label: 'Высокий у меня', tone: 'p1', scope: 'worker', compute: (c) => String(open(c.mine).filter((i) => i.priority <= 'P2').length) },
  { id: 'center-new', label: 'Ждут в центре', tone: 'coord', scope: 'worker', compute: (c) => String(c.scope.filter((i) => i.status === 'coordinators').length) },
];

export const DEFAULT_CENTER_METRICS = ['open', 'new', 'soon', 'resolvedHour'];
export const DEFAULT_WORKER_METRICS = ['my-overdue', 'my-next'];

export const metricById = (id: string) => METRICS.find((m) => m.id === id);
