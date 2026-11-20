// Общие типы сервера и дашборда.

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

/**
 * coordinators — инцидент висит на группе координаторов: нужно решить, какой команде его отдать.
 * assigned     — передан команде, исполнитель ещё не взял.
 * in_progress  — исполнитель работает.
 * escalated    — эскалирован дежурному руководителю.
 * resolved     — решён.
 */
export type Status = 'coordinators' | 'assigned' | 'in_progress' | 'escalated' | 'resolved';

export type Trend = 'growing' | 'stable' | 'declining';
export type Source = 'monitoring' | 'support' | 'partner' | 'user';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface SystemInfo {
  id: string;
  name: string;
  short: string;
  icon: string; // имя иконки lucide
  dependsOn: string[];
}

export interface TeamInfo {
  id: string;
  name: string;
  short: string;
  members: string[];
  isCoordinators?: boolean;
}

export interface HistoryItem {
  at: number;
  text: string;
  actor?: string;
  kind: 'system' | 'coordinator' | 'team' | 'ai';
}

/** Короткая ИИ-оценка, которая едет вместе с инцидентом (для очереди). */
export interface AiBrief {
  risk: number; // 0–100
  level: RiskLevel;
  teamId: string | null; // рекомендованная команда
  confidence: number; // 0–1
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Выездная бригада: едет к месту аварии, как машина в такси-агрегаторе. */
export interface Crew {
  name: string;
  from: GeoPoint;
  dispatchedAt: number;
  etaMs: number;
  arrived: boolean;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  systemId: string;
  service: string;
  component: string;
  region: string;
  geo: GeoPoint;
  /** Линия на карте: например, оборванная магистраль между двумя городами. [lon, lat] */
  path: [number, number][] | null;
  crew: Crew | null;
  teamId: string | null;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
  slaMinutes: number;
  slaDeadline: number;
  affectedUsers: number;
  signals: string[];
  source: Source;
  trend: Trend;
  reassignCount: number;
  relatedIds: string[];
  parentId: string | null; // первопричина, если инцидент связан как дочерний
  acknowledged: boolean;
  resolvedAt: number | null;
  history: HistoryItem[];
  ai: AiBrief;
}

export type FeedKind =
  | 'created'
  | 'p1'
  | 'coordinators'
  | 'assigned'
  | 'in_progress'
  | 'escalated'
  | 'priority_up'
  | 'sla_warning'
  | 'sla_breach'
  | 'resolved'
  | 'linked'
  | 'crew'
  | 'comment';

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

export interface Stats {
  resolvedLastHour: number;
  createdLastHour: number;
  breachedLastHour: number;
  mttrMinutes: number | null;
  flowPerMin: number;
  aiAccuracy: number | null; // доля совпадений подсказки команды с «правдой» генератора
  series: { at: number; open: number; critical: number; atRisk: number }[];
}

export type Intensity = 'calm' | 'normal' | 'storm';

export interface AiStatus {
  mode: 'claude' | 'heuristic';
  model: string | null;
  reason: string;
}

export interface Snapshot {
  serverTime: number;
  incidents: Incident[];
  feed: FeedEvent[];
  systems: SystemInfo[];
  teams: TeamInfo[];
  stats: Stats;
  intensity: Intensity;
  ai: AiStatus;
}

export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'incident'; data: Incident }
  | { type: 'remove'; data: { id: string } }
  | { type: 'feed'; data: FeedEvent }
  | { type: 'brief'; data: Record<string, AiBrief> }
  | { type: 'insight'; data: Insight }
  | { type: 'stats'; data: Stats }
  | { type: 'intensity'; data: Intensity }
  | { type: 'tick'; data: { serverTime: number } };

export type ScenarioKind = 'billing_outage' | 'network_cut' | 'coord_flood' | 'ddos';

export const PRIORITY_SLA_MIN: Record<Priority, number> = { P1: 60, P2: 240, P3: 480, P4: 1440 };
export const AT_RISK_MIN = 30;
