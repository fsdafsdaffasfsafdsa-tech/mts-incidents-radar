// Карточка инцидента — боковая шторка, как карточка поездки в такси-приложении.
import { useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  Eye,
  Link2,
  MapPin,
  Minus,
  MoreHorizontal,
  Navigation,
  Send,
  Siren,
  TrendingDown,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type { Incident } from '../../shared/types';
import { act, select, useStore } from '../store';
import { PRIO_LABEL, STATUS_LABEL, fmtAgo, fmtClock, fmtUsers } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Avatar, Prio, SlaTimer } from './bits';
import { SysIcon } from './SysIcon';
import { AiPanel } from './AiPanel';

const SOURCE: Record<Incident['source'], string> = {
  monitoring: 'мониторинг',
  support: 'обращения абонентов',
  partner: 'партнёр',
  user: 'жалоба абонента',
};

export function IncidentSheet() {
  const inc = useStore((s) => (s.selectedId ? s.incidents.get(s.selectedId) : undefined));
  if (!inc) return null;
  return <Sheet key={inc.id} inc={inc} />;
}

function Sheet({ inc }: { inc: Incident }) {
  const system = useStore((s) => s.systems.find((x) => x.id === inc.systemId));
  const teams = useStore((s) => s.teams);
  const now = useNow(1000);
  const [assignOpen, setAssignOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const resolved = inc.status === 'resolved';
  const team = teams.find((t) => t.id === inc.teamId);

  useEffect(() => {
    const close = () => {
      setAssignOpen(false);
      setMoreOpen(false);
    };
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, []);

  return (
    <section className={`sheet p-${inc.priority}`} aria-label={`Инцидент ${inc.id}`}>
      <div className="sheet-scroll">
        <header className="sh-head">
          <div className="sh-tags">
            <Prio p={inc.priority} size="lg" />
            <span className="sh-prio">{PRIO_LABEL[inc.priority]}</span>
            <span className={`pill st st-${inc.status}`}>{STATUS_LABEL[inc.status]}</span>
            {!inc.acknowledged && !resolved && <span className="pill pill-unack">новый</span>}
            <span className="grow" />
            <button className="icon-btn" onClick={() => select(null)} aria-label="Закрыть карточку" title="Закрыть (Esc)">
              <X size={18} />
            </button>
          </div>
          <h1 className="sh-title">{inc.title}</h1>
          <div className="sh-where">
            <span className="sh-sys">
              <SysIcon systemId={inc.systemId} size={14} /> {system?.short}
            </span>
            <span className="sep">·</span>
            <span>{inc.service}</span>
            <span className="sep">·</span>
            <span>
              <MapPin size={12} /> {inc.region}
            </span>
          </div>
          <div className="sh-meta num">
            {inc.id} · создан {fmtAgo(now - inc.createdAt)} · {SOURCE[inc.source]}
          </div>
        </header>

        <div className="sh-eta">
          <div className="eta-sla">
            <span className="eta-label">До нарушения SLA</span>
            <SlaTimer inc={inc} big />
            <span className="eta-sub">срок {fmtClock(inc.slaDeadline)}</span>
          </div>
          <div className="eta-who">
            <span className="eta-label">Кто решает</span>
            {inc.status === 'coordinators' ? (
              <>
                <span className="who-main coord">Координаторы</span>
                <span className="eta-sub">команда не выбрана</span>
              </>
            ) : (
              <>
                <span className="who-main">{team?.short ?? '—'}</span>
                <span className="eta-sub person">
                  {inc.assignee ? (
                    <>
                      <Avatar name={inc.assignee} /> {inc.assignee}
                    </>
                  ) : (
                    <span className="warn">исполнитель не взял</span>
                  )}
                </span>
              </>
            )}
          </div>
        </div>

        {inc.crew && <CrewRow inc={inc} now={now} />}

        <div className="sh-impact">
          <span>
            <Users size={14} /> {inc.affectedUsers > 0 ? `≈ ${fmtUsers(inc.affectedUsers)} абонентов` : 'абоненты не затронуты'}
          </span>
          <span className={`trend-${inc.trend}`}>
            {inc.trend === 'growing' ? <TrendingUp size={14} /> : inc.trend === 'declining' ? <TrendingDown size={14} /> : <Minus size={14} />}
            {inc.trend === 'growing' ? 'ухудшается' : inc.trend === 'declining' ? 'восстанавливается' : 'стабильно'}
          </span>
          {inc.relatedIds.length > 0 && (
            <span>
              <Link2 size={14} /> связан с {inc.relatedIds.length}
            </span>
          )}
        </div>

        <AiPanel inc={inc} />

        <button className="sh-details-toggle" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
          Сигналы, описание и хронология <ChevronDown size={15} className={details ? 'rot' : ''} />
        </button>
        {details && (
          <div className="sh-details">
            <ul className="signals">
              {inc.signals.map((s) => (
                <li key={s} className="num">
                  {s}
                </li>
              ))}
            </ul>
            <p className="desc">{inc.description}</p>
            <ol className="timeline">
              {[...inc.history].reverse().map((h, i) => (
                <li key={i} className={`tl-${h.kind}`}>
                  <span className="tl-time num">{fmtClock(h.at)}</span>
                  <span className="tl-text">{h.text}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {!resolved && (
        <footer className="sh-actions">
          {!inc.acknowledged ? (
            <button className="btn btn-primary" onClick={() => void act(inc.id, 'ack')} title="A">
              <Eye size={15} /> Взять на контроль
            </button>
          ) : (
            <span className="sh-acked">
              <Eye size={14} /> на контроле
            </span>
          )}
          <div className="menu-wrap">
            <button className="btn" onClick={() => setAssignOpen((v) => !v)} aria-expanded={assignOpen}>
              <Send size={15} /> Передать <ChevronDown size={14} />
            </button>
            {assignOpen && (
              <div className="popover up assign-pop">
                {teams
                  .filter((t) => !t.isCoordinators)
                  .map((t) => (
                    <button
                      key={t.id}
                      className={t.id === inc.teamId ? 'current' : ''}
                      onClick={() => {
                        setAssignOpen(false);
                        void act(inc.id, 'assign', { teamId: t.id, byAi: t.id === inc.ai.teamId });
                      }}
                    >
                      <span>{t.name}</span>
                      {t.id === inc.ai.teamId && <span className="ai-tag">ИИ</span>}
                      {t.id === inc.teamId && <span className="muted">сейчас</span>}
                    </button>
                  ))}
              </div>
            )}
          </div>
          <button className="btn btn-ok" onClick={() => void act(inc.id, 'resolve')} title="Shift+R">
            <CheckCircle2 size={15} /> Решён
          </button>
          <div className="menu-wrap">
            <button className="btn btn-icon" onClick={() => setMoreOpen((v) => !v)} aria-label="Ещё действия">
              <MoreHorizontal size={16} />
            </button>
            {moreOpen && (
              <div className="popover up right more-pop">
                {inc.priority !== 'P1' && (
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      void act(inc.id, 'raise');
                    }}
                  >
                    <ArrowUpCircle size={15} /> Повысить приоритет
                  </button>
                )}
                {inc.status !== 'escalated' && (
                  <button
                    className="warn"
                    onClick={() => {
                      setMoreOpen(false);
                      void act(inc.id, 'escalate');
                    }}
                  >
                    <Siren size={15} /> Эскалировать руководителю смены
                  </button>
                )}
              </div>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}

function CrewRow({ inc, now }: { inc: Incident; now: number }) {
  const c = inc.crew!;
  const k = c.arrived ? 1 : Math.min(1, Math.max(0, (now - c.dispatchedAt) / c.etaMs));
  const left = Math.max(0, c.dispatchedAt + c.etaMs - now);
  const min = Math.floor(left / 60_000);
  const sec = Math.floor((left % 60_000) / 1000);
  return (
    <div className={`crew-row ${c.arrived ? 'arrived' : ''}`}>
      <span className="crew-icon">
        <Navigation size={16} />
      </span>
      <div className="crew-body">
        <span className="crew-name">{c.name}</span>
        <span className="crew-state">{c.arrived ? 'на месте, работает' : `в пути · прибудет через ${min ? `${min} мин ` : ''}${sec} с`}</span>
        <span className="crew-bar">
          <span style={{ width: `${k * 100}%` }} />
        </span>
      </div>
    </div>
  );
}
