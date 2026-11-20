// Общие типы сервера и дашборда.

/**
 * Приоритет в терминах выгрузки ITSM: priorityId 4 «Наивысший» → P1, 3 «Высокий» → P2, 2 «Средний» → P3, 1 «Низкий» → P4.
 * Критический инцидент — P1 (Наивысший).
 */
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

/**
 * assigned    — «Назначен» (stateId 0): ждёт, когда группа возьмёт в работу.
 * in_progress — «Выполняется» (stateId 2).
 * research    — «Исследование ситуации» (stateId 20): сбой устранён, идёт разбор причин.
 * resolved    — «Завершен» / «Закрыт».
 */
export type Status = 'assigned' | 'in_progress' | 'research' | 'resolved';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Продукт из выгрузки (productName / productMasterId). */
export interface SystemInfo {
  id: string;
  name: string;
  short: string;
}

/** Группа назначения из выгрузки (assignedGroupName). id совпадает с названием. */
export interface TeamInfo {
  id: string;
  name: string;
  short: string;
  isCoordinators?: boolean;
}

export const COORDINATORS_GROUP = 'КЦ ИТ Координаторы Массовых Инцидентов';

export interface HistoryItem {
  at: number;
  text: string;
  kind: 'system' | 'coordinator' | 'team' | 'ai';
}

/** Короткая ИИ-оценка, которая едет вместе с инцидентом (для очереди). */
export interface AiBrief {
  risk: number; // 0–100
  level: RiskLevel;
  teamId: string | null; // рекомендованная группа
  confidence: number; // 0–1
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Выездная бригада — осталась от карты-прототипа; в выгрузке ITSM её нет, всегда null. См. docs/map-removal.md. */
export interface Crew {
  name: string;
  from: GeoPoint;
  dispatchedAt: number;
  etaMs: number;
  arrived: boolean;
}

export interface Incident {
  id: string;
  /** Поля карты-прототипа: в выгрузке их нет, всегда null. См. docs/map-removal.md. */
  crew: Crew | null;
  path: [number, number][] | null;
  /**
   * Точка на карте. В выгрузке координат нет, поэтому сервер ставит инцидент условно:
   * продукт → город, внутри города — разброс по id. На карте это подписано.
   */
  geo: GeoPoint;
  region: string;
  title: string; // header
  description: string;
  shortDescription: string;
  priority: Priority;
  status: Status;
  state: string; // текстовый статус из выгрузки
  stateReason: string | null;
  systemId: string; // название продукта (productMasterId у одного продукта бывает разным)
  product: string;
  service: string;
  scenario: string;
  teamId: string | null; // assignedGroupName
  onCoordinators: boolean;
  assignee: string | null;
  initiator: string | null;
  channel: string | null; // receivingChannel
  serviceType: string | null; // Клиентский / Пользовательский / Технологический
  urgency: string | null;
  impact: string | null;
  urgencyId: number | null;
  impactId: number | null;
  createdAt: number;
  updatedAt: number;
  slaDeadline: number | null;
  resolvedAt: number | null; // completionDate
  isMaster: boolean;
  isDouble: boolean;
  isEffect: boolean; // является причиной дочерних инцидентов
  isReason: boolean; // является дочерним инцидентом
  isNeedUp: boolean | null;
  solution: string | null;
  acknowledged: boolean; // «на контроле» у координатора — локальная отметка дашборда
  history: HistoryItem[];
  ai: AiBrief;
}

/** Инцидент не закрыт: висит в работе или в исследовании. */
export const isOpen = (i: Incident) => i.status !== 'resolved';
/** Срок решения ещё идёт: инцидент не устранён. */
export const slaRunning = (i: Incident) => i.status === 'assigned' || i.status === 'in_progress';

export type FeedKind =
  | 'created'
  | 'p1'
  | 'coordinators'
  | 'assigned'
  | 'in_progress'
  | 'research'
  | 'priority_up'
  | 'sla_warning'
  | 'sla_breach'
  | 'resolved'
  | 'removed';

export interface FeedEvent {
  id: string;
  at: number;
  kind: FeedKind;
  incidentId: string;
  priority: Priority;
  systemId: string;
  text: string;
  actor?: string;
}

export interface TeamScore {
  teamId: string;
  confidence: number; // 0–1
  reasons: string[];
}

export interface RiskFactor {
  label: string;
  weight: number; // вклад в логит, знак = направление
}

export interface Insight {
  incidentId: string;
  source: 'claude' | 'heuristic';
  model?: string;
  summary: string;
  cause: string | null;
  nextSteps: string[];
  teams: TeamScore[];
  risk: {
    score: number;
    level: RiskLevel;
    factors: RiskFactor[];
    minutesToBreach: number | null;
    note: string;
  };
  correlation: null | {
    rootId: string | null;
    ids: string[];
    text: string;
  };
  generatedAt: number;
  latencyMs: number;
  pendingLlm?: boolean;
}

export interface AiStatus {
  mode: 'claude' | 'heuristic';
  model: string | null;
  reason: string;
}

/** Состояние файла с выгрузкой: откуда читаем, когда обновили, есть ли ошибка. */
export interface SourceStatus {
  file: string;
  loadedAt: number | null;
  count: number;
  skipped: number;
  error: string | null;
}

export interface Snapshot {
  serverTime: number;
  incidents: Incident[];
  feed: FeedEvent[];
  systems: SystemInfo[];
  teams: TeamInfo[];
  source: SourceStatus;
  itsmUrl: string | null;
  ai: AiStatus;
}

export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'incident'; data: Incident }
  | { type: 'remove'; data: { id: string } }
  | { type: 'feed'; data: FeedEvent }
  | { type: 'brief'; data: Record<string, AiBrief> }
  | { type: 'insight'; data: Insight }
  | { type: 'catalog'; data: { systems: SystemInfo[]; teams: TeamInfo[] } }
  | { type: 'source'; data: SourceStatus }
  | { type: 'tick'; data: { serverTime: number } };

export const AT_RISK_MIN = 30;
