import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { serverNow } from '../store';

// Общие тикеры: все таймеры SLA обновляются одним интервалом, а не сотней.
const tickers = new Map<number, { now: number; subs: Set<() => void>; timer: number | null }>();

function getTicker(ms: number) {
  let t = tickers.get(ms);
  if (!t) {
    t = { now: serverNow(), subs: new Set(), timer: null };
    tickers.set(ms, t);
  }
  return t;
}

export function useNow(ms = 1000): number {
  const t = getTicker(ms);
  return useSyncExternalStore(
    (cb) => {
      t.subs.add(cb);
      if (t.timer === null) {
        t.timer = window.setInterval(() => {
          t.now = serverNow();
          for (const s of t.subs) s();
        }, ms);
      }
      return () => {
        t.subs.delete(cb);
        if (t.subs.size === 0 && t.timer !== null) {
          clearInterval(t.timer);
          t.timer = null;
        }
      };
    },
    () => t.now,
  );
}

/** Подсветка изменившегося значения: возвращает счётчик, который растёт при каждом изменении. */
export function useBump(value: unknown): number {
  const [n, setN] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setN((x) => x + 1);
    }
  }, [value]);
  return n;
}

/** Плавный счётчик для крупных цифр. */
export function useTween(value: number, ms = 450): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    if (a === value) return;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(a + (value - a) * e);
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}
