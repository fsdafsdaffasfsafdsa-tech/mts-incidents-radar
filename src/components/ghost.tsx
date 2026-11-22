// Курсор Джарвиса — «работа видна» как у человека: Джарвис ведёт курсор к нужной строке, нажимает, печатает действие
// («Передаю инцидент команде…»), жмёт «ввод» — и видно, получилось ли. Настоящее действие делает сервер; курсор
// показывает, где и что он делает. Шаги приходят из потока ответа Джарвиса (ghostStep), сценарий для жюри зовёт
// ghostClick / ghostType напрямую. Шаги идут по очереди, даже если сервер сделал всё за миг.
import { useEffect, useState } from 'react';
import { Check, CornerDownLeft, X } from 'lucide-react';
import './ghost.css';

type GStep = { id: string; text: string; state: 'run' | 'done' | 'fail'; tool?: string; target?: string | null };
type Job = { id: string; text: string; state: 'run' | 'done' | 'fail'; tool: string; target: string | null; el?: Element | null };
type View = {
  on: boolean;
  x: number;
  y: number;
  click: number; // счётчик щелчков — для вспышки
  pill: { text: string; typed: number; state: 'type' | 'enter' | 'ok' | 'fail' } | null;
};

const view: View = { on: false, x: 0, y: 0, click: 0, pill: null };
const subs = new Set<() => void>();
const set = (p: Partial<View>) => {
  Object.assign(view, p);
  subs.forEach((f) => f());
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Только чтение (посмотреть, найти, посчитать) курсором не показываем — только действия.
const READ_ONLY = /^(get_|list_|find_|search|shift_summary|explain|status|dash_state)/;

const jobs: Job[] = [];
let running = false;
let hideTimer = 0;

/** Шаг из потока ответа Джарвиса. */
export function ghostStep(e: GStep) {
  const tool = e.tool ?? '';
  const known = jobs.find((j) => j.id === e.id);
  if (known) {
    known.state = e.state;
    if (e.state !== 'run' && e.text) known.text = e.text;
    return;
  }
  if (e.state !== 'run' || !tool || (READ_ONLY.test(tool) && !e.target)) return;
  jobs.push({ id: e.id, text: e.text, state: e.state, tool, target: e.target ?? null });
  void play();
}

/** Сценарий: подвести курсор и нажать (элемент или CSS-селектор). Возвращает элемент, если нашёлся. */
export async function ghostClick(target: Element | string | null, press = true) {
  const el = typeof target === 'string' ? visible(document.querySelector(target)) : target;
  if (!el) return null;
  await moveTo(el);
  if (press) await tap(el);
  return el;
}
/** Сценарий: подвести курсор, напечатать текст и нажать «ввод». */
export async function ghostType(target: Element | string | null, text: string) {
  const el = typeof target === 'string' ? visible(document.querySelector(target)) : target;
  if (el) await moveTo(el);
  else show(window.innerWidth / 2, window.innerHeight - 120);
  await typeText(text);
  await enter();
  set({ pill: { text, typed: text.length, state: 'ok' } });
  await sleep(500);
  set({ pill: null });
  idle();
}

function visible(el: Element | null) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight ? el : null;
}
function targetOf(j: Job): Element | null {
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, ''));
  if (j.target?.startsWith('mail:') || /mail/.test(j.tool)) return visible(document.querySelector('.db-mail .ml-row')) ?? visible(document.querySelector('.db-mail'));
  if (j.target) {
    const row = visible(document.querySelector(`[data-flip="${esc(j.target)}"]`)) ?? visible(document.querySelector(`[data-id="${esc(j.target)}"]`));
    if (row) return row;
  }
  if (/dash|block|design/.test(j.tool)) return visible(document.querySelector('.dash-grid'));
  return visible(document.querySelector('.jvb')) ?? visible(document.querySelector('.jv-orb'));
}
function show(x: number, y: number) {
  clearTimeout(hideTimer);
  if (!view.on) set({ on: true, x: Math.min(window.innerWidth - 40, x + 160), y: Math.min(window.innerHeight - 40, y + 120) });
  requestAnimationFrame(() => set({ x, y }));
}
async function moveTo(el: Element) {
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + Math.min(r.width * 0.3, 140));
  const y = Math.round(r.top + Math.min(r.height / 2, 40));
  const far = Math.hypot(view.x - x, view.y - y);
  show(x, y);
  await sleep(view.on && far < 30 ? 120 : 700);
}
async function tap(el: Element) {
  set({ click: view.click + 1 });
  try {
    (el as HTMLElement).animate?.(
      [
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
        { transform: 'scale(0.97)', boxShadow: '0 0 0 3px var(--jv, #4e8cff)', offset: 0.35 },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
      ],
      { duration: 520, easing: 'ease-out' },
    );
  } catch {
    /* элемент без анимаций */
  }
  await sleep(320);
}
async function typeText(text: string) {
  const step = Math.max(12, Math.min(32, 1100 / Math.max(1, text.length)));
  for (let k = 1; k <= text.length; k++) {
    set({ pill: { text, typed: k, state: 'type' } });
    await sleep(step);
  }
}
async function enter() {
  if (view.pill) set({ pill: { ...view.pill, state: 'enter' } });
  await sleep(320);
}
function idle() {
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => set({ on: false, pill: null }), 1400);
}

async function play() {
  if (running) return;
  running = true;
  try {
    while (jobs.length) {
      const j = jobs[0];
      const el = targetOf(j);
      if (el) {
        await moveTo(el);
        await tap(el);
      } else show(window.innerWidth / 2, window.innerHeight / 2);
      await typeText(j.text);
      await enter();
      for (let t = 0; t < 25 && j.state === 'run'; t++) await sleep(100);
      set({ pill: { text: j.text, typed: j.text.length, state: j.state === 'fail' ? 'fail' : 'ok' } });
      await sleep(750);
      set({ pill: null });
      jobs.shift();
    }
  } finally {
    running = false;
    idle();
  }
}

/** Курсор и «печать» Джарвиса — поверх всего экрана, мышь не перехватывает. */
export function Ghost() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  if (!view.on) return null;
  const px = Math.min(view.x + 22, window.innerWidth - 340);
  const py = Math.min(view.y + 20, window.innerHeight - 70);
  return (
    <div className="gh" aria-hidden>
      <div className="gh-cursor" style={{ transform: `translate(${view.x}px, ${view.y}px)` }}>
        <svg viewBox="0 0 24 24" width="26" height="26">
          <path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.4 L18 13.4 Z" />
        </svg>
        <i className="gh-name">Джарвис</i>
        <span className="gh-click" key={view.click} />
      </div>
      {view.pill && (
        <div className={`gh-pill st-${view.pill.state}`} style={{ transform: `translate(${px}px, ${py}px)` }}>
          <span className="gh-text">
            {view.pill.text.slice(0, view.pill.typed)}
            {view.pill.state === 'type' && <i className="gh-caret" />}
          </span>
          <span className="gh-key">{view.pill.state === 'ok' ? <Check /> : view.pill.state === 'fail' ? <X /> : <CornerDownLeft />}</span>
        </div>
      )}
    </div>
  );
}
