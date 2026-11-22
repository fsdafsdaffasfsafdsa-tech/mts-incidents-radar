// Блок Джарвиса на стене — обычный блок без фигуры персонажа: шапка «Джарвис · говорит» со значком микрофона,
// «эквалайзер», который двигается по состоянию (говорит — прыгает, слушает — зелёный и спокойнее, думает — бежит
// волной), и фраза — что он сказал или говорит сейчас. Кнопок нет: «стоп», «пауза», «продолжаем работу» —
// голосом; щелчок по эквалайзеру (для мыши) — начать разговор. Плавающий шар Джарвиса при этом блоке скрыт.
import { AudioLines, Mic, MicOff, Pause } from 'lucide-react';
import { personaById } from '../../../shared/personas';
import { jarvisBusyRecently, jarvisPrefs, useJarvisLive, useJarvisPause, useJarvisSaid, useJarvisWork } from '../Jarvis';
import { BlockHead, type BlockCtx } from './Dashboard';

type JState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'success';
const J_TEXT: Record<JState, string> = { idle: 'на связи', listening: 'слушает', thinking: 'думает', speaking: 'говорит', success: 'сделано' };
const BARS = 16;

/** Одна короткая фраза: первое предложение, не длиннее ~90 знаков (по границе слова). */
const firstSentence = (t: string) => {
  const s = (t.split(/(?<=[.!?])\s+/)[0] ?? t).replace(/\s*\([^)]*\)/g, '').trim();
  if (s.length <= 90) return s;
  const cut = s.slice(0, 90);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 50 ? cut.lastIndexOf(' ') : 90).replace(/[,;:—-]+$/, '')}…`;
};

export function JarvisBlock({ ctx, brief }: { ctx: BlockCtx; brief: string | null }) {
  const live = useJarvisLive();
  const work = useJarvisWork();
  const pause = useJarvisPause();
  const said = useJarvisSaid();
  const p = personaById(jarvisPrefs.persona);
  const recent = jarvisBusyRecently(ctx.now);
  const done = !work.busy && work.done.length > 0 && ctx.now - work.at < 4000;
  const state: JState = done ? 'success' : live.phase === 'speak' ? 'speaking' : live.phase === 'think' || work.busy ? 'thinking' : live.hearing || live.phase === 'listen' ? 'listening' : 'idle';
  const top = ctx.snap.action[0];
  const heard = live.heard.trim();
  const phrase = live.muted
    ? 'Браузер не даёт мне говорить до первого щелчка — щёлкните по стене.'
    : pause.sleep
    ? 'Жду. Скажите «продолжаем работу».'
    : heard && state === 'listening'
      ? `«${heard.length > 80 ? `…${heard.slice(-78)}` : heard}»`
      : work.busy
      ? 'Секунду, разбираюсь…'
      : recent && work.reply
        ? firstSentence(work.reply)
        : said[0] && ctx.now - said[0].at < 60_000
          ? firstSentence(said[0].text)
          : firstSentence(brief ?? (top ? `Главное — ${top.inc.title}.` : 'Всё спокойно, сэр.'));
  const MicIcon = pause.mute ? MicOff : pause.sleep ? Pause : Mic;
  const micCls = pause.mute || pause.sleep ? 'off' : state === 'listening' ? 'on' : '';
  return (
    <div className={`db db-jv2 jvb s-${state}`} style={{ ['--pc' as string]: p.color }}>
      <BlockHead
        title={p.name}
        icon={<AudioLines size={18} />}
        right={
          <span className="jvb-state">
            {pause.mute ? 'микрофон выключен' : pause.sleep ? 'пауза' : J_TEXT[state]}
            <span
              className={`jvb-mic ${micCls}`}
              role="button"
              tabIndex={0}
              onClick={() => window.dispatchEvent(new Event(pause.sleep ? 'radar:jarvis-pause' : 'radar:jarvis-mute'))}
              title={pause.mute ? 'Микрофон выключен — щелчок, чтобы включить' : pause.sleep ? 'Пауза — щелчок или «Джарвис, …», чтобы продолжить' : 'Микрофон включён — щелчок, чтобы выключить'}
            >
              <MicIcon />
            </span>
          </span>
        }
      />
      <div className={`jvb-eq st-${state}`} aria-hidden onClick={() => window.dispatchEvent(new Event('radar:jarvis'))} title="Нажмите и говорите">
        {Array.from({ length: BARS }, (_, k) => (
          <i key={k} style={{ animationDelay: `${(k % 8) * 0.09}s` }} />
        ))}
      </div>
      <p className="jvb-phrase" key={phrase}>
        {phrase.split(' ').map((w, k) => (
          <span key={k} className="jvb-w" style={{ animationDelay: `${Math.min(k, 30) * 45}ms` }}>
            {w}{' '}
          </span>
        ))}
      </p>
      {state === 'speaking' && <small className="jvb-hint">скажите «стоп» — замолчу</small>}
      {/* услышал, но не понял, что это ему, — видно, а не «молчит»; подсказка, как обратиться */}
      {state !== 'speaking' && live.ignored && ctx.now - live.ignored.at < 6000 && (
        <small className="jvb-ignored">
          услышал «{live.ignored.text.length > 40 ? `${live.ignored.text.slice(0, 38)}…` : live.ignored.text}» — скажите «{p.name}, …»
        </small>
      )}
    </div>
  );
}
