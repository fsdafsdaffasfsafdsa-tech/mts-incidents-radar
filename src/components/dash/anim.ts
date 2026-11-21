// Анимации стены на события — плавно и без лагов: только transform и opacity (их считает видеокарта),
// через Web Animations API, и только когда что-то поменялось. При «уменьшить движение» в системе — ничего не двигаем.
//   useFlip  — строки списка плавно переезжают на новое место, новые — въезжают, «стало горячее» — короткая вспышка;
//   useBump  — число поменялось: короткий «прыжок»;
//   useFlash — что-то поменялось: класс на ~1 с для CSS-подсветки.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

// Тихий режим — переключатель самого приложения, а не системы: на стене дежурки анимации — часть сигнала, а в Windows
// «эффекты анимации» часто выключены ради скорости, и браузер тогда просил бы сайт не двигаться вовсе.
// CSS слушает его через @container style(--motion: calm).
const MOTION_KEY = 'radar.motion';
export const motionCalm = () => typeof document !== 'undefined' && document.documentElement.style.getPropertyValue('--motion') === 'calm';
export function setMotionCalm(calm: boolean) {
  if (typeof document === 'undefined') return;
  if (calm) document.documentElement.style.setProperty('--motion', 'calm');
  else document.documentElement.style.removeProperty('--motion');
  try {
    localStorage.setItem(MOTION_KEY, calm ? 'calm' : 'full');
  } catch {
    /* хранилище недоступно — режим только на эту вкладку */
  }
}
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem(MOTION_KEY) === 'calm') setMotionCalm(true);
} catch {
  /* нет доступа к хранилищу — анимации по умолчанию */
}
const reduced = motionCalm;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const SHAKE: Keyframe[] = [0, -7, 6, -5, 4, -2, 0].map((x) => ({ transform: `translateX(${x}px)` }));

/**
 * Строки с data-flip="id" внутри box: переезд на новое место — плавно (FLIP), новая строка — въезжает справа,
 * data-level вырос (инцидент стал горячее, писем больше) — вспышка цвета --flash. Первый показ не анимируем.
 */
export function useFlip(box: RefObject<HTMLElement | null>) {
  const prev = useRef<Map<string, { top: number; level: number }> | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const next = new Map<string, { top: number; level: number }>();
    const nodes = el.querySelectorAll<HTMLElement>('[data-flip]');
    const was = prev.current;
    const animate = was !== null && !reduced();
    nodes.forEach((n) => {
      const id = n.dataset.flip!;
      const top = n.offsetTop;
      const level = Number(n.dataset.level ?? 0);
      next.set(id, { top, level });
      if (!animate) return;
      const old = was!.get(id);
      if (!old) {
        // новая строка — влетает справа с перелётом и вспышкой
        n.animate(
          [
            { opacity: 0, transform: 'translateX(48px) scale(0.9)' },
            { opacity: 1, transform: 'translateX(-6px) scale(1.04)', offset: 0.6 },
            { transform: 'translateX(2px) scale(0.99)', offset: 0.82 },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 640, easing: EASE },
        );
        n.animate([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 4px var(--flash, var(--jv)), 0 0 18px var(--flash, var(--jv))' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1300, easing: 'ease-out' });
        return;
      }
      if (old.top !== top) n.animate([{ transform: `translateY(${old.top - top}px)` }, { transform: 'translateY(0) scale(1.02)', offset: 0.75 }, { transform: 'none' }], { duration: 520, easing: EASE });
      if (level > old.level) {
        n.animate([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 5px var(--flash, var(--d-crit)), 0 0 22px var(--flash, var(--d-crit))' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1000, easing: 'ease-out' });
        // раскалился до красного — короткая тряска
        if (level >= 3) n.animate(SHAKE, { duration: 460, easing: 'ease-in-out', composite: 'add' });
      }
    });
    prev.current = next;
  });
}

/** Число поменялось — короткий «прыжок» элемента (на первом показе — нет). */
export function useBump<T extends HTMLElement>(value: unknown) {
  const ref = useRef<T>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    const up = typeof value === 'number' && typeof prev.current === 'number' ? value > prev.current : true;
    prev.current = value;
    if (!ref.current || reduced()) return;
    ref.current.animate(
      up
        ? [{ transform: 'scale(1)' }, { transform: 'scale(1.6) rotate(-6deg)', offset: 0.4 }, { transform: 'scale(0.92)', offset: 0.75 }, { transform: 'scale(1)' }]
        : [{ transform: 'scale(1)' }, { transform: 'scale(0.7)', offset: 0.4 }, { transform: 'scale(1)' }],
      { duration: 520, easing: EASE },
    );
  }, [value]);
  return ref;
}

/** Значение поменялось — true на ms миллисекунд (для CSS-подсветки), на первом показе — false. */
export function useFlash(value: unknown, ms = 1100) {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return on;
}
