// Избранное смены: закрепить инцидент с заметкой и напоминанием. Окно открывается звёздочкой на карточке
// (на стене и в рабочем месте) или командой Джарвиса; заметку и напоминание видит вся смена.
import { useEffect, useState } from 'react';
import { Star, X } from 'lucide-react';
import { pinIncident, unpinIncident, useStore } from '../store';
import { fmtShort } from '../../shared/dash';
import './fav-itsm.css';

export const openFav = (id: string) => window.dispatchEvent(new CustomEvent('radar:fav', { detail: id }));
// Частые заметки — одним нажатием, чтобы не печатать во время аварии.
const QUICK = ['Жду ответа команды', 'Позвонить руководителю команды', 'Проверить после решения', 'Под контролем руководства', 'Связан с другим инцидентом', 'Передать следующей смене'];
const REMIND = [
  { min: 0, name: 'без напоминания' },
  { min: 15, name: '15 мин' },
  { min: 30, name: '30 мин' },
  { min: 60, name: '1 ч' },
  { min: 120, name: '2 ч' },
];

export function FavDialog() {
  const [id, setId] = useState<string | null>(null);
  const inc = useStore((s) => (id ? s.incidents.get(id) : undefined));
  const [note, setNote] = useState('');
  const [remind, setRemind] = useState(0);
  useEffect(() => {
    const f = (e: Event) => setId((e as CustomEvent<string>).detail);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setId(null);
    window.addEventListener('radar:fav', f);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('radar:fav', f);
      window.removeEventListener('keydown', esc);
    };
  }, []);
  useEffect(() => {
    if (!inc) return;
    setNote(inc.pin?.note ?? '');
    setRemind(inc.pin?.remindAt ? Math.max(0, Math.round((inc.pin.remindAt - Date.now()) / 60_000)) : 0);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!id || !inc) return null;
  const close = () => setId(null);
  return (
    <div className="fav-wrap" onClick={close}>
      <div className="fav" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Избранное смены">
        <header>
          <Star size={18} />
          <b>{inc.pin ? 'В избранном смены' : 'В избранное смены'}</b>
          <button onClick={close} aria-label="Закрыть">
            <X size={16} />
          </button>
        </header>
        <p className="fav-t">{inc.title}</p>
        {inc.pin && (
          <small className="fav-by">
            закрепил {inc.pin.by} · {fmtShort(Date.now() - inc.pin.at)} назад
          </small>
        )}
        <label>
          Заметка для смены
          <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} placeholder="Например: жду ответа от Billing до 18:00, позвонить руководителю, если не возьмут" autoFocus />
        </label>
        <div className="fav-quick">
          {QUICK.map((q) => (
            <button key={q} onClick={() => setNote((n) => (n.includes(q) ? n : (n.trim() ? `${n.trim()}. ${q}` : q).slice(0, 300)))}>
              + {q}
            </button>
          ))}
        </div>
        <div className="fav-remind">
          <span>Напомнить через</span>
          {REMIND.map((r) => (
            <button key={r.min} className={remind === r.min ? 'on' : ''} onClick={() => setRemind(r.min)}>
              {r.name}
            </button>
          ))}
        </div>
        <footer>
          {inc.pin && (
            <button
              onClick={() => {
                void unpinIncident(inc.id);
                close();
              }}
            >
              Убрать из избранного
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            className="on"
            onClick={() => {
              void pinIncident(inc.id, note.trim(), remind || null);
              close();
            }}
          >
            <Star size={14} /> {inc.pin ? 'Сохранить' : 'Закрепить'}
          </button>
        </footer>
      </div>
    </div>
  );
}
