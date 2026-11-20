// Видеостена пункта: широкий экран над рабочими местами. Видно с расстояния, без кнопок, всегда тёмная.
// Слева — часы и счётчики, в центре — карта жалоб, справа — что горит, внизу — бегущая строка событий.
// Можно открыть отдельно на компьютере стены: адрес с ?wall (нужен вход дежурного).
import { useEffect, useMemo, useState } from 'react';
import { Expand, MonitorUp, Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { fmtClock, fmtDur, urgency } from '../lib/format';
import { useNow } from '../lib/hooks';
import { RFMap } from './RFMap';
import { Spark } from './kit';

export function WallPage({ standalone = false }: { standalone?: boolean }) {
  const incidents = useStore((s) => s.incidents);
  const complaints = useStore((s) => s.complaints);
  const signals = useStore((s) => s.signals);
  const feed = useStore((s) => s.feed);
  const stats = useStore((s) => s.stats);
  const teamIndex = useStore((s) => s.teamIndex);
  const now = useNow(1000);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  const k = useMemo(() => {
    const all = [...incidents.values()];
    const open = all.filter((i) => i.status !== 'resolved');
    const series = new Array(12).fill(0);
    for (const c of complaints) {
      const b = Math.floor((now - c.at) / 300_000);
      if (b >= 0 && b < 12) series[11 - b]++;
    }
    return {
      atPoint: open.filter((i) => i.status === 'coordinators').length,
      atTeams: open.filter((i) => i.status === 'assigned' || i.status === 'in_progress').length,
      done: all.filter((i) => i.status === 'resolved' && i.resolvedAt && now - i.resolvedAt < 3_600_000).length,
      signals: [...signals.values()].filter((s) => s.status !== 'closed').length,
      waiting: open.filter((i) => (i.escalation ?? 0) >= 1 && i.status === 'assigned' && !i.assignee).length,
      critical: open.filter((i) => i.priority === 'P1' || i.p1Proposal).length,
      ai: all.reduce((n, i) => n + i.history.filter((h) => h.kind === 'ai' && now - h.at < 3_600_000).length, 0),
      // На стене важнее то, что происходит сейчас: критические и предложения «Наивысшего», затем инциденты из жалоб, затем остальное.
      hot: open
        .sort((a, b) => {
          const w = (i: typeof a) => (i.priority === 'P1' || i.p1Proposal ? 2000 : 0) + (i.origin === 'complaints' ? 1000 + Math.min(900, i.complaints ?? 0) : 0);
          return w(b) - w(a) || urgency(b, now) - urgency(a, now);
        })
        .slice(0, 7),
      series,
    };
  }, [incidents, complaints, signals, now]);
  const ticker = feed.slice(0, 14);

  return (
    <div className={`wall ${standalone ? 'standalone' : ''}`}>
      <section className="w-left">
        <div className="w-clock num">{fmtClock(now)}</div>
        <div className="w-date">
          {new Date(now).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })} · МСК
        </div>
        <div className="w-kpis">
          <div className="w-kpi big">
            <span className="num">{stats?.flowPerMin ?? 0}</span>
            <span>жалоб в минуту</span>
            <Spark values={k.series} width={220} height={40} />
          </div>
          <div className={`w-kpi ${k.atPoint ? 'warn' : ''}`}>
            <span className="num">{k.atPoint}</span>
            <span>на пункте</span>
          </div>
          <div className="w-kpi">
            <span className="num">{k.atTeams}</span>
            <span>у команд</span>
          </div>
          <div className={`w-kpi ${k.critical ? 'hot' : ''}`}>
            <span className="num">{k.critical}</span>
            <span>критических</span>
          </div>
          <div className={`w-kpi ${k.waiting ? 'warn' : ''}`}>
            <span className="num">{k.waiting}</span>
            <span>не взяли 10+ мин</span>
          </div>
          <div className={`w-kpi ${k.signals ? 'warn' : ''}`}>
            <span className="num">{k.signals}</span>
            <span>сигналов</span>
          </div>
          <div className="w-kpi ok">
            <span className="num">{k.done}</span>
            <span>решено за час</span>
          </div>
        </div>
        <div className="w-ai">
          <Sparkles size={18} /> ИИ за час: <b className="num">{k.ai}</b> действий
        </div>
      </section>

      <section className="w-map">
        <RFMap forceTheme="dark" />
      </section>

      <section className="w-hot">
        <h2>Горит сейчас</h2>
        {!k.hot.length && <div className="w-empty">Всё спокойно</div>}
        {k.hot.map((i) => {
          const left = i.slaDeadline - now;
          return (
            <div key={i.id} className={`w-row p-${i.priority}`}>
              <span className="w-bar" />
              <span className="w-main">
                <b>{i.title}</b>
                <span>
                  {i.status === 'coordinators' ? 'на пункте' : teamIndex.get(i.teamId ?? '')?.name ?? '—'}
                  {i.assigneeName ? ` · ${i.assigneeName}` : ''}
                  {i.origin === 'complaints' ? ` · ${i.complaints} жалоб` : ''}
                </span>
              </span>
              <span className={`w-left-time num ${left < 30 * 60_000 ? 'hot' : ''}`}>{left > 0 ? fmtDur(left) : 'срок прошёл'}</span>
            </div>
          );
        })}
      </section>

      <footer className="w-ticker">
        <div className="w-track">
          {[...ticker, ...ticker].map((e, n) => (
            <span key={`${e.id}${n}`} className={`w-ev k-${e.kind}`}>
              <b className="num">{fmtClock(e.at)}</b> {e.text}
              <i>·</i> {incidents.get(e.incidentId)?.title ?? ''}
            </span>
          ))}
        </div>
      </footer>

      {!full && (
        <div className="w-tools">
          {!standalone && (
            <button className="btn btn-sm" onClick={() => window.open('/?wall', 'radar-wall', 'noopener')} title="Открыть в отдельном окне — перенести на экран стены">
              <MonitorUp size={14} /> На экран стены
            </button>
          )}
          <button className="btn btn-sm" onClick={() => void document.documentElement.requestFullscreen?.()} title="На весь экран (Esc — выйти)">
            <Expand size={14} /> На весь экран
          </button>
        </div>
      )}
    </div>
  );
}
