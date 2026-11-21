// Клиентское состояние координирующего пункта: снимок + поток SSE, тосты по роли, звук, действия.
import { useSyncExternalStore } from 'react';
import type {
  AiStatus,
  Cluster,
  Complaint,
  FeedEvent,
  Incident,
  MailItem,
  Me,
  Person,
  PointMessage,
  PointSnapshot,
  Priority,
  Region,
  RiskFactor,
  RiskLevel,
  Signal,
  Stats,
  Team,
  TeamPick,
  TeamRequest,
} from '../shared/types';
import { configureSound, play, unlockAudio, type Cue, type SoundPack } from './lib/sound';
import { RECUR_MIN } from '../shared/dash';
import { voiceLine } from '../shared/attention';
import { themeById } from './lib/themes';
import { DEFAULT_HOTKEYS, type HotAction } from './lib/hotkeys';

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

export interface RouteInfo {
  picks: TeamPick[];
  risk: { score: number; level: RiskLevel; factors: RiskFactor[]; minutesToBreach: number | null; note: string };
  coordinator: { personId: string; why: string } | null; // кому из дежурных подходит (подсказка)
  at: number;
}

export type PointTab = 'incidents' | 'requests' | 'signals';

export interface State {
  me: Me | null;
  authChecked: boolean;
  connected: boolean;
  everConnected: boolean;
  offset: number;
  incidents: Map<string, Incident>;
  complaints: Complaint[];
  clusters: Cluster[];
  regions: Region[];
  teams: Team[];
  teamIndex: Map<string, Team>;
  staff: Person[];
  people: Map<string, Person>;
  load: Record<string, number>;
  requests: Map<string, TeamRequest>;
  signals: Map<string, Signal>;
  feed: FeedEvent[];
  mail: MailItem[]; // почта дежурного с разбором ИИ
  stats: Stats | null;
  ai: AiStatus | null;
  config: PointSnapshot['config'] | null;
  routes: Map<string, RouteInfo>;
  selectedId: string | null;
  pointTab: PointTab;
  view: 'main' | 'directory';
  tab: string; // вкладка процесса: map, inbox, teams, requests, signals, done, ai, directory …
  dirQuery: string; // поиск в справочнике, переданный из быстрого поиска
  palette: boolean; // открыт быстрый поиск (Ctrl+K)
  replayAt: number | null; // перемотка карты: момент времени или null — реальное время
  hotkeys: Record<HotAction, string>;
  hotkeysOn: boolean;
  alarmOn: boolean; // тревога для критических: мигание экрана и сирена
  toasts: Toast[];
  sound: boolean;
  theme: 'dark' | 'light'; // подложка: от неё зависит карта
  skin: string; // тема экрана из настроек
  soundPack: SoundPack;
  volume: number;
  soundEvents: Record<Cue, boolean>;
  motion: boolean; // анимации
  settings: boolean; // открыто окно настроек
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
export const readLocal = readPref;
export const writeLocal = writePref;

let state: State = {
  me: null,
  authChecked: false,
  connected: false,
  everConnected: false,
  offset: 0,
  incidents: new Map(),
  complaints: [],
  clusters: [],
  regions: [],
  teams: [],
  teamIndex: new Map(),
  staff: [],
  people: new Map(),
  load: {},
  requests: new Map(),
  signals: new Map(),
  feed: [],
  mail: [],
  stats: null,
  ai: null,
  config: null,
  routes: new Map(),
  selectedId: null,
  pointTab: 'incidents',
  view: 'main',
  tab: '',
  dirQuery: '',
  palette: false,
  replayAt: null,
  hotkeys: { ...DEFAULT_HOTKEYS, ...readPref<Partial<Record<HotAction, string>>>('radar.hotkeys', {}) },
  hotkeysOn: readPref('radar.hotkeysOn', true),
  alarmOn: readPref('radar.alarmOn', true),
  toasts: [],
  sound: readPref('radar.sound2', false), // звуковые эффекты по умолчанию выключены — о событиях говорит Джарвис
  theme: themeById(readPref('radar.skin', readPref('radar.theme', 'light'))).base,
  skin: themeById(readPref('radar.skin', readPref('radar.theme', 'light'))).id,
  soundPack: readPref('radar.soundPackV2', false) ? readPref<SoundPack>('radar.soundPack', 'ring') : 'ring',
  volume: readPref('radar.volume', 0.8),
  soundEvents: readPref<Record<Cue, boolean>>('radar.soundEvents', { p1: true, coord: true, warn: true, request: true, resolved: true }),
  motion: readPref('radar.motion', true),
  settings: false,
};
configureSound({ pack: state.soundPack, volume: state.volume, events: state.soundEvents });
if (!readPref('radar.soundPackV2', false)) {
  writePref('radar.soundPack', 'ring');
  writePref('radar.soundPackV2', true);
}

const listeners = new Set<() => void>();
export const getState = () => state;
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
// Для отладки и скриншотов: состояние в консоли браузера.
(globalThis as unknown as { __radarState?: () => State }).__radarState = () => state;

// ─── справочные выборки ────────────────────────────────────────────────────

export const teamName = (id: string | null | undefined) => (id ? state.teamIndex.get(id)?.name ?? id : '—');
export const personOf = (id: string | null | undefined) => (id ? state.people.get(id) ?? state.staff.find((p) => p.id === id) : undefined);
export const regionName = (id: string | null | undefined) => state.regions.find((r) => r.id === id)?.name ?? '';

// ─── вход ──────────────────────────────────────────────────────────────────

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
  setState({ me: data as Me, selectedId: null, view: 'main' });
  connect();
  return null;
}

