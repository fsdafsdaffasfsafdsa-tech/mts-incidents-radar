// Пересменка — короткая анимация 16:9 в стиле мини-сериала (плоский 2D, крупные числа и значки, субтитры-караоке,
// голос Джарвиса): что было у предыдущего дежурного и что добить и проследить. Сцены собираются из данных смены
// по правилам (быстро, без модели); каждая сцена идёт, пока Джарвис договаривает (или по времени, если голоса нет).
// Открыть: openHandover() — кнопка «Пересменка» на пульте показа или Ctrl+Shift+H.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clapperboard, Flame, Inbox, RotateCcw, Send, Star, Timer, UserX, Users, X, type LucideIcon } from 'lucide-react';
import type { Incident } from '../../../shared/types';
import { isRecurring, waitingTake } from '../../../shared/dash';
import { myShiftWork } from '../../../shared/shift';
import { getState, serverNow } from '../../store';
import { fmtClock } from '../../lib/format';
import { say, stopVoice } from '../Jarvis';
import { oneLine, serviceIcon } from './wall2';

const MIN = 60_000;
const SHIFT = 12 * 60 * MIN;
export const openHandover = () => window.dispatchEvent(new Event('radar:handover'));

type Scene = { id: string; say: string; min: number; render: (t: number) => React.ReactNode };
const PRIO_C: Record<string, string> = { P1: '#ff5269', P2: '#ffb547', P3: '#f2d16b', P4: '#42c5f5' };
const plural = (n: number, a: string, b: string, c: string) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const left = (i: Incident, now: number) => {
  const m = Math.round((i.slaDeadline - now) / MIN);
  const a = Math.abs(m);
  const t = a < 60 ? `${a} мин` : a < 2880 ? `${Math.round(a / 60)} ч` : `${Math.round(a / 1440)} дн`;
  return m < 0 ? `просрочен на ${t}` : `${t} до срока`;
};

/** Сцены пересменки по данным смены. */
function buildScenes(): Scene[] {
  const st = getState();
  const now = serverNow();
  const from = now - SHIFT;
  const all = [...st.incidents.values()];
  const me = st.me?.name ?? 'дежурный';
  const work = myShiftWork(all, me, from);
  const solved = all.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from).length;
  const created = all.filter((i) => i.createdAt > from).length;
  const open = all.filter((i) => i.status !== 'resolved');
  const hot = open.filter((i) => i.priority === 'P1' || i.priority === 'P2' || i.slaDeadline - now < 60 * MIN).sort((a, b) => a.slaDeadline - b.slaDeadline).slice(0, 3);
  const recur = all.filter((i) => isRecurring(i, now)).slice(0, 2);
  const stuck = open.filter((i) => (waitingTake(i, now) ?? 0) > 10 * MIN).slice(0, 2);
  const pinned = all.filter((i) => i.pin && i.status !== 'resolved').slice(0, 2);
  const events = st.feed.filter((e) => e.at > from && ['p1', 'recur', 'routed', 'resolved', 'coordinators'].includes(e.kind)).slice(0, 7).reverse();
  const watch = [...recur.map((i) => ({ i, icon: RotateCcw, why: `снова ${i.recur?.count ?? 0} ${plural(i.recur?.count ?? 0, 'жалоба', 'жалобы', 'жалоб')} после решения` })), ...stuck.map((i) => ({ i, icon: UserX, why: 'команда не берёт' })), ...pinned.map((i) => ({ i, icon: Star, why: i.pin?.note ? `заметка: ${i.pin.note}` : 'в избранном смены' }))].slice(0, 3);

  const scenes: Scene[] = [
    {
      id: 'title',
      min: 3800,
      say: 'Сэр, пересменка. Коротко — что было за смену и что передаём дальше.',
      render: () => (
        <div className="ho-title">
          <span className="ho-clap">
            <Clapperboard />
          </span>
          <b>ПЕРЕСМЕНКА</b>
          <small className="num">
            {fmtClock(from)} — {fmtClock(now)}
          </small>
          <em>{me}</em>
        </div>
      ),
    },
    {
      id: 'numbers',
      min: 6000,
      say: `За смену пришло ${created} ${plural(created, 'инцидент', 'инцидента', 'инцидентов')}. Взято в работу ${work.taken}, передано командам ${work.routed}, решено ${solved}.`,
      render: () => (
        <div className="ho-nums">
          {(
            [
              [Inbox, created, 'пришло', '#4e8cff'],
              [Users, work.taken, 'взято', '#f2d16b'],
              [Send, work.routed, 'передано', '#ffb547'],
              [CheckCircle2, solved, 'решено', '#3ecf8e'],
            ] as [LucideIcon, number, string, string][]
          ).map(([I, n, w, c], k) => (
            <div key={w} className="ho-num" style={{ ['--c' as string]: c, animationDelay: `${k * 0.25}s` }}>
              <I />
              <b className="num">
                <Count to={n} delay={k * 250} />
              </b>
              <small>{w}</small>
            </div>
          ))}
        </div>
      ),
    },
  ];
  if (events.length)
    scenes.push({
      id: 'timeline',
      min: 6500,
      say: `Главные события смены — на линии времени. ${events.filter((e) => e.kind === 'p1').length ? 'Были критические.' : 'Критических не было.'} ${recur.length ? 'Были повторные жалобы после решения.' : ''}`,
      render: () => (
        <div className="ho-tl">
          <i className="ho-tl-line" />
          {events.map((e, k) => (
            <div key={e.id} className={`ho-ev k-${e.kind}`} style={{ left: `${6 + (k / Math.max(1, events.length - 1)) * 88}%`, animationDelay: `${0.3 + k * 0.45}s` }}>
              <i style={{ background: PRIO_C[e.priority] ?? '#9fb0c8' }} />
              <b className="num">{fmtClock(e.at)}</b>
              <small>{e.text.slice(0, 36)}</small>
            </div>
          ))}
        </div>
      ),
    });
  scenes.push({
    id: 'todo',
    min: 7000,
    say: hot.length ? `Добить: ${hot.map((i) => `${oneLine(i)}, ${left(i, now)}`).join('; ')}.` : 'Горящих инцидентов не осталось.',
    render: () => (
      <div className="ho-cards">
        <h3 className="ho-h">
          <Flame /> Добить
        </h3>
        {hot.length ? (
          hot.map((i, k) => <Card key={i.id} i={i} k={k} note={left(i, now)} icon={Timer} />)
        ) : (
          <div className="ho-calm">
            <CheckCircle2 /> всё под контролем
          </div>
        )}
      </div>
    ),
  });
  if (watch.length)
    scenes.push({
      id: 'watch',
      min: 7000,
      say: `Проследить: ${watch.map((x) => `${oneLine(x.i)} — ${x.why}`).join('; ')}.`,
      render: () => (
        <div className="ho-cards">
          <h3 className="ho-h blue">
            <RotateCcw /> Проследить
          </h3>
          {watch.map((x, k) => (
            <Card key={x.i.id} i={x.i} k={k} note={x.why} icon={x.icon} />
          ))}
        </div>
      ),
    });
  scenes.push({
    id: 'end',
    min: 3800,
    say: 'Смена передана. Если что — спрашивайте меня, сэр.',
    render: () => (
      <div className="ho-title end">
        <span className="ho-ok">
          <CheckCircle2 />
        </span>
        <b>СМЕНА ПЕРЕДАНА</b>
        <small>вопросы — Джарвису</small>
      </div>
    ),
  });
  return scenes;
}

