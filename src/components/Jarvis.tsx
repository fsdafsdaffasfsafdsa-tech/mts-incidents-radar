// «Джарвис» — с ИИ можно разговаривать голосом: «Джарвис, что горит?», «открой мобильный интернет в Москве»,
// «передай по совету», «кто на смене», «перемотай карту». Отвечает голосом и показывает нужное на экране.
// Голос ElevenLabs и мозг Claude — на сервере через OpenRouter (ключ не уходит в браузер). Без ключа —
// понятные команды по правилам и встроенный голос браузера.
import { useEffect, useRef, useState } from 'react';
import { Bot, Mic, MicOff, Send, Volume2, VolumeX, X } from 'lucide-react';
import { getState, openIncident, readLocal, setTab, writeLocal } from '../store';

type Phase = 'idle' | 'listen' | 'think' | 'speak';
type Line = { role: 'user' | 'assistant'; content: string; llm?: boolean };
type Action = { type: 'open'; id: string } | { type: 'tab'; tab: string } | { type: 'replay' };
interface Status {
  llm: boolean;
  tts: boolean;
  model: string;
  voices: string[];
}

// ─── настройки (в браузере) ────────────────────────────────────────────────
export const JARVIS_VOICES: { id: string; name: string }[] = [
  { id: 'adam', name: 'Адам — низкий, спокойный' },
  { id: 'brian', name: 'Брайан — глубокий' },
  { id: 'bill', name: 'Билл — строгий' },
  { id: 'george', name: 'Джордж — мягкий' },
  { id: 'matilda', name: 'Матильда — женский' },
];
export const jarvisPrefs = {
  voice: readLocal<string>('radar.jarvis.voice', 'adam'),
  speak: readLocal<boolean>('radar.jarvis.speak', true),
  announce: readLocal<boolean>('radar.jarvis.announce', true),
  wake: readLocal<boolean>('radar.jarvis.wake', false),
};
const listeners = new Set<() => void>();
export function setJarvisPref<K extends keyof typeof jarvisPrefs>(k: K, v: (typeof jarvisPrefs)[K]) {
  jarvisPrefs[k] = v;
  writeLocal(`radar.jarvis.${k}`, v);
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
let audio: HTMLAudioElement | null = null;
let actx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let onPhase: (p: Phase) => void = () => undefined;
let speaking = 0;

function stopVoice() {
  speaking++;
  audio?.pause();
  audio = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function browserVoice(text: string, id: number) {
  return new Promise<void>((done) => {
    if (!('speechSynthesis' in window)) return done();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    const ru = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('ru'));
    u.voice = ru.find((v) => /male|дмитрий|pavel|павел|online/i.test(v.name)) ?? ru[0] ?? null;
    u.rate = 1.05;
    u.pitch = 0.85;
    u.onend = u.onerror = () => done();
    if (id === speaking) speechSynthesis.speak(u);
    else done();
  });
}

/** Сказать вслух. Сначала голос ElevenLabs с сервера, если его нет — голос браузера. */
export async function say(text: string) {
  stopVoice();
  const id = speaking;
  const t = text.replace(/[«»"*_#]/g, '').trim();
  if (!t) return;
  onPhase('speak');
  try {
    const st = await jarvisStatus();
    if (st?.tts) {
      const r = await fetch('/api/jarvis/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, voice: jarvisPrefs.voice }) });
      if (r.status === 200 && id === speaking) {
        const url = URL.createObjectURL(await r.blob());
        const a = new Audio(url);
        audio = a;
        try {
          actx ??= new AudioContext();
          if (actx.state === 'suspended') await actx.resume();
          analyser = actx.createAnalyser();
          analyser.fftSize = 256;
          actx.createMediaElementSource(a).connect(analyser).connect(actx.destination);
        } catch {
          analyser = null;
        }
        await new Promise<void>((done) => {
          a.onended = a.onerror = () => done();
          a.play().catch(() => done());
        });
        URL.revokeObjectURL(url);
        analyser = null;
        if (id === speaking) onPhase('idle');
        return;
      }
    }
  } catch {
    /* сервер не озвучил — говорим голосом браузера */
  }
  if (id !== speaking) return;
  await browserVoice(t, id);
  if (id === speaking) onPhase('idle');
}

/** Объявление о событии (тревога, критический) — если в настройках включено «объявлять голосом». */
export function announce(text: string) {
  if (!jarvisPrefs.announce || getState().me?.role !== 'coordinator' || !getState().sound) return;
  // Даём сирене прозвучать первой.
  setTimeout(() => void say(text), 1800);
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
};
const RecCtor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
export const canListen = !!RecCtor;
const WAKE = /(?:^|\s)(джарвис|жарвис|джервис|jarvis)[,.!?\s]*/i;

const TABS = ['map', 'inbox', 'teams', 'done', 'requests', 'signals', 'shift', 'ai', 'wall', 'directory', 'desk'];
const SUGGEST = ['Что горит?', 'Кто на смене?', 'Открой самый срочный', 'Сколько жалоб?', 'Перемотай карту', 'Открой видеостену'];

function runActions(actions: Action[]) {
  for (const a of actions) {
    if (a.type === 'open' && getState().incidents.has(a.id)) openIncident(a.id);
    if (a.type === 'tab' && TABS.includes(a.tab)) setTab(a.tab);
    if (a.type === 'replay') setTimeout(() => window.dispatchEvent(new Event('radar:replay')), 350);
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
  const rec = useRef<Rec | null>(null);
  const wakeRec = useRef<Rec | null>(null);
  const orb = useRef<HTMLButtonElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;

  useEffect(() => {
    onPhase = setPhase;
    void jarvisStatus().then(setStatus);
    return () => {
      onPhase = () => undefined;
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
      else if (phase === 'listen') lvl = 0.15 + Math.abs(Math.sin(performance.now() / 420)) * 0.2;
      orb.current?.style.setProperty('--lvl', lvl.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [lines, heard]);

  async function ask(q: string) {
    const question = q.replace(WAKE, ' ').trim() || q.trim();
    if (!question) return;
    setErr('');
    setOpen(true);
    const history = linesRef.current.slice(-6).map(({ role, content }) => ({ role, content }));
    setLines((l) => [...l, { role: 'user', content: question }]);
    setPhase('think');
    try {
      const r = await fetch('/api/jarvis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: question, selectedId: getState().selectedId, history }) });
      const data = (await r.json()) as { reply: string; actions: Action[]; llm: boolean; error?: string };
      if (!r.ok) throw new Error(data.error ?? 'нет ответа');
      setLines((l) => [...l, { role: 'assistant', content: data.reply, llm: data.llm }]);
      runActions(data.actions ?? []);
      if (jarvisPrefs.speak && getState().sound) void say(data.reply);
      else setPhase('idle');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  function listen() {
    if (!RecCtor) {
      setOpen(true);
      setErr('Браузер не умеет распознавать речь — напишите вопрос (голос работает в Chrome и Edge).');
      return;
    }
    if (phase === 'listen') {
      rec.current?.stop();
      return;
    }
    stopVoice();
    wakeRec.current?.abort();
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
    r.onerror = (e) => {
      if (e.error === 'not-allowed') setErr('Нет доступа к микрофону — разрешите его в адресной строке.');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') setErr(`Микрофон: ${e.error}`);
    };
    r.onend = () => {
      rec.current = null;
      setHeard('');
      if (final.trim()) void ask(final);
      else setPhase((p) => (p === 'listen' ? 'idle' : p));
    };
    rec.current = r;
    setPhase('listen');
    r.start();
  }
  const listenRef = useRef(listen);
  listenRef.current = listen;
  const askRef = useRef(ask);
  askRef.current = ask;

  // Горячая клавиша (по умолчанию V) — говорить с Джарвисом.
  useEffect(() => {
    const f = () => listenRef.current();
    window.addEventListener('radar:jarvis', f);
    return () => window.removeEventListener('radar:jarvis', f);
  }, []);

  // «Слушать всегда»: фраза, начинающаяся со слова «Джарвис», сразу уходит помощнику.
  useEffect(() => {
    if (!prefs.wake || !RecCtor || phase !== 'idle') return;
    let alive = true;
    const start = () => {
      if (!alive) return;
      const r = new RecCtor();
      r.lang = 'ru-RU';
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (e) => {
        for (let k = e.resultIndex; k < e.results.length; k++) {
          const t = e.results[k][0].transcript;
          if (e.results[k].isFinal && WAKE.test(t)) {
            alive = false;
            r.abort();
            const rest = t.split(WAKE).slice(2).join(' ').trim();
            if (rest.length > 2) void askRef.current(rest);
            else listenRef.current();
            return;
          }
        }
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed') alive = false;
      };
      r.onend = () => setTimeout(start, 300);
      wakeRec.current = r;
      try {
        r.start();
      } catch {
        /* уже запущен */
      }
    };
    start();
    return () => {
      alive = false;
      wakeRec.current?.abort();
      wakeRec.current = null;
    };
  }, [prefs.wake, phase]);

  const label = { idle: canListen ? 'Нажмите и говорите' : 'Напишите вопрос', listen: 'Слушаю…', think: 'Думаю…', speak: 'Говорю…' }[phase];
  const last = [...lines].reverse().find((l) => l.role === 'assistant');

  return (
    <div className={`jv jv-${phase} ${open ? 'jv-open' : ''}`}>
      {open && (
        <div className="jv-panel" role="dialog" aria-label="Джарвис — голосовой помощник">
          <div className="jv-head">
            <Bot size={16} />
            <b>Джарвис</b>
            <span className={`jv-mode ${status?.llm ? 'on' : ''}`} title={status?.llm ? `Мозг: ${status.model}. Голос: ElevenLabs` : 'Без ключа OpenRouter: команды по правилам и голос браузера'}>
              {status?.llm ? 'Claude + ElevenLabs' : 'по правилам'}
            </span>
            <button className="icon-btn" onClick={() => setJarvisPref('speak', !prefs.speak)} title={prefs.speak ? 'Отвечать голосом — вкл.' : 'Отвечать голосом — выкл.'} aria-label="Отвечать голосом">
              {prefs.speak ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                stopVoice();
                rec.current?.abort();
                setPhase('idle');
                setOpen(false);
              }}
              aria-label="Закрыть"
            >
              <X size={15} />
            </button>
          </div>
          <div className="jv-log" ref={log}>
            {!lines.length && (
              <div className="jv-hello">
                Спросите голосом или текстом.{prefs.wake ? ' Можно просто сказать «Джарвис, …».' : ''}
                <div className="jv-sug">
                  {SUGGEST.map((s) => (
                    <button key={s} className="chip" onClick={() => void ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {lines.map((l, k) => (
              <div key={k} className={`jv-line ${l.role}`}>
                {l.content}
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
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: что горит в Москве?" aria-label="Вопрос Джарвису" />
            <button type="submit" className="icon-btn" disabled={!text.trim() || phase === 'think'} aria-label="Отправить">
              <Send size={15} />
            </button>
          </form>
        </div>
      )}
      {!open && last && phase === 'speak' && <div className="jv-sub">{last.content}</div>}
      <div className="jv-dock">
        {phase !== 'idle' && <span className="jv-label">{label}</span>}
        <button
          ref={orb}
          className="jv-orb"
          onClick={() => (open ? listen() : (setOpen(true), canListen && listen()))}
          onContextMenu={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
          }}
          title={`Джарвис — ${label}. Правая кнопка — показать/скрыть окно`}
          aria-label="Говорить с Джарвисом"
        >
          <span className="jv-core" />
          <span className="jv-ring r1" />
          <span className="jv-ring r2" />
          <span className="jv-ico">{phase === 'listen' ? <MicOff size={18} /> : <Mic size={18} />}</span>
        </button>
      </div>
    </div>
  );
}

/** Раздел настроек: голос, озвучка ответов и событий, «слушать всегда». */
export function JarvisSettings() {
  const prefs = usePrefs();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => void jarvisStatus().then(setStatus), []);
  return (
    <section>
      <h3>
        Джарвис — голосовой помощник
        <span className={`jv-mode ${status?.llm ? 'on' : ''}`}>{status?.llm ? 'Claude + ElevenLabs' : 'по правилам, голос браузера'}</span>
      </h3>
      <div className="jv-set">
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
        <button className="btn btn-sm" onClick={() => void say('Добрый вечер, сэр. Все системы пункта в норме.')}>
          Прослушать
        </button>
      </div>
      <label className="chk">
        <input type="checkbox" checked={prefs.speak} onChange={(e) => setJarvisPref('speak', e.target.checked)} /> Отвечать голосом
      </label>
      <label className="chk">
        <input type="checkbox" checked={prefs.announce} onChange={(e) => setJarvisPref('announce', e.target.checked)} /> Объявлять голосом критические инциденты
      </label>
      <label className="chk">
        <input type="checkbox" checked={prefs.wake} disabled={!canListen} onChange={(e) => setJarvisPref('wake', e.target.checked)} /> Слушать всегда — отвечать на «Джарвис, …» {canListen ? '' : '(браузер не умеет)'}
      </label>
    </section>
  );
}
