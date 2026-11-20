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
/** online — решается удалённо, offline — нужен выезд специалиста. */
export type WorkMode = 'online' | 'offline';
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
  teamId: string | null; // рекомендованная группа
  confidence: number; // 0–1
  workerId: string | null; // рекомендованный сотрудник
  workerConfidence: number;
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
  shortDescription: string;
  solution: string | null;
  mode: WorkMode;
  priorityText: string; // как в данных: Наивысший, Высокий, Средний, Низкий
  impact: string;
  urgency: string;
  stateText: string; // статус как в данных
  stateReason: string | null;
  productName: string;
  serviceType: string; // Клиентский, Пользовательский, Технологический
  channel: string; // канал регистрации
  groupName: string;
  assigneeName: string | null;
  isMaster: boolean;
  isDouble: boolean;
  isEffect: boolean; // причина дочерних
  isReason: boolean; // дочерний
  origin: 'dataset' | 'stream' | 'complaints';
  takenAt: number | null; // координатор взял на контроль
  // ─── координирующий пункт ───
  coordinatorId?: string | null; // дежурный пункта, который ведёт инцидент
  coordinatorName?: string | null;
  regionId?: string | null; // где возник (для инцидентов из жалоб)
  regionIds?: string[];
  regionName?: string | null;
  complaints?: number; // привязано жалоб
  complaintsSeries?: number[]; // жалоб за каждые 5 минут, последние 12 точек
  levelLog?: LevelChange[];
  p1Proposal?: string | null; // ИИ предлагает «Наивысший», ждёт подтверждения человеком
  leadNotifiedAt?: number | null;
  routedAt?: number | null; // когда передан команде (от этого считаются таймеры автоэскалации)
  escalation?: number; // ступень автоэскалации: 0 — нет, 1 — напомнили, 2 — руководителю, 3 — предложена дежурная смена
  comments?: IncidentComment[];
  startedAt: number | null;
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
  | 'comment'
  | 'routed'
  | 'request'
  | 'signal';

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

/** Подбор исполнителя: балл 0–100 и из чего он сложился. */
export interface WorkerScore {
  workerId: string;
  confidence: number; // доля среди допущенных (softmax)
  score: number; // 0–100
  reasons: string[]; // коротко: «40 мин езды», «свободен», «3 похожих закрыл», «6 ч на смене»
  parts: { label: string; points: number }[];
  km: number | null;
  etaMin: number | null;
  blocked: string | null; // жёсткий фильтр: перерыв, конец смены
}

/** Пара «инцидент → сотрудник» в плане распределения пачкой. */
export interface PlanItem {
  incidentId: string;
  workerId: string;
  score: number;
  etaMin: number | null;
}

/** coordinator — дежурный пункта, engineer — сотрудник команды, lead — руководитель команды. */
export type Role = 'coordinator' | 'engineer' | 'lead';
export interface Me {
  login: string;
  name: string;
  role: Role;
  personId: string | null;
  teamId: string | null;
}

// ─── Координирующий пункт: регионы, команды, люди, жалобы, запросы ─────────

export type ScheduleKindT = '24/7' | '8-22' | '5/2';

export interface Region {
  id: string;
  name: string;
  district: string; // код ФО: cfo, szfo, yufo, skfo, pfo, ufo, sfo, dfo
  city: string;
  lat: number;
  lon: number;
  tz: number; // UTC+N
  weight: number; // доля абонентов, для фона жалоб
}

export interface Team {
  id: string;
  name: string;
  direction: string; // направление: «Радиосеть», «Биллинг» …
  kind: string; // код направления: ran, fix, l2, dev …
  services: string[]; // какие сервисы абонентов обслуживает
  regionId: string | null;
  district: string | null;
  schedule: ScheduleKindT;
  tz: number;
  leadId: string | null;
  backupId: string | null; // дежурная смена, если команда сейчас не работает
  size: number;
  itsm?: boolean; // группа из выгрузки ITSM
}

export interface Person {
  id: string; // = логин
  name: string;
  teamId: string;
  role: 'engineer' | 'lead' | 'coordinator';
  schedule: ScheduleKindT;
  crew: number;
  tz: number;
  spec?: string; // специализация дежурного пункта: Сеть, ИТ-продукты, B2B
  teams?: string[]; // ещё в каких командах состоит (бывает у людей из выгрузки ITSM)
  away?: boolean; // отошёл (перерыв)
}

export interface Complaint {
  id: string;
  at: number;
  regionId: string;
  lat: number;
  lon: number;
  service: string;
  channel: string;
  text: string;
  b2b: boolean;
  incidentId: string | null;
}

/** Сообщение в карточке инцидента: пункт ↔ команда. */
export interface IncidentComment {
  id: string;
  at: number;
  author: string;
  personId: string | null;
  side: 'point' | 'team';
  teamId: string | null;
  text: string;
}