export async function doLogout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
  es?.close();
  es = null;
  setState({ me: null, connected: false, everConnected: false, incidents: new Map(), selectedId: null, toasts: [] });
}

// ─── поток ─────────────────────────────────────────────────────────────────

let es: EventSource | null = null;

export function connect() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.onopen = () => setState({ connected: true, everConnected: true });
  es.onerror = () => {
    setState({ connected: false });
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
      handle(JSON.parse(e.data) as PointMessage);
    } catch (err) {
      console.error('Плохое сообщение потока', err);
    }
  };
}

const HOUR = 3_600_000;

function handle(msg: PointMessage) {
  switch (msg.type) {
    case 'snapshot': {
      const d = msg.data;
      setState({
        connected: true,
        everConnected: true,
        offset: d.serverTime - Date.now(),
        incidents: new Map(d.incidents.map((i) => [i.id, i])),
        complaints: d.complaints,
        clusters: d.clusters,
        regions: d.regions,
        teams: d.teams,
        teamIndex: new Map(d.teams.map((t) => [t.id, t])),
        staff: d.staff,
        people: new Map(d.people.map((p) => [p.id, p])),
        load: d.load,
        requests: new Map(d.requests.map((r) => [r.id, r])),
        signals: new Map(d.signals.map((s) => [s.id, s])),
        feed: d.feed,
        stats: d.stats,
        ai: d.ai,
        config: d.config,
      });
      if (isPoint()) void loadMail();
      break;
    }
    case 'incident': {
      const incidents = new Map(state.incidents);
      const prev = incidents.get(msg.data.id);
      incidents.set(msg.data.id, msg.data);
      setState({ incidents });
      onIncident(prev, msg.data);
      break;
    }
    case 'remove': {
      const incidents = new Map(state.incidents);
      incidents.delete(msg.data.id);
      setState({ incidents, selectedId: state.selectedId === msg.data.id ? null : state.selectedId });
      break;
    }
    case 'complaints': {
      const now = serverNow();
      const merged = state.complaints.concat(msg.data);
      // Держим час и не больше 6000 точек — карта остаётся лёгкой.
      const from = merged.findIndex((c) => now - c.at < HOUR);
      setState({ complaints: (from > 0 ? merged.slice(from) : merged).slice(-6000) });
      break;
    }
    case 'clusters':
      setState({ clusters: msg.data });
      break;
    case 'request': {
      const requests = new Map(state.requests);
      const prev = requests.get(msg.data.id);
      requests.set(msg.data.id, msg.data);
      setState({ requests });
      if (!prev && msg.data.status === 'pending' && isPoint()) {
        toast({ kind: 'coord', title: msg.data.kind === 'transfer' ? 'Запрос на передачу' : 'Сообщение команды', body: `${teamName(msg.data.fromTeamId)}: ${msg.data.reason}`, incidentId: msg.data.incidentId ?? undefined, ttl: 9000 });
        cue('request');
      }
      break;
    }
    case 'signal': {
      const signals = new Map(state.signals);
      const prev = signals.get(msg.data.id);
      signals.set(msg.data.id, msg.data);
      setState({ signals });
      onSignal(prev, msg.data);
      break;
    }
    case 'people': {
      const people = new Map(state.people);
      const staff = state.staff.map((p) => msg.data.find((x) => x.id === p.id) ?? p);
      for (const p of msg.data) if (people.has(p.id) || p.teamId === state.me?.teamId) people.set(p.id, p);
      setState({ people, staff });
      break;
    }
    case 'load':
      setState({ load: msg.data });
      break;
    case 'feed':
      setState({ feed: [msg.data, ...state.feed].slice(0, 200) });
      break;
    case 'mail': {
      const m = msg.data;
      const rest = state.mail.filter((x) => x.id !== m.id);
      setState({ mail: [m, ...rest].sort((a, b) => b.at - a.at).slice(0, 80) });
      break;
    }
    case 'stats':
      setState({ stats: msg.data });
      break;
    case 'tick':
      setState({ offset: msg.data.serverTime - Date.now() });
      break;
    case 'insight':
      break;
  }
}

