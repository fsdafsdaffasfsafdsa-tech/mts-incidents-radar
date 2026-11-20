// Клиентское состояние: снимок + поток SSE, внимание координатора, тосты, звук.
import { useSyncExternalStore } from 'react';
import type {
  AiStatus,
  FeedEvent,
  Incident,
  Insight,
  Intensity,
  ScenarioKind,
  ServerMessage,
  Stats,
  SystemInfo,
  TeamInfo,
  Office,
  Me,
  PlanItem,
  Snapshot,
  Worker,
  WorkMode,
} from '../shared/types';
import { play, unlockAudio, type Cue } from './lib/sound';

export const ME = 'А. Корнеева';

export type ToastKind = 'p1' | 'coord' | 'warn' | 'resolved' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body: string;
  incidentId?: string;
  at: number;
  ttl: number;
}

export type QueueFilter = 'open' | 'attention' | 'coordinators' | 'critical' | 'risk' | 'breach' | 'resolved';
export type View = 'map' | 'queue' | 'systems' | 'feed';
export type Screen = 'online' | 'offline' | 'cabinet';
/** Папка слева: смена (urgent, coordinators…), система `sys:<id>`, команда `team:<id>` или лента `feed`. */
export type FolderId = string;
export type MetricPlacement = 'top' | 'side';
export interface MetricSlot {
  id: string;
  size: 's' | 'l';
}
export interface MetricsCfg {
  placement: MetricPlacement;
  slots: MetricSlot[];
}
export const DEFAULT_METRICS: MetricsCfg = {
  placement: 'top',
  slots: [
    { id: 'open', size: 's' },
    { id: 'critical', size: 's' },
    { id: 'risk', size: 's' },
    { id: 'coord', size: 's' },
    { id: 'resolvedHour', size: 's' },
  ],
};

export interface State {
  me: Me | null;
  authChecked: boolean;
  config: Snapshot['config'] | null;
  connected: boolean;
  everConnected: boolean;
  offset: number;
  incidents: Map<string, Incident>;
  feed: FeedEvent[];
  systems: SystemInfo[];
  teams: TeamInfo[];
  stats: Stats | null;
  intensity: Intensity;
  ai: AiStatus | null;
  insights: Map<string, Insight>;
  attention: string[];
  fresh: Map<string, number>;
  toasts: Toast[];
  selectedId: string | null;
  hoverId: string | null;
  view: View;
  screen: Screen;
  workers: Worker[];
  offices: Office[];
  cabinet: { mode: WorkMode; workerId: string | null };
  folder: FolderId;
  mode: 'map' | 'list';
  metrics: MetricsCfg;
  collapsed: string[];
  filter: QueueFilter;
  systemFilter: string | null;
  search: string;
  sound: boolean;
  notify: boolean;
  theme: 'dark' | 'light';
}

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* приватный режим */
  }
}

let state: State = {
  me: null,
  authChecked: false,
  config: null,
  connected: false,
  everConnected: false,
  offset: 0,
  incidents: new Map(),
  feed: [],
  systems: [],
  teams: [],
  stats: null,
  intensity: 'normal',
  ai: null,
  insights: new Map(),
  attention: [],
  fresh: new Map(),
  toasts: [],
  selectedId: null,
  hoverId: null,
  view: 'map',
  screen: readPref<Screen>('radar.screen', 'online'),
  workers: [],
  offices: [],
  cabinet: readPref('radar.cabinet', { mode: 'online' as WorkMode, workerId: null as string | null }),
  folder: 'urgent',
  mode: readPref<'map' | 'list'>('radar.mode', 'map'),
  metrics: readPref<MetricsCfg>('radar.metrics', DEFAULT_METRICS),
  collapsed: readPref<string[]>('radar.collapsed', ['teams']),
  filter: 'open',
  systemFilter: null,
  search: '',
  sound: readPref('radar.sound', true),
  notify: readPref('radar.notify', false),
  theme: readPref('radar.theme', 'dark'),
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const serverNow = () => Date.now() + state.offset;

// ─── Подключение к потоку ──────────────────────────────────────────────────

let es: EventSource | null = null;

// ─── Вход ──────────────────────────────────────────────────────────────────

export async function checkAuth() {
  try {
    const r = await fetch('/api/me');
    const me = r.ok ? ((await r.json()) as Me) : null;
    setState({ me, authChecked: true });
    if (me) connect();
  } catch {
    setState({ authChecked: true });
  }
}

export async function doLogin(login: string, password: string): Promise<string | null> {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return data.error ?? `Ошибка ${r.status}`;
  unlockAudio();
  setState({ me: data as Me, selectedId: null });
  connect();
  return null;
}

export async function doLogout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
  es?.close();
  es = null;
  setState({ me: null, connected: false, everConnected: false, incidents: new Map(), workers: [], selectedId: null, attention: [], toasts: [] });
}

