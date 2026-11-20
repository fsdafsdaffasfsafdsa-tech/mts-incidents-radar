import { useMemo } from 'react';
import { setState, useStore, type QueueFilter } from '../store';
import { GROUPS, matches } from '../lib/queue';
import { useBump, useNow, useTween } from '../lib/hooks';

interface Tile {
  id: QueueFilter;
  label: string;
  value: number;
  sub: string;
  tone: string;
}

const EXTRA = [
  { id: 'open', label: 'Открыто', hint: 'в работе и в исследовании', tone: 'neutral' },
  { id: 'breach', label: 'Дедлайн прошёл', hint: 'нужна эскалация', tone: 'breach' },
] as const;

/** Сводка: четыре группы ТЗ плюс «открыто» и «дедлайн прошёл». Клик фильтрует очередь. */
export function Kpis() {
  const incidents = useStore((s) => s.incidents);
  const filter = useStore((s) => s.filter);
  const now = useNow(5000);

  const tiles = useMemo<Tile[]>(() => {
    const none = new Set<string>();
    const count = (f: QueueFilter) => [...incidents.values()].filter((i) => matches(i, f, none, now)).length;
    const unack = [...incidents.values()].filter((i) => matches(i, 'coordinators', none, now) && !i.acknowledged).length;
    const critResolved = [...incidents.values()].filter((i) => matches(i, 'critical', none, now) && i.status === 'resolved').length;
    return [
      { ...EXTRA[0], value: count('open'), sub: EXTRA[0].hint },
      ...GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        tone: g.tone,
        value: count(g.id),
        sub: g.id === 'coordinators' && unack ? `${unack} не просмотрены` : g.id === 'critical' && critResolved ? `из них решено: ${critResolved}` : g.hint,
      })),
      { ...EXTRA[1], value: count('breach'), sub: EXTRA[1].hint },
    ];
  }, [incidents, now]);

  return (
    <section className="kpis" aria-label="Сводка">
      {tiles.map((t) => (
        <KpiTile key={t.id} t={t} active={filter === t.id} />
      ))}
    </section>
  );
}

function KpiTile({ t, active }: { t: Tile; active: boolean }) {
  const shown = useTween(t.value);
  const bump = useBump(t.value);
  return (
    <button className={`kpi tone-${t.tone} ${active ? 'active' : ''}`} onClick={() => setState({ filter: active ? 'open' : t.id })} title="Показать в очереди">
      <span key={bump} className={bump ? 'kpi-flash' : ''} aria-hidden />
      <span className="kpi-label">{t.label}</span>
      <span className="kpi-value num">{shown}</span>
      <span className="kpi-sub">{t.sub}</span>
    </button>
  );
}
