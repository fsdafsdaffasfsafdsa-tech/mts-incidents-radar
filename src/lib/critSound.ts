// Звук и голос при критических — выключатель внизу стены. По умолчанию выключено: критический показывается
// только на экране (мигание, срочное окно, полоса), без сирены, звуков и объявления голосом. Хранится в браузере
// и сразу доходит до других окон (событие storage).
import { useEffect, useState } from 'react';

const KEY = 'radar.critSound';
const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
let on = read();
const subs = new Set<() => void>();

/** Включён ли звук и голос при критических. */
export const critSound = () => on;
export function setCritSound(v: boolean) {
  on = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* приватное окно — живём без сохранения */
  }
  subs.forEach((f) => f());
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    on = read();
    subs.forEach((f) => f());
  });

export function useCritSound(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return on;
}