/** Мой профиль сотрудника (для онлайн- и выездных). */
export const myWorker = (s: State) => (s.me?.workerId ? s.workers.find((w) => w.id === s.me!.workerId) : undefined);

export function connect() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.onopen = () => setState({ connected: true, everConnected: true });
  es.onerror = () => {
    setState({ connected: false });
    // Сессия могла истечь: проверяем и, если нужно, возвращаем на экран входа.
    void fetch('/api/me').then((r) => {
      if (r.status === 401) {
        es?.close();
        es = null;
        setState({ me: null });
      }
    });
  };
  es.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data) as ServerMessage);
    } catch (err) {
      console.error('Плохое сообщение потока', err);
    }
  };
}

function handle(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot': {
      const d = msg.data;
      const incidents = new Map(d.incidents.map((i) => [i.id, i]));
      // При первом подключении в «внимание» попадают непросмотренные P1/P2 и очередь координаторов.
      const attention = state.everConnected && state.attention.length
        ? state.attention.filter((id) => incidents.has(id))
        : d.incidents
            .filter((i) => i.status !== 'resolved' && !i.acknowledged && (i.priority <= 'P2' || i.status === 'coordinators'))
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((i) => i.id);
      setState({
        connected: true,
        everConnected: true,
        offset: d.serverTime - Date.now(),
        incidents,
        feed: d.feed,
        systems: d.systems,
        teams: d.teams,
        stats: d.stats,
        intensity: d.intensity,
        ai: d.ai,
        attention,
        workers: d.workers ?? [],
        offices: d.offices ?? [],
        config: d.config ?? null,
      });
      break;
    }
    case 'incident': {
      const incidents = new Map(state.incidents);
      const prev = incidents.get(msg.data.id);
      incidents.set(msg.data.id, msg.data);
      const patch: Partial<State> = { incidents };
      if (!prev) {
        const fresh = new Map(state.fresh);
        fresh.set(msg.data.id, Date.now());
        patch.fresh = fresh;
      }
      setState(patch);
      break;
    }
    case 'remove': {
      const incidents = new Map(state.incidents);
      incidents.delete(msg.data.id);
      setState({
        incidents,
        attention: state.attention.filter((x) => x !== msg.data.id),
        selectedId: state.selectedId === msg.data.id ? null : state.selectedId,
      });
      break;
    }
    case 'brief': {
      const incidents = new Map(state.incidents);
      for (const [id, ai] of Object.entries(msg.data)) {
        const inc = incidents.get(id);
        if (inc) incidents.set(id, { ...inc, ai });
      }
      setState({ incidents });
      break;
    }
    case 'feed':
      setState({ feed: [msg.data, ...state.feed].slice(0, 200) });
      onFeed(msg.data);
      break;
    case 'insight': {
      const insights = new Map(state.insights);
      insights.set(msg.data.incidentId, msg.data);
      setState({ insights });
      break;
    }
    case 'stats':
      setState({ stats: msg.data });
      break;
    case 'intensity':
      setState({ intensity: msg.data });
      break;
    case 'tick':
      setState({ offset: msg.data.serverTime - Date.now() });
      break;
    case 'worker': {
      const w = msg.data;
      const workers = state.workers.some((x) => x.id === w.id) ? state.workers.map((x) => (x.id === w.id ? w : x)) : [...state.workers, w];
      setState({ workers });
      break;
    }
  }
}

// ─── Внимание, тосты, звук ─────────────────────────────────────────────────

let toastSeq = 1;

function addAttention(id: string) {
  if (state.selectedId === id) return;
  setState({ attention: [id, ...state.attention.filter((x) => x !== id)] });
}

