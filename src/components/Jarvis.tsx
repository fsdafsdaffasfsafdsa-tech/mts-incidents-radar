// «Джарвис» — голосовой ИИ-помощник дежурного. Две независимые функции, обе включаются в настройках:
//   «Джарвис управляет экраном» — слушает всегда («Джарвис, …»), открывает вкладки и инциденты, объясняет ситуацию,
//      подсказывает, кому дать, и по команде выдаёт. Пока включено — Джарвиса не выключить (только в настройках).
//   «Голос Джарвиса» — отвечает вслух живым голосом (говорящие модели OpenRouter, ключ на сервере), объявляет критические.
// Разговор помнит, о каком инциденте речь: «объясни», «кому дать?», «выдай» — без номеров.
import { useEffect, useRef, useState } from 'react';
import './jarvis-pause.css';
import { getState, openIncident, openTeamInDirectory, readLocal, setReplay, setSettings, setSkin, setTab, useStore, writeLocal } from '../store';
import type { DashOp } from '../../shared/dash';
import { PERSONAS, personaById } from '../../shared/personas';
import { applyDashOp, closeWork, dashSummary, getDash, isWorkOpen, openWork, useDash, useWorkOpen, wallWindowOpen } from '../lib/dashLayout';
import { claimJarvis, isJarvisLeader, onJarvisLeader, useJarvisLeader } from '../lib/jarvisLeader';
import { denoise, denoiseOff, preloadRnnoise, type Denoise } from '../lib/denoise';
import { ghostStep } from './ghost';
import { ACK_RE, RESUME_RE, SLEEP_RE, afterWake as afterWakeIn, bargeIn, forMeWithoutName, isEcho as isEchoOf, looksForMe, lowRu, sameRequest, wakeRe } from '../../shared/hearing';

type Phase = 'idle' | 'listen' | 'think' | 'speak';
type Line = { role: 'user' | 'assistant'; content: string; llm?: boolean; done?: string[]; event?: boolean };
export type Step = { id: string; text: string; state: 'run' | 'done' | 'fail'; note?: string; tool?: string; target?: string | null };
type Action =
  | { type: 'open'; id: string }
  | { type: 'tab'; tab: string }
  | { type: 'replay'; on: boolean }
  | { type: 'settings'; open: boolean }
  | { type: 'theme'; id: string }
  | { type: 'team'; name: string }
  | { type: 'show'; what: string }
  | { type: 'mail'; id: string }
  | { type: 'report' }
  | { type: 'dash'; cmd: DashOp }
  | { type: 'design'; prompt: string }
  | { type: 'block'; prompt: string; character: boolean };
interface Status {
  llm: boolean;
  tts: boolean;
  model: string;
  voices: string[];
}

// ─── настройки (в браузере, у каждого дежурного свои) ──────────────────────
export const JARVIS_VOICES: { id: string; name: string }[] = [
  { id: 'mm-guy', name: 'Русский мужской — живой (MiniMax)' },
  { id: 'mm-reliable', name: 'Русский мужской — спокойный диктор (MiniMax)' },
  { id: 'grok-rex', name: 'Рекс — энергичный (Grok)' },
  { id: 'gm-charon', name: 'Харон — выразительный, «как Джарвис» (Gemini, отвечает дольше)' },
  { id: 'gm-puck', name: 'Пак — бодрый (Gemini, отвечает дольше)' },
  { id: 'el-brian', name: 'Брайан — тёплый, глубокий (ElevenLabs)' },
  { id: 'el-adam', name: 'Адам — прежний голос (ElevenLabs)' },
  { id: 'el-matilda', name: 'Матильда — женский (ElevenLabs)' },
];
export const jarvisPrefs = {
  control: readLocal<boolean>('radar.jarvis.control', true), // управляет экраном, слушает всегда (по умолчанию — да: всё голосом)
  speak: readLocal<boolean>('radar.jarvis.speak', true), // голос Джарвиса
  announce: readLocal<boolean>('radar.jarvis.announce', true), // объявлять критические голосом
  voice: readLocal<string>('radar.jarvis.voice2', 'mm-guy'), // новый набор голосов: прежний «Адам» не прижился
  persona: readLocal<string>('radar.jarvis.persona', 'jarvis'), // персонаж: имя, характер, голос, картинка
  work: readLocal<boolean>('radar.jarvis.work', true), // показывать, что он делает на сайте прямо сейчас
  scenario: false, // идёт сценарий для жюри: Джарвис действует и говорит, микрофон молчит (не сохраняется)
};
/** Сценарий для жюри включает режим «сценарий» (не сохраняется в настройках). */
export function setScenarioMode(on: boolean) {
  jarvisPrefs.scenario = on;
  listeners.forEach((f) => f());
}
const listeners = new Set<() => void>();
export function setJarvisPref<K extends keyof typeof jarvisPrefs>(k: K, v: (typeof jarvisPrefs)[K]) {
  jarvisPrefs[k] = v;
  writeLocal(`radar.jarvis.${k === 'voice' ? 'voice2' : k}`, v);
  listeners.forEach((f) => f());
}
/** Подписка на изменения настроек Джарвиса (для сохранения в учётной записи). */
export function subscribeJarvisPrefs(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
function usePrefs() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  return jarvisPrefs;
}

let statusP: Promise<Status | null> | null = null;
export const jarvisStatus = () =>
  (statusP ??= fetch('/api/jarvis/status')
    .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
    .catch(() => null));

// ─── голос ─────────────────────────────────────────────────────────────────
// Голос Джарвиса не зависит от общего выключателя звука сигналов — у него своя настройка.
let audio: HTMLAudioElement | null = null;
let actx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let onPhase: (p: Phase) => void = () => undefined;
let onVoiceNote: (s: string) => void = () => undefined;
let speaking = 0;
/** Фраза, которую браузер не дал сказать до первого щелчка, — скажем её сразу после. */
let blockedLine: string | null = null;
function setAudioBlocked(on: boolean) {
  if (jarvisLive.muted === on) return;
  jarvisLive.muted = on;
  liveSubs.forEach((f) => f());
}
let speakingText = ''; // что говорит прямо сейчас
let talking = false; // говорит прямо сейчас

/** Браузер даёт звук только после действия человека — «будим» звук при первом клике или клавише. */
export function unlockJarvisAudio() {
  try {
    actx ??= new AudioContext();
    if (actx.state === 'suspended') void actx.resume();
  } catch {
    actx = null;
  }
}
if (typeof window !== 'undefined') {
  const once = () => {
    unlockJarvisAudio();
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
    // Браузер не дал говорить до первого щелчка — договариваем то, что хотели сказать, а не теряем.
    const t = blockedLine;
    blockedLine = null;
    setAudioBlocked(false);
    if (t) setTimeout(() => void say(t), 120);
  };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}

export function stopVoice() {
  speaking++;
  talking = false;
  audio?.pause();
  audio = null;
  analyser = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function browserVoice(text: string, id: number) {
  return new Promise<void>((done) => {
    if (!('speechSynthesis' in window) || id !== speaking) return done();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    const ru = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('ru'));
    u.voice = ru.find((v) => /male|дмитрий|pavel|павел|online/i.test(v.name)) ?? ru[0] ?? null;
    u.rate = 1.05;
    u.pitch = 0.85;
    // Голос браузера иногда не присылает «конец» — страхуемся таймером.
    const guard = setTimeout(() => (speechSynthesis.cancel(), done()), Math.max(10_000, text.length * 120));
    u.onend = u.onerror = () => (clearTimeout(guard), done());
    speechSynthesis.speak(u);
  });
}

