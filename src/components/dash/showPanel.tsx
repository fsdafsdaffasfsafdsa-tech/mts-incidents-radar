// Кнопки ситуаций — всегда внизу стены. Самотёка нет: ничего не появляется само, каждая кнопка создаёт настоящую
// ситуацию на сервере (server/show.ts) — стена, срочное окно, уведомления и Джарвис реагируют как вживую.
// «Очистить» — пустая смена. Видео пересменки — кнопкой в шапке.
import { useEffect, useState } from 'react';
import { ArrowUp, Brush, Hand, Inbox, Layers, LifeBuoy, Mail, MailWarning, MessagesSquare, Repeat, RotateCcw, Siren, Timer, TrendingUp, UserX, Users, Volume2, VolumeX, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { clearShift, showAction } from '../../store';
import { setCritSound, useCritSound } from '../../lib/critSound';
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
      { kind: 'teamTake', icon: Wrench, label: 'Взяли в работу', tone: 'ok' },
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
  const loud = useCritSound(); // звук и голос при критических (по умолчанию выключены)
  // «очистить», когда смена открыта в другом браузере: первое нажатие предупреждает, второе (в течение 8 с) — чистит у всех
  const [armed, setArmed] = useState(0);
  const act = async (kind: string) => {
    setBusy(kind);
    try {
      if (kind === 'clear') {
        const force = Date.now() < armed;
        const r = await clearShift(force);
        if ('busy' in r) {
          setArmed(Date.now() + 8000);
          setNote({ text: r.error, bad: true });
        } else {
          setArmed(0);
          setNote({ text: 'Смена очищена' });
        }
        return;
      }
      const r = await showAction(kind);
      setNote({ text: r.text ?? 'Готово' });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), bad: true });
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(0), Math.max(0, armed - Date.now()));
    return () => clearTimeout(t);
  }, [armed]);
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
        <span className={`sp-clear ${armed ? 'armed' : ''}`} role="button" tabIndex={0} onClick={() => act('clear')} title={armed ? 'Смена открыта в другом окне: щелчок — очистить у всех' : 'Пустая смена: убрать все инциденты, жалобы, письма и сигналы'}>
          <Brush /> {armed ? 'у всех?' : 'очистить'}
        </span>
        <span className={`sp-motion ${calm ? '' : 'on'}`} role="button" tabIndex={0} onClick={motion} title={calm ? 'Анимации спокойные. Щелчок — жёсткие' : 'Анимации жёсткие. Щелчок — спокойные'}>
          <Zap /> {calm ? 'тихо' : 'жёстко'}
        </span>
        <span className={`sp-motion ${loud ? 'on' : ''}`} role="button" tabIndex={0} aria-pressed={loud} onClick={() => setCritSound(!loud)} title={loud ? 'Критические — со звуком и голосом. Щелчок — только на экране' : 'Критические — только на экране, без звука и голоса. Щелчок — включить звук'}>
          {loud ? <Volume2 /> : <VolumeX />} {loud ? 'звук' : 'без звука'}
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
