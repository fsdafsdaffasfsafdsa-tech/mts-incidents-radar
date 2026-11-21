// Кнопки ситуаций — всегда внизу стены. Самотёка нет: ничего не появляется само, каждая кнопка создаёт настоящую
// ситуацию на сервере (server/show.ts) — стена, срочное окно, уведомления и Джарвис реагируют как вживую.
// «Очистить» — пустая смена. Видео пересменки — кнопкой в шапке.
import { useState } from 'react';
import { ArrowUp, Brush, Inbox, Mail, MailWarning, Repeat, RotateCcw, Siren, Timer, TrendingUp, UserX, Zap, type LucideIcon } from 'lucide-react';
import { showAction } from '../../store';
import { motionCalm, setMotionCalm } from './anim';

const BTNS: { kind: string; icon: LucideIcon; label: string; tone: string }[] = [
  { kind: 'crit', icon: Siren, label: 'Критический', tone: 'crit' },
  { kind: 'recur', icon: RotateCcw, label: 'Снова жалобы', tone: 'crit' },
  { kind: 'p1ask', icon: TrendingUp, label: 'ИИ: «Наивысший»', tone: 'crit' },
  { kind: 'above', icon: ArrowUp, label: 'Важнее критич.', tone: 'high' },
  { kind: 'sla', icon: Timer, label: 'Срок горит', tone: 'high' },
  { kind: 'stuck', icon: UserX, label: 'Не берут', tone: 'high' },
  { kind: 'pingpong', icon: Repeat, label: 'По кругу', tone: 'mid' },
  { kind: 'coord', icon: Inbox, label: 'Распределить', tone: 'jv' },
  { kind: 'mailCrit', icon: MailWarning, label: 'Письмо: сбой', tone: 'jv' },
  { kind: 'mailAsk', icon: Mail, label: 'Письмо: не к нам', tone: 'jv' },
];

export function ShowPanel() {
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [calm, setCalm] = useState(motionCalm);
  const act = async (kind: string) => {
    setBusy(kind);
    try {
      const r = await showAction(kind);
      setNote({ text: r.text ?? (kind === 'clear' ? 'Смена очищена' : 'Готово') });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), bad: true });
    } finally {
      setBusy(null);
    }
  };
  const motion = () => {
    setMotionCalm(!calm);
    setCalm(!calm);
  };
  return (
    <div className="sp" role="toolbar" aria-label="Кнопки ситуаций">
      <div className="sp-grid">
        {BTNS.map((b) => (
          <span key={b.kind} role="button" tabIndex={0} className={`sp-btn t-${b.tone} ${busy === b.kind ? 'busy' : ''}`} onClick={() => act(b.kind)} title={b.label}>
            <b.icon />
            <small>{b.label}</small>
          </span>
        ))}
      </div>
      <div className="sp-side">
        <span className="sp-clear" role="button" tabIndex={0} onClick={() => act('clear')} title="Пустая смена: убрать все инциденты, жалобы, письма и сигналы">
          <Brush /> очистить
        </span>
        <span className={`sp-motion ${calm ? '' : 'on'}`} role="button" tabIndex={0} onClick={motion} title={calm ? 'Анимации спокойные. Щелчок — жёсткие' : 'Анимации жёсткие. Щелчок — спокойные'}>
          <Zap /> {calm ? 'тихо' : 'жёстко'}
        </span>
      </div>
      {note && (
        <p className={`sp-note ${note.bad ? 'bad' : ''}`} key={note.text}>
          {note.text}
        </p>
      )}
    </div>
  );
}
