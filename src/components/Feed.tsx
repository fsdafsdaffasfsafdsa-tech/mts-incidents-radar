import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock,
  ArrowUpCircle,
  CheckCircle2,
  CirclePlus,
  Flame,
  Microscope,
  Pause,
  Play,
  Send,
  TimerOff,
  Trash2,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { FeedEvent, FeedKind } from '../../shared/types';
import { select, useStore } from '../store';
import { fmtAgo } from '../lib/format';
import { useNow } from '../lib/hooks';

const META: Record<FeedKind, { icon: LucideIcon; label: string; tone: string }> = {
  p1: { icon: Flame, label: 'Критический', tone: 'p1' },
  created: { icon: CirclePlus, label: 'Новый', tone: 'neutral' },
  coordinators: { icon: Users, label: 'На координаторов', tone: 'coord' },
  assigned: { icon: Send, label: 'Назначен', tone: 'neutral' },
  in_progress: { icon: UserCheck, label: 'В работе', tone: 'neutral' },
  research: { icon: Microscope, label: 'Исследование', tone: 'ai' },
  priority_up: { icon: ArrowUpCircle, label: 'Приоритет ↑', tone: 'warn' },
  sla_warning: { icon: AlarmClock, label: 'Дедлайн скоро', tone: 'warn' },
  sla_breach: { icon: TimerOff, label: 'Дедлайн прошёл', tone: 'p1' },
  resolved: { icon: CheckCircle2, label: 'Решён', tone: 'ok' },
  removed: { icon: Trash2, label: 'Удалён', tone: 'neutral' },
};

type Mode = 'all' | 'important' | 'routing' | 'resolved';
const MODES: { id: Mode; label: string; kinds: FeedKind[] | null }[] = [
  { id: 'all', label: 'Все', kinds: null },
  { id: 'important', label: 'Важное', kinds: ['p1', 'priority_up', 'sla_breach', 'sla_warning'] },
  { id: 'routing', label: 'Назначения', kinds: ['coordinators', 'assigned', 'in_progress'] },
  { id: 'resolved', label: 'Решённые', kinds: ['resolved', 'research'] },
];

export function Feed() {
  const feed = useStore((s) => s.feed);
  const [mode, setMode] = useState<Mode>('all');
  const [hover, setHover] = useState(false);
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const now = useNow(5000);
  const listRef = useRef<HTMLDivElement>(null);

  // Пока курсор над лентой, она не прыгает: новые события копятся сверху.
  useEffect(() => {
    if (hover && !frozen) setFrozen(feed);
    if (!hover && frozen) setFrozen(null);
  }, [hover, feed, frozen]);

  const kinds = MODES.find((m) => m.id === mode)!.kinds;
  const source = frozen ?? feed;
  const list = useMemo(() => source.filter((e) => !kinds || kinds.includes(e.kind)).slice(0, 80), [source, kinds]);
  const pending = frozen ? feed.filter((e) => !frozen.includes(e) && (!kinds || kinds.includes(e.kind))).length : 0;

  return (
    <section className="panel feed" aria-label="Лента событий">
      <div className="panel-head">
        <h2>Лента событий</h2>
        <span className={`feed-state ${frozen ? 'paused' : ''}`}>
          {frozen ? <Pause size={12} /> : <Play size={12} />}
          {frozen ? (pending ? `пауза · ${pending} новых` : 'пауза') : 'в реальном времени'}
        </span>
      </div>
      <div className="seg seg-sm">
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="feed-list" ref={listRef} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {list.map((e) => (
          <FeedItem key={e.id} e={e} now={now} />
        ))}
      </div>
    </section>
  );
}

function FeedItem({ e, now }: { e: FeedEvent; now: number }) {
  const inc = useStore((s) => s.incidents.get(e.incidentId));
  const sys = useStore((s) => s.systems.find((x) => x.id === e.systemId)?.short);
  const m = META[e.kind];
  const Icon = m.icon;
  const recent = now - e.at < 8000;
  return (
    <button className={`fe tone-${m.tone} ${recent ? 'recent' : ''}`} onClick={() => inc && select(e.incidentId)} disabled={!inc}>
      <span className="fe-icon">
        <Icon size={14} />
      </span>
      <span className="fe-body">
        <span className="fe-top">
          <b>{m.label}</b>
          <span className={`prio-text p-${e.priority}`}>{e.priority}</span>
          <span className="fe-sys">{sys}</span>
        </span>
        <span className="fe-text">{e.text}</span>
        {inc && <span className="fe-inc">{inc.title}</span>}
        <span className="fe-meta num">
          {e.incidentId} · {fmtAgo(now - e.at)}
        </span>
      </span>
    </button>
  );
}
