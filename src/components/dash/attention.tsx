// Уведомления стены в три уровня (shared/attention.ts):
//   «Срочно»   — на весь экран, звук, помощник говорит голосом и ждёт ответа («беру», «верни в работу», «принял»);
//                после «Принял» остаётся полосой, пока ситуация не ушла;
//   «Внимание» — полосой сверху, мягкий звук, уходит сама;
//   «Инфо»     — тихой строкой без звука.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, CheckCircle2, ExternalLink, Eye, Info, Mic, RotateCcw, Send, Siren, Star, Timer, UserCheck, X } from 'lucide-react';
import { serviceIcon, shortPlace, splitTitle } from './wall2';
import { timerText } from './blocks3';
import type { Incident } from '../../../shared/types';
import { ALERT_META, detect, levelOf, stillUrgent, voiceLine, type AlertKind, type Found, type Level, type Sig } from '../../../shared/attention';
import { dashSnapshot, fmtShort, isRecurring } from '../../../shared/dash';
import { answerP1, getState, reopenIncident, routeTo, takeAtPoint, teamName } from '../../store';
import { fmtClock } from '../../lib/format';
import { useDashEvents, type DashLayout } from '../../lib/dashLayout';
import { announceText } from '../Jarvis';

export interface Alert {
  key: string;
  kind: AlertKind;
  level: Level;
  inc: Incident;
  text?: string;
  at: number;
  until: number;
  acked?: boolean;
  coord: string | null; // кто вёл в момент тревоги — «взяли» = сменился
  test?: boolean;
}
export interface InfoItem {
  key: string;
  kind: AlertKind;
  inc: Incident;
  text?: string;
  at: number;
}

const ORDER: AlertKind[] = ['crit', 'recur', 'p1ask', 'critStuck', 'critSla', 'coord', 'resolvedCrit', 'remind', 'slaHigh', 'notTaken', 'pingpong', 'fav', 'forgot'];
const rank = (k: AlertKind) => (ORDER.includes(k) ? ORDER.indexOf(k) : 50);
const byRank = (a: Alert, b: Alert) => Number(!!a.acked) - Number(!!b.acked) || rank(a.kind) - rank(b.kind) || b.at - a.at;
const URGENT_LIFE = 10 * 60_000;
const LIFE: Partial<Record<AlertKind, number>> = { remind: 40_000, resolvedCrit: 45_000 };
const FORGOT_EVERY = 10 * 60_000;

function chime(kind: 'urgent' | 'good' | 'soft') {
  try {
    const ctx = new AudioContext();
    const notes = kind === 'urgent' ? [880, 660, 880, 660] : kind === 'good' ? [523, 659, 784] : [587, 740];
    notes.forEach((f, k) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = kind === 'urgent' ? 'square' : 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + k * 0.22);
      g.gain.exponentialRampToValueAtTime(kind === 'soft' ? 0.1 : 0.18, ctx.currentTime + k * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + k * 0.22 + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + k * 0.22);
      o.stop(ctx.currentTime + k * 0.22 + 0.22);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    /* без звука */
  }
}

