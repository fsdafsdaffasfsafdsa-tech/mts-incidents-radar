// Тревога для критического: экран мигает красным, звучит сирена «БУУМ-БУУМ», пока кто-то не нажмёт «Принял».
// Срабатывает на новый критический на пункте, на повышение до «Наивысшего» и на предложение ИИ поднять до него.
import { useEffect, useRef, useState } from 'react';
import { Siren } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { getState, openIncident, toast, useStore } from '../store';
import { forecast } from '../../shared/forecast';
import { useNow } from '../lib/hooks';
import { siren, unlockAudio } from '../lib/sound';
import { announceIncident, announceText, jarvisPrefs } from './Jarvis';

export function Alarm() {
  const incidents = useStore((s) => s.incidents);
  const on = useStore((s) => s.alarmOn);
  const sound = useStore((s) => s.sound);
  const p1Sound = useStore((s) => s.soundEvents.p1);
  const [inc, setInc] = useState<Incident | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    const hot = [...incidents.values()].filter((i) => i.status !== 'resolved' && (i.priority === 'P1' || i.p1Proposal));
    const keys = hot.map((i) => `${i.id}:${i.priority}:${i.p1Proposal ? 1 : 0}`);
    // Первый снимок — то, что уже было до входа, тревогу не поднимаем.
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const fresh = hot.find((i, k) => !seen.current!.has(keys[k]));
    for (const k of keys) seen.current.add(k);
    if (!fresh || !on || inc) return;
    setInc(fresh);
    unlockAudio();
    if (sound && p1Sound) stop.current = siren();
    if (!jarvisPrefs.scenario)
      announceIncident(fresh.id, fresh.p1Proposal ? `ИИ предлагает поднять «${fresh.title}» до наивысшего. Подтверждаем?` : `новый критический — «${fresh.title}». Что будем делать?`, fresh.p1Proposal && fresh.priority !== 'P1' ? `p1ask:${fresh.id}` : `crit:${fresh.id}`);
  }, [incidents, on]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stop.current?.(), []);
  // «Проверить тревогу» в настройках: берём самый горящий открытый инцидент.
  useEffect(() => {
    const test = () => {
      const list = [...getState().incidents.values()].filter((i) => i.status !== 'resolved');
      const pick = list.find((i) => i.priority === 'P1') ?? list.sort((a, b) => a.slaDeadline - b.slaDeadline)[0];
      if (!pick) return;
      unlockAudio();
      setInc(pick);
      stop.current?.();
      if (getState().sound) stop.current = siren();
      announceIncident(pick.id, `критический — «${pick.title}». Что будем делать?`, `test:${Date.now()}`);
    };
    // Сценарий для жюри: тревога по конкретному инциденту (голос объявления — у сценария).
    const forId = (e: Event) => {
      const pick = getState().incidents.get((e as CustomEvent<string>).detail);
      if (!pick) return;
      unlockAudio();
      setInc(pick);
      stop.current?.();
      if (getState().sound) stop.current = siren();
    };
    window.addEventListener('radar:alarm-test', test);
    window.addEventListener('radar:alarm-for', forId);
    return () => {
      window.removeEventListener('radar:alarm-test', test);
      window.removeEventListener('radar:alarm-for', forId);
    };
  }, []);
  // Джарвис заговорил — сирена смолкает (мигание остаётся до «Принял»);
  // Джарвис открыл этот инцидент по голосовой команде — тревога принята.
  useEffect(() => {
    const quiet = () => {
      stop.current?.();
      stop.current = null;
    };
    const opened = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== incRef.current?.id) return;
      quiet();
      setInc(null);
    };
    window.addEventListener('radar:siren-stop', quiet);
    window.addEventListener('radar:jarvis-open', opened);
    return () => {
      window.removeEventListener('radar:siren-stop', quiet);
      window.removeEventListener('radar:jarvis-open', opened);
    };
  }, []);
  const incRef = useRef(inc);
  incRef.current = inc;
  if (!inc) return null;
  const ack = (open: boolean) => {
    stop.current?.();
    stop.current = null;
    if (open) openIncident(inc.id);
    setInc(null);
  };
  return (
    <div className="alarm" role="alertdialog" aria-label="Критический инцидент">
      <div className="alarm-card">
        <Siren size={42} className="alarm-ico" />
        <div className="alarm-h">{inc.p1Proposal && inc.priority !== 'P1' ? 'ИИ предлагает «Наивысший»' : 'Критический инцидент'}</div>
        <div className="alarm-title">{inc.title}</div>
        <div className="alarm-sub">{inc.origin === 'complaints' ? `${inc.complaints} жалоб · ${inc.regionName ?? ''}` : inc.productName}</div>
        <div className="alarm-act">
          <button className="btn btn-danger" onClick={() => ack(true)} autoFocus>
            Принял — открыть
          </button>
          <button className="btn" onClick={() => ack(false)}>
            Принял
          </button>
        </div>
      </div>
    </div>
  );
}

/** Прогноз: по темпу жалоб инцидент станет критическим в ближайшие 15 минут — предупреждаем заранее (один раз). */
export function ForecastWatch() {
  const now = useNow(15_000);
  const warned = useRef(new Set<string>());
  useEffect(() => {
    const s = getState();
    const rules = s.config?.rules;
    if (!rules) return;
    for (const i of s.incidents.values()) {
      if (jarvisPrefs.scenario || i.origin !== 'complaints' || i.status === 'resolved' || i.priority === 'P1' || i.p1Proposal || warned.current.has(i.id)) continue;
      const f = forecast(i, s.complaints, rules, Date.now());
      if (f?.next?.level !== 'P1' || f.next.inMin > 15) continue;
      warned.current.add(i.id);
      toast({ kind: 'warn', title: `Прогноз: станет критическим через ~${f.next.inMin} мин`, body: `${i.title} · ${f.rate} жалоб/мин, ${f.trend === 'up' ? 'растёт' : 'держится'}`, incidentId: i.id, ttl: 14_000 });
      announceText(`по темпу жалоб ${i.title.replace(/^Жалобы: /, '')} станет критическим примерно через ${f.next.inMin} минут. Поднять уровень заранее?`, i.id, `forecast:${i.id}`);
    }
  }, [now]);
  return null;
}