/** Сказать вслух голосом выбранной говорящей модели с сервера; если его нет — голосом браузера. Ждёт, пока договорит. */
export async function say(text: string, opt: { voice?: string; asJarvis?: boolean } = {}) {
  stopVoice();
  const id = speaking;
  const t = text.replace(/[«»"*_#]/g, '').trim();
  if (!t) return;
  const asJarvis = opt.asJarvis !== false;
  const phase = (p: Phase) => asJarvis && onPhase(p);
  speakingText = t;
  talking = true;
  try {
    await sayNow(t, id, opt, asJarvis, phase);
  } finally {
    if (id === speaking) talking = false;
  }
}
async function sayNow(t: string, id: number, opt: { voice?: string; asJarvis?: boolean }, asJarvis: boolean, phase: (p: Phase) => void) {
  window.dispatchEvent(new Event('radar:siren-stop')); // сирена не перекрикивает Джарвиса
  phase('speak');
  try {
    const st = await jarvisStatus();
    if (st?.tts) {
      const r = await fetch('/api/jarvis/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, voice: opt.voice ?? jarvisPrefs.voice }), signal: AbortSignal.timeout(15_000) });
      if (id !== speaking) return;
      if (r.status === 200) {
        const url = URL.createObjectURL(await r.blob());
        const a = new Audio(url);
        audio = a;
        // Пульс шара под голос — только если звук уже «разбужен», иначе играем напрямую.
        if (actx?.state === 'running') {
          try {
            analyser = actx.createAnalyser();
            analyser.fftSize = 256;
            actx.createMediaElementSource(a).connect(analyser).connect(actx.destination);
          } catch {
            analyser = null;
          }
        }
        const played = await new Promise<boolean>((done) => {
          // Страховка: если браузер не сообщил о конце звука, не «зависаем» в режиме «говорю» (и не глохнем).
          const guard = setTimeout(() => (a.pause(), done(true)), Math.max(12_000, t.length * 110));
          a.onended = () => (clearTimeout(guard), done(true));
          a.onerror = () => (clearTimeout(guard), done(false));
          a.play().catch(() => (clearTimeout(guard), done(false)));
        });
        URL.revokeObjectURL(url);
        analyser = null;
        if (played) {
          const used = r.headers.get('X-Jarvis-Voice');
          const name = JARVIS_VOICES.find((x) => x.id === used)?.name.split(' (')[0];
          if (asJarvis) onVoiceNote(used && used !== jarvisPrefs.voice && name ? `Выбранный голос сейчас недоступен — говорю голосом «${name}».` : '');
          if (id === speaking) phase('idle');
          return;
        }
        // Звук запрещён до первого щелчка (правило Chrome; у установленного приложения его нет) — запоминаем фразу
        // и скажем её сразу после любого щелчка; голос браузера тоже заблокирован, его не пробуем.
        if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === false) {
          blockedLine = t;
          setAudioBlocked(true);
          if (id === speaking) phase('idle');
          return;
        }
        onVoiceNote('Браузер не дал включить звук — нажмите на шар Джарвиса один раз.');
      } else onVoiceNote('Живой голос сейчас недоступен — говорю голосом браузера.');
    }
  } catch {
    onVoiceNote('Живой голос сейчас недоступен — говорю голосом браузера.');
  }
  if (id !== speaking) return;
  await browserVoice(t, id);
  if (id === speaking) phase('idle');
}

// Мост к окну Джарвиса: объявления о критических попадают в разговор и становятся его темой.
let bridge: { announce: (text: string, id: string, urgent?: boolean) => Promise<void>; ask: (text: string, quiet?: boolean) => Promise<string>; speak: (text: string, id: string) => Promise<void> } | null = null;
/** Джарвис говорит готовый текст об инциденте (строка в разговоре, тема — этот инцидент) и ждёт, пока договорит. */
export const jarvisSpeak = (text: string, id: string) => bridge?.speak(text, id) ?? say(text);

/** Задать Джарвису вопрос из интерфейса (кнопки, сценарий для жюри). Ждёт, пока он ответит и договорит. */
export const jarvisAsk = (text: string, opts: { quiet?: boolean } = {}) => bridge?.ask(text, opts.quiet) ?? Promise.resolve('');
/** Джарвис на этом экране есть (шар смонтирован) — можно задавать вопросы. */
export const jarvisReady = () => !!bridge;

// ─── объявления: всё, что происходит, говорит Джарвис — по одному: следующую проблему — только когда
// с текущей разобрались (дежурный ответил Джарвису, подтвердил, инцидент сдвинулся) или прошло 2 минуты ───
const annQueue: { text: string; id: string; key: string; st: string | null; at: number; urgent?: boolean }[] = [];
/** Сейчас звучит срочное объявление на весь экран — его договаривают до конца, перебить нельзя. */
let uninterruptible = false;
const ANN_WAIT = 120_000; // дольше не держим очередь — говорим следующее
const ANN_STALE = 10 * 60_000; // объявление старше — уже не актуально
let annAck = 0; // когда дежурный последний раз подтвердил (Esc, «принял», действие)
window.addEventListener('radar:ack', () => (annAck = Date.now()));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') annAck = Date.now();
});
const statusOf = (id: string) => (id ? getState().incidents.get(id)?.status ?? null : null);
const annRecent = new Map<string, number>();
let annRunning = false;
// Объявляет только ведущее окно (lib/jarvisLeader): пункт открыт в двух окнах — слышно один раз.
const canAnnounce = () => getState().me?.role === 'coordinator' && jarvisPrefs.speak && jarvisPrefs.announce && !jarvisPause.sleep && isJarvisLeader();
// Окно перестало быть ведущим — замолкаем и забываем очередь: её скажет ведущее окно.
onJarvisLeader(() => {
  if (isJarvisLeader()) return;
  annQueue.length = 0;
  stopVoice();
});
/** «Сэр, …» — обращение выбранного персонажа (у Ники — без обращения). */
function withAddress(text: string) {
  const t = text.replace(/^(Внимание[.!]\s*)?(Сэр,\s*)?/i, '').trim();
  const addr = personaById(jarvisPrefs.persona).address;
  return addr ? `${addr[0].toUpperCase()}${addr.slice(1)}, ${t[0].toLowerCase()}${t.slice(1)}` : `${t[0].toUpperCase()}${t.slice(1)}`;
}
/** Поставить объявление в очередь. key — что это за событие: одно и то же не повторяем 45 секунд. */
function enqueueAnnounce(text: string, id: string, key = `inc:${id}`, urgent = false) {
  if (!canAnnounce()) return;
  const now = Date.now();
  if ((annRecent.get(key) ?? 0) > now - 45_000 || annQueue.some((x) => x.key === key)) return;
  // Один инцидент — одно объявление за полторы минуты: он может попасть в два блока сразу (например, «не берут» и
  // «срок горит»), а Джарвис не должен рассказывать про него дважды.
  if (id && ((annRecent.get(`id:${id}`) ?? 0) > now - 90_000 || annQueue.some((x) => x.id === id))) return;
  annRecent.set(key, now);
  if (id) annRecent.set(`id:${id}`, now);
  annQueue.push({ text: withAddress(text), id, key, st: statusOf(id), at: now, urgent });
  void runAnnounce();
}
// ─── что Джарвис объявил сам — для блока Джарвиса на стене (лента разговора) ───
export const jarvisSaid: { text: string; at: number; id: string }[] = [];
const saidSubs = new Set<() => void>();
function logSaid(text: string, id: string) {
  jarvisSaid.unshift({ text, at: Date.now(), id });
  if (jarvisSaid.length > 6) jarvisSaid.length = 6;
  saidSubs.forEach((f) => f());
}
export function useJarvisSaid() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    saidSubs.add(f);
    return () => void saidSubs.delete(f);
  }, []);
  return jarvisSaid;
}
/** Объявление ещё актуально: не устарело и инцидент не сдвинулся с тех пор (иначе с ним уже разобрались). */
const annFresh = (a: (typeof annQueue)[number]) => Date.now() - a.at < ANN_STALE && (!a.id || (getState().incidents.has(a.id) && statusOf(a.id) === a.st));
/** Ждём, пока с объявленным разберутся: дежурный поговорил с Джарвисом и тот закончил, подтвердил, инцидент сдвинулся. */
async function waitHandled(a: (typeof annQueue)[number], spokeAt: number) {
  while (Date.now() - spokeAt < ANN_WAIT && annQueue.length && canAnnounce()) {
    if (jarvisWork.at > spokeAt && !jarvisWork.busy) return;
    if (annAck > spokeAt) return;
    if (a.id && statusOf(a.id) !== a.st) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function runAnnounce() {
  if (annRunning) return;
  annRunning = true;
  try {
    while (annQueue.length) {
      const a = annQueue.shift()!;
      if (!canAnnounce() || !annFresh(a)) continue;
      logSaid(a.text, a.id);
      if (bridge) await bridge.announce(a.text, a.id, a.urgent);
      else await say(a.text);
      await waitHandled(a, Date.now()); // следующую проблему — только после этой
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    annRunning = false;
  }
}
// Объявления из других частей (рабочее место): window.dispatchEvent(new CustomEvent('radar:announce', { detail: { text, id, key } })).
window.addEventListener('radar:announce', (e) => {
  const d = (e as CustomEvent<{ text: string; id: string; key?: string }>).detail;
  if (!d?.text || !d.id) return;
  // На стене события объявляет сама стена (dash/attention) — второй голос про то же не нужен.
  // И ждём, пока серия изменений закончится: инцидент «на распределении» мог через миг уйти команде.
  setTimeout(() => {
    if (onDashboard() || getState().tab === 'wall') return;
    if (d.key?.startsWith('coord:') && statusOf(d.id) !== 'coordinators') return;
    enqueueAnnounce(d.text, d.id, d.key);
  }, 600);
});

/** Объявить критический инцидент голосом: что случилось, где и что советует ИИ. */
export function announceIncident(id: string, fallback: string, key = `crit:${id}`) {
  if (!canAnnounce()) return;
  void (async () => {
    let text = fallback;
    try {
      const r = await fetch(`/api/jarvis/brief/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) text = ((await r.json()) as { text: string }).text;
    } catch {
      /* по шаблону с клиента */
    }
    enqueueAnnounce(text, id, key);
  })();
}

/** Сказать готовый текст об инциденте (событие на стене, прогноз) — если голос и объявления включены. */
export function announceText(text: string, id: string, key?: string, urgent = false) {
  enqueueAnnounce(text, id, key, urgent);
}

// ─── работа Джарвиса — для ИИ-блока на дашборде ────────────────────────────
/** Что Джарвис делает сейчас: вопрос, шаги, о каком инциденте речь, ответ. ИИ-блок стены показывает это у себя. */
export interface JarvisWork {
  q: string;
  steps: Step[];
  focusId: string | null;
  reply: string;
  done: string[];
  busy: boolean;
  at: number;
}
export const jarvisWork: JarvisWork = { q: '', steps: [], focusId: null, reply: '', done: [], busy: false, at: 0 };
const workSubs = new Set<() => void>();
function setWork(p: Partial<JarvisWork>) {
  Object.assign(jarvisWork, p, { at: Date.now() });
  workSubs.forEach((f) => f());
}
export function useJarvisWork() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    workSubs.add(f);
    return () => void workSubs.delete(f);
  }, []);
  return jarvisWork;
}
/** Джарвис работает или только что закончил — ИИ-блок показывает его работу. */
export const jarvisBusyRecently = (now = Date.now()) => jarvisWork.busy || (jarvisWork.at > 0 && now - jarvisWork.at < 25_000);
/** Дежурный на дашборде (не в рабочем месте). */
const onDashboard = () => !isWorkOpen() && !new URLSearchParams(location.search).has('wall');
/** На стене есть ИИ-блок (сам или в сменяемой панели) — работа Джарвиса показывается в нём. */
const aiBlockOnWall = () => getDash().items.some((i) => i.block === 'assistant' || i.block === 'rotate');
const workInBlock = () => onDashboard() && aiBlockOnWall();

// ─── живое состояние — для персонажа на стене ──────────────────────────────
/** Что Джарвис делает прямо сейчас: ждёт, слушает, думает, говорит. Персонаж в ИИ-блоке анимируется по нему. */
export const jarvisLive: { phase: Phase; hearing: boolean; heard: string; muted?: boolean; ignored?: { text: string; at: number } } = { phase: 'idle', hearing: false, heard: '' };
const liveSubs = new Set<() => void>();
export function useJarvisLive() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    liveSubs.add(f);
    return () => void liveSubs.delete(f);
  }, []);
  return jarvisLive;
}

// ─── пауза ─────────────────────────────────────────────────────────────────
/**
 * sleep — «всё, пока не надо»: не говорит и не отвечает, слушает только «продолжаем работу»;
 * mute — микрофон выключен кнопкой: не слышит ничего, пока не включат снова.
 */
export const jarvisPause = { sleep: false, mute: false };
const pauseSubs = new Set<() => void>();
function setPause(p: Partial<typeof jarvisPause>) {
  Object.assign(jarvisPause, p);
  pauseSubs.forEach((f) => f());
}
export function useJarvisPause() {
  return usePause();
}
function usePause() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    pauseSubs.add(f);
    return () => void pauseSubs.delete(f);
  }, []);
  return jarvisPause;
}
// Что из услышанного — ему, что — эхо, что — перебили: shared/hearing.ts (там же — почему и тесты на живых фразах).
/** Модель решила, что реплика не ей, — молчим. */
const NOT_FOR_ME = /^[\s—–-]*$/;

// ─── распознавание речи ────────────────────────────────────────────────────
type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
};
const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
const RecCtor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
export const canListen = !!RecCtor;

// Шумоподавление. Сам распознаватель браузера обработку звука не включает, но Chrome 135+ принимает в start()
// готовую дорожку микрофона — с шумоподавлением, эхоподавлением (голос Джарвиса из колонок вычитается, и он не
// перебивает сам себя) и выравниванием громкости. Дорожка держится открытой, пока он слушает: перезапуски
// распознавания не открывают микрофон заново. В других браузерах — как раньше, микрофон берёт распознаватель.
// Поверх — RNNoise и Silero VAD (src/lib/denoise.ts): чистка шума нейросетью и тишина вместо звука без речи.
const chromiumMajor = (() => {
  const b = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands;
  const v = b?.find((x) => /Chromium|Google Chrome|Microsoft Edge/.test(x.brand))?.version ?? /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1];
  return Number(v) || 0;
})();
const CLEAN_MIC = chromiumMajor >= 135 && !!navigator.mediaDevices?.getUserMedia;
const MIC_CONSTRAINTS: MediaTrackConstraints & Record<string, unknown> = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, voiceIsolation: true };

type EarState = 'off' | 'starting' | 'on' | 'error';
/**
 * Постоянный слух для режима «управляет экраном».
 * Браузер держит только одно распознавание за раз, поэтому новое запускаем лишь после того, как старое
 * действительно завершилось (onend), — иначе запуск молча падает и Джарвис «глохнет».
 * Сторож раз в 2 с поднимает слух, если браузер уронил его без onend или он завис без событий.
 */
class Ear {
  private rec: Rec | null = null;
  private running = false; // от start() до onend
  private want = false;
  private lastStart = 0;
  private lastEvent = 0;
  private abortAt = 0;
  private fails = 0;
  private started = false; // браузер прислал onstart
  // Микрофон не дали (вход на сайт без действия человека, микрофон занят, разрешение «на этот раз»): не сдаёмся,
  // а пробуем снова — сами через растущую паузу и сразу при любом щелчке, клавише, возврате на вкладку.
  private blockedUntil = 0;
  private blockFails = 0;
  // дорожка микрофона с шумо- и эхоподавлением (CLEAN_MIC); null — распознаватель берёт микрофон сам
  private stream: MediaStream | null = null;
  private asking = false;
  private clean = CLEAN_MIC;
  // RNNoise + Silero VAD поверх дорожки микрофона; распознаватель слушает её, как только браузер запустил звук
  private dn: Denoise | null = null;
  private recTrack: MediaStreamTrack | null = null;
  h: { result: (t: string, final: boolean) => void; state: (s: EarState, err?: string) => void } | null = null;

  /** Какую дорожку слушать: очищенную, если обработка идёт, иначе — дорожку браузера. */
  private pick(): MediaStreamTrack | null {
    const raw = this.stream?.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
    if (raw && this.dn?.ready() && this.dn.track.readyState === 'live') return this.dn.track;
    return raw;
  }

  /** Чистая дорожка микрофона: запросить один раз и держать, пока слушаем. */
  private async ensureTrack(): Promise<MediaStreamTrack | null> {
    if (!this.clean) return null;
    const live = this.stream?.getAudioTracks().find((t) => t.readyState === 'live');
    if (live) return live;
    if (this.asking) return null;
    this.asking = true;
    try {
      if (!denoiseOff()) void preloadRnnoise(); // RNNoise грузится, пока браузер открывает микрофон
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS as MediaTrackConstraints });
      const stream = this.stream;
      const dn = await denoise(stream).catch(() => null);
      if (this.stream !== stream || !this.want) dn?.close(); // пока собирали — отпустили микрофон
      else {
        this.dn = dn;
        // обработку запустили позже (первый щелчок) — переходим на чистую дорожку
        dn?.onReady(() => {
          if (this.dn === dn && this.rec && this.recTrack !== dn.track) this.abort();
        });
      }
      const t = stream.getAudioTracks()[0];
      // микрофон «онемел» (его забрала другая программа, сменили устройство) — берём заново
      t?.addEventListener('mute', () => {
        setTimeout(() => {
          if (t.muted && this.want) {
            this.release();
            if (this.rec) this.abort();
            this.retry();
          }
        }, 1500);
      });
      t?.addEventListener('ended', () => {
        this.stream = null;
        if (this.want) this.retry(); // микрофон сменили или отключили — берём заново
      });
      return t ?? null;
    } catch {
      this.clean = false; // не дали или не умеет — слушаем как раньше
      return null;
    } finally {
      this.asking = false;
    }
  }
  /** Отпустить микрофон (выключили, свернули вкладку, другое окно стало ведущим). */
  private release() {
    this.dn?.close();
    this.dn = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Попробовать снова прямо сейчас (действие человека, вкладка снова видна, микрофон разрешили). */
  retry() {
    if (!this.want) return;
    this.blockedUntil = 0;
    if (!this.running) this.kick();
    else if (!this.started) this.nudge(); // уже слышит — не трогаем
  }

  set(want: boolean) {
    this.want = want;
    if (want) this.kick();
    else {
      if (this.rec) this.abort();
      this.release();
    }
  }
  private abort() {
    this.abortAt = Date.now();
    try {
      this.rec?.abort();
    } catch {
      /* уже остановлен */
    }
  }
  private kick() {
    if (!this.want || this.running || !RecCtor) return;
    if (Date.now() < this.blockedUntil) return;
    const wait = 500 - (Date.now() - this.lastStart);
    if (wait > 0) {
      setTimeout(() => this.kick(), wait + 30);
      return;
    }
    // сначала — чистая дорожка микрофона (один раз), потом распознавание на ней
    if (this.clean && !this.stream?.getAudioTracks().some((t) => t.readyState === 'live')) {
      if (!this.asking) void this.ensureTrack().then(() => this.kick());
      return;
    }
    const track = this.pick();
    const r = new RecCtor();
    r.lang = 'ru-RU';
    r.continuous = true;
    r.interimResults = true;
    const touch = () => (this.lastEvent = Date.now());
    r.onstart = () => {
      touch();
      this.fails = 0;
      this.blockFails = 0;
      this.blockedUntil = 0;
      if (this.rec === r) {
        this.started = true;
        this.h?.state('on');
      }
    };
    r.onaudiostart = touch;
    r.onspeechstart = touch;
    r.onresult = (e) => {
      touch();
      if (this.rec !== r || !this.want) return;
      for (let k = e.resultIndex; k < e.results.length; k++) this.h?.result(e.results[k][0].transcript, e.results[k].isFinal);
    };
    r.onerror = (e) => {
      touch();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.blockFails++;
        this.blockedUntil = Date.now() + Math.min(20_000, 2500 * 2 ** (this.blockFails - 1));
        this.h?.state('error', e.error);
      } else if (e.error === 'network') this.fails++;
    };
    r.onend = () => {
      if (this.rec === r) {
        this.rec = null;
        this.running = false;
        this.abortAt = 0;
      }
      if (this.want) setTimeout(() => this.kick(), Math.max(Math.min(5000, 250 * 2 ** this.fails), this.blockedUntil - Date.now() + 30));
      else this.h?.state('off');
    };
    this.rec = r;
    this.recTrack = track;
    this.running = true;
    this.started = false;
    this.lastStart = this.lastEvent = Date.now();
    this.abortAt = 0;
    this.h?.state('starting');
    try {
      if (track) r.start(track);
      else r.start();
    } catch {
      if (track && track === this.dn?.track) {
        // очищенную дорожку браузер не принял — слушаем дорожку микрофона без нейросетей
        this.dn.close();
        this.dn = null;
      } else if (track) {
        // браузер не принял дорожку — слушаем как раньше, микрофон берёт распознаватель
        this.clean = false;
        this.release();
      }
      this.rec = null;
      this.running = false;
      setTimeout(() => this.kick(), track ? 50 : 1000);
    }
  }
  /** Сторож. */
  tick() {
    if (!this.want) return;
    if (!this.running) return this.kick();
    const now = Date.now();
    if (this.abortAt && now - this.abortAt > 2000) {
      // остановка не дошла до onend — считаем завершённым и запускаем заново
      this.rec = null;
      this.running = false;
      this.abortAt = 0;
      return this.kick();
    }
    if (!this.abortAt && !this.started && now - this.lastStart > 4000) return this.abort(); // запуск завис: onstart так и не пришёл
    // Завис без событий. Не чаще раза в минуту: каждый перезапуск заново открывает микрофон, а на Windows это
    // дёргает гарнитуры и другие аудиопрограммы. Тишину браузер закрывает сам — тогда просто запускаем снова.
    // С чистой дорожкой перезапуск распознавания не трогает микрофон — не ждём минуту, хватит 15 секунд.
    if (!this.abortAt && now - this.lastEvent > (this.stream ? 15_000 : 60_000)) this.abort();
  }
  /** Человек нажал на шар — «говорю, а ты не слышишь»: если давно не было звука, перезапускаем сразу. */
  nudge() {
    if (!this.want) return;
    if (!this.running) return this.kick();
    if (!this.abortAt && Date.now() - this.lastEvent > 3000) this.abort();
  }
}
const ear = new Ear();
// Зовут по имени персонажа или по-старому «Джарвис».
let wakeFor = '';
let wakeCache = /$^/;
function wake() {
  if (wakeFor !== jarvisPrefs.persona) {
    wakeFor = jarvisPrefs.persona;
    wakeCache = wakeRe([...personaById(jarvisPrefs.persona).wake, ...PERSONAS[0].wake]);
  }
  return wakeCache;
}
const WAKE = { test: (t: string) => wake().test(lowRu(t)) };
const afterWake = (t: string) => afterWakeIn(t, wake());
const FOLLOW_MS = 9000; // после ответа можно продолжать без слова «Джарвис»

const TABS = ['map', 'inbox', 'teams', 'done', 'reviews', 'requests', 'signals', 'shift', 'ai', 'wall', 'directory', 'desk'];

function flashEl(el: Element) {
  el.classList.remove('jv-flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('jv-flash');
  setTimeout(() => el.classList.remove('jv-flash'), 1600);
}
function flash(sel: string) {
  setTimeout(() => {
    const el = document.querySelector(sel);
    if (el) flashEl(el);
  }, 80);
}

// Что изменилось — туда и прокручиваем карточку (раздел может быть внизу, за краем экрана).
const SHOW: Record<string, string[]> = {
  top: ['[data-jv="top"]'],
  who: ['[data-jv="who"]'],
  route: ['[data-jv="route"]', '[data-jv="who"]'],
  level: ['[data-jv="level"]'],
  p1: ['[data-jv="p1"]', '[data-jv="level"]'],
  signal: ['[data-jv="signal"]', '[data-jv="who"]'],
  chat: ['[data-jv="chat"]'],
  decide: ['[data-jv="decide"]'],
};
const smooth = (): ScrollBehavior => (document.documentElement.dataset.motion === 'off' ? 'auto' : 'smooth');
/** Ждём, пока карточка отрисуется (до 2 с), прокручиваем к разделу и подсвечиваем его. */
function reveal(what: string) {
  const sels = SHOW[what] ?? [];
  const started = Date.now();
  const attempt = () => {
    for (const s of sels) {
      const el = document.querySelector(`.icard ${s}`) ?? document.querySelector(s);
      if (!el) continue;
      const step = el.closest('.step.closed');
      if (step) {
        (step.querySelector('.step-h') as HTMLElement | null)?.click();
        setTimeout(attempt, 120);
        return;
      }
      el.scrollIntoView({ behavior: smooth(), block: what === 'top' ? 'start' : 'center' });
      if (what === 'chat') {
        const list = el.querySelector('.chat-list');
        list?.scrollTo({ top: list.scrollHeight, behavior: smooth() });
      }
      flashEl(el);
      return;
    }
    if (Date.now() - started < 2000) setTimeout(attempt, 150);
  };
  setTimeout(attempt, 350);
}
/** Строка открытого инцидента в списке — тоже в поле зрения. */
function revealRow() {
  setTimeout(() => document.querySelector('.prow.sel, .trow.sel')?.scrollIntoView({ behavior: smooth(), block: 'nearest' }), 400);
}

function runActions(actions: Action[]) {
  // Прокручиваем только к последнему изменению — иначе экран дёргается между разделами.
  const lastShow = [...actions].reverse().find((a) => a.type === 'show');
  for (const a of actions) {
    if (a.type === 'show' && a !== lastShow) continue;
    switch (a.type) {
      case 'open':
        if (getState().incidents.has(a.id)) {
          setWork({ focusId: a.id });
          // На дашборде экран не перекидываем: инцидент показывается в ИИ-блоке (кнопка «В рабочем месте» — там же).
          if (!onDashboard()) {
            openIncident(a.id);
            revealRow();
          }
        }
        window.dispatchEvent(new CustomEvent('radar:jarvis-open', { detail: a.id }));
        break;
      case 'show':
        if (!onDashboard()) reveal(a.what);
        break;
      case 'mail':
        window.dispatchEvent(new CustomEvent('radar:mail-open', { detail: a.id }));
        break;
      case 'report':
        void import('../lib/shiftReport').then((m) => m.downloadShiftReport());
        break;
      case 'dash':
        // Стена в отдельном окне получит изменение сама; иначе возвращаемся на главный экран — дашборд.
        if (!new URLSearchParams(location.search).has('wall') && !wallWindowOpen() && isWorkOpen() && getState().tab !== 'wall') closeWork();
        setTimeout(() => applyDashOp(a.cmd), 60);
        break;
      case 'block':
        if (!new URLSearchParams(location.search).has('wall') && !wallWindowOpen() && isWorkOpen() && getState().tab !== 'wall') closeWork();
        void import('../lib/dashDesign').then((m) => m.makeBlockNow(a.prompt, a.character));
        break;
      case 'design':
        if (!new URLSearchParams(location.search).has('wall') && !wallWindowOpen() && isWorkOpen() && getState().tab !== 'wall') closeWork();
        void import('../lib/dashDesign').then((m) => m.designNow(a.prompt));
        break;
      case 'tab':
        // «Видеостена» — это главный экран; любая другая вкладка открывает рабочее место.
        if (a.tab === 'wall') {
          closeWork();
          break;
        }
        if (TABS.includes(a.tab)) {
          openWork();
          setTab(a.tab);
          flash(`.stab[data-tab="${a.tab}"]`);
        }
        break;
      case 'replay':
        if (a.on) setTimeout(() => window.dispatchEvent(new Event('radar:replay')), 350);
        else setReplay(null);
        break;
      case 'settings':
        setSettings(a.open);
        break;
      case 'theme':
        setSkin(a.id);
        break;
      case 'team':
        openWork();
        openTeamInDirectory(a.name);
        break;
    }
  }
}

// ─── шар и окно разговора ──────────────────────────────────────────────────
export function Jarvis() {
  const prefs = usePrefs();
  const pause = usePause();
  const speakEnd = useRef(0); // когда закончил говорить — хвост собственного голоса не принимаем за команду
  const bargeAt = useRef(0); // когда человек перебил его голосом
  const currentQ = useRef(''); // о чём он думает сейчас — повтор той же просьбы не выполняем второй раз
  const pending = useRef<string | null>(null); // попросили, пока думал, — выполним сразу после ответа
  const lastQ = useRef(0); // когда он последний раз спросил («Завести инцидент?») — ждём ответ
  // «Очистить» на пульте — новая смена: старый разговор и объявления забываем. Иначе Джарвис вспоминает инциденты,
  // которых уже нет («про Новосибирск: такого инцидента нет»), и путается в ответах на «да».
  const incCount = useStore((s) => s.incidents.size);
  const hadIncidents = useRef(false);
  useEffect(() => {
    if (incCount > 0) {
      hadIncidents.current = true;
      return;
    }
    if (!hadIncidents.current) return;
    hadIncidents.current = false;
    setLines([]);
    focus.current = null;
    pending.current = null;
    lastQ.current = 0;
    annQueue.length = 0;
    jarvisSaid.length = 0;
    setWork({ q: '', steps: [], reply: '', done: [], busy: false, focusId: null });
  }, [incCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [steps, setSteps] = useState<Step[]>([]); // «Работа Джарвиса»: что он делает прямо сейчас
  const [stepsAt, setStepsAt] = useState(0);
  const [heard, setHeard] = useState('');
  const [, setStatus] = useState<Status | null>(null);
  const [, setErr] = useState('');
  const [, setNote] = useState('');
  const [awaiting, setAwaiting] = useState(false); // ждёт продолжения без слова «Джарвис»
  const [micDenied, setMicDenied] = useState(false);
  const leader = useJarvisLeader(); // это окно — ведущее (говорит и слушает)
  const workOpen = useWorkOpen() && !new URLSearchParams(location.search).has('wall'); // рабочее место (не стена)
  useDash(); // перерисовка, когда блоки стены меняются (есть ли на ней блок Джарвиса)
  const [earState, setEarState] = useState<EarState>('off'); // что на самом деле с микрофоном
  const busy = useRef(false); // уже отвечает — новые фразы не берём
  const rec = useRef<Rec | null>(null);
  const orb = useRef<HTMLButtonElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<Line[]>([]);
  const focus = useRef<string | null>(null);
  const followUntil = useRef(0);
  const followTimer = useRef<number | null>(null);
  linesRef.current = lines;
  const control = prefs.control;

  useEffect(() => {
    onPhase = setPhase;
    onVoiceNote = setNote;
    void jarvisStatus().then(setStatus);
    return () => {
      onPhase = () => undefined;
      onVoiceNote = () => undefined;
    };
  }, []);

  /** Окно разговора открываем сами, только если на стене нет ИИ-блока: иначе всё видно в нём. */
  const openPanel = () => !workInBlock() && setOpen(true);
  // шаги — и в ИИ-блок
  useEffect(() => {
    if (steps.length) setWork({ steps });
  }, [steps]);

  /** Окно продолжения: несколько секунд после ответа Джарвис слушает без слова «Джарвис». */
  function follow(ms = FOLLOW_MS) {
    if (!jarvisPrefs.control) return;
    followUntil.current = Date.now() + ms;
    setAwaiting(true);
    if (followTimer.current) clearTimeout(followTimer.current);
    const check = () => {
      // Окно продлевается, пока человек говорит, — закрываем, только когда время действительно вышло.
      const left = followUntil.current - Date.now();
      if (left > 50) followTimer.current = window.setTimeout(check, left);
      else {
        setAwaiting(false);
        setHeard('');
      }
    };
    followTimer.current = window.setTimeout(check, ms);
  }

  // Объявления о критических: строка в разговоре, тема разговора — этот инцидент.
  useEffect(() => {
    bridge = {
      announce: async (t, id, urgent) => {
        // Не перебиваем текущий ответ: ждём, пока договорит и додумает (не дольше 30 секунд).
        for (let k = 0; k < 100 && (talking || busy.current); k++) await new Promise((r) => setTimeout(r, 300));
        focus.current = id;
        setWork({ focusId: id, q: '', steps: [], reply: t, done: [], busy: false });
        setLines((l) => [...l, { role: 'assistant', content: t, event: true }]);
        uninterruptible = !!urgent; // срочное на весь экран — договаривает до конца
        try {
          await say(t);
        } finally {
          uninterruptible = false;
        }
        speakEnd.current = Date.now();
        if (/\?\s*$/.test(t.trim())) lastQ.current = Date.now();
        // Спросил «что будем делать?» — ждём ответа: слушает всегда — окно без слова «Джарвис», иначе — слушаем один раз сами.
        if (jarvisPrefs.control) follow(15_000);
        else if (canListen && !jarvisPause.mute && !jarvisPause.sleep) listenOnceRef.current();
      },
      // quiet — спрашивают с видеостены: ответ виден в ИИ-помощнике, окно разговора не закрывает стену.
      ask: async (t, quiet) => {
        if (!quiet) openPanel();
        return askRef.current(t);
      },
      speak: async (t, id) => {
        focus.current = id;
        setLines((l) => [...l, { role: 'assistant', content: t, event: true }]);
        await say(t);
      },
    };
    return () => {
      bridge = null;
    };
  }, []);

  // «Пульс» шара: под громкость голоса, когда говорит; мягкое дыхание — когда слушает.
  useEffect(() => {
    let raf = 0;
    const buf = new Uint8Array(128);
    const tick = () => {
      let lvl = 0;
      if (analyser) {
        analyser.getByteFrequencyData(buf);
        lvl = buf.slice(2, 40).reduce((a, b) => a + b, 0) / (38 * 255);
      } else if (phase === 'speak') lvl = 0.25 + Math.abs(Math.sin(performance.now() / 140)) * 0.35;
      else if (phase === 'listen' || awaiting) lvl = 0.15 + Math.abs(Math.sin(performance.now() / 420)) * 0.2;
      orb.current?.style.setProperty('--lvl', lvl.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, awaiting]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [lines, heard]);

  async function ask(q: string): Promise<string> {
    const question = afterWake(q) || q.trim();
    if (!question || busy.current) return '';
    const nq = lowRu(question);
    // Написали или сказали на паузе — значит, снова нужен.
    if (jarvisPause.sleep && !SLEEP_RE.test(nq)) {
      if (RESUME_RE.test(nq) && nq.split(/\s+/).length <= 4) return resumeRef.current(), '';
      setPause({ sleep: false });
    }
    // «Всё, пока не надо» — пауза; «принял» о срочном — подтверждение. Это решается здесь, без сервера.
    if (SLEEP_RE.test(nq)) {
      setLines((l) => [...l, { role: 'user', content: question }, { role: 'assistant', content: 'Хорошо, не мешаю. Скажите «продолжаем работу», когда понадоблюсь.' }]);
      setAwaiting(false);
      followUntil.current = 0;
      if (jarvisPrefs.speak) await say('Хорошо, не мешаю. Скажите «продолжаем работу», когда понадоблюсь.');
      speakEnd.current = Date.now();
      setPause({ sleep: true });
      return '';
    }
    if (ACK_RE.test(nq) && focus.current) {
      window.dispatchEvent(new CustomEvent('radar:ack', { detail: focus.current }));
      setLines((l) => [...l, { role: 'user', content: question }, { role: 'assistant', content: 'Принято.' }]);
      if (jarvisPrefs.speak) await say('Принято.');
      speakEnd.current = Date.now();
      return 'Принято.';
    }
    // к нему точно обращаются: по имени, задачей или ответом на его вопрос — модель не должна промолчать «—»
    const addressed = WAKE.test(q) || forMeWithoutName(question) || Date.now() - lastQ.current < 60_000 || Date.now() - bargeAt.current < 10_000;
    busy.current = true;
    currentQ.current = question;
    lastQ.current = 0;
    setErr('');
    setHeard('');
    setAwaiting(false);
    followUntil.current = 0;
    const history = linesRef.current.slice(-8).map(({ role, content, done }) => ({ role, content: done?.length ? `${content} (Сделано: ${done.join('; ')})` : content }));
    setLines((l) => [...l, { role: 'user', content: question }]);
    setPhase('think');
    setWork({ q: question, steps: [], reply: '', done: [], busy: true, focusId: focus.current });
    try {
      const s = getState();
      const live = jarvisPrefs.work;
      if (live) {
        setSteps([{ id: 'hear', text: `Услышал: «${question.length > 60 ? `${question.slice(0, 58)}…` : question}»`, state: 'done' }]);
        setStepsAt(Date.now());
      }
      const r = await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: question, addressed, selectedId: s.selectedId, focusId: focus.current, tab: s.tab, mode: jarvisPrefs.control || jarvisPrefs.scenario ? 'control' : 'chat', short: jarvisPrefs.scenario, history, dash: dashSummary(), dashControl: getDash().jarvisEdit, persona: jarvisPrefs.persona, stream: live }),
        signal: AbortSignal.timeout(60_000), // не «зависает» навсегда: иначе он больше не слушает
      });
      type Reply = { reply: string; actions: Action[]; done: string[]; focus: string | null; llm: boolean; error?: string };
      let data: Reply;
      if (live && r.ok && r.body && (r.headers.get('Content-Type') ?? '').includes('event-stream')) {
        // Поток: шаги показываем сразу, действия выполняем сразу — экран меняется, пока он ещё думает.
        data = await readStream(r.body, (e) => {
          if (e.type === 'step') {
            // «Думаю» — пока идёт работа; «ответ готов» — в конце списка, после всех шагов.
            setSteps((list) => (e.id === 'think' && e.state !== 'run' ? [...list.filter((x) => x.id !== 'think'), e] : list.some((x) => x.id === e.id) ? list.map((x) => (x.id === e.id ? { ...x, ...e } : x)) : [...list, e]));
            // «работа видна» — курсор Джарвиса на экране: едет к строке, нажимает, печатает действие
            if (e.id !== 'think' && jarvisPrefs.work) ghostStep(e);
          } else if (e.type === 'actions') runActions(e.actions);
        });
        setSteps((list) => list.map((x) => (x.state === 'run' ? { ...x, state: 'done' } : x)));
        setStepsAt(Date.now());
      } else {
        data = (await r.json()) as Reply;
        if (!r.ok) throw new Error(data.error ?? 'нет ответа');
        runActions(data.actions ?? []);
      }
      if (NOT_FOR_ME.test(data.reply ?? '') && !data.done?.length) {
        // не ему: убираем услышанное из разговора и молчим
        setLines((l) => (l[l.length - 1]?.role === 'user' && l[l.length - 1].content === question ? l.slice(0, -1) : l));
        setSteps([]);
        setWork({ busy: false, reply: '', q: '' });
        setPhase('idle');
        return '';
      }
      if (data.focus) focus.current = data.focus;
      setWork({ busy: false, reply: data.reply, done: data.done ?? [], focusId: data.focus ?? jarvisWork.focusId ?? focus.current });
      setLines((l) => [...l, { role: 'assistant', content: data.reply, llm: data.llm, done: data.done }]);
      // Джарвис показывает изменение в карточке — сворачиваем окно, чтобы оно его не закрывало
      // (ответ виден подписью у шара; окно — по клику на шар).
      if (data.actions?.some((a) => a.type === 'show') && window.innerWidth < 2200) setOpen(false);
      if (jarvisPrefs.speak || jarvisPrefs.scenario) await say(data.reply);
      speakEnd.current = Date.now();
      if (/\?\s*$/.test(data.reply.trim())) lastQ.current = Date.now(); // спросил — минуту ждём ответ «да…» без имени
      // сделал что-то по инциденту из срочного — срочное на стене считаем принятым
      if (data.done?.length && focus.current) window.dispatchEvent(new CustomEvent('radar:ack', { detail: focus.current }));
      setPhase('idle');
      follow();
      return data.reply;
    } catch (e) {
      const msg = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'не дождался ответа — повторите' : e instanceof Error ? e.message : String(e);
      setErr(msg);
      setWork({ busy: false, reply: `Не получилось: ${msg}` });
      setPhase('idle');
      return '';
    } finally {
      busy.current = false;
      // пока думал, попросили другое — выполняем сразу, без «скажите ещё раз»
      const next = pending.current;
      pending.current = null;
      if (next) setTimeout(() => void askRef.current(next), 250);
    }
  }
  const askRef = useRef(ask);
  askRef.current = ask;

  function micError(e: string) {
    if (e === 'not-allowed' || e === 'service-not-allowed') {
      setMicDenied(true);
      setErr(window.isSecureContext ? 'Нет доступа к микрофону — разрешите его в адресной строке браузера.' : `Микрофон работает только по https — откройте https://${location.hostname}`);
    } else if (e !== 'no-speech' && e !== 'aborted' && e !== 'network') setErr(`Микрофон: ${e}`);
  }

  // Разовое прослушивание (когда Джарвис не управляет экраном): нажали — сказали — ответ.
  function listenOnce() {
    if (!RecCtor) {
      openPanel();
      setErr('Браузер не умеет распознавать речь — напишите вопрос (голос работает в Chrome и Edge).');
      return;
    }
    if (phase === 'listen') return rec.current?.stop();
    stopVoice();
    openPanel();
    setErr('');
    setHeard('');
    const r = new RecCtor();
    r.lang = 'ru-RU';
    r.interimResults = true;
    r.continuous = false;
    let final = '';
    r.onresult = (e) => {
      let interim = '';
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const res = e.results[k];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      setHeard(final + interim);
    };
    r.onerror = (e) => micError(e.error);
    r.onend = () => {
      rec.current = null;
      setHeard('');
      if (final.trim()) void askRef.current(final);
      else setPhase((p) => (p === 'listen' ? 'idle' : p));
    };
    rec.current = r;
    setPhase('listen');
    r.start();
  }

  /** Распознал собственную реплику (колонки → микрофон) — не команда. */
  function resume() {
    setPause({ sleep: false });
    openPanel();
    const t = 'Продолжаем. Слушаю.';
    setLines((l) => [...l, { role: 'assistant', content: t }]);
    if (jarvisPrefs.speak) void say(t).then(() => ((speakEnd.current = Date.now()), follow()));
    else follow();
  }
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  function toggleMute() {
    unlockJarvisAudio();
    const mute = !jarvisPause.mute;
    setPause(mute ? { mute: true } : { mute: false, sleep: false });
    if (!mute) {
      setErr('');
      follow();
    }
  }
  function stopTalking() {
    stopVoice();
    speakEnd.current = Date.now();
    setPhase('idle');
    follow();
  }
  const toggleMuteRef = useRef(toggleMute);
  toggleMuteRef.current = toggleMute;
  const stopTalkingRef = useRef(stopTalking);
  stopTalkingRef.current = stopTalking;
  // Кнопки персонажа на стене: микрофон, пауза, «стоп».
  useEffect(() => {
    const mute = () => toggleMuteRef.current();
    const pauseT = () => (jarvisPause.sleep ? resumeRef.current() : (setPause({ sleep: true }), stopVoice()));
    const stop = () => stopTalkingRef.current();
    const panel = () => setOpen(true); // сценарий: окно разговора — чтобы курсор напечатал в нём реплику
    window.addEventListener('radar:jarvis-mute', mute);
    window.addEventListener('radar:jarvis-pause', pauseT);
    window.addEventListener('radar:jarvis-stop', stop);
    window.addEventListener('radar:jarvis-panel', panel);
    return () => {
      window.removeEventListener('radar:jarvis-mute', mute);
      window.removeEventListener('radar:jarvis-pause', pauseT);
      window.removeEventListener('radar:jarvis-stop', stop);
      window.removeEventListener('radar:jarvis-panel', panel);
    };
  }, []);
  // Esc — замолчать.
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && phase === 'speak' && !uninterruptible && stopTalking();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const listenOnceRef = useRef(listenOnce);
  listenOnceRef.current = listenOnce;

  // Режим «управляет экраном»: слушаем всегда, пока Джарвис не думает и не говорит.
  // Фраза со словом «Джарвис» — команда; после ответа несколько секунд можно продолжать без него.
  function onHeard(t: string, final: boolean) {
    const low = lowRu(t);
    const now = Date.now();
    const recentSpoken = now - speakEnd.current < 8000 || phase === 'speak';
    // 1. Говорит, а человек заговорил — замолкает и слушает (shared/hearing: эхо и шум не обрывают).
    if (phase === 'speak') {
      if (uninterruptible) return; // срочное на весь экран договаривает — перебить нельзя
      const b = bargeIn(t, speakingText) ?? (WAKE.test(t) && !isEchoOf(t, speakingText) ? 'talk' : null);
      if (!b) return;
      stopVoice();
      setPhase('idle');
      bargeAt.current = now;
      speakEnd.current = 0; // это не хвост его голоса — фразу человека не отбрасываем
      if (b === 'stop') {
        setHeard('');
        follow();
        return;
      }
      if (final) return void askRef.current(afterWake(t) || t.trim());
      setHeard(afterWake(t));
      follow(8000);
      return;
    }
    // 2. Пауза — ждём «продолжаем работу» или обращение по имени («Джарвис, …» — сразу и выполняет).
    if (jarvisPause.sleep) {
      if (!final) return;
      if (WAKE.test(t)) {
        setPause({ sleep: false });
        const rest = afterWake(t);
        if (rest.length > 2 && !RESUME_RE.test(lowRu(rest))) return void askRef.current(rest);
        return resume();
      }
      if (RESUME_RE.test(low)) resume();
      return;
    }
    // 3. Его же голос из колонок — не команда (длинный кусок его реплики; ответ со словами из вопроса — не эхо).
    if (recentSpoken && isEchoOf(t, speakingText)) return;
    // 4. Думает — слух не выключаем: новую просьбу запомним и выполним сразу после ответа, повтор той же — пропустим.
    if (busy.current || phase === 'think') {
      if (!final) return;
      const said = afterWake(t) || t.trim();
      if (said.length < 2 || sameRequest(said, currentQ.current)) return;
      if (WAKE.test(t) || looksForMe(said) || forMeWithoutName(said)) {
        pending.current = said;
        setHeard(said);
      }
      return;
    }
    if (phase !== 'idle') return;
    // 5. Только что перебил его — дослушиваем и выполняем без слова «Джарвис».
    const barged = now - bargeAt.current < 10_000;
    const live = now < followUntil.current;
    const answering = now - lastQ.current < 60_000; // он задал вопрос — ответ «да, назначь» берём и через минуту
    if (!final) {
      if (live || barged || answering || WAKE.test(t) || forMeWithoutName(t)) {
        setHeard(afterWake(t));
        followUntil.current = Math.max(followUntil.current, now + 4000); // человек говорит — окно не закрываем
        setAwaiting(true);
      }
      return;
    }
    const said = t.trim();
    if (said.length < 2) return;
    if (WAKE.test(said)) {
      const rest = afterWake(said);
      if (rest.length > 2) return void askRef.current(rest);
      setHeard('');
      return follow(); // «Джарвис» — и пауза: ждём команду
    }
    // в разговоре — короткий ответ или просьба; вне разговора — просьба или вопрос о деле («что горит?»)
    if (barged || (live || answering ? looksForMe(said) : forMeWithoutName(said))) {
      bargeAt.current = 0;
      return void askRef.current(said);
    }
    setHeard(''); // говорят не ему — не отвечаем
    jarvisLive.ignored = { text: said, at: now }; // но в блоке видно: услышал, не понял, что это ему
    liveSubs.forEach((f) => f());
  }
  const onHeardRef = useRef(onHeard);
  onHeardRef.current = onHeard;
  useEffect(() => {
    ear.h = {
      result: (t, final) => onHeardRef.current(t, final),
      state: (s, e) => {
        setEarState(s);
        if (s === 'error' && e) micError(e);
        if (s === 'on') {
          // слух поднялся (в том числе после «нет микрофона») — убираем подсказку про микрофон
          setMicDenied((was) => {
            if (was) setErr('');
            return false;
          });
        }
      },
    };
    return () => {
      ear.h = null;
      ear.set(false);
    };
  }, []);
  // Вкладку свернули или ушли на другую — микрофон отпускаем: не мешаем другим аудиопрограммам. Вернулись — слушает.
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const f = () => setTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  useEffect(() => {
    // «Нет микрофона» не выключает слух: Ear сам пробует снова (см. retry) — иначе после входа на сайт его надо «протыкивать».
    // Слушает только ведущее окно: два окна с распознаванием мешают друг другу, и ни одно ничего не делает.
    ear.set(!!RecCtor && control && leader && tabVisible && !prefs.scenario && !pause.mute && (phase === 'idle' || phase === 'speak' || phase === 'think')); // и пока думает — слышит
  }, [control, leader, tabVisible, phase, prefs.scenario, pause.mute]);
  // Сторож: раз в 2 с поднимает слух, если браузер его уронил; любой щелчок, клавиша, возврат на вкладку или
  // выданное разрешение микрофона — пробуем сразу.
  useEffect(() => {
    if (!control) return;
    const t = window.setInterval(() => ear.tick(), 2000);
    const now = () => ear.retry();
    const vis = () => document.visibilityState === 'visible' && ear.retry();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('focus', now);
    window.addEventListener('pointerdown', now, true);
    window.addEventListener('keydown', now, true);
    let perm: PermissionStatus | null = null;
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => {
        perm = p;
        p.onchange = () => p.state === 'granted' && ear.retry();
      })
      .catch(() => undefined);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('focus', now);
      window.removeEventListener('pointerdown', now, true);
      window.removeEventListener('keydown', now, true);
      if (perm) perm.onchange = null;
    };
  }, [control]);

  // Нажали на шар или клавишу V.
  function press() {
    unlockJarvisAudio();
    claimJarvis(); // нажали здесь — Джарвис теперь в этом окне
    if (phase === 'speak') return uninterruptible ? undefined : stopTalking();
    if (jarvisPause.sleep || jarvisPause.mute) {
      setPause({ sleep: false, mute: false });
      setOpen(true);
      return follow();
    }
    setOpen(true);
    if (control) {
      if (micDenied || earState === 'error') {
        setMicDenied(false); // попробовать ещё раз после разрешения микрофона
        setErr('');
      }
      ear.nudge(); // если слух упал или завис — перезапускаем сразу
      follow(); // слушает и так — просто ждём команду без слова «Джарвис»
    } else listenOnce();
  }
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    const f = () => pressRef.current();
    // просьба текстом — как будто сказали голосом (проверки и запись демо без микрофона)
    const ask = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (typeof t === 'string' && t.trim()) void askRef.current(t.trim());
    };
    window.addEventListener('radar:jarvis', f);
    window.addEventListener('radar:jarvis-ask', ask);
    return () => {
      window.removeEventListener('radar:jarvis', f);
      window.removeEventListener('radar:jarvis-ask', ask);
    };
  }, []);

  // Подпись — по настоящему состоянию микрофона, а не по таймеру.
  const hearing = control ? earState === 'on' : phase === 'listen';
  useEffect(() => {
    jarvisLive.phase = phase;
    jarvisLive.hearing = hearing || awaiting;
    jarvisLive.heard = heard; // блок на стене показывает, что он сейчас слышит
    liveSubs.forEach((f) => f());
  }, [phase, hearing, awaiting, heard]);
  // Шара в углу и всплывающего окна нет совсем: Джарвис работает голосом, его состояние — в блоке Джарвиса на стене
  // (что он слышит, говорит и делает; курсор Джарвиса показывает действия). Раньше шар прятался только при одном
  // виде блока — и висел у тех, у кого стена собрана иначе, а его кнопка паузы мешала.
  void workOpen;
  void stepsAt;
  return null;
}