/** Число «докручивается» до значения. */
function Count({ to, delay = 0 }: { to: number; delay?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now() + delay;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / 900));
      setN(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, delay]);
  return <>{n}</>;
}

function Card({ i, k, note, icon: NI }: { i: Incident; k: number; note: string; icon: LucideIcon }) {
  const I = serviceIcon(i);
  return (
    <div className="ho-card" style={{ ['--c' as string]: PRIO_C[i.priority], animationDelay: `${0.25 + k * 0.35}s` }}>
      <span className="ho-card-ic">
        <I />
      </span>
      <b>{oneLine(i)}</b>
      <small>
        <NI /> {note}
      </small>
    </div>
  );
}

/** Субтитры-караоке: слова загораются в темпе речи. */
function Karaoke({ text, at }: { text: string; at: number }) {
  const words = useMemo(() => text.split(/\s+/), [text]);
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN(Math.min(words.length, Math.floor((Date.now() - at) / 320) + 1)), 80);
    return () => clearInterval(t);
  }, [at, words.length]);
  return (
    <p className="ho-sub">
      {words.map((w, k) => (
        <span key={k} className={k < n ? 'on' : ''}>
          {w}{' '}
        </span>
      ))}
    </p>
  );
}

export function Handover() {
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [k, setK] = useState(0);
  const [at, setAt] = useState(0);
  const run = useRef(0);
  useEffect(() => {
    const go = () => {
      setScenes(buildScenes());
      setK(0);
      setOpen(true);
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyH') go();
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('radar:handover', go);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('radar:handover', go);
      window.removeEventListener('keydown', key);
    };
  }, []);
  // сцена идёт, пока Джарвис договаривает (не меньше min), потом — следующая
  useEffect(() => {
    if (!open || !scenes[k]) return;
    const my = ++run.current;
    const sc = scenes[k];
    const t0 = Date.now();
    setAt(t0);
    const fallback = Math.max(sc.min, sc.say.split(/\s+/).length * 330 + 900);
    void (async () => {
      await Promise.race([say(sc.say).catch(() => undefined), new Promise((r) => setTimeout(r, fallback + 6000))]);
      const rest = Math.max(0, Math.max(sc.min, Date.now() - t0 < 1200 ? fallback : 0) - (Date.now() - t0));
      await new Promise((r) => setTimeout(r, rest + 500));
      if (run.current !== my) return;
      if (k + 1 < scenes.length) setK(k + 1);
      else setOpen(false);
    })();
  }, [open, k, scenes]);
  useEffect(() => {
    if (!open) {
      run.current++;
      stopVoice();
    }
  }, [open]);
  if (!open || !scenes[k]) return null;
  const sc = scenes[k];
  return (
    <div className="ho-wrap" role="dialog" aria-label="Пересменка">
      <div className="ho-frame">
        <div className="ho-bg" />
        <div className="ho-scene" key={sc.id}>
          {sc.render(Date.now() - at)}
        </div>
        <div className="ho-prog">
          {scenes.map((s, j) => (
            <i key={s.id} className={j < k ? 'done' : j === k ? 'now' : ''} style={j === k ? { animationDuration: `${Math.max(sc.min, sc.say.split(/\s+/).length * 330)}ms` } : undefined} />
          ))}
        </div>
        <Karaoke text={sc.say} at={at} />
        <span className="ho-x" role="button" tabIndex={0} onClick={() => setOpen(false)} title="Закрыть (Esc)">
          <X />
        </span>
      </div>
    </div>
  );
}