// ─── уведомления по роли ───────────────────────────────────────────────────

const isPoint = () => state.me?.role === 'coordinator';
let toastSeq = 1;
export function toast(t: Omit<Toast, 'id' | 'at'>) {
  const item: Toast = { ...t, id: `T${toastSeq++}`, at: Date.now() };
  setState({ toasts: [item, ...state.toasts].slice(0, 4) });
  setTimeout(() => dismissToast(item.id), item.ttl);
}
export function dismissToast(id: string) {
  if (state.toasts.some((t) => t.id === id)) setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}
function cue(c: Cue) {
  if (state.sound) play(c);
}

/** Сказать голосом Джарвиса (очередь у Джарвиса: по порядку, без повторов по ключу). */
const announce = (text: string, id: string, key: string) => window.dispatchEvent(new CustomEvent('radar:announce', { detail: { text, id, key } }));

function onIncident(prev: Incident | undefined, inc: Incident) {
  const me = state.me;
  if (!me) return;
  const msgs = inc.comments ?? [];
  if (prev && msgs.length > (prev.comments?.length ?? 0)) {
    const c = msgs[msgs.length - 1];
    const surname = me.name.split(' ')[0];
    const mine = me.role === 'coordinator' ? inc.coordinatorId === me.personId : inc.teamId === me.teamId;
    if (c.personId !== me.personId && (mine || c.text.includes(`@${surname}`))) {
      toast({ kind: 'info', title: `Сообщение: ${c.author}`, body: c.text, incidentId: inc.id, ttl: 8000 });
      cue('request');
    }
    return;
  }
  if (isPoint()) {
    if (prev && inc.status === 'resolved' && (inc.recur?.count ?? 0) >= RECUR_MIN && (prev.recur?.count ?? 0) < RECUR_MIN) {
      toast({ kind: 'p1', title: 'Решили, а жалобы снова идут', body: `${inc.title} · после решения ${inc.recur!.count} жалоб — вернуть в работу`, incidentId: inc.id, ttl: 20000 });
      cue('p1');
      announce(voiceLine('recur', inc, Date.now(), teamName), inc.id, `recur:${inc.id}`);
    } else if (!prev && inc.status === 'coordinators') {
      const p1 = inc.priority === 'P1';
      toast({ kind: p1 ? 'p1' : 'coord', title: inc.origin === 'complaints' ? 'ИИ собрал жалобы в инцидент' : 'Новый инцидент на пункте', body: inc.title, incidentId: inc.id, ttl: p1 ? 15000 : 7000 });
      cue(p1 ? 'p1' : 'coord');
      if (!p1) announce(voiceLine('coord', inc, Date.now(), teamName), inc.id, `coord:${inc.id}`); // критический объявляет тревога
    } else if (prev && !prev.p1Proposal && inc.p1Proposal) {
      toast({ kind: 'p1', title: 'ИИ предлагает «Наивысший»', body: inc.title, incidentId: inc.id, ttl: 15000 });
      cue('p1');
    } else if (prev && me.role === 'coordinator' && prev.coordinatorId !== me.personId && inc.coordinatorId === me.personId) {
      toast({ kind: 'coord', title: inc.history.some((h) => h.kind === 'ai' && h.at === inc.updatedAt) ? 'ИИ распределил вам инцидент' : 'Вам передали инцидент', body: inc.title, incidentId: inc.id, ttl: 9000 });
      cue('coord');
      announce(`вам передали «${inc.title}». ${inc.ai?.teamId ? `ИИ советует «${teamName(inc.ai.teamId)}». Передать?` : 'Что будем делать?'}`, inc.id, `mine:${inc.id}`);
    } else if (prev && prev.priority !== inc.priority && inc.priority < prev.priority) {
      toast({ kind: 'warn', title: `Уровень повышен: ${inc.priorityText}`, body: inc.title, incidentId: inc.id, ttl: 7000 });
    }
    return;
  }
  const mine = inc.teamId === me.teamId;
  if (mine && (!prev || prev.teamId !== inc.teamId) && inc.status === 'assigned') {
    toast({ kind: inc.priority === 'P1' ? 'p1' : 'coord', title: 'Пункт передал инцидент вашей команде', body: inc.title, incidentId: inc.id, ttl: 12000 });
    cue(inc.priority === 'P1' ? 'p1' : 'coord');
  } else if (prev && prev.assignee !== me.personId && inc.assignee === me.personId && inc.history.at(-1)?.actor !== me.name) {
    toast({ kind: 'coord', title: 'Вам назначен инцидент', body: inc.title, incidentId: inc.id, ttl: 10000 });
    cue('coord');
  }
}

