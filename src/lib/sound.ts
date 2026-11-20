// Звуковое сопровождение: синтезированные сигналы (без файлов). Набор звуков, громкость и события выбираются в настройках.
export type Cue = 'p1' | 'coord' | 'warn' | 'resolved' | 'request';
export type SoundPack = 'classic' | 'soft' | 'clear' | 'calm';

export const SOUND_PACKS: { id: SoundPack; name: string; hint: string }[] = [
  { id: 'classic', name: 'Классический', hint: 'короткие двухтоновые сигналы' },
  { id: 'soft', name: 'Мягкий', hint: 'тихие колокольчики — для долгой смены' },
  { id: 'clear', name: 'Чёткий', hint: 'резкие короткие — слышно в шумном зале' },
  { id: 'calm', name: 'Спокойный', hint: 'один низкий тон, почти не отвлекает' },
];

export const CUE_TEXT: Record<Cue, string> = {
  p1: 'Критический инцидент и предложение «Наивысшего»',
  coord: 'Новый инцидент на пункте или передан вам',
  warn: 'Сигнал: застрял, просьба о помощи, повышение уровня',
  request: 'Запрос команды',
  resolved: 'Инцидент решён',
};

let ctx: AudioContext | null = null;
let last = 0;
let pack: SoundPack = 'classic';
let volume = 0.8;
let enabled: Record<Cue, boolean> = { p1: true, coord: true, warn: true, request: true, resolved: true };

export function configureSound(o: { pack?: SoundPack; volume?: number; events?: Record<Cue, boolean> }) {
  if (o.pack) pack = o.pack;
  if (o.volume !== undefined) volume = Math.max(0, Math.min(1, o.volume));
  if (o.events) enabled = { ...enabled, ...o.events };
}

export function unlockAudio() {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

type Note = [freq: number, at: number, dur: number, gain: number, type?: OscillatorType];

const PACKS: Record<SoundPack, Record<Cue, Note[]>> = {
  classic: {
    p1: [[880, 0, 0.26, 0.16, 'triangle'], [587.3, 0.2, 0.42, 0.16, 'triangle'], [880, 0.75, 0.22, 0.1, 'triangle'], [587.3, 0.93, 0.36, 0.1, 'triangle']],
    coord: [[659.3, 0, 0.16, 0.09], [987.8, 0.11, 0.24, 0.07]],
    warn: [[523.3, 0, 0.14, 0.08, 'triangle'], [523.3, 0.2, 0.14, 0.08, 'triangle']],
    request: [[784, 0, 0.12, 0.07], [659.3, 0.1, 0.18, 0.06]],
    resolved: [[523.3, 0, 0.18, 0.06], [784, 0.12, 0.3, 0.06]],
  },
  soft: {
    p1: [[1046.5, 0, 0.9, 0.08], [1318.5, 0.18, 0.9, 0.06], [1568, 0.36, 1.1, 0.05]],
    coord: [[1318.5, 0, 0.7, 0.05], [1760, 0.12, 0.8, 0.035]],
    warn: [[880, 0, 0.6, 0.05], [880, 0.35, 0.6, 0.04]],
    request: [[1174.7, 0, 0.6, 0.04]],
    resolved: [[1568, 0, 0.5, 0.035], [2093, 0.15, 0.7, 0.03]],
  },
  clear: {
    p1: [[1200, 0, 0.09, 0.09, 'square'], [1200, 0.14, 0.09, 0.09, 'square'], [1200, 0.28, 0.09, 0.09, 'square'], [900, 0.5, 0.25, 0.08, 'square']],
    coord: [[1000, 0, 0.07, 0.07, 'square'], [1400, 0.09, 0.08, 0.06, 'square']],
    warn: [[700, 0, 0.1, 0.07, 'square'], [700, 0.16, 0.1, 0.07, 'square']],
    request: [[1100, 0, 0.08, 0.06, 'square']],
    resolved: [[900, 0, 0.07, 0.05, 'square'], [1350, 0.09, 0.12, 0.05, 'square']],
  },
  calm: {
    p1: [[392, 0, 0.7, 0.12, 'triangle'], [392, 0.8, 0.7, 0.1, 'triangle']],
    coord: [[440, 0, 0.45, 0.08, 'triangle']],
    warn: [[349.2, 0, 0.5, 0.08, 'triangle']],
    request: [[493.9, 0, 0.4, 0.06, 'triangle']],
    resolved: [[523.3, 0, 0.5, 0.05, 'triangle']],
  },
};

/** Сигнал события. preview — прослушать в настройках (без паузы и проверки включённых событий). */
export function play(cue: Cue, preview?: SoundPack) {
  if (!ctx || ctx.state !== 'running') return;
  if (!preview && !enabled[cue]) return;
  const now = performance.now();
  if (!preview && now - last < 1100 && cue !== 'p1') return;
  last = now;
  const t = ctx.currentTime + 0.01;
  for (const [f, at, dur, g, type] of PACKS[preview ?? pack][cue]) tone(f, t + at, dur, g, type);
}