/** Раздел настроек: две независимые функции — «управляет экраном» и «голос». */
export function JarvisSettings() {
  const prefs = usePrefs();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => void jarvisStatus().then(setStatus), []);
  return (
    <section>
      <h3>
        Джарвис — голосовой помощник
        <span className={`jv-mode ${status?.llm ? 'on' : ''}`}>{status?.llm ? 'Claude + живой голос' : 'по правилам, голос браузера'}</span>
      </h3>

      <PersonaPicker />

      <div className={`jv-opt ${prefs.work ? 'on' : ''}`}>
        <label className="jv-switch">
          <input type="checkbox" checked={prefs.work} onChange={(e) => setJarvisPref('work', e.target.checked)} />
          <span className="jv-knob" />
          <b>Показывать работу Джарвиса</b>
        </label>
        <p className="muted">Пока он отвечает, у шара видно по шагам, что он делает на сайте: смотрит инцидент, открывает вкладку, передаёт команде, перестраивает стену. Изменения на экране появляются сразу, не дожидаясь ответа.</p>
      </div>

      <div className={`jv-opt ${prefs.control ? 'on' : ''}`}>
        <label className="jv-switch">
          <input type="checkbox" checked={prefs.control} onChange={(e) => setJarvisPref('control', e.target.checked)} />
          <span className="jv-knob" />
          <b>Джарвис управляет экраном</b>
        </label>
        <p className="muted">
          Слушает всегда: скажите «Джарвис, открой входящие и объясни ситуацию», «кому можно дать?», «выдай». Открывает вкладки и инциденты, подсказывает и по команде передаёт, поручает коллеге, поднимает уровень, пишет в переписку. Пока включено, Джарвиса не выключить — только здесь.
        </p>
        {!canListen && <p className="jv-warn">Этот браузер не распознаёт речь — работает в Chrome и Edge.</p>}
        {canListen && !window.isSecureContext && <p className="jv-warn">Микрофон работает только по https: https://{location.hostname}</p>}
      </div>

      <div className={`jv-opt ${prefs.speak ? 'on' : ''}`}>
        <label className="jv-switch">
          <input type="checkbox" checked={prefs.speak} onChange={(e) => setJarvisPref('speak', e.target.checked)} />
          <span className="jv-knob" />
          <b>Голос Джарвиса</b>
        </label>
        <p className="muted">Отвечает вслух: думает Claude, говорит живой голос — по умолчанию родной русский голос MiniMax, можно выбрать другой. Не зависит от звука сигналов.</p>
        <div className={`jv-set ${prefs.speak ? '' : 'off'}`}>
          <label>
            Голос
            <select value={prefs.voice} onChange={(e) => setJarvisPref('voice', e.target.value)} disabled={!status?.tts}>
              {JARVIS_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-sm"
            onClick={() => {
              unlockJarvisAudio();
              void say(personaById(prefs.persona).hello);
            }}
          >
            Прослушать
          </button>
        </div>
        <label className="chk">
          <input type="checkbox" checked={prefs.announce} disabled={!prefs.speak} onChange={(e) => setJarvisPref('announce', e.target.checked)} /> Объявлять критические инциденты: что случилось и что советует ИИ
        </label>
      </div>
    </section>
  );
}

/** Выбор персонажа ИИ: имя, характер, голос и картинка меняются вместе. */
export function PersonaPicker({ compact = false }: { compact?: boolean }) {
  const prefs = usePrefs();
  return (
    <div className={`persona-pick ${compact ? 'compact' : ''}`}>
      {PERSONAS.map((p) => (
        <button
          key={p.id}
          className={`persona ${prefs.persona === p.id ? 'on' : ''}`}
          style={{ ['--pc' as string]: p.color }}
          onClick={() => {
            setJarvisPref('persona', p.id);
            setJarvisPref('voice', p.voice);
            unlockJarvisAudio();
            if (jarvisPrefs.speak) void say(p.hello, { voice: p.voice });
          }}
          title={`${p.name}: ${p.title}`}
        >
          <img src={p.avatar} alt="" onError={(e) => ((e.currentTarget.style.visibility = 'hidden'))} />
          <b>{p.name}</b>
          {!compact && <small>{p.title}</small>}
        </button>
      ))}
    </div>
  );
}

type StreamEvent = { type: 'step'; id: string; text: string; state: 'run' | 'done' | 'fail'; note?: string } | { type: 'actions'; actions: Action[] } | ({ type: 'reply' } & { reply: string; actions: Action[]; done: string[]; focus: string | null; llm: boolean }) | { type: 'error'; error: string };
/** Читает поток событий ответа: шаги и действия — сразу, в конце — сам ответ. */
async function readStream(body: ReadableStream<Uint8Array>, on: (e: Exclude<StreamEvent, { type: 'reply' } | { type: 'error' }>) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let final: Extract<StreamEvent, { type: 'reply' }> | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 2);
      if (!chunk.startsWith('data:')) continue;
      const e = JSON.parse(chunk.slice(5)) as StreamEvent;
      if (e.type === 'reply') final = e;
      else if (e.type === 'error') throw new Error(e.error);
      else on(e);
    }
  }
  if (!final) throw new Error('ответ оборвался');
  return final;
}