function onSignal(prev: Signal | undefined, s: Signal) {
  const me = state.me;
  if (!me) return;
  if (isPoint() && !prev && s.status === 'open') {
    toast({ kind: 'warn', title: s.kind === 'help' ? 'Сотрудник просит помощи' : 'ИИ: инцидент застрял', body: s.text, incidentId: s.incidentId, ttl: 9000 });
    cue('warn');
  }
  if (me.role !== 'coordinator' && s.kind === 'timer' && s.teamId === me.teamId && !prev) {
    toast({ kind: 'warn', title: 'Напоминание: инцидент ждёт вашу команду', body: s.text, incidentId: s.incidentId, ttl: 12000 });
    cue('warn');
  }
  if (me.role === 'lead' && s.teamId === me.teamId && s.status === 'notified' && prev?.status !== 'notified') {
    toast({ kind: 'warn', title: 'Пункт обращает ваше внимание', body: s.text, incidentId: s.incidentId, ttl: 15000 });
    cue('warn');
  }
}

// ─── действия ──────────────────────────────────────────────────────────────

export function select(id: string | null) {
  setState({ selectedId: id });
  if (id) void loadRoute(id);
}

export async function loadRoute(id: string) {
  try {
    const r = await fetch(`/api/incidents/${id}/route`);
    if (!r.ok) return;
    const data = (await r.json()) as Omit<RouteInfo, 'at'>;
    const routes = new Map(state.routes);
    routes.set(id, { ...data, at: Date.now() });
    setState({ routes });
  } catch {
    /* сеть */
  }
}

async function post<T = unknown>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    toast({ kind: 'info', title: 'Не получилось', body: data.error ?? `Ошибка ${r.status}`, ttl: 5000 });
    throw new Error(data.error);
  }
  return data as T;
}
const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);

