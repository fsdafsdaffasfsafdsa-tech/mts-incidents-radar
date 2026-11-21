// Срочное: Джарвис говорит — и экран параллельно показывает линию времени инцидента
// (возник → решён → снова жалобы → сейчас → срок). Внизу — субтитры его речи (слово за словом,
// вопрос выделен) и «слушаю»; кнопок нет — дежурный отвечает голосом.
import { useEffect, useMemo, useState } from 'react';
import { Mic, Siren } from 'lucide-react';
import type { Incident } from '../../../shared/types';
import { ALERT_META, voiceLine, type AlertKind } from '../../../shared/attention';
import { personaById } from '../../../shared/personas';
import { teamName } from '../../store';
import { fmtClock } from '../../lib/format';
import { jarvisPrefs } from '../Jarvis';
import type { Alert } from './attention';
import { shortPlace, splitTitle } from './wall2';

const MIN = 60_000;

/** Что скажет Джарвис — с обращением персонажа. */
function spoken(kind: AlertKind, i: Incident, now: number) {
  const t = voiceLine(kind, i, now, teamName);
  const addr = personaById(jarvisPrefs.persona).address;
  return addr ? `${addr[0].toUpperCase()}${addr.slice(1)}, ${t}` : `${t[0].toUpperCase()}${t.slice(1)}`;
}

/** Субтитры: слова проявляются в темпе речи (~3 слова в секунду), вопрос в конце — выделен. */
function Subtitles({ text, at }: { text: string; at: number }) {
  const p = personaById(jarvisPrefs.persona);
  const words = useMemo(() => text.split(/\s+/), [text]);
  const qStart = useMemo(() => {
    const k = text.lastIndexOf('. ');
    return k > 0 && text.trim().endsWith('?') ? text.slice(0, k + 1).split(/\s+/).length : words.length;
  }, [text, words.length]);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setShown(Math.min(words.length, Math.floor((Date.now() - at) / 330) + 1)), 120);
    return () => clearInterval(t);
  }, [at, words.length]);
  return (
    <div className="us-sub">
      <img className="us-sub-ava" src={p.cutout} alt="" />
      <p>
        {words.map((w, k) => (
          <span key={k} className={`${k < shown ? 'on' : ''} ${k >= qStart ? 'q' : ''}`}>
            {w}{' '}
          </span>
        ))}
      </p>
      <span className="us-mic" title="Слушаю ответ">
        <Mic />
      </span>
    </div>
  );
}

/** «вчера» / «завтра» / «19.11» — если событие не сегодня; сегодня — пусто. */
function dayTag(at: number, now: number) {
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * MIN) / (1440 * MIN));
  const d = day(at) - day(now);
  if (!d) return '';
  if (d === -1) return 'вчера';
  if (d === 1) return 'завтра';
  const x = new Date(at);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}`;
}

/** Линия времени: точки событий появляются по очереди, пока Джарвис говорит. */
function Timeline({ i, now }: { i: Incident; now: number }) {
  const ev: { at: number; text: string; tone: string }[] = [{ at: i.createdAt, text: 'возник', tone: 'n' }];
  if (i.routedAt) ev.push({ at: i.routedAt, text: 'передан', tone: 'n' });
  if (i.startedAt) ev.push({ at: i.startedAt, text: 'взяли', tone: 'n' });
  if (i.resolvedAt) ev.push({ at: i.resolvedAt, text: 'решён', tone: 'ok' });
  if (i.recur) ev.push({ at: i.recur.since, text: 'снова жалобы', tone: 'bad' });
  ev.push({ at: now, text: 'сейчас', tone: 'now' });
  if (i.status !== 'resolved') ev.push({ at: i.slaDeadline, text: 'срок', tone: i.slaDeadline < now ? 'bad' : 'flag' });
  const list = ev.sort((a, b) => a.at - b.at);
  const t0 = list[0].at;
  const t1 = Math.max(list.at(-1)!.at, t0 + MIN);
  // события рядом не налезают: неважные («передан», «взяли») рядом с другими пропускаем,
  // а близкие важные чередуем — подпись над линией и под ней
  const kept: ((typeof list)[number] & { p: number; up: boolean })[] = [];
  for (const e of list) {
    const p = 4 + ((e.at - t0) / (t1 - t0)) * 92;
    const prev = kept.at(-1);
    if (prev && p - prev.p < 7) {
      if (e.tone === 'n') continue;
      if (prev.tone === 'n') {
        kept[kept.length - 1] = { ...e, p, up: prev.up };
        continue;
      }
    }
    kept.push({ ...e, p, up: !!prev && p - prev.p < 14 && !prev.up });
  }
  return (
    <div className="us-tl">
      <i className="us-tl-line" />
      {kept.map((e, k) => (
        <span key={k} className={`us-tl-ev t-${e.tone} ${e.up ? 'up' : ''}`} style={{ left: `${e.p}%`, animationDelay: `${0.3 + k * 0.7}s` }}>
          <i />
          <b className="num">{fmtClock(e.at)}</b>
          <small>
            {dayTag(e.at, now) ? `${dayTag(e.at, now)} · ` : ''}
            {e.text}
          </small>
        </span>
      ))}
    </div>
  );
}

/** Срочное: плашка сверху, название и линия времени по центру, субтитры Джарвиса внизу. */
export function UrgentShow({ list, incidents, now }: { list: Alert[]; incidents: Map<string, Incident>; now: number }) {
  const a = list[0];
  const i = a ? incidents.get(a.inc.id) ?? a.inc : null;
  if (!a || !i) return null;
  const meta = ALERT_META[a.kind];
  const { name, place } = splitTitle(i);
  return (
    <div className={`us-wrap k-${a.kind}`} role="alertdialog" aria-label={`Срочно: ${meta.title}`}>
      <div className="us-dim" />
      <div className="us-kind">
        <Siren /> {meta.title}
        {a.test ? <em>проверка</em> : null}
        {list.length > 1 && <i>+{list.length - 1}</i>}
      </div>
      <div className="us-center">
        <b className="us-name">
          {name}
          {place ? ` · ${shortPlace(place)}` : ''}
        </b>
        <Timeline i={i} now={now} />
      </div>
      <Subtitles text={spoken(a.kind, i, a.at)} at={a.at} />
    </div>
  );
}
