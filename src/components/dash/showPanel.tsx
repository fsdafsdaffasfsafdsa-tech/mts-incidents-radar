// Пульт показа: ситуации запускаются кнопками, самотёк на паузе. Для ведущего, не для жюри: открывается по адресу
// с ?show или по Ctrl+Shift+S, сворачивается в маленькую кнопку. Каждая кнопка создаёт настоящую ситуацию на сервере
// (server/show.ts) — стена, уведомления и Джарвис реагируют как вживую.
import { useEffect, useState } from 'react';
import { ArrowUp, Brush, Clapperboard, Inbox, Mail, MailWarning, Pause, Play, Repeat, RotateCcw, Siren, Timer, TrendingUp, UserX, X, Zap, type LucideIcon } from 'lucide-react';
import { readLocal, showAction, showState, writeLocal } from '../../store';
import { motionCalm, setMotionCalm } from './anim';
import { openHandover } from './handover';

const BTNS: { kind: string; icon: LucideIcon; label: string; tone: string }[] = [
  { kind: 'crit', icon: Siren, label: 'Критический', tone: 'crit' },
  { kind: 'coord', icon: Inbox, label: 'На распределение', tone: 'jv' },
  { kind: 'recur', icon: RotateCcw, label: 'Решили — снова жалобы', tone: 'crit' },
  { kind: 'above', icon: ArrowUp, label: 'Важнее критического', tone: 'high' },
  { kind: 'sla', icon: Timer, label: 'Срок горит', tone: 'high' },
  { kind: 'stuck', icon: UserX, label: 'Команда не берёт', tone: 'high' },
  { kind: 'pingpong', icon: Repeat, label: 'Передают по кругу', tone: 'mid' },
  { kind: 'p1ask', icon: TrendingUp, label: 'ИИ: «Наивысший»?', tone: 'crit' },
  { kind: 'mailCrit', icon: MailWarning, label: 'Письмо о сбое', tone: 'jv' },
  { kind: 'mailAsk', icon: Mail, label: 'Письмо: переназначить', tone: 'jv' },
];

export function ShowPanel() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has('show') || readLocal<boolean>('radar.show.panel', false));
  const [show, setShow] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [calm, setCalm] = useState(motionCalm);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    writeLocal('radar.show.panel', open);
    if (open) void showState().then((s) => setShow(s?.show ?? null));
  }, [open]);
  if (!open) return null;
  const act = async (kind: string) => {
    setBusy(kind);
    try {
      const r = await showAction(kind);
      if (kind === 'on' || kind === 'off') setShow(kind === 'on');
      setNote(r.text ?? (kind === 'clear' ? 'Смена очищена' : kind === 'on' ? 'Самотёк выключен — всё по кнопкам' : kind === 'off' ? 'Самотёк включён' : 'Готово'));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="sp" role="region" aria-label="Пульт показа">
      <div className="sp-head">
        <b>Пульт показа</b>
        <span className={`sp-mode ${show ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => act(show ? 'off' : 'on')} title={show ? 'Сейчас всё по кнопкам. Щелчок — включить самотёк' : 'Сейчас всё идёт само. Щелчок — только по кнопкам'}>
          {show ? <Pause /> : <Play />} {show ? 'по кнопкам' : 'самотёк'}
        </span>
        <span className={`sp-mode sp-motion ${calm ? '' : 'on'}`} role="button" tabIndex={0} onClick={() => (setMotionCalm(!calm), setCalm(!calm))} title={calm ? 'Анимации спокойные. Щелчок — жёсткие' : 'Анимации жёсткие. Щелчок — спокойные'}>
          <Zap /> {calm ? 'тихо' : 'жёстко'}
        </span>
        <span className="sp-clear" role="button" tabIndex={0} onClick={() => act('clear')} title="Чистая смена: убрать все инциденты, жалобы, письма и сигналы">
          <Brush /> очистить
        </span>
        <span className="sp-x" role="button" tabIndex={0} onClick={() => setOpen(false)} title="Свернуть (Ctrl+Shift+S)">
          <X />
        </span>
      </div>
      <div className="sp-grid">
        {BTNS.map((b) => (
          <span key={b.kind} role="button" tabIndex={0} className={`sp-btn t-${b.tone} ${busy === b.kind ? 'busy' : ''}`} onClick={() => act(b.kind)}>
            <b.icon />
            <small>{b.label}</small>
          </span>
        ))}
        <span role="button" tabIndex={0} className="sp-btn t-ok" onClick={openHandover}>
          <Clapperboard />
          <small>Пересменка</small>
        </span>
      </div>
      {note && <p className="sp-note">{note}</p>}
    </div>
  );
}
