// Шумоподавление слуха Джарвиса — две маленькие нейросети прямо в браузере, без сервера:
//   RNNoise    — вычищает постоянный шум: вентилятор, кондиционер, клавиатуру, улицу, гул зала;
//   Silero VAD — каждые 32 мс решает, есть ли в звуке человеческая речь. Нет речи — распознаватель слышит
//                тишину: шум не превращается в «слова», не будит Джарвиса, не держит фразу «недосказанной».
// Silero слушает звук, очищенный RNNoise, — так шум реже похож на речь. А распознаватель слышит речь как есть
// (только с шумоподавлением браузера): проверка в Chrome под сильным шумом показала, что после RNNoise Google
// путает слова («Джарвис» → «Чарльз»), а исходную речь с воротами Silero понимает верно.
// Звук к распознавателю идёт с задержкой 0,6 с: пока Silero решает, что началась речь, начало фразы («Дж…»)
// ждёт в задержке и не отрезается. Что не загрузилось — того нет: без Silero звук идёт без ворот;
// без обоих Ear слушает дорожку браузера, как раньше.
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimd from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

const SAMPLE_RATE = 48_000; // RNNoise работает на 48 кГц
// Проверено в Chrome на фразе «Джарвис, покажи критические инциденты» под шумом: при шуме громче голоса
// Silero узнаёт речь не сразу — запас 0,6 с и порог 0,35, чтобы «Джарвис» в начале не отрезался.
const PRE_ROLL = 0.6; // с — запас перед началом фразы
const HOLD_MS = 1000; // пауза между словами — ворота не закрываются
const OPEN_P = 0.35; // вероятность речи от Silero, с которой ворота открываются
/** Файлы Silero и среды ONNX: vite.config.ts кладёт их по этому адресу. */
const VAD_BASE = '/vad/';

export type DenoiseStatus = { rnnoise: boolean; vad: boolean; speech: boolean; running: boolean };
export type Denoise = {
  /** Чистая дорожка для распознавателя. */
  track: MediaStreamTrack;
  /** Звук реально идёт: браузер запустил обработку (без разрешения на звук она стоит до первого щелчка). */
  ready: () => boolean;
  /** Обработка запустилась позже (после щелчка) — пора перейти на чистую дорожку. */
  onReady: (cb: () => void) => void;
  status: () => DenoiseStatus;
  close: () => void;
};

/** Выключить на этом компьютере: localStorage['radar.jarvis.denoise'] = 'off'. */
export function denoiseOff(): boolean {
  try {
    return localStorage.getItem('radar.jarvis.denoise') === 'off';
  } catch {
    return false;
  }
}

let rnnoiseBin: Promise<ArrayBuffer | null> | null = null;
/** Загрузить RNNoise заранее (один раз на вкладку). */
export function preloadRnnoise(): Promise<ArrayBuffer | null> {
  rnnoiseBin ??= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimd }).catch((err: unknown) => {
    console.warn('RNNoise не загрузился — слушаем без него:', err);
    return null;
  });
  return rnnoiseBin;
}

let last: DenoiseStatus | null = null;
/** Что сейчас включено — для проверки (в консоли: radarDenoise()). */
export const denoiseStatus = () => (last ? { ...last } : null);
(window as unknown as { radarDenoise: typeof denoiseStatus }).radarDenoise = denoiseStatus;

