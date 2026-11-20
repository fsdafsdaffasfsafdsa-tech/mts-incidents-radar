// Экран командира смены пункта: кто на смене, нераспределённые инциденты, распределение ИИ, график пункта.
import { useMemo, useState } from 'react';
import { BellRing, Users, Wand2, X } from 'lucide-react';
import { applyPointPlan, fetchPointPlan, select, setPointTab, useStore } from '../store';
import { useNow } from '../lib/hooks';
import { Initials, PrioDot } from './ui';
import { IncidentCard } from './IncidentCard';
import { IncidentList, IncidentRow, Requests, Signals } from './PointScreen';
import { PersonRow, isOn, shiftHint } from './kit';

export function CommanderScreen() {
  const sel = useStore((s) => (s.selectedId ? s.incidents.get(s.selectedId) : undefined));
  return (
    <div className="commander">
      <section className="panel plist" aria-label="Нераспределённые">
        <Unassigned />
      </section>
      <Shift />
      {sel ? <IncidentCard inc={sel} onClose={() => select(null)} /> : <Roster />}
    </div>
  );
}

function Unassigned() {
  const incidents = useStore((s) => s.incidents);
  const tab = useStore((s) => s.pointTab);
  const requests = useStore((s) => s.requests);
  const signals = useStore((s) => s.signals);
  const free = [...incidents.values()].filter((i) => i.status === 'coordinators' && !i.coordinatorId);
  const pending = [...requests.values()].filter((r) => r.status === 'pending').length;
  const open = [...signals.values()].filter((s) => s.status === 'open').length;
  const [plan, setPlan] = useState<{ incidentId: string; personId: string; why: string }[] | null>(null);
  return (
    <>
      <header className="pl-head">
        <h2>Распределение</h2>
        <button className="btn btn-sm btn-ai" disabled={!free.length} onClick={() => void fetchPointPlan().then(setPlan)} title="Каждому дежурному — не больше трёх новых, с учётом специализации и загрузки">
          <Wand2 size={14} /> Распределить ИИ <span className="num">{free.length}</span>
        </button>
      </header>
      <div className="seg seg-sm ptabs">
        <button className={tab === 'incidents' ? 'on' : ''} onClick={() => setPointTab('incidents')}>
          Инциденты
        </button>
        <button className={tab === 'requests' ? 'on' : ''} onClick={() => setPointTab('requests')}>
          Запросы {pending > 0 && <span className="badge">{pending}</span>}
        </button>
        <button className={tab === 'signals' ? 'on' : ''} onClick={() => setPointTab('signals')}>
          Сигналы {open > 0 && <span className="badge warn">{open}</span>}
        </button>
      </div>
      {tab === 'incidents' ? <IncidentList forceScope="free" /> : tab === 'requests' ? <Requests list={[...requests.values()]} /> : <Signals list={[...signals.values()]} />}
      {plan && <PlanModal plan={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

function PlanModal({ plan, onClose }: { plan: { incidentId: string; personId: string; why: string }[]; onClose: () => void }) {
  const incidents = useStore((s) => s.incidents);
  const staff = useStore((s) => s.staff);
  const [off, setOff] = useState<Set<string>>(new Set());
  const chosen = plan.filter((p) => !off.has(p.incidentId));
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal plan" role="dialog" aria-label="План распределения" onClick={(e) => e.stopPropagation()}>
        <header>
          <Wand2 size={16} />
          <h3>ИИ предлагает распределить</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </header>
        <p className="muted plan-sub">Только дежурные на смене. Каждому — не больше трёх новых, сначала по специализации. Снимите галочку, если не согласны.</p>
        <div className="plan-rows">
          {!plan.length && <div className="empty">Некому распределять: нет дежурных на смене или нет новых инцидентов</div>}
          {plan.map((p) => {
            const inc = incidents.get(p.incidentId);
            const who = staff.find((x) => x.id === p.personId);
            if (!inc || !who) return null;
            const on = !off.has(p.incidentId);
            return (
              <label key={p.incidentId} className={`plan-row ${on ? '' : 'off'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const n = new Set(off);
                    if (on) n.add(p.incidentId);
                    else n.delete(p.incidentId);
                    setOff(n);
                  }}
                />
                <PrioDot p={inc.priority} />
                <span className="plan-inc">
                  <b>{inc.title}</b>
                  <span className="muted">{inc.origin === 'complaints' ? `${inc.complaints} жалоб` : 'ITSM'}</span>
                </span>
                <span className="plan-arrow">→</span>
                <span className="plan-w">
                  <Initials name={who.name} />
                  <span>
                    <b>{who.name}</b>
                    <span className="muted">{p.why}</span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!chosen.length} onClick={() => void applyPointPlan(chosen).then(onClose)}>
            Назначить {chosen.length}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Дежурные на смене и что у каждого в работе. */
function Shift() {
  const staff = useStore((s) => s.staff);
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(15_000);
  const duty = staff.filter((p) => p.role === 'coordinator' && isOn(p, now));
  const commander = staff.find((p) => p.role === 'commander' && isOn(p, now));
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
        {commander && <span className="muted">командир: {commander.name} · {shiftHint(commander, now)}</span>}
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
function Roster() {
  const staff = useStore((s) => s.staff);
  const signals = useStore((s) => s.signals);
  const requests = useStore((s) => s.requests);
  const now = useNow(30_000);
  const openSig = [...signals.values()].filter((s) => s.status === 'open').length;
  const pending = [...requests.values()].filter((r) => r.status === 'pending').length;
  const order = { commander: 0, coordinator: 1, lead: 2, engineer: 3 } as const;
  const sorted = [...staff].sort((a, b) => Number(isOn(b, now)) - Number(isOn(a, now)) || a.crew - b.crew || order[a.role] - order[b.role]);
  return (
    <aside className="panel roster" aria-label="График пункта">
      <div className="roster-kpi">
        <button className="kpi-btn" onClick={() => setPointTab('signals')}>
          <BellRing size={15} /> <b className="num">{openSig}</b> сигналов
        </button>
        <button className="kpi-btn" onClick={() => setPointTab('requests')}>
          <b className="num">{pending}</b> запросов команд
        </button>
      </div>
      <h3 className="cm-h">График пункта на сутки вперёд</h3>
      <div className="pl-rows">
        {sorted.map((p) => (
          <PersonRow key={p.id} p={p} now={now} />
        ))}
      </div>
    </aside>
  );
}
