// «Джарвис» — голосовой ИИ-помощник дежурного. Две независимые функции, обе включаются в настройках:
//   «Джарвис управляет экраном» — слушает всегда («Джарвис, …»), открывает вкладки и инциденты, объясняет ситуацию,
//      подсказывает, кому дать, и по команде выдаёт. Пока включено — Джарвиса не выключить (только в настройках).
//   «Голос Джарвиса» — отвечает вслух живым голосом (говорящие модели OpenRouter, ключ на сервере), объявляет критические.
// Разговор помнит, о каком инциденте речь: «объясни», «кому дать?», «выдай» — без номеров.
import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Lock, Mic, Send, Volume2, VolumeX, X } from 'lucide-react';
import { getState, openIncident, openTeamInDirectory, readLocal, setReplay, setSettings, setSkin, setTab, writeLocal } from '../store';

type Phase = 'idle' | 'listen' | 'think' | 'speak';
type Line = { role: 'user' | 'assistant'; content: string; llm?: boolean; done?: string[]; event?: boolean };
type Action =
  | { type: 'open'; id: string }
  | { type: 'tab'; tab: string }
  | { type: 'replay'; on: boolean }
  | { type: 'settings'; open: boolean }
  | { type: 'theme'; id: string }
  | { type: 'team'; name: string }
  | { type: 'show'; what: string };
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
  control: readLocal<boolean>('radar.jarvis.control', false), // управляет экраном, слушает всегда
  speak: readLocal<boolean>('radar.jarvis.speak', true), // голос Джарвиса
  announce: readLocal<boolean>('radar.jarvis.announce', true), // объявлять критические голосом
  voice: readLocal<string>('radar.jarvis.voice2', 'mm-guy'), // новый набор голосов: прежний «Адам» не прижился
};
const listeners = new Set<() => void>();
export function setJarvisPref<K extends keyof typeof jarvisPrefs>(k: K, v: (typeof jarvisPrefs)[K]) {
  jarvisPrefs[k] = v;
  writeLocal(`radar.jarvis.${k === 'voice' ? 'voice2' : k}`, v);
  listeners.forEach((f) => f());
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
export async function say(text: string) {
  stopVoice();
  const id = speaking;
  const t = text.replace(/[«»"*_#]/g, '').trim();
  if (!t) return;
  window.dispatchEvent(new Event('radar:siren-stop')); // сирена не перекрикивает Джарвиса
  onPhase('speak');
  try {
    const st = await jarvisStatus();
    if (st?.tts) {
      const r = await fetch('/api/jarvis/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, voice: jarvisPrefs.voice }) });
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
          onVoiceNote(used && used !== jarvisPrefs.voice && name ? `Выбранный голос сейчас недоступен — говорю голосом «${name}».` : '');
          if (id === speaking) onPhase('idle');
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
  if (id === speaking) onPhase('idle');
}

// Мост к окну Джарвиса: объявления о критических попадают в разговор и становятся его темой.
let bridge: { announce: (text: string, id: string) => void } | null = null;

/** Объявить критический инцидент голосом: что случилось, где и что советует ИИ. */
export function announceIncident(id: string, fallback: string) {
  if (getState().me?.role !== 'coordinator' || !jarvisPrefs.speak || !jarvisPrefs.announce) return;
  // Даём сирене прозвучать первой.
  setTimeout(async () => {
    let text = fallback;
    try {
      const r = await fetch(`/api/jarvis/brief/${encodeURIComponent(id)}`);
      if (r.ok) text = ((await r.json()) as { text: string }).text;
    } catch {
      /* по шаблону с клиента */
    }
    if (bridge) bridge.announce(text, id);
    else void say(text);
  }, 1800);
}

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
  h: { result: (t: string, final: boolean) => void; state: (s: EarState, err?: string) => void } | null = null;

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
      if (this.rec === r) this.h?.state('on');
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
        this.want = false;
        this.h?.state('error', e.error);
      } else if (e.error === 'network') this.fails++;
    };
    r.onend = () => {
      if (this.rec === r) {
        this.rec = null;
        this.running = false;
        this.abortAt = 0;
      }
      if (this.want) setTimeout(() => this.kick(), Math.min(5000, 250 * 2 ** this.fails));
      else this.h?.state('off');
    };
    this.rec = r;
    this.running = true;
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
const WAKE = /(?:^|\s)(джарвис|жарвис|джервис|джарвиз|джавис|jarvis)[,.!?\s]*/i;
const afterWake = (t: string) => {
  const m = WAKE.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : t.trim();
};
const FOLLOW_MS = 9000; // после ответа можно продолжать без слова «Джарвис»

const TABS = ['map', 'inbox', 'teams', 'done', 'requests', 'signals', 'shift', 'ai', 'wall', 'directory', 'desk'];
const SUGGEST_CONTROL = ['Что горит?', 'Открой входящие и объясни ситуацию', 'Кому можно дать?', 'Кто на смене?', 'Перемотай карту'];
const SUGGEST_CHAT = ['Что горит?', 'Кто на смене?', 'Сколько жалоб?', 'Что с самым срочным?'];

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
          openIncident(a.id);
          revealRow();
        }
        window.dispatchEvent(new CustomEvent('radar:jarvis-open', { detail: a.id }));
        break;
      case 'show':
        reveal(a.what);
        break;
      case 'tab':
        if (TABS.includes(a.tab)) {
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
        openTeamInDirectory(a.name);
        break;
    }
  }
}

// ─── шар и окно разговора ──────────────────────────────────────────────────
export function Jarvis() {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [heard, setHeard] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [awaiting, setAwaiting] = useState(false); // ждёт продолжения без слова «Джарвис»
  const [micDenied, setMicDenied] = useState(false);
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
      announce: (t, id) => {
        focus.current = id;
        setLines((l) => [...l, { role: 'assistant', content: t, event: true }]);
        void say(t).then(() => follow());
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

  async function ask(q: string) {
    const question = afterWake(q) || q.trim();
    if (!question || busy.current) return;
    busy.current = true;
    setErr('');
    setHeard('');
    setAwaiting(false);
    followUntil.current = 0;
    const history = linesRef.current.slice(-8).map(({ role, content, done }) => ({ role, content: done?.length ? `${content} (Сделано: ${done.join('; ')})` : content }));
    setLines((l) => [...l, { role: 'user', content: question }]);
    setPhase('think');
    try {
      const s = getState();
      const r = await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: question, selectedId: s.selectedId, focusId: focus.current, tab: s.tab, mode: jarvisPrefs.control ? 'control' : 'chat', history }),
      });
      const data = (await r.json()) as { reply: string; actions: Action[]; done: string[]; focus: string | null; llm: boolean; error?: string };
      if (!r.ok) throw new Error(data.error ?? 'нет ответа');
      if (data.focus) focus.current = data.focus;
      setLines((l) => [...l, { role: 'assistant', content: data.reply, llm: data.llm, done: data.done }]);
      runActions(data.actions ?? []);
      // Джарвис показывает изменение в карточке — сворачиваем окно, чтобы оно его не закрывало
      // (ответ виден подписью у шара; окно — по клику на шар).
      if (data.actions?.some((a) => a.type === 'show') && window.innerWidth < 2200) setOpen(false);
      if (jarvisPrefs.speak) await say(data.reply);
      setPhase('idle');
      follow();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase('idle');
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
      setOpen(true);
      setErr('Браузер не умеет распознавать речь — напишите вопрос (голос работает в Chrome и Edge).');
      return;
    }
    if (phase === 'listen') return rec.current?.stop();
    stopVoice();
    setOpen(true);
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

  // Режим «управляет экраном»: слушаем всегда, пока Джарвис не думает и не говорит.
  // Фраза со словом «Джарвис» — команда; после ответа несколько секунд можно продолжать без него.
  function onHeard(t: string, final: boolean) {
    if (busy.current || phase !== 'idle') return;
    const now = Date.now();
    const live = now < followUntil.current;
    if (!final) {
      if (live) {
        setHeard(afterWake(t));
        followUntil.current = Math.max(followUntil.current, now + 4000); // человек говорит — окно не закрываем
        setAwaiting(true);
      } else if (WAKE.test(t)) {
        setOpen(true);
        setHeard(afterWake(t));
        follow(6000);
      }
      return;
    }
    const said = t.trim();
    if (live && said.length >= 2) return void askRef.current(said);
    if (WAKE.test(said)) {
      const rest = afterWake(said);
      setOpen(true);
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
      },
    };
    return () => {
      ear.h = null;
      ear.set(false);
    };
  }, []);
  useEffect(() => {
    ear.set(!!RecCtor && control && !micDenied && phase === 'idle');
  }, [control, micDenied, phase]);
  // Сторож: раз в 2 с и при возвращении на вкладку поднимает слух, если браузер его уронил.
  useEffect(() => {
    if (!control) return;
    const t = window.setInterval(() => ear.tick(), 2000);
    const vis = () => document.visibilityState === 'visible' && ear.tick();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [control]);

  // Нажали на шар или клавишу V.
  function press() {
    unlockJarvisAudio();
    if (phase === 'speak') {
      stopVoice();
      setPhase('idle');
      follow();
      return;
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
  const label =
    phase === 'think'
      ? 'Думаю…'
      : phase === 'speak'
        ? 'Говорю… (нажмите, чтобы прервать)'
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

  return (
    <div className={`jv jv-${phase} ${awaiting && (hearing || !control) ? 'jv-await' : ''} ${open ? 'jv-open' : ''} ${control ? 'jv-control' : ''} ${control && phase === 'idle' && !hearing ? 'jv-deaf' : ''}`}>
      {open && (
        <div className="jv-panel" role="dialog" aria-label="Джарвис — голосовой помощник">
          <div className="jv-head">
            <Bot size={16} />
            <b>Джарвис</b>
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
            <button className={`jv-flag ${control ? 'on' : ''}`} onClick={() => setSettings(true)} title="Меняется в настройках">
              {control ? <Lock size={12} /> : null}
              {control ? 'управляет экраном · слушает всегда' : 'только ответы'}
            </button>
            <button className={`jv-flag ${prefs.speak ? 'on' : ''}`} onClick={() => setSettings(true)} title="Меняется в настройках">
              {prefs.speak ? <Volume2 size={12} /> : <VolumeX size={12} />}
              {prefs.speak ? 'голос' : 'без голоса'}
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
      <div className="jv-dock">
        {(phase !== 'idle' || awaiting || (control && (!open || !hearing))) && <span className={`jv-label ${control && phase === 'idle' && !hearing ? 'warn' : ''}`}>{label}</span>}
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
              void say('Добрый вечер, сэр. Все системы пункта в норме.');
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
