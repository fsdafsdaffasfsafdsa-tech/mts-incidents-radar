// Клиентское состояние: снимок + поток SSE, внимание координатора, тосты, звук.
import { useSyncExternalStore } from 'react';
import type { AiStatus, FeedEvent, Incident, Insight, ServerMessage, SourceStatus, SystemInfo, TeamInfo } from '../shared/types';
import { isOpen } from '../shared/types';
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

/** Четыре группы из ТЗ (critical, coordinators, high, research) и служебные фильтры. Инцидент может попасть в несколько групп. */
export type QueueFilter = 'open' | 'attention' | 'critical' | 'coordinators' | 'high' | 'research' | 'risk' | 'breach' | 'resolved';
export type View = 'board' | 'map' | 'queue' | 'systems' | 'feed';

export interface State {
  connected: boolean;
  everConnected: boolean;
  offset: number;
  incidents: Map<string, Incident>;
  feed: FeedEvent[];
  systems: SystemInfo[];
  teams: TeamInfo[];
  source: SourceStatus | null;
  itsmUrl: string | null;
  ai: AiStatus | null;
  insights: Map<string, Insight>;
  attention: string[];
  fresh: Map<string, number>;
  toasts: Toast[];
  selectedId: string | null;
  hoverId: string | null;
  view: View;
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
  connected: false,
  everConnected: false,
  offset: 0,
  incidents: new Map(),
  feed: [],
  systems: [],
  teams: [],
  source: null,
  itsmUrl: null,
  ai: null,
  insights: new Map(),
  attention: [],
  fresh: new Map(),
  toasts: [],
  selectedId: null,
  hoverId: null,
  view: 'board',
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

export function connect() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.onopen = () => setState({ connected: true, everConnected: true });
  es.onerror = () => setState({ connected: false });
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
            .filter((i) => isOpen(i) && !i.acknowledged && (i.priority <= 'P2' || i.onCoordinators))
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
        source: d.source,
        itsmUrl: d.itsmUrl,
        ai: d.ai,
        attention,
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
    case 'catalog':
      setState({ systems: msg.data.systems, teams: msg.data.teams });
      break;
    case 'source': {
      const prev = state.source;
      setState({ source: msg.data });
      if (msg.data.error && msg.data.error !== prev?.error) toast({ kind: 'warn', title: 'Файл с инцидентами не прочитан', body: msg.data.error, ttl: 9_000 });
      break;
    }
    case 'tick':
      setState({ offset: msg.data.serverTime - Date.now() });
      break;
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
  if (ev.actor === ME) return; // свои действия не подсвечиваем
  const inc = state.incidents.get(ev.incidentId);
  const title = inc?.title ?? ev.text;
  const sys = systemName(ev.systemId);
  switch (ev.kind) {
    case 'p1':
      addAttention(ev.incidentId);
      toast({ kind: 'p1', title: `Критический инцидент · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 20_000 });
      cue('p1');
      notifyBrowser(`Критический · ${sys}`, title);
      break;
    case 'coordinators':
      addAttention(ev.incidentId);
      toast({ kind: 'coord', title: `Назначен на координаторов · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 10_000 });
      cue('coord');
      notifyBrowser(`Назначен на координаторов · ${sys}`, title);
      break;
    case 'priority_up':
      addAttention(ev.incidentId);
      toast({ kind: 'warn', title: `${ev.text} · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 9_000 });
      cue('warn');
      break;
    case 'sla_breach':
      if (ev.priority <= 'P2') {
        addAttention(ev.incidentId);
        toast({ kind: 'warn', title: `Дедлайн прошёл · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 9_000 });
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
        toast({ kind: 'resolved', title: `${ev.priority === 'P1' ? 'Критический решён' : 'Решён'} · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 8_000 });
        cue('resolved');
      }
      break;
    }
    case 'research':
      if (ev.priority <= 'P2' || state.selectedId === ev.incidentId)
        toast({ kind: 'info', title: `Исследование ситуации · ${sys}`, body: title, incidentId: ev.incidentId, ttl: 6_000 });
      break;
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

/** «Взять на контроль» — единственное действие на дашборде; изменения инцидента вносятся в ITSM. */
export async function ack(id: string) {
  setState({ attention: state.attention.filter((x) => x !== id) });
  await post(`/api/incidents/${id}/ack`, {});
}

/** Ссылка на инцидент в ITSM по шаблону ITSM_URL (с подстановкой {id}). */
export function itsmLink(id: string): string | null {
  const t = state.itsmUrl;
  if (!t) return null;
  return t.includes('{id}') ? t.replaceAll('{id}', encodeURIComponent(id)) : `${t.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
}

export function openItsm(id: string) {
  const url = itsmLink(id);
  if (url) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  void navigator.clipboard?.writeText(id).catch(() => undefined);
  toast({ kind: 'info', title: `Номер ${id} скопирован`, body: 'Адрес ITSM не настроен: задайте ITSM_URL в .env, и кнопка будет открывать инцидент.', ttl: 6_000 });
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

export function setView(view: View) {
  setState({ view });
}

export function teamName(id: string | null | undefined, short = true) {
  const t = state.teams.find((x) => x.id === id);
  return t ? (short ? t.short : t.name) : '—';
}