export const takeAtPoint = (incidentId: string) => quiet(post('/api/point/assign', { incidentId }));
export const assignCoordinator = (incidentId: string, personId: string) => quiet(post('/api/point/assign', { incidentId, personId }));
export async function fetchPointPlan() {
  const r = await fetch('/api/point/plan');
  return r.ok ? ((await r.json()) as { incidentId: string; personId: string; why: string }[]) : [];
}
export async function applyPointPlan(items: { incidentId: string; personId: string; why: string }[]) {
  const r = await post<{ assigned: number }>('/api/point/plan', { items });
  toast({ kind: 'info', title: 'Распределено', body: `Дежурным передано: ${r.assigned}`, ttl: 4000 });
}
export async function routeTo(id: string, teamId: string) {
  await post(`/api/incidents/${id}/route`, { teamId });
  void loadRoute(id);
}
export const setLevel = (id: string, priority: Priority, reason: string) => quiet(post(`/api/incidents/${id}/level`, { priority, reason }));
export const answerP1 = (id: string, confirm: boolean) => quiet(post(`/api/incidents/${id}/p1`, { confirm }));
export const resolveAtPoint = (id: string) => quiet(post(`/api/incidents/${id}/resolve`));
export const createFromCluster = (key: string) => quiet(post(`/api/clusters/${encodeURIComponent(key)}/create`));
export const notifyLead = (signalId: string) => quiet(post(`/api/signals/${signalId}/notify`));
export const closeSignal = (signalId: string) => quiet(post(`/api/signals/${signalId}/close`));
export const answerRequest = (id: string, approve: boolean, teamId?: string, comment?: string) => quiet(post(`/api/requests/${id}`, { approve, teamId, comment }));

export const teamTake = (incidentId: string) => quiet(post('/api/team/take', { incidentId }));
export const teamAssign = (incidentId: string, personId: string) => quiet(post('/api/team/assign', { incidentId, personId }));
export const teamResolve = (incidentId: string, solution: string) => quiet(post('/api/team/resolve', { incidentId, solution }));
export const teamRelease = (incidentId: string) => quiet(post('/api/team/release', { incidentId }));
export async function teamTransfer(incidentId: string, toTeamId: string | null, reason: string) {
  await post('/api/team/transfer', { incidentId, toTeamId, reason });
  toast({ kind: 'info', title: 'Запрос отправлен в пункт', body: 'Дежурный проверит и передаст', ttl: 4000 });
}
export async function teamHelp(incidentId: string, text: string) {
  await post('/api/team/help', { incidentId, text });
  toast({ kind: 'info', title: 'Пункт видит ваш сигнал', body: text, ttl: 4000 });
}
export async function teamReport(toTeamId: string, text: string) {
  await post('/api/team/report', { toTeamId, text });
  toast({ kind: 'info', title: 'Сообщение отправлено в пункт', body: text, ttl: 4000 });
}
export const setAway = (away: boolean) => quiet(post('/api/me/away', { away }));
export const sendComment = (id: string, text: string) => quiet(post(`/api/incidents/${id}/comment`, { text }));

export async function fetchTeam(id: string): Promise<{ team: Team; members: Person[] } | null> {
  const r = await fetch(`/api/teams/${id}`);
  return r.ok ? r.json() : null;
}
export async function fetchComplaints(id: string): Promise<Complaint[]> {
  const r = await fetch(`/api/incidents/${id}/complaints`);
  return r.ok ? r.json() : [];
}

export const demoOutage = (service: string, regionIds: string[], minutes = 6, perSec = 0.6) => {
  unlockAudio();
  quiet(post('/api/demo/outage', { service, regionIds, minutes, perSec }));
};
export const demoAuto = (on: boolean) => quiet(post('/api/demo/auto', { on }));

export function toggleSound() {
  unlockAudio();
  const sound = !state.sound;
  writePref('radar.sound2', sound);
  setState({ sound });
  if (sound) play('coord');
}
export function toggleTheme() {
  setSkin(state.theme === 'dark' ? 'light' : 'dark');
}

// ─── настройки: тема экрана, звук, анимации ─────────────────────────────────

export function setSkin(id: string) {
  const t = themeById(id);
  writePref('radar.skin', t.id);
  setState({ skin: t.id, theme: t.base });
}
export function setSoundPack(pack: SoundPack) {
  unlockAudio();
  writePref('radar.soundPack', pack);
  configureSound({ pack });
  setState({ soundPack: pack, sound: true });
  writePref('radar.sound2', true);
  play('coord', pack);
}
export function setVolume(volume: number) {
  writePref('radar.volume', volume);
  configureSound({ volume });
  setState({ volume });
}
export function setSoundEvent(cue: Cue, on: boolean) {
  const soundEvents = { ...state.soundEvents, [cue]: on };
  writePref('radar.soundEvents', soundEvents);
  configureSound({ events: soundEvents });
  setState({ soundEvents });
}
export function previewCue(cue: Cue) {
  unlockAudio();
  setTimeout(() => play(cue, state.soundPack), 30);
}
export function setMotion(motion: boolean) {
  writePref('radar.motion', motion);
  setState({ motion });
}
export const setSettings = (settings: boolean) => setState({ settings });
export function setPointTab(pointTab: PointTab) {
  setState({ pointTab });
}
export function setView(view: State['view']) {
  setState({ view });
}
export function setTab(tab: string) {
  setState({ tab });
  writePref(`radar.tab.${state.me?.role ?? ''}`, tab);
}
/** Открыть инцидент: переходим на вкладку, где с ним работают. */
/** Ссылка «открыть в ITSM»: адрес из ITSM_URL на сервере или встроенная ITSM-карточка (демо). */
export const itsmLink = (id: string) => (state.config?.itsmUrl ?? '/itsm/{id}').replace('{id}', encodeURIComponent(id));

