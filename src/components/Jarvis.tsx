// «Джарвис» — голосовой ИИ-помощник дежурного. Две независимые функции, обе включаются в настройках:
//   «Джарвис управляет экраном» — слушает всегда («Джарвис, …»), открывает вкладки и инциденты, объясняет ситуацию,
//      подсказывает, кому дать, и по команде выдаёт. Пока включено — Джарвиса не выключить (только в настройках).
//   «Голос Джарвиса» — отвечает вслух живым голосом (говорящие модели OpenRouter, ключ на сервере), объявляет критические.
// Разговор помнит, о каком инциденте речь: «объясни», «кому дать?», «выдай» — без номеров.
import { useEffect, useRef, useState } from 'react';
import { Activity, Check, Loader2, Lock, Mic, MicOff, Pause, Send, Square, Volume2, VolumeX, X } from 'lucide-react';
import './jarvis-pause.css';
import { getState, openIncident, openTeamInDirectory, readLocal, setReplay, setSettings, setSkin, setTab, writeLocal } from '../store';
import type { DashOp } from '../../shared/dash';
import { PERSONAS, inGender, personaById } from '../../shared/personas';
import { applyDashOp, closeWork, dashSummary, getDash, isWorkOpen, openWork, useDash, useWorkOpen, wallWindowOpen } from '../lib/dashLayout';
import { claimJarvis, isJarvisLeader, onJarvisLeader, useJarvisLeader } from '../lib/jarvisLeader';
import { ghostStep } from './ghost';

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
let bridge: { announce: (text: string, id: string) => Promise<void>; ask: (text: string, quiet?: boolean) => Promise<string>; speak: (text: string, id: string) => Promise<void> } | null = null;
/** Джарвис говорит готовый текст об инциденте (строка в разговоре, тема — этот инцидент) и ждёт, пока договорит. */
export const jarvisSpeak = (text: string, id: string) => bridge?.speak(text, id) ?? say(text);

/** Задать Джарвису вопрос из интерфейса (кнопки, сценарий для жюри). Ждёт, пока он ответит и договорит. */
export const jarvisAsk = (text: string, opts: { quiet?: boolean } = {}) => bridge?.ask(text, opts.quiet) ?? Promise.resolve('');
/** Джарвис на этом экране есть (шар смонтирован) — можно задавать вопросы. */
export const jarvisReady = () => !!bridge;

