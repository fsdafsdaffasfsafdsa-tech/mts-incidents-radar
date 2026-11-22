// Один Джарвис на все окна пункта. Если пункт открыт в двух вкладках или окнах (дашборд и «На экран стены»),
// в каждой свой Джарвис: оба объявляют одно и то же (слышно дважды), оба держат распознавание речи — браузер отдаёт
// микрофон одному, и второй «слушает, но ничего не делает». Поэтому говорит и слушает только ведущее окно — то, где
// дежурный работает сейчас: любой щелчок, клавиша или фокус делают окно ведущим, остальные замолкают.
// Окна договариваются через BroadcastChannel; ведущее раз в 2 с отмечается, пропало на 5 с — видимое окно забирает.
import { useEffect, useState } from 'react';

type Msg = { t: 'claim' | 'alive' | 'bye'; id: string };
const ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const ch: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('radar-jarvis') : null;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

// Окно, открытое на виду, — сразу ведущее (его только что открыли, чтобы работать); фоновое — ждёт.
let leader = !ch || visible();
let lastAlive = 0;
let claimedAt = 0; // когда это окно последний раз забрало Джарвиса
const subs = new Set<() => void>();
function set(v: boolean) {
  if (leader === v) return;
  leader = v;
  subs.forEach((f) => f());
}

/** Это окно — ведущее: здесь Джарвис говорит и слушает. */
export const isJarvisLeader = () => leader;

/** Сделать это окно ведущим (остальные замолкают). */
export function claimJarvis() {
  claimedAt = Date.now();
  set(true);
  ch?.postMessage({ t: 'claim', id: ID } satisfies Msg);
}

/** Подписка на смену ведущего окна. */
export function onJarvisLeader(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}
export function useJarvisLeader() {
  const [v, setV] = useState(leader);
  useEffect(() => onJarvisLeader(() => setV(leader)), []);
  return v;
}

if (ch) {
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (!m || m.id === ID) return;
    if (m.t === 'claim') {
      lastAlive = Date.now();
      set(false);
    } else if (m.t === 'alive') {
      lastAlive = Date.now();
      // два ведущих (окна открыли одновременно) — уступает одно, по жребию; но свежий щелчок здесь важнее
      // отметки, отправленной другим окном до того, как оно узнало, что Джарвиса забрали
      if (leader && m.id > ID && Date.now() - claimedAt > 2500) set(false);
    } else if (m.t === 'bye') {
      lastAlive = 0;
      if (visible()) claimJarvis();
    }
  };
  if (leader) ch.postMessage({ t: 'claim', id: ID } satisfies Msg);
  setInterval(() => {
    if (leader) ch.postMessage({ t: 'alive', id: ID } satisfies Msg);
    else if (Date.now() - lastAlive > 5000 && visible()) claimJarvis();
  }, 2000);
  const take = () => !leader && claimJarvis();
  const bye = () => {
    if (!leader) return;
    set(false);
    ch.postMessage({ t: 'bye', id: ID } satisfies Msg);
  };
  window.addEventListener('focus', take);
  window.addEventListener('pointerdown', take, true);
  window.addEventListener('keydown', take, true);
  window.addEventListener('pagehide', bye);
  // Перешли на вкладку — Джарвис здесь сразу, без щелчка. Ушли с неё (свернули, другая вкладка) — отдаём его:
  // скрытая вкладка слушать не может, и раньше Джарвис молчал везде, пока по нему не щёлкнешь.
  document.addEventListener('visibilitychange', () => (visible() ? take() : bye()));
}
