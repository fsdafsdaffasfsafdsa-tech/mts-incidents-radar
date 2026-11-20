import { useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { bulkAssign, useStore } from '../store';
import { urgency } from '../lib/format';
import { Prio } from './bits';
import { SysIcon } from './SysIcon';

const THRESHOLD = 0.7;

/** Разбор очереди координаторов: ИИ предлагает команду, координатор подтверждает пачкой. */
export function RoutingModal({ onClose }: { onClose: () => void }) {
  const incidents = useStore((s) => s.incidents);
  const teams = useStore((s) => s.teams);
  const systems = useStore((s) => s.systems);
  const [snapshot] = useState(() =>
    [...incidents.values()].filter((i) => i.status === 'coordinators').sort((a, b) => urgency(b, Date.now()) - urgency(a, Date.now())),
  );
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(snapshot.map((i) => [i.id, i.ai.teamId ?? ''])),
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(snapshot.filter((i) => i.ai.confidence >= THRESHOLD && i.ai.teamId).map((i) => i.id)),
  );
  const [busy, setBusy] = useState(false);
  const routable = teams.filter((t) => !t.isCoordinators);
  const selected = useMemo(() => snapshot.filter((i) => checked.has(i.id) && choice[i.id]), [snapshot, checked, choice]);

  const submit = async () => {
    setBusy(true);
    try {
      await bulkAssign(selected.map((i) => ({ id: i.id, teamId: choice[i.id] })));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Разбор очереди координаторов">
        <header className="modal-head">
          <Sparkles size={18} />
          <div>
            <h2>Разбор очереди координаторов</h2>
            <p>
              ИИ предложил команду для каждого инцидента. Уверенные (от {Math.round(THRESHOLD * 100)}%) уже отмечены — проверьте и
              передайте одним нажатием.
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <div className="route-list">
          {snapshot.length === 0 && <div className="empty">Очередь координаторов пуста.</div>}
          {snapshot.map((i) => {
            const live = incidents.get(i.id);
            const gone = !live || live.status !== 'coordinators';
            return (
              <label key={i.id} className={`route-row ${gone ? 'gone' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked.has(i.id) && !gone}
                  disabled={gone}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(i.id);
                    else next.delete(i.id);
                    setChecked(next);
                  }}
                />
                <Prio p={i.priority} />
                <span className="route-main">
                  <span className="route-title">{i.title}</span>
                  <span className="route-meta">
                    <SysIcon systemId={i.systemId} size={12} /> {systems.find((s) => s.id === i.systemId)?.short} · {i.id}
                    {gone && ' · уже разобран'}
                  </span>
                </span>
                <span className="route-conf">
                  <span className={`conf-chip ${i.ai.confidence >= THRESHOLD ? 'hi' : 'lo'}`}>
                    <Sparkles size={11} /> {Math.round(i.ai.confidence * 100)}%
                  </span>
                </span>
                <select
                  value={choice[i.id]}
                  disabled={gone}
                  onChange={(e) => setChoice({ ...choice, [i.id]: e.target.value })}
                >
                  {routable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.id === i.ai.teamId ? ' · ИИ' : ''}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
        <footer className="modal-foot">
          <span className="muted">
            Выбрано {selected.length} из {snapshot.length}
          </span>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-ai" disabled={!selected.length || busy} onClick={() => void submit()}>
            <Sparkles size={15} /> Передать выбранные ({selected.length})
          </button>
        </footer>
      </div>
    </div>
  );
}

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['↑ ↓  или  J K', 'перейти по очереди'],
    ['N', 'следующий, требующий внимания'],
    ['A', 'взять на контроль'],
    ['1', 'передать команде, которую советует ИИ'],
    ['E', 'эскалировать руководителю смены'],
    ['Shift + R', 'отметить решённым'],
    ['/', 'поиск'],
    ['M', 'звук вкл/выкл'],
    ['D', 'демо-управление потоком'],
    ['Esc', 'закрыть окно'],
  ];
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm" role="dialog" aria-label="Горячие клавиши">
        <header className="modal-head">
          <div>
            <h2>Горячие клавиши</h2>
            <p>Координатору не нужно тянуться к мыши, пока горит P1.</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <dl className="keys">
          {keys.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
