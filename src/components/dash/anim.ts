// Анимации стены на события — плавно и без лагов: только transform и opacity (их считает видеокарта),
// через Web Animations API, и только когда что-то поменялось. При «уменьшить движение» в системе — ничего не двигаем.
//   useFlip  — строки списка плавно переезжают на новое место, новые — въезжают, «стало горячее» — короткая вспышка;
//   useBump  — число поменялось: короткий «прыжок»;
//   useFlash — что-то поменялось: класс на ~1 с для CSS-подсветки.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

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
        n.animate([{ opacity: 0, transform: 'translateX(14px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE });
        n.animate([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 3px var(--flash, var(--jv))' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1100, easing: 'ease-out' });
        return;
      }
      if (old.top !== top) n.animate([{ transform: `translateY(${old.top - top}px)` }, { transform: 'none' }], { duration: 480, easing: EASE });
      if (level > old.level) n.animate([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 4px var(--flash, var(--d-crit))' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 900, easing: 'ease-out' });
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
    ref.current.animate([{ transform: 'scale(1)' }, { transform: `scale(${up ? 1.35 : 0.8})` }, { transform: 'scale(1)' }], { duration: 420, easing: EASE });
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
