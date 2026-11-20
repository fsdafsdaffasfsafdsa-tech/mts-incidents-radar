// Короткие синтезированные сигналы. Без файлов, тихо и мягко, не чаще раза в секунду.
export type Cue = 'p1' | 'coord' | 'warn' | 'resolved';

let ctx: AudioContext | null = null;
let last = 0;

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
  g.gain.exponentialRampToValueAtTime(gain, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

export function play(cue: Cue) {
  if (!ctx || ctx.state !== 'running') return;
  const now = performance.now();
  if (now - last < 1100 && cue !== 'p1') return;
  last = now;
  const t = ctx.currentTime + 0.01;
  switch (cue) {
    case 'p1':
      tone(880, t, 0.26, 0.16, 'triangle');
      tone(587.3, t + 0.2, 0.42, 0.16, 'triangle');
      tone(880, t + 0.75, 0.22, 0.1, 'triangle');
      tone(587.3, t + 0.93, 0.36, 0.1, 'triangle');
      break;
    case 'coord':
      tone(659.3, t, 0.16, 0.09);
      tone(987.8, t + 0.11, 0.24, 0.07);
      break;
    case 'warn':
      tone(523.3, t, 0.14, 0.08, 'triangle');
      tone(523.3, t + 0.2, 0.14, 0.08, 'triangle');
      break;
    case 'resolved':
      tone(523.3, t, 0.18, 0.06);
      tone(784, t + 0.12, 0.3, 0.06);
      break;
  }
}