export interface LevelChange {
  at: number;
  from: Priority;
  to: Priority;
  reason: string;
  auto: boolean;
}

/** Команда пишет в пункт: «это не наше — передайте команде X» или «у команды X проблема». */
export interface TeamRequest {
  id: string;
  at: number;
  kind: 'transfer' | 'report';
  incidentId: string | null;
  fromTeamId: string;
  fromPersonId: string;
  toTeamId: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  aiNote: string;
  aiTeamId: string | null;
  doneAt?: number;
  doneBy?: string;
  comment?: string;
}

/** Сигнал пункту: сотрудник просит помощи или ИИ видит, что инцидент застрял. */
export interface Signal {
  id: string;
  at: number;
  kind: 'help' | 'stuck' | 'timer';
  incidentId: string;
  personId: string | null;
  teamId: string | null;
  text: string;
  status: 'open' | 'notified' | 'closed';
  notifiedAt?: number;
  notifiedBy?: string;
}

/** Подбор команды для инцидента. */
export interface TeamPick {
  teamId: string;
  score: number; // 0–100
  reasons: string[];
  onDuty: boolean;
  onDutyCount: number;
  load: number;
  backupFor?: string | null; // предложена как дежурная замена этой команды
}

/** Кластер жалоб, который ещё не стал инцидентом. */
export interface Cluster {
  key: string;
  service: string;
  regionId: string;
  count: number; // за 10 минут
  expected: number;
  pValue: number;
}

export interface PointSnapshot {
  serverTime: number;
  incidents: Incident[];
  complaints: Complaint[];
  clusters: Cluster[];
  regions: Region[];
  teams: Team[];
  staff: Person[]; // люди пункта
  people: Person[]; // люди команд, с которыми сейчас есть работа, и своя команда
  load: Record<string, number>; // открытых инцидентов у команды
  requests: TeamRequest[];
  signals: Signal[];
  feed: FeedEvent[];
  stats: Stats;
  ai: AiStatus;
  config: { itsmUrl: string | null; source: string; rules: EscalationRules };
}

export interface EscalationRules {
  windowMin: number;
  p3: number;
  p2: number;
  p2multi: number;
  p1: number;
  p1regions: number;
  ceiling: Priority;
  gapMin: number;
}

export type PointMessage =
  | { type: 'snapshot'; data: PointSnapshot }
  | { type: 'incident'; data: Incident }
  | { type: 'remove'; data: { id: string } }
  | { type: 'complaints'; data: Complaint[] }
  | { type: 'clusters'; data: Cluster[] }
  | { type: 'request'; data: TeamRequest }
  | { type: 'signal'; data: Signal }
  | { type: 'people'; data: Person[] }
  | { type: 'load'; data: Record<string, number> }
  | { type: 'feed'; data: FeedEvent }
  | { type: 'stats'; data: Stats }
  | { type: 'tick'; data: { serverTime: number } }
  | { type: 'insight'; data: Insight };

export type WorkerStatus = 'free' | 'busy' | 'break' | 'enroute' | 'onsite';

/** Сотрудник: онлайн (решает удалённо) или офлайн (выезжает). */
export interface Worker {
  id: string; // логин
  name: string;
  mode: WorkMode;
  groups: string[];
  office: string | null; // для выездных — офис МТС
  status: WorkerStatus;
  currentId: string | null;
  queue: string[]; // личный порядок задач, который сотрудник ставит сам
  focus: string; // «чем занимаюсь» коротко
  done: number; // сделано за смену
  manual: boolean; // кабинетом управляет человек
  shiftStart: number; // начало смены, мс
  trips: number; // выездов за смену
  lat: number | null; // где сейчас (для выездных)
  lon: number | null;
  place: string; // «офис Краснодар», «Анапа · БС 23-0451»
}

export interface Office {
  id: string;
  city: string;
  lat: number;
  lon: number;
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
  workers: WorkerScore[];
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
  workers: Worker[];
  offices: Office[];
  config: { itsmUrl: string | null; bounds: [[number, number], [number, number]]; source: string };
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
  | { type: 'tick'; data: { serverTime: number } }
  | { type: 'worker'; data: Worker };

export type ScenarioKind = 'mass_outage' | 'field_wave' | 'coord_flood';

/** Срок решения по приоритету, как в наборе данных: Высокий 6 ч, Средний 12 ч, Низкий 32 ч. */
export const PRIORITY_SLA_MIN: Record<Priority, number> = { P1: 120, P2: 360, P3: 720, P4: 1920 };
export const PRIORITY_TEXT: Record<Priority, string> = { P1: 'Наивысший', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' };
export const AT_RISK_MIN = 30;
