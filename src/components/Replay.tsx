// «Перемотка» карты: как за последний час жалобы расходились по регионам и когда появлялись инциденты.
import { useEffect, useMemo, useRef, useState } from 'react';
import { History, Pause, Play, Radio } from 'lucide-react';
import { getState, serverNow, setReplay, useStore } from '../store';
import { fmtClock } from '../lib/format';

const HOUR = 3_600_000;
const SPEEDS = [30, 60, 120];

export function Replay() {
  const replayAt = useStore((s) => s.replayAt);
  const complaints = useStore((s) => s.complaints);
  const incidents = useStore((s) => s.incidents);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const raf = useRef<number | null>(null);
  const from = useMemo(() => Math.max(serverNow() - HOUR, complaints[0]?.at ?? serverNow() - HOUR), [complaints.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = serverNow();

  // Уходим со страницы — возвращаем реальное время.
  useEffect(() => () => setReplay(null), []);

  useEffect(() => {
    if (!playing || replayAt === null) return;
    let last = performance.now();
    const step = (t: number) => {
      const dt = t - last;
      last = t;
      const next = (getState().replayAt ?? from) + dt * speed;
      if (next >= serverNow()) {
        setPlaying(false);
        setReplay(null);
        return;
      }
      setReplay(next);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed]); // eslint-disable-line react-hooks/exhaustive-deps

  const marks = useMemo(
    () => [...incidents.values()].filter((i) => i.origin === 'complaints' && i.createdAt >= from).map((i) => ({ id: i.id, at: i.createdAt, p: i.priority, title: i.title })),
    [incidents, from],
  );
  const shown = replayAt === null ? 0 : complaints.filter((c) => c.at <= replayAt && replayAt - c.at < 30 * 60_000).length;

  if (replayAt === null)
    return (
      <button
        className="replay-open"
        onClick={() => {
          setReplay(from);
          setPlaying(true);
        }}
        title="Проиграть последний час: как расходились жалобы и когда появлялись инциденты"
      >
        <History size={15} /> Перемотка
      </button>
    );

  const pct = (t: number) => `${((t - from) / Math.max(1, to - from)) * 100}%`;
  return (
    <div className="replay">
      <button className="icon-btn" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <span className="rp-time num">
        {fmtClock(replayAt)} <span className="muted">−{Math.max(0, Math.round((to - replayAt) / 60_000))} мин</span>
      </span>
      <div className="rp-track">
        {marks.map((m) => (
          <button key={m.id} className={`rp-mark p-${m.p}`} style={{ left: pct(m.at) }} title={`${fmtClock(m.at)} · ${m.title}`} onClick={() => (setPlaying(false), setReplay(m.at))} />
        ))}
        <input
          type="range"
          min={from}
          max={to}
          step={1000}
          value={replayAt}
          onChange={(e) => {
            setPlaying(false);
            setReplay(Number(e.target.value));
          }}
          aria-label="Момент времени"
        />
      </div>
      <span className="rp-count muted">{shown} жалоб на карте</span>
      <div className="seg seg-sm">
        {SPEEDS.map((s) => (
          <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
            ×{s}
          </button>
        ))}
      </div>
      <button
        className="btn btn-sm"
        onClick={() => {
          setPlaying(false);
          setReplay(null);
        }}
      >
        <Radio size={14} /> В реальное время
      </button>
    </div>
  );
}

