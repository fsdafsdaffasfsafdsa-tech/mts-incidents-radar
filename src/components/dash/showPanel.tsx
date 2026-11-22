// Кнопки ситуаций — всегда внизу стены. Самотёка нет: ничего не появляется само, каждая кнопка создаёт настоящую
// ситуацию на сервере (server/show.ts) — стена, срочное окно, уведомления и Джарвис реагируют как вживую.
// «Очистить» — пустая смена. Видео пересменки — кнопкой в шапке.
import { useState } from 'react';
import { ArrowUp, Brush, Hand, Inbox, Layers, LifeBuoy, Mail, MailWarning, MessagesSquare, Repeat, RotateCcw, Siren, Timer, TrendingUp, UserX, Users, Zap, type LucideIcon } from 'lucide-react';
import { showAction } from '../../store';
import { motionCalm, setMotionCalm } from './anim';

type Btn = { kind: string; icon: LucideIcon; label: string; tone: string };
// Четыре группы: инциденты, сроки, вопросы команд, почта.
const GROUPS: { name: string; icon: LucideIcon; btns: Btn[] }[] = [
  {
    name: 'Инциденты',
    icon: Siren,
    btns: [
      { kind: 'crit', icon: Siren, label: 'Критический', tone: 'crit' },
      { kind: 'recur', icon: RotateCcw, label: 'Снова жалобы', tone: 'crit' },
      { kind: 'p1ask', icon: TrendingUp, label: 'ИИ: «Наивысший»', tone: 'crit' },
      { kind: 'coord', icon: Inbox, label: 'Распределить', tone: 'jv' },
      { kind: 'lows', icon: Layers, label: 'Мелкие', tone: 'mid' },
    ],
  },
  {
    name: 'Сроки',
    icon: Timer,
    btns: [
      { kind: 'sla', icon: Timer, label: 'Срок горит', tone: 'high' },
      { kind: 'above', icon: ArrowUp, label: 'Важнее критич.', tone: 'high' },
      { kind: 'stuck', icon: UserX, label: 'Не берут', tone: 'high' },
    ],
  },
  {
    name: 'Команды',
    icon: Users,
    btns: [
      { kind: 'teamNotOurs', icon: Hand, label: 'Не наше', tone: 'mid' },
      { kind: 'teamHelp', icon: LifeBuoy, label: 'Нужна помощь', tone: 'mid' },
      { kind: 'pingpong', icon: Repeat, label: 'По кругу', tone: 'mid' },
      { kind: 'leadQ', icon: MessagesSquare, label: 'Спросить руковод.', tone: 'jv' },
    ],
  },
  {
    name: 'Почта',
    icon: Mail,
    btns: [
      { kind: 'mailCrit', icon: MailWarning, label: 'Письмо: сбой', tone: 'jv' },
      { kind: 'mailAsk', icon: Mail, label: 'Письмо: не к нам', tone: 'jv' },
    ],
  },
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
        {GROUPS.map((g) => (
          <div key={g.name} className="sp-grp" style={{ flexGrow: g.btns.length }} role="group" aria-label={g.name}>
            <i className="sp-grp-name">
              <g.icon /> {g.name}
            </i>
            {g.btns.map((b) => (
              <span key={b.kind} role="button" tabIndex={0} className={`sp-btn t-${b.tone} ${busy === b.kind ? 'busy' : ''}`} onClick={() => act(b.kind)} title={b.label}>
                <b.icon />
                <small>{b.label}</small>
              </span>
            ))}
          </div>
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