function toast(t: Omit<Toast, 'id' | 'at'>) {
  const item: Toast = { ...t, id: `T${toastSeq++}`, at: Date.now() };
  setState({ toasts: [item, ...state.toasts].slice(0, 5) });
  setTimeout(() => dismissToast(item.id), item.ttl);
}

export function dismissToast(id: string) {
  if (state.toasts.some((t) => t.id === id)) setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}

function cue(c: Cue) {
  if (state.sound) play(c);
}

function systemName(id: string) {
  return state.systems.find((s) => s.id === id)?.short ?? id;
}

function notifyBrowser(title: string, body: string) {
  if (!state.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    new Notification(title, { body, tag: title, icon: '/favicon.svg' });
  } catch {
    /* не поддерживается */
  }
}

function onFeed(ev: FeedEvent) {
  const me = state.me;
  if (!me || ev.actor === me.name) return; // свои действия не подсвечиваем
  const inc = state.incidents.get(ev.incidentId);
  const title = inc?.title ?? ev.text;
  const sys = systemName(ev.systemId);
  // Сотруднику — только то, что касается его: новая задача, вернули, срок горит.
  if (me.role !== 'coordinator') {
    const mine = inc?.assignee === me.workerId;
    if (ev.kind === 'assigned' && mine) {
      toast({ kind: inc?.priority === 'P1' ? 'p1' : 'coord', title: inc?.mode === 'offline' ? 'Новый выезд' : 'Новая задача', body: `${inc?.region && inc.mode === 'offline' ? `${inc.region} · ` : ''}${title}`, incidentId: ev.incidentId, ttl: 12_000 });
      cue(inc?.priority === 'P1' ? 'p1' : 'coord');
      notifyBrowser('Новая задача', title);
    } else if (mine && (ev.kind === 'sla_warning' || ev.kind === 'sla_breach')) {
      toast({ kind: 'warn', title: ev.kind === 'sla_breach' ? 'Дедлайн прошёл' : 'Дедлайн близко', body: title, incidentId: ev.incidentId, ttl: 9_000 });
      cue('warn');
    }
    return;
  }
  switch (ev.kind) {
    case 'p1':
      addAttention(ev.incidentId);
      toast({ kind: 'p1', title: `Критический P1 · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 20_000 });
      cue('p1');
      notifyBrowser(`P1 · ${sys}`, title);
      break;
    case 'coordinators':
      addAttention(ev.incidentId);
      if (ev.priority <= 'P2') {
        toast({ kind: 'coord', title: `На координаторов · ${ev.priority} · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 8_000 });
        cue('coord');
        notifyBrowser(`Назначен на координаторов · ${sys}`, title);
      }
      break;
    case 'priority_up':
      addAttention(ev.incidentId);
      toast({ kind: 'warn', title: `${ev.text} · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 9_000 });
      cue('warn');
      break;
    case 'sla_breach':
      if (ev.priority <= 'P2') {
        addAttention(ev.incidentId);
        toast({ kind: 'warn', title: `SLA нарушен · ${ev.priority} · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 9_000 });
        cue('warn');
      }
      break;
    case 'sla_warning':
      addAttention(ev.incidentId);
      break;
    case 'created':
      if (ev.priority === 'P2') addAttention(ev.incidentId);
      break;
    case 'resolved': {
      const watched = state.selectedId === ev.incidentId;
      setState({ attention: state.attention.filter((x) => x !== ev.incidentId) });
      if (ev.priority === 'P1' || watched) {
        toast({ kind: 'resolved', title: `Решён · ${ev.priority} · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 6_000 });
        cue('resolved');
      }
      break;
    }
  }
}

// ─── Действия ──────────────────────────────────────────────────────────────

export function select(id: string | null) {
  setState({ selectedId: id, attention: id ? state.attention.filter((x) => x !== id) : state.attention });
  if (id) void loadInsight(id);
}

export async function loadInsight(id: string) {
  try {
    const r = await fetch(`/api/incidents/${id}/insight`);
    if (!r.ok) return;
    const insight = (await r.json()) as Insight;
    const insights = new Map(state.insights);
    const prev = insights.get(id);
    // Не затираем ответ Claude эвристикой, если он уже пришёл по SSE.
    if (prev?.source === 'claude' && insight.source === 'heuristic' && insight.pendingLlm) return;
    insights.set(id, insight);
    setState({ insights });
  } catch {
    /* сеть */
  }
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    toast({ kind: 'info', title: 'Не получилось', body: data.error ?? `Ошибка ${r.status}`, ttl: 5000 });
    throw new Error(data.error);
  }
  return data;
}

export async function act(id: string, type: 'ack' | 'take' | 'assign' | 'raise' | 'escalate' | 'resolve' | 'link', extra: Record<string, unknown> = {}) {
  setState({ attention: state.attention.filter((x) => x !== id) });
  await post(`/api/incidents/${id}/action`, { type, actor: ME, ...extra });
  void loadInsight(id);
}

export async function bulkAssign(items: { id: string; teamId: string }[]) {
  const r = await post('/api/bulk-assign', { items, actor: ME });
  toast({ kind: 'info', title: 'ИИ-маршрутизация', body: `Передано команд: ${r.assigned}`, ttl: 5000 });
  setState({ attention: state.attention.filter((x) => !items.some((i) => i.id === x)) });
}

export async function runScenario(kind: ScenarioKind) {
  unlockAudio();
  await post('/api/demo/scenario', { kind });
}

export async function setIntensity(level: Intensity) {
  await post('/api/demo/intensity', { level });
}

export function toggleSound() {
  unlockAudio();
  const sound = !state.sound;
  writePref('radar.sound', sound);
  setState({ sound });
  if (sound) play('coord');
}

export async function toggleNotify() {
  if (!state.notify && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') return;
  }
  const notify = !state.notify;
  writePref('radar.notify', notify);
  setState({ notify });
}

export function toggleTheme() {
  const theme = state.theme === 'dark' ? 'light' : 'dark';
  writePref('radar.theme', theme);
  setState({ theme });
}

export function setScreen(screen: Screen) {
  writePref('radar.screen', screen);
  setState({ screen, selectedId: null });
}

export function setCabinet(cabinet: { mode: WorkMode; workerId: string | null }) {
  writePref('radar.cabinet', cabinet);
  setState({ cabinet, selectedId: null });
  if (cabinet.workerId) void workerAct(cabinet.workerId, { action: 'claim' });
}

export async function workerAct(workerId: string, body: { action: string; incidentId?: string; status?: string; focus?: string; queue?: string[] }) {
  return post(`/api/workers/${encodeURIComponent(workerId)}`, body);
}

/** План распределения пачкой (венгерский алгоритм на сервере). */
export async function fetchPlan(mode: WorkMode): Promise<PlanItem[]> {
  const r = await fetch(`/api/plan?mode=${mode}`);
  return r.ok ? ((await r.json()) as PlanItem[]) : [];
}

export async function applyPlan(items: PlanItem[]) {
  const r = await post('/api/bulk-assign', { items: items.map((x) => ({ id: x.incidentId, workerId: x.workerId })) });
  toast({ kind: 'info', title: 'Распределено', body: `Назначено задач: ${r.assigned}`, ttl: 5000 });
  setState({ attention: state.attention.filter((x) => !items.some((i) => i.incidentId === x)) });
}

export function itsmLink(id: string) {
  const t = state.config?.itsmUrl;
  return t ? t.replace('{id}', encodeURIComponent(id)) : null;
}

export function workerName(id: string | null | undefined) {
  return state.workers.find((w) => w.id === id)?.name ?? '—';
}

export function readLocal<T>(key: string, fallback: T): T {
  return readPref(key, fallback);
}

export function writeLocal(key: string, v: unknown) {
  writePref(key, v);
}

export function setView(view: View) {
  setState({ view });
}

export function setFolder(folder: FolderId) {
  setState({ folder, search: '' });
}

export function setMode(mode: 'map' | 'list') {
  writePref('radar.mode', mode);
  setState({ mode });
}

export function setMetrics(metrics: MetricsCfg) {
  writePref('radar.metrics', metrics);
  setState({ metrics });
}

export function toggleGroup(group: string) {
  const collapsed = state.collapsed.includes(group) ? state.collapsed.filter((g) => g !== group) : [...state.collapsed, group];
  writePref('radar.collapsed', collapsed);
  setState({ collapsed });
}

export function teamName(id: string | null | undefined, short = true) {
  const t = state.teams.find((x) => x.id === id);
  return t ? (short ? t.short : t.name) : '—';
}