/** Следит за инцидентами и раскладывает события по уровням. На отдельном экране стены голосом не говорит. */
export function useAttention(incidents: Map<string, Incident>, d: DashLayout, standalone: boolean) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [info, setInfo] = useState<InfoItem[]>([]);
  const dRef = useRef(d);
  dRef.current = d;
  const prev = useRef<Map<string, Sig> | null>(null);
  const fired = useRef(new Set<string>());
  const favPrev = useRef<Map<string, string> | null>(null);

  const push = useCallback(
    (list: Found[], test = false) => {
      const now = Date.now();
      const fresh: Alert[] = [];
      const quiet: InfoItem[] = [];
      for (const f of list) {
        const level = levelOf(f.kind, f.inc);
        const key = `${f.kind}-${f.inc.id}-${now}`;
        if (level === 'info') quiet.push({ key, kind: f.kind, inc: f.inc, text: f.text, at: now });
        else if (dRef.current.banners) fresh.push({ key, kind: f.kind, level, inc: f.inc, text: f.text, at: now, until: now + (level === 'urgent' ? URGENT_LIFE : (LIFE[f.kind] ?? 25_000)), coord: f.inc.coordinatorId ?? null, test });
      }
      if (quiet.length) setInfo((l) => [...quiet, ...l].filter((x) => now - x.at < 30 * 60_000).slice(0, 40));
      if (!fresh.length) return;
      fresh.sort(byRank);
      setAlerts((l) => [...l.filter((x) => !fresh.some((f) => f.inc.id === x.inc.id && f.kind === x.kind)), ...fresh].sort(byRank));
      const top = fresh[0];
      if (dRef.current.sound) chime(top.level === 'urgent' ? 'urgent' : top.kind === 'resolvedCrit' ? 'good' : 'soft');
      // Всё, что «срочно» и «внимание», говорит помощник — с вопросом, что делаем; мелочи («инфо») — молча.
      // На отдельном экране стены не говорим: голос — в окне дежурного.
      if (!standalone) for (const a of fresh.slice(0, 3)) announceText(voiceLine(a.kind, a.inc, now, teamName), a.inc.id, `${a.kind}:${a.inc.id}`);
    },
    [standalone],
  );

  const scan = useCallback(() => {
    const now = Date.now();
    const all = [...getState().incidents.values()].filter((i) => !dRef.current.onlyFile || i.origin !== 'complaints');
    const { found, next } = detect(prev.current, all, now, fired.current);
    prev.current = next;
    // избранное: решён, передан, сменился уровень — сразу видно всей смене
    const favs = new Map(all.filter((i) => i.pin).map((i) => [i.id, `${i.status}|${i.priority}|${i.teamId}`]));
    if (favPrev.current)
      for (const [id, sig] of favs) {
        const was = favPrev.current.get(id);
        if (!was || was === sig) continue;
        const i = all.find((x) => x.id === id)!;
        const [st, pr, tm] = was.split('|');
        found.push({ kind: 'fav', inc: i, text: i.status === 'resolved' && st !== 'resolved' ? 'решён' : i.teamId !== tm ? `передан: ${teamName(i.teamId)}` : i.priority !== pr ? `уровень: ${i.priorityText}` : 'изменился статус' });
      }
    favPrev.current = favs;
    if (found.length) push(found);
  }, [push]);
  useEffect(scan, [incidents, scan]);

  // По часам: состояния (срок на исходе, не берут), напоминания из избранного, «не забудьте»; срочное — пока актуально.
  const remindFired = useRef(new Set<string>());
  const lastForgot = useRef(Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      scan();
      const all = [...getState().incidents.values()];
      const extra: Found[] = [];
      for (const i of all)
        if (i.pin?.remindAt && i.pin.remindAt <= now && now - i.pin.remindAt < 10 * 60_000) {
          const k = `${i.id}:${i.pin.remindAt}`;
          if (!remindFired.current.has(k)) (remindFired.current.add(k), extra.push({ kind: 'remind', inc: i, text: i.pin.note || 'напоминание' }));
        }
      if (now - lastForgot.current >= FORGOT_EVERY) {
        lastForgot.current = now;
        const snap = dashSnapshot(all, now, { onlyFile: dRef.current.onlyFile });
        const top = snap.forgotten[0];
        if (top) extra.push({ kind: 'forgot', inc: top.inc, text: `${snap.forgotten.length} важн. без внимания · ${fmtShort(top.idle)}` });
      }
      if (extra.length) push(extra);
    }, 15_000);
    return () => clearInterval(t);
  }, [push, scan]);

  // Раз в секунду: убрать ушедшее (срочное — когда ситуация разрешилась).
  useEffect(() => {
    if (!alerts.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      const st = getState().incidents;
      setAlerts((l) => {
        const out = l.filter((a) => a.until > now && (a.level !== 'urgent' || a.test || stillUrgent(a.kind, st.get(a.inc.id), now, a.coord)));
        return out.length === l.length ? l : out;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [alerts.length]);

  // Непринятое срочное напоминает о себе звуком раз в 45 секунд.
  const hasOpen = alerts.some((a) => a.level === 'urgent' && !a.acked);
  useEffect(() => {
    if (!hasOpen) return;
    const t = setInterval(() => dRef.current.sound && chime('urgent'), 45_000);
    return () => clearInterval(t);
  }, [hasOpen]);

  const ack = useCallback((key?: string) => setAlerts((l) => l.map((a) => (key ? a.key === key : a === l.find((x) => x.level === 'urgent' && !x.acked)) ? { ...a, acked: true } : a).sort(byRank)), []);
  const dismiss = useCallback((key?: string) => setAlerts((l) => (key ? l.filter((a) => a.key !== key) : l.filter((a) => a !== l.find((x) => x.level !== 'urgent' || x.acked)))), []);
  // «Принял», «беру» голосом — Джарвис сообщает, о каком инциденте речь.
  useEffect(() => {
    const f = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setAlerts((l) => l.map((a) => (a.inc.id === id && a.level === 'urgent' ? { ...a, acked: true } : a)).sort(byRank));
    };
    window.addEventListener('radar:ack', f);
    return () => window.removeEventListener('radar:ack', f);
  }, []);
  useDashEvents(
    useCallback(
      (e) => {
        if (e.type !== 'test-alarm') return;
        const list = [...getState().incidents.values()];
        const any = (e.kind === 'recur' ? list.find((i) => isRecurring(i, Date.now())) : undefined) ?? list.find((i) => i.status !== 'resolved') ?? list[0];
        if (any) push([{ kind: e.kind, inc: any, text: e.kind === 'recur' ? '«Billing L2» решила 4 мин назад · снова 7 жалоб' : undefined }], true);
      },
      [push],
    ),
  );

  return useMemo(
    () => ({
      urgent: alerts.filter((a) => a.level === 'urgent' && !a.acked),
      strip: alerts.filter((a) => a.level !== 'urgent' || a.acked),
      info,
      ack,
      dismiss,
    }),
    [alerts, info, ack, dismiss],
  );
}

const left = (i: Incident, now: number) => (i.slaDeadline - now > 0 ? fmtShort(i.slaDeadline - now) : `−${fmtShort(now - i.slaDeadline)}`);

/** Главное действие по срочному — одной кнопкой (у проверочных тревог действий нет). */
function primaryOf(a: Alert, i: Incident): { label: string; icon: React.ReactNode; run: () => void; alt?: { label: string; run: () => void } } | null {
  if (a.test) return null;
  if (a.kind === 'recur' && i.status === 'resolved') return { label: 'Вернуть в работу', icon: <RotateCcw size={18} />, run: () => void reopenIncident(i.id) };
  if ((a.kind === 'crit' || a.kind === 'coord') && i.status === 'coordinators' && i.ai?.teamId)
    return { label: `Передать: ${teamName(i.ai.teamId).split(' · ')[0]}`, icon: <Send size={18} />, run: () => void routeTo(i.id, i.ai.teamId!), alt: !i.coordinatorId ? { label: 'Беру на себя', run: () => void takeAtPoint(i.id) } : undefined };
  if ((a.kind === 'crit' || a.kind === 'coord') && i.status !== 'resolved' && !i.coordinatorId) return { label: 'Беру на себя', icon: <UserCheck size={18} />, run: () => void takeAtPoint(i.id) };
  if (a.kind === 'p1ask' && i.p1Proposal) return { label: 'Поднять до «Наивысшего»', icon: <Siren size={18} />, run: () => void answerP1(i.id, true), alt: { label: 'Отклонить', run: () => void answerP1(i.id, false) } };
  return null;
}

/** Вопрос, который задаёт помощник, — одной строкой крупно. */
function questionOf(a: Alert, i: Incident) {
  switch (a.kind) {
    case 'recur':
      return 'Вернуть в работу?';
    case 'crit':
    case 'coord':
      return i.status === 'coordinators' && i.ai?.teamId ? `Передать «${teamName(i.ai.teamId).split(' · ')[0]}»?` : i.coordinatorId ? 'Что будем делать?' : 'Взять на себя?';
    case 'p1ask':
      return 'Поднять до наивысшего?';
    case 'critStuck':
      return 'Указать руководителю команды?';
    default:
      return 'Что будем делать?';
  }
}

/**
 * Срочное — «режим фокуса» на всю стену (по предложению ChatGPT): крупная пиктограмма сервиса, сервис и место,
 * таймер, один вопрос и одна главная кнопка; помощник спрашивает голосом и ждёт ответа. Шар помощника — поверх.
 */
export function UrgentOverlay({ list, incidents, now, onAck, onOpen }: { list: Alert[]; incidents: Map<string, Incident>; now: number; onAck: (key: string) => void; onOpen: (i: Incident) => void }) {
  const a = list[0];
  if (!a) return null;
  const i = incidents.get(a.inc.id) ?? a.inc;
  const meta = ALERT_META[a.kind];
  const act = primaryOf(a, i);
  const Icon = serviceIcon(i);
  const { name, place } = splitTitle(i);
  const left = i.slaDeadline - now;
  return (
    <div className={`dur-wrap k-${a.kind}`} role="alertdialog" aria-label={`Срочно: ${meta.title}`}>
      <div className="dur dur2">
        <div className="dur-top">
          <Siren size={22} />
          <b>{meta.title}</b>
          {a.test && <em>проверка</em>}
          {list.length > 1 && <span className="dur-more">+{list.length - 1}</span>}
        </div>
        <div className="dur-main">
          <span className="dur-ill">
            <Icon />
          </span>
          <div className="dur-what">
            <h1>{name}</h1>
            {place && <p className="dur-place">{shortPlace(place)}</p>}
            <p className={`dur-timer ${i.status === 'resolved' || left < 30 * 60_000 ? 'hot' : ''}`}>
              {i.status === 'resolved' && i.recur ? (
                <>
                  <RotateCcw /> снова {i.recur.count}
                </>
              ) : (
                <>
                  <Timer /> <b className="num">{timerText(left)}</b>
                </>
              )}
            </p>
          </div>
        </div>
        <p className="dur-q">{questionOf(a, i)}</p>
        <div className="dur-act">
          {act && (
            <button
              className="main"
              onClick={() => {
                act.run();
                onAck(a.key);
              }}
            >
              {act.icon} {act.label}
            </button>
          )}
          {act?.alt && (
            <button
              onClick={() => {
                act.alt!.run();
                onAck(a.key);
              }}
            >
              {act.alt.label}
            </button>
          )}
          <button onClick={() => onAck(a.key)}>
            <CheckCircle2 size={18} /> Принял
          </button>
          <button className="icon" onClick={() => onOpen(i)} title="Открыть в ITSM" aria-label="Открыть в ITSM">
            <ExternalLink size={18} />
          </button>
        </div>
        <p className="dur-voice">
          <span className="dur-mic">
            <Mic size={16} />
          </span>
          Ожидаю голосовую команду
        </p>
      </div>
    </div>
  );
}

const STRIP_ICON: Partial<Record<AlertKind, React.ReactNode>> = { resolvedCrit: <CheckCircle2 size={20} />, remind: <Star size={20} />, fav: <Star size={20} />, forgot: <Eye size={20} />, recur: <RotateCcw size={20} /> };

/** Полоса «Внимание» (и принятые срочные, пока ситуация не ушла). Пусто — тихая строка «Инфо». */
export function AttentionStrip({ list, info, incidents, now, onClose, onOpen }: { list: Alert[]; info: InfoItem[]; incidents: Map<string, Incident>; now: number; onClose: (key: string) => void; onOpen: (i: Incident) => void }) {
  if (!list.length) return <InfoLine info={info} incidents={incidents} now={now} onOpen={onOpen} />;
  return (
    <div className="dash-alerts" role="status">
      {list.slice(0, 3).map((a) => {
        const i = incidents.get(a.inc.id) ?? a.inc;
        const act = a.level === 'urgent' ? primaryOf(a, i) : null;
        return (
          <div key={a.key} className={`dal k-${a.kind} lv-${a.level}`}>
            <button className="dal-in" onClick={() => onOpen(i)} title="Открыть">
              {STRIP_ICON[a.kind] ?? (a.level === 'urgent' ? <Siren size={20} /> : <BellRing size={20} />)}
              <span className="dal-t">
                <small>
                  {a.level === 'urgent' ? 'Срочно · ' : ''}
                  {ALERT_META[a.kind].title}
                  {a.test ? ' · проверка' : ''}
                </small>
                <b>{i.title}</b>
                {a.text && <em>{a.text}</em>}
              </span>
              <span className="dal-r num">{a.kind === 'resolvedCrit' ? `за ${fmtShort((i.resolvedAt ?? now) - i.createdAt)}` : i.status === 'resolved' ? '✓' : left(i, now)}</span>
            </button>
            {act && (
              <button className="dal-do" onClick={act.run}>
                {act.label}
              </button>
            )}
            {a.level !== 'urgent' && (
              <button className="dal-x" onClick={() => onClose(a.key)} aria-label="Скрыть">
                <X size={15} />
              </button>
            )}
            {a.level !== 'urgent' && <i className="dal-life" style={{ animationDuration: `${a.until - a.at}ms` }} />}
          </div>
        );
      })}
      {list.length > 3 && <span className="dal-more">ещё {list.length - 3}</span>}
    </div>
  );
}

/** «Инфо»: мелочи тихой строкой — решён, передан, взяли в работу. Последние по очереди, без звука. */
function InfoLine({ info, incidents, now, onOpen }: { info: InfoItem[]; incidents: Map<string, Incident>; now: number; onOpen: (i: Incident) => void }) {
  const recent = info.filter((x) => now - x.at < 15 * 60_000);
  const [k, setK] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setK((x) => x + 1), 6000);
    return () => clearInterval(t);
  }, []);
  if (!recent.length)
    return (
      <div className="dash-alerts idle" aria-live="polite">
        <span className="dal-idle">
          <CheckCircle2 size={15} /> Срочного нет
        </span>
      </div>
    );
  const cur = recent[k % Math.min(recent.length, 5)];
  const i = incidents.get(cur.inc.id) ?? cur.inc;
  return (
    <div className="dash-alerts idle" aria-live="polite">
      <button className="dal-idle dal-info" key={cur.key} onClick={() => onOpen(i)} title="Открыть">
        <Info size={15} />
        <b className="num">{fmtClock(cur.at)}</b>
        <span>{ALERT_META[cur.kind].title}</span>
        <span className="dal-info-t">{i.title}</span>
        {cur.text && <em>· {cur.text}</em>}
      </button>
      {recent.length > 1 && <span className="dal-info-n">ещё {recent.length - 1} за 15 мин</span>}
    </div>
  );
}