// ─── объявления: всё, что происходит, говорит Джарвис — по одному: следующую проблему — только когда
// с текущей разобрались (дежурный ответил Джарвису, подтвердил, инцидент сдвинулся) или прошло 2 минуты ───
const annQueue: { text: string; id: string; key: string; st: string | null; at: number }[] = [];
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
function enqueueAnnounce(text: string, id: string, key = `inc:${id}`) {
  if (!canAnnounce()) return;
  const now = Date.now();
  if ((annRecent.get(key) ?? 0) > now - 45_000 || annQueue.some((x) => x.key === key)) return;
  // Один инцидент — одно объявление за полторы минуты: он может попасть в два блока сразу (например, «не берут» и
  // «срок горит»), а Джарвис не должен рассказывать про него дважды.
  if (id && ((annRecent.get(`id:${id}`) ?? 0) > now - 90_000 || annQueue.some((x) => x.id === id))) return;
  annRecent.set(key, now);
  if (id) annRecent.set(`id:${id}`, now);
  annQueue.push({ text: withAddress(text), id, key, st: statusOf(id), at: now });
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
      if (bridge) await bridge.announce(a.text, a.id);
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
export function announceText(text: string, id: string, key?: string) {
  enqueueAnnounce(text, id, key);
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
export const jarvisLive: { phase: Phase; hearing: boolean; heard: string } = { phase: 'idle', hearing: false, heard: '' };
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
const lowRu = (t: string) => t.toLowerCase().replace(/ё/g, 'е').trim();
const STOP_RE = /(^|[\s,.!?])(стоп|хватит|стой|достаточно|замолчи|помолчи|тихо|прекрати)([\s,.!?]|$)/;
const SLEEP_RE = /(вс[её],? ?(пока )?не надо|пока не надо|пауза|не слушай|отдохни|перерыв|отключись|помолчи пока|выключи микрофон|не мешай)/;
const RESUME_RE = /(продолж|возвращайся|вернись|работаем|просыпайся|проснись|включись|снова в работу)/;
const ACK_RE = /^(принял|принято|понял|вижу|ясно|ок|окей|хорошо|увидел)[.!]*$/;
// Без слова «Джарвис» (в окне после его вопроса или ответа) берём только то, что похоже на ответ ему: коротко или с
// просьбой. Разговор людей между собой («лучше, чем было, но всё равно») — мимо, без ответа.
const ANSWER_RE =
  /(^|[\s,.!?])(да|нет|ага|угу|давай|давайте|конечно|согласен|подтверждаю|не надо|не нужно|отмена|отмени|заведи|заводи|завести|создай|передай|передавай|отдай|выдай|назначь|возьми|беру|взял|подними|понизь|отклони|напиши|скажи|сообщи|открой|покажи|убери|закрой|верни|переназначь|закрепи|напомни|прочитай|объясни|расскажи|разберись|займись|проверь|посмотри|найди|сделай|отправь|подскажи|помоги|сколько|кому)([\s,.!?]|$)/;
const looksForMe = (t: string) => {
  const low = lowRu(t);
  return low.split(/\s+/).filter(Boolean).length <= 3 || ANSWER_RE.test(low);
};
// Фраза начинается с команды — это Джарвису и без его имени («покажи, что горит», «привет, разберись с МТС Банком»).
const CMD_START_RE =
  /^(покажи|открой|заведи|создай|передай|назначь|подними|понизь|отклони|напиши|сообщи|закрой|верни|переназначь|закрепи|напомни|прочитай|объясни|расскажи|разберись|займись|проверь|посмотри|найди|сделай|отправь|подскажи|помоги|что горит|что важнее|что я упускаю|что с |сколько|кому )/;
/** Приветствия и связки в начале («привет», «слушай», «так») не мешают узнать команду. */
const coreOf = (low: string) => low.replace(/^((привет|здравствуй|слушай|так|ну|а|окей|ок|эй|смотри|давай)[,.!\s]+)+/, '');
const isCommand = (t: string) => CMD_START_RE.test(coreOf(lowRu(t)));
/** Модель решила, что реплика не ей, — молчим. */
const NOT_FOR_ME = /^[\s—–-]*$/;

// ─── распознавание речи ────────────────────────────────────────────────────
type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
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
  h: { result: (t: string, final: boolean) => void; state: (s: EarState, err?: string) => void } | null = null;

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
    else if (this.rec) this.abort();
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
    this.running = true;
    this.started = false;
    this.lastStart = this.lastEvent = Date.now();
    this.abortAt = 0;
    this.h?.state('starting');
    try {
      r.start();
    } catch {
      this.rec = null;
      this.running = false;
      setTimeout(() => this.kick(), 1000);
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
    if (!this.abortAt && now - this.lastEvent > 10000) this.abort(); // завис без событий (обычно браузер сам закрывает тишину за ~8 с)
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
let wakeRe = /$^/;
function wake() {
  if (wakeFor !== jarvisPrefs.persona) {
    wakeFor = jarvisPrefs.persona;
    const words = [...new Set([...personaById(jarvisPrefs.persona).wake, ...PERSONAS[0].wake])].sort((a, b) => b.length - a.length);
    wakeRe = new RegExp(`(?:^|\\s)(${words.join('|')})[,.!?\\s]*`, 'i');
  }
  return wakeRe;
}
const WAKE = { test: (t: string) => wake().test(t), exec: (t: string) => wake().exec(t) };
const afterWake = (t: string) => {
  const m = WAKE.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : t.trim();
};
const FOLLOW_MS = 9000; // после ответа можно продолжать без слова «Джарвис»

const TABS = ['map', 'inbox', 'teams', 'done', 'reviews', 'requests', 'signals', 'shift', 'ai', 'wall', 'directory', 'desk'];
const SUGGEST_CONTROL = ['Что горит?', 'Открой входящие и объясни ситуацию', 'Кому можно дать?', 'Что важнее критического?', 'Перемотай карту'];
const SUGGEST_CHAT = ['Что горит?', 'Что важнее критического?', 'Сколько жалоб?', 'Что с самым срочным?'];

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
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [steps, setSteps] = useState<Step[]>([]); // «Работа Джарвиса»: что он делает прямо сейчас
  const [stepsAt, setStepsAt] = useState(0);
  const [heard, setHeard] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
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
      announce: async (t, id) => {
        // Не перебиваем текущий ответ: ждём, пока договорит и додумает (не дольше 30 секунд).
        for (let k = 0; k < 100 && (talking || busy.current); k++) await new Promise((r) => setTimeout(r, 300));
        focus.current = id;
        setWork({ focusId: id, q: '', steps: [], reply: t, done: [], busy: false });
        setLines((l) => [...l, { role: 'assistant', content: t, event: true }]);
        await say(t);
        speakEnd.current = Date.now();
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
    busy.current = true;
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
        body: JSON.stringify({ text: question, selectedId: s.selectedId, focusId: focus.current, tab: s.tab, mode: jarvisPrefs.control || jarvisPrefs.scenario ? 'control' : 'chat', short: jarvisPrefs.scenario, history, dash: dashSummary(), dashControl: getDash().jarvisEdit, persona: jarvisPrefs.persona, stream: live }),
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
  function isEcho(t: string) {
    const last = [...linesRef.current].reverse().find((l) => l.role === 'assistant');
    if (!last || Date.now() - speakEnd.current > 6000) return false;
    const words = lowRu(t).split(/[^а-яa-z0-9]+/).filter((w) => w.length > 3);
    if (words.length < 3) return false;
    const said = lowRu(last.content);
    return words.filter((w) => said.includes(w)).length / words.length >= 0.6;
  }
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
    const k = (e: KeyboardEvent) => e.key === 'Escape' && phase === 'speak' && stopTalking();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const listenOnceRef = useRef(listenOnce);
  listenOnceRef.current = listenOnce;

  // Режим «управляет экраном»: слушаем всегда, пока Джарвис не думает и не говорит.
  // Фраза со словом «Джарвис» — команда; после ответа несколько секунд можно продолжать без него.
  function onHeard(t: string, final: boolean) {
    const low = lowRu(t);
    // Говорит, а человек заговорил — замолкает и слушает. Своё эхо из колонок отличаем: перебили, если прозвучали
    // хотя бы два новых слова, которых нет в его фразе, или «стоп», «хватит».
    if (phase === 'speak' || bargeAt.current > Date.now() - 1500) {
      const spoken = lowRu(speakingText);
      const fresh = low.split(/[^а-яa-z0-9]+/).filter((w) => w.length > 2 && !spoken.includes(w));
      const m = STOP_RE.exec(low);
      const stopWord = !!m && low.split(/\s+/).length <= 3 && !spoken.includes(m[2]);
      if (!stopWord && fresh.length < 2 && phase === 'speak') return;
      if (phase === 'speak') {
        stopVoice();
        setPhase('idle');
        bargeAt.current = Date.now();
        speakEnd.current = 0; // это не хвост его голоса — фразу человека не отбрасываем
      }
      if (stopWord) {
        setHeard('');
        follow();
        return;
      }
      // перебили — значит, говорят ему: дослушиваем и выполняем без слова «Джарвис»
      if (final) return void askRef.current(afterWake(t) || t.trim());
      setHeard(afterWake(t));
      follow(8000);
      return;
    }
    // Пауза — ждём только «продолжаем работу».
    if (jarvisPause.sleep) {
      if (final && RESUME_RE.test(low)) resume();
      return;
    }
    if (busy.current || phase !== 'idle') return;
    const now = Date.now();
    if (now - speakEnd.current < 1200) return; // хвост собственного голоса
    if (final && isEcho(t)) return;
    const live = now < followUntil.current;
    if (!final) {
      if (live) {
        setHeard(afterWake(t));
        followUntil.current = Math.max(followUntil.current, now + 4000); // человек говорит — окно не закрываем
        setAwaiting(true);
      } else if (WAKE.test(t)) {
        openPanel();
        setHeard(afterWake(t));
        follow(6000);
      }
      return;
    }
    const said = t.trim();
    if (live && said.length >= 2) {
      // перебил Джарвиса — точно говорят ему
      if (WAKE.test(said) || looksForMe(said) || isCommand(said) || now - bargeAt.current < 10_000) return void askRef.current(said);
      setHeard(''); // говорят не ему — не отвечаем и окно не продлеваем
      return;
    }
    if (isCommand(said)) {
      openPanel();
      return void askRef.current(said);
    }
    if (WAKE.test(said)) {
      const rest = afterWake(said);
      openPanel();
      if (rest.length > 2) return void askRef.current(rest);
      setHeard('');
      return follow(); // «Джарвис» — и пауза: ждём команду
    }
    if (!live) setHeard('');
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
  useEffect(() => {
    // «Нет микрофона» не выключает слух: Ear сам пробует снова (см. retry) — иначе после входа на сайт его надо «протыкивать».
    // Слушает только ведущее окно: два окна с распознаванием мешают друг другу, и ни одно ничего не делает.
    ear.set(!!RecCtor && control && leader && !prefs.scenario && !pause.mute && (phase === 'idle' || phase === 'speak'));
  }, [control, leader, phase, prefs.scenario, pause.mute]);
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
    if (phase === 'speak') return stopTalking();
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
    window.addEventListener('radar:jarvis', f);
    return () => window.removeEventListener('radar:jarvis', f);
  }, []);

  // Подпись — по настоящему состоянию микрофона, а не по таймеру.
  const hearing = control ? earState === 'on' : phase === 'listen';
  useEffect(() => {
    jarvisLive.phase = phase;
    jarvisLive.hearing = hearing || awaiting;
    jarvisLive.heard = heard; // блок на стене показывает, что он сейчас слышит
    liveSubs.forEach((f) => f());
  }, [phase, hearing, awaiting, heard]);
  const label = !leader
    ? 'Джарвис в другом окне — нажмите, чтобы он был здесь'
    : pause.mute
    ? 'Микрофон выключен — нажмите, чтобы включить'
    : pause.sleep && phase === 'idle'
      ? 'Пауза — скажите «продолжаем работу»'
      : phase === 'think'
      ? 'Думаю…'
      : phase === 'speak'
        ? 'Говорю… «стоп» — прервать'
        : !control
          ? phase === 'listen'
            ? 'Слушаю…'
            : canListen
              ? 'Нажмите и говорите'
              : 'Напишите вопрос'
          : micDenied || earState === 'error'
            ? 'Нет микрофона — нажмите'
            : !hearing
              ? 'Включаю микрофон…'
              : awaiting
                ? 'Слушаю…'
                : 'Скажите «Джарвис, …»';
  const last = [...lines].reverse().find((l) => l.role === 'assistant');
  const suggest = control ? SUGGEST_CONTROL : SUGGEST_CHAT;
  const persona = personaById(prefs.persona);
  // На дашборде с ИИ-блоком «за работой» показывается в блоке, а не всплывающим окном у шара.
  const workVisible = prefs.work && steps.length > 0 && (phase === 'think' || Date.now() - stepsAt < 7000) && !workInBlock();
  // На стене с блоком Джарвиса шара с фото и всплывающего окна нет: что он говорит, слышит и делает — в блоке.
  // Сам Джарвис работает как прежде (слушает, говорит, делает); шар и окно — только на рабочем месте.
  if (!workOpen && aiBlockOnWall()) return null;

  return (
    <div className={`jv jv-${phase} ${pause.sleep ? 'jv-sleep' : ''} ${pause.mute ? 'jv-mute' : ''} ${awaiting && (hearing || !control) && !pause.sleep ? 'jv-await' : ''} ${open ? 'jv-open' : ''} ${control ? 'jv-control' : ''} ${control && phase === 'idle' && !hearing ? 'jv-deaf' : ''}`}>
      {open && (
        <div className="jv-panel" role="dialog" aria-label="Джарвис — голосовой помощник">
          <div className="jv-head">
            <img className="jv-ava" src={persona.avatar} alt="" onError={(e) => ((e.currentTarget.style.display = 'none'))} />
            <b>{persona.name}</b>
            <span className={`jv-mode ${status?.llm ? 'on' : ''}`} title={status?.llm ? `Думает: ${status.model}. Говорит: живой голос через OpenRouter` : 'Без ключа OpenRouter: команды по правилам и голос браузера'}>
              {status?.llm ? 'Claude + живой голос' : 'по правилам'}
            </span>
            <button
              className="icon-btn"
              onClick={() => {
                if (!control) {
                  stopVoice();
                  rec.current?.abort();
                  setPhase('idle');
                }
                setOpen(false);
              }}
              aria-label={control ? 'Скрыть окно (Джарвис продолжит слушать)' : 'Закрыть'}
              title={control ? 'Скрыть окно — Джарвис продолжит слушать. Выключается только в настройках.' : 'Закрыть'}
            >
              <X size={15} />
            </button>
          </div>
          <div className="jv-flags">
            <button className={`jv-flag ${control || prefs.scenario ? 'on' : ''}`} onClick={() => setSettings(true)} title="Меняется в настройках">
              {control ? <Lock size={12} /> : null}
              {prefs.scenario ? 'сценарий для жюри' : control ? 'управляет экраном · слушает всегда' : 'только ответы'}
            </button>
            <button className={`jv-flag ${prefs.speak ? 'on' : ''}`} onClick={() => setSettings(true)} title="Меняется в настройках">
              {prefs.speak ? <Volume2 size={12} /> : <VolumeX size={12} />}
              {prefs.speak ? 'голос' : 'без голоса'}
            </button>
            <button className={`jv-flag ${prefs.work ? 'on' : ''}`} onClick={() => setJarvisPref('work', !prefs.work)} title="Показывать, что Джарвис делает на сайте прямо сейчас">
              <Activity size={12} /> {prefs.work ? 'работа видна' : 'работа скрыта'}
            </button>
          </div>
          <div className="jv-log" ref={log}>
            {!lines.length && (
              <div className="jv-hello">
                {control ? 'Скажите «Джарвис» и команду — или нажмите на шар и говорите.' : 'Спросите голосом или текстом.'}
                <div className="jv-sug">
                  {suggest.map((s) => (
                    <button key={s} className="chip" onClick={() => void ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {lines.map((l, k) => (
              <div key={k} className={`jv-line ${l.role} ${l.event ? 'event' : ''}`}>
                {l.content}
                {!!l.done?.length && (
                  <span className="jv-done">
                    {l.done.map((d, j) => (
                      <span key={j}>
                        <Check size={11} /> {d}
                      </span>
                    ))}
                  </span>
                )}
                {l.role === 'assistant' && l.llm === false && <span className="jv-rule">по правилам</span>}
              </div>
            ))}
            {heard && <div className="jv-line user interim">{heard}</div>}
            {phase === 'think' && (
              <div className="jv-line assistant jv-dots">
                <i />
                <i />
                <i />
              </div>
            )}
            {err && <div className="jv-err">{err}</div>}
            {note && <div className="jv-note">{note}</div>}
          </div>
          <form
            className="jv-input"
            onSubmit={(e) => {
              e.preventDefault();
              const q = text;
              setText('');
              void ask(q);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={control ? 'Например: открой входящие и объясни ситуацию' : 'Например: что горит в Москве?'} aria-label="Вопрос Джарвису" />
            <button type="submit" className="icon-btn" disabled={!text.trim() || phase === 'think'} aria-label="Отправить">
              <Send size={15} />
            </button>
          </form>
        </div>
      )}
      {!open && last && (phase === 'speak' || awaiting) && (
        <div className="jv-sub">
          {last.content}
          {!!last.done?.length && (
            <span className="jv-done">
              {last.done.map((d, j) => (
                <span key={j}>
                  <Check size={11} /> {d}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {!open && heard && <div className="jv-sub user">{heard}</div>}
      {workVisible && (
        <div className="jv-work" role="status" aria-live="polite">
          <div className="jv-work-h">
            <Activity size={13} /> {persona.name} за работой
          </div>
          {steps.map((x) => (
            <div key={x.id} className={`jv-step ${x.state}`}>
              <span className="jv-step-i">{x.state === 'run' ? <Loader2 size={13} /> : x.state === 'done' ? <Check size={13} /> : <X size={13} />}</span>
              <span>
                {inGender(x.text, persona)}
                {x.note && <small>{x.note}</small>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="jv-dock">
        {(phase !== 'idle' || awaiting || pause.sleep || pause.mute || (control && (!open || !hearing))) && <span className={`jv-label ${control && phase === 'idle' && !hearing && !pause.mute ? 'warn' : ''}`}>{label}</span>}
        {phase === 'speak' && (
          <button className="jv-stop" onClick={stopTalking} title="Замолчать (Esc или скажите «стоп»)">
            <Square size={13} /> Стоп
          </button>
        )}
        {control && phase !== 'speak' && (
          <span className="jv-pausebar">
            <button className={`jv-pbtn ${pause.mute ? 'on' : ''}`} onClick={toggleMute} title={pause.mute ? 'Включить микрофон' : 'Выключить микрофон — Джарвис перестанет слушать'} aria-label={pause.mute ? 'Включить микрофон' : 'Выключить микрофон'}>
              {pause.mute ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
            <button
              className={`jv-pbtn ${pause.sleep ? 'on' : ''}`}
              onClick={() => (pause.sleep ? resumeRef.current() : (setPause({ sleep: true }), stopVoice()))}
              title={pause.sleep ? 'Продолжить работу' : 'Пауза: не отвечать и не объявлять, пока не скажете «продолжаем работу»'}
              aria-label={pause.sleep ? 'Продолжить' : 'Пауза'}
            >
              <Pause size={15} />
            </button>
          </span>
        )}
        <button
          ref={orb}
          className="jv-orb"
          onClick={press}
          onContextMenu={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
          }}
          title={`Джарвис — ${label}. Правая кнопка — показать или скрыть окно`}
          aria-label="Говорить с Джарвисом"
        >
          <span className="jv-core" />
          <span className="jv-ring r1" />
          <span className="jv-ring r2" />
          {prefs.persona !== 'jarvis' || persona.avatar ? <img className="jv-face" src={persona.avatar} alt="" onError={(e) => ((e.currentTarget.style.display = 'none'))} /> : null}
          <span className="jv-ico">
            <Mic size={18} />
          </span>
          {control && <span className="jv-live" aria-hidden />}
        </button>
      </div>
    </div>
  );
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
