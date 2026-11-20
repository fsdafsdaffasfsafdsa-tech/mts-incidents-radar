// Смена пункта: кто из дежурных на смене, что у каждого в работе, и график пункта на сутки.
// (Роль командира смены убрана: новые инциденты распределяет ИИ, дежурные передают друг другу сами.)
import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { select, useStore } from '../store';
import { useNow } from '../lib/hooks';
import { Initials } from './ui';
import { IncidentRow } from './PointScreen';
import { PersonRow, isOn, shiftHint } from './kit';

/** Дежурные на смене и что у каждого в работе. */
export function Shift() {
  const staff = useStore((s) => s.staff);
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(15_000);
  const duty = staff.filter((p) => p.role === 'coordinator' && isOn(p, now));
  const byCoord = useMemo(() => {
    const m = new Map<string, typeof list>();
    const list = [...incidents.values()].filter((i) => i.status !== 'resolved' && i.coordinatorId);
    for (const i of list) m.set(i.coordinatorId!, [...(m.get(i.coordinatorId!) ?? []), i]);
    return m;
  }, [incidents]);
  return (
    <section className="panel shift" aria-label="Смена">
      <header className="pl-head">
        <h2>
          <Users size={16} /> Смена пункта
        </h2>
        <span className="muted">новые инциденты, которые никто не взял за полторы минуты, ИИ распределяет сам</span>
      </header>
      <div className="shift-grid">
        {duty.map((p) => {
          const mine = byCoord.get(p.id) ?? [];
          const routed = mine.filter((i) => i.status !== 'coordinators').length;
          return (
            <div key={p.id} className="coord-card">
              <div className="cc-head">
                <Initials name={p.name} />
                <span>
                  <b>{p.name}</b>
                  <span className="muted">
                    {p.spec} · {shiftHint(p, now)}
                  </span>
                </span>
                <span className={`load l${Math.min(3, mine.length)}`}>{mine.length}</span>
              </div>
              <div className="cc-sub muted">
                на пункте {mine.length - routed} · у команд {routed}
              </div>
              <div className="cc-list">
                {!mine.length && <div className="empty sm">Свободен</div>}
                {mine
                  .sort((a, b) => a.priority.localeCompare(b.priority))
                  .slice(0, 6)
                  .map((i) => (
                    <IncidentRow key={i.id} inc={i} sel={i.id === selectedId} onClick={() => select(i.id)} />
                  ))}
              </div>
            </div>
          );
        })}
        {!duty.length && <div className="empty">Сейчас на смене нет дежурных</div>}
      </div>
    </section>
  );
}

/** Когда инцидент не выбран: сигналы, запросы и график всего пункта. */
export function Roster() {
  const staff = useStore((s) => s.staff);
  const now = useNow(30_000);
  const order = { coordinator: 0, lead: 1, engineer: 2 } as const;
  const sorted = [...staff].sort((a, b) => Number(isOn(b, now)) - Number(isOn(a, now)) || a.crew - b.crew || order[a.role] - order[b.role]);
  return (
    <section className="panel roster" aria-label="График пункта">
      <h3 className="cm-h">График пункта на сутки вперёд</h3>
      <div className="pl-rows">
        {sorted.map((p) => (
          <PersonRow key={p.id} p={p} now={now} />
        ))}
      </div>
    </section>
  );
}