/** Пропустить микрофон через RNNoise и ворота Silero. null — не получилось, слушаем как раньше. */
/** use — для проверок: выключить RNNoise / Silero или дать распознавателю звук после RNNoise (clean). */
export async function denoise(input: MediaStream, use: { rnnoise?: boolean; vad?: boolean; clean?: boolean } = {}): Promise<Denoise | null> {
  if (denoiseOff() || typeof AudioWorkletNode === 'undefined') return null;
  const bin = use.rnnoise === false ? null : await preloadRnnoise();
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  } catch {
    return null;
  }
  const st: DenoiseStatus = { rnnoise: false, vad: false, speech: false, running: false };
  const src = ctx.createMediaStreamSource(input);
  let head: AudioNode = src;
  if (bin) {
    try {
      await ctx.audioWorklet.addModule(rnnoiseWorklet);
      const rn = new RnnoiseWorkletNode(ctx, { wasmBinary: bin, maxChannels: 1 });
      src.connect(rn);
      head = rn;
      st.rnnoise = true;
    } catch (err) {
      console.warn('RNNoise не запустился — слушаем без него:', err);
    }
  }
  // пока Silero грузится — звук идёт как есть: без задержки и с открытыми воротами
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0;
  const gate = ctx.createGain();
  gate.gain.value = 1;
  const out = ctx.createMediaStreamDestination();
  (use.clean ? head : src).connect(delay).connect(gate).connect(out);
  const track = out.stream.getAudioTracks()[0];
  if (!track) {
    void ctx.close();
    return null;
  }

  let closed = false;
  let vad: { destroy: () => Promise<void> } | null = null;
  let lastSpeech = 0;
  const waiters: (() => void)[] = [];
  const running = () => ctx.state === 'running';
  // Без разрешения на звук браузер держит обработку на паузе — запускаем при первом действии человека.
  const wake = () => {
    if (!closed && !running()) void ctx.resume().catch(() => {});
  };
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  events.forEach((e) => window.addEventListener(e, wake, { capture: true, passive: true }));
  ctx.onstatechange = () => {
    st.running = running();
    if (st.running) waiters.splice(0).forEach((cb) => cb());
  };
  wake();
  st.running = running();

  // Ворота: Silero слышит речь — открыть; тишина дольше паузы между словами — закрыть, когда хвост фразы
  // выйдет из задержки.
  const onFrame = (p: { isSpeech: number }) => {
    const now = performance.now();
    const t = ctx.currentTime;
    if (p.isSpeech >= OPEN_P) {
      lastSpeech = now;
      if (!st.speech) {
        st.speech = true;
        gate.gain.cancelScheduledValues(t);
        gate.gain.setTargetAtTime(1, t, 0.015);
      }
    } else if (st.speech && now - lastSpeech > HOLD_MS) {
      st.speech = false;
      gate.gain.cancelScheduledValues(t);
      gate.gain.setTargetAtTime(0, t + PRE_ROLL, 0.08);
    }
  };
  void (async () => {
    if (use.vad === false) return;
    try {
      const tap = ctx.createMediaStreamDestination();
      head.connect(tap);
      const { MicVAD } = await import('@ricky0123/vad-web');
      const v = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_BASE,
        onnxWASMBasePath: VAD_BASE,
        audioContext: ctx,
        getStream: async () => tap.stream,
        pauseStream: async () => {},
        resumeStream: async (s) => s,
        ortConfig: (ort) => {
          ort.env.logLevel = 'error';
          ort.env.wasm.numThreads = 1; // без изоляции страницы потоки недоступны — не пытаемся
        },
        positiveSpeechThreshold: OPEN_P,
        negativeSpeechThreshold: OPEN_P - 0.12,
        onFrameProcessed: onFrame,
        startOnLoad: true,
      });
      if (closed) return void v.destroy();
      vad = v;
      st.vad = true;
      // Silero работает — включаем задержку и закрываем ворота до первой речи
      const t = ctx.currentTime;
      delay.delayTime.setValueAtTime(PRE_ROLL, t);
      gate.gain.cancelScheduledValues(t);
      gate.gain.setValueAtTime(st.speech ? 1 : 0, t);
    } catch (err) {
      console.warn('Silero VAD не загрузился — слушаем без ворот:', err);
    }
  })();

  last = st;
  return {
    track,
    ready: running,
    onReady: (cb) => {
      if (running()) cb();
      else waiters.push(cb);
    },
    status: () => ({ ...st }),
    close: () => {
      if (closed) return;
      closed = true;
      events.forEach((e) => window.removeEventListener(e, wake, { capture: true }));
      void vad?.destroy().catch(() => {});
      track.stop();
      void ctx.close().catch(() => {});
      if (last === st) last = null;
    },
  };
}