/** Избранное смены: закрепить инцидент с заметкой и напоминанием (видно всем дежурным). */
export const pinIncident = (id: string, note: string, remindMin: number | null) => post(`/api/incidents/${encodeURIComponent(id)}/pin`, { note, remindMin }).catch(() => undefined);
export const unpinIncident = (id: string) => post(`/api/incidents/${encodeURIComponent(id)}/unpin`).catch(() => undefined);
/** Решили, а жалобы снова идут — вернуть в работу той же команде. */
export const reopenIncident = (id: string) => quiet(post(`/api/incidents/${encodeURIComponent(id)}/reopen`));
/** Демо: команда закрывает инцидент из жалоб, а жалобы продолжаются. */
export const demoRecur = () => post('/api/demo/scenario', { step: 'recur' });
/** Дежурный посмотрел инцидент — «Не забыть» перестаёт его подсовывать. */
export const markSeen = (id: string) => {
  if (state.me?.role === 'coordinator') void post(`/api/incidents/${encodeURIComponent(id)}/seen`).catch(() => undefined);
};

export function openIncident(id: string) {
  markSeen(id);
  const inc = state.incidents.get(id);
  const role = state.me?.role;
  if (inc && role === 'coordinator' && state.tab === 'desk') {
    // На «Моём столе» не уходим со стола: инцидент откроется в блоке карточки.
  } else if (inc && role === 'coordinator') setTab(inc.status === 'resolved' ? 'done' : inc.status === 'coordinators' ? 'inbox' : 'teams'); else if (inc) setTab('work');
  select(id);
}
export const savedTab = (role: string) => readPref<string>(`radar.tab.${role}`, '');

export function openTeamInDirectory(name: string) {
  setState({ dirQuery: name, palette: false });
  setTab(state.me?.role === 'coordinator' ? 'directory' : 'directory');
}
export const setPalette = (palette: boolean) => setState({ palette });
export const setReplay = (replayAt: number | null) => setState({ replayAt });
/** Назначить клавишу действию. Если клавиша уже занята — у прежнего действия она снимается. */
export function setHotkey(action: HotAction, code: string) {
  const hotkeys = { ...state.hotkeys };
  for (const k of Object.keys(hotkeys) as HotAction[]) if (hotkeys[k] === code) hotkeys[k] = '';
  hotkeys[action] = code;
  writePref('radar.hotkeys', hotkeys);
  setState({ hotkeys });
}
export function resetHotkeys() {
  writePref('radar.hotkeys', DEFAULT_HOTKEYS);
  setState({ hotkeys: { ...DEFAULT_HOTKEYS } });
}
export function setAlarmOn(alarmOn: boolean) {
  writePref('radar.alarmOn', alarmOn);
  setState({ alarmOn });
}
export function setHotkeysOn(hotkeysOn: boolean) {
  writePref('radar.hotkeysOn', hotkeysOn);
  setState({ hotkeysOn });
}

// ─── почта ───
export async function loadMail() {
  try {
    const r = await fetch('/api/mail');
    if (r.ok) setState({ mail: ((await r.json()) as { items: MailItem[] }).items });
  } catch {
    /* позже придёт потоком */
  }
}
export const mailRead = (id: string) => quiet(post(`/api/mail/${encodeURIComponent(id)}/read`));
export const mailToIncident = (id: string) => post<Incident>(`/api/mail/${encodeURIComponent(id)}/incident`);
export const mailUpload = (raw: string) => post<MailItem>('/api/mail/upload', { raw });
