// Карточка инцидента для пункта: жалобы, уровень, ИИ-подбор команды, кто ведёт, сигналы, история.
import { useEffect, useMemo, useState } from 'react';
import { BellRing, CheckCircle2, ChevronDown, Copy, ExternalLink, Send, Sparkles, UserCheck, X } from 'lucide-react';
import type { Incident, Priority } from '../../shared/types';
import { PRIORITY_TEXT } from '../../shared/types';
import { SCHEDULE_TEXT } from '../../shared/schedule';
import { answerP1, assignCoordinator, closeSignal, loadRoute, notifyLead, resolveAtPoint, routeTo, select, setLevel, takeAtPoint, useStore } from '../store';
import { fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Deadline, Elapsed, Initials, PRIO_COLORS, PrioDot } from './ui';
import { LevelLog, STATUS_TEXT, Spark, isOn } from './kit';

export function IncidentCard({ inc, onClose }: { inc: Incident; onClose?: () => void }) {
  const me = useStore((s) => s.me)!;
  const route = useStore((s) => s.routes.get(inc.id));
  const teamIndex = useStore((s) => s.teamIndex);
  const staff = useStore((s) => s.staff);
  const signals = useStore((s) => s.signals);
  const itsmUrl = useStore((s) => s.config?.itsmUrl ?? null);
  const now = useNow(5000);
  const [more, setMore] = useState(false);
  const team = inc.teamId ? teamIndex.get(inc.teamId) : undefined;
  const atPoint = inc.status === 'coordinators';
  const mine = inc.coordinatorId === me.personId;
  const sigs = useMemo(() => [...signals.values()].filter((s) => s.incidentId === inc.id && s.status !== 'closed'), [signals, inc.id]);

  useEffect(() => {
    void loadRoute(inc.id);
    const t = setInterval(() => void loadRoute(inc.id), 15_000);
    return () => clearInterval(t);
  }, [inc.id, inc.status, inc.teamId]);

  const coordinators = staff.filter((p) => p.role === 'coordinator' && isOn(p, now));

  return (
    <section className={`panel icard p-${inc.priority}`} aria-label={inc.title}>
      <header className="pd-head">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className={`chip-state st-${inc.status}`}>{STATUS_TEXT[inc.status]}</span>
        <span className={`chip-origin o-${inc.origin}`}>{inc.origin === 'complaints' ? 'из жалоб' : 'ITSM'}</span>
        <span className="pd-sp" />
        {itsmUrl ? (
          <a className="btn btn-sm" href={itsmUrl.replace('{id}', inc.id)} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} /> ITSM
          </a>
        ) : (
          <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(inc.id)} title="Скопировать номер">
            <Copy size={14} /> {inc.id}
          </button>
        )}
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        )}
      </header>
      <h1 className="pd-title">{inc.title}</h1>
      <div className="pd-where">
        {inc.origin === 'complaints' ? `${inc.service} · ${inc.regionName ?? ''}` : `${inc.productName} › ${inc.service}`}
      </div>

      {inc.p1Proposal && (
        <div className="p1-box">
          <Sparkles size={16} />
          <span>{inc.p1Proposal}</span>
          <button className="btn btn-sm btn-danger" onClick={() => answerP1(inc.id, true)}>
            Поднять до «Наивысшего»
          </button>
          <button className="btn btn-sm" onClick={() => answerP1(inc.id, false)}>
            Не нужно
          </button>
        </div>
      )}

      <div className="tiles3">
        <div className="tile">
          <span className="t-lbl">Уровень</span>
          <span className="t-val" style={{ color: PRIO_COLORS[inc.priority] }}>
            {inc.priorityText}
          </span>
          <span className="t-sub">с {fmtClock(inc.createdAt)}</span>
        </div>
        {inc.origin === 'complaints' ? (
          <div className="tile">
            <span className="t-lbl">Жалоб</span>
            <span className="t-val num">{inc.complaints ?? 0}</span>
            <Spark values={inc.complaintsSeries ?? []} />
          </div>
        ) : (
          <div className="tile">
            <span className="t-lbl">Время решения</span>
            <span className="t-val">
              <Elapsed from={inc.createdAt} to={inc.resolvedAt} />
            </span>
          </div>
        )}
        <div className="tile">
          <span className="t-lbl">До дедлайна</span>
          <span className="t-val">
            <Deadline inc={inc} big />
          </span>
          <span className="t-sub">срок {fmtClock(inc.slaDeadline)}</span>
        </div>
      </div>
      <p className="pd-short">{inc.shortDescription}</p>

      {/* кто ведёт на пункте */}
      <div className="owner">
        <span className="o-lbl">Ведёт на пункте</span>
        {inc.coordinatorName ? (
          <span className="o-who">
            <Initials name={inc.coordinatorName} /> {inc.coordinatorName}
            {mine && <span className="tag">вы</span>}
          </span>
        ) : (
          <span className="muted">никто</span>
        )}
        {inc.status !== 'resolved' && me.role === 'coordinator' && !mine && (
          <button className="btn btn-sm" onClick={() => takeAtPoint(inc.id)}>
            <UserCheck size={14} /> Взять себе
          </button>
        )}
        {inc.status !== 'resolved' && me.role === 'commander' && (
          <select className="fsel" value={inc.coordinatorId ?? ''} onChange={(e) => e.target.value && assignCoordinator(inc.id, e.target.value)}>
            <option value="">{inc.coordinatorId ? 'Передать другому…' : 'Назначить дежурного…'}</option>
            {coordinators.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.spec}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* команда */}
      {team && team.id !== 'kp' && (
        <div className="owner">
          <span className="o-lbl">Команда</span>
          <span className="o-who">
            <b>{team.name}</b>
            <span className="muted">
              {SCHEDULE_TEXT[team.schedule]}
              {inc.assigneeName ? ` · у ${inc.assigneeName}` : inc.status === 'assigned' ? ' · ещё не взяли' : ''}
            </span>
          </span>
        </div>
      )}

      {sigs.map((s) => (
        <div key={s.id} className={`sig-box k-${s.kind}`}>
          <BellRing size={15} />
          <span>{s.text}</span>
          {s.status === 'open' ? (
            <button className="btn btn-sm btn-warn" onClick={() => notifyLead(s.id)}>
              Указать руководителю
            </button>
          ) : (
            <span className="tag">руководитель уведомлён</span>
          )}
          <button className="icon-btn" onClick={() => closeSignal(s.id)} aria-label="Снять сигнал">
            <X size={14} />
          </button>
        </div>
      ))}

      {/* ИИ: кому передать */}
      {inc.status !== 'resolved' && (
        <div className="ai-route">
          <h3>
            <Sparkles size={14} /> Кому передать
            {route?.risk && <span className={`risk r-${route.risk.level}`}>риск {route.risk.score}</span>}
          </h3>
          {!route && <div className="empty">Считаем…</div>}
          {route?.picks.map((p, k) => {
            const t = teamIndex.get(p.teamId);
            if (!t) return null;
            const current = inc.teamId === p.teamId;
            return (
              <div key={p.teamId} className={`pick ${k === 0 ? 'best' : ''} ${p.onDuty ? '' : 'off'}`}>
                <span className="pk-score num">{p.score}</span>
                <span className="pk-main">
                  <b>{t.name}</b>
                  <span className="muted">{p.reasons.join(' · ')}</span>
                </span>
                {current ? (
                  <span className="tag ok">передано</span>
                ) : (
                  <button className={`btn btn-sm ${k === 0 ? 'btn-ai' : ''}`} onClick={() => void routeTo(inc.id, p.teamId)}>
                    <Send size={13} /> Передать
                  </button>
                )}
              </div>
            );
          })}
          <TeamSearch onPick={(id) => void routeTo(inc.id, id)} />
        </div>
      )}

      {inc.status !== 'resolved' && <LevelControl inc={inc} />}

      <div className="pd-actions">
        {inc.status !== 'resolved' && (atPoint || mine || me.role === 'commander') && (
          <button className="btn btn-ok" onClick={() => resolveAtPoint(inc.id)}>
            <CheckCircle2 size={15} /> Закрыть
          </button>
        )}
      </div>

      <button className="more-toggle" onClick={() => setMore((v) => !v)} aria-expanded={more}>
        Подробнее <ChevronDown size={14} className={more ? 'rot' : ''} />
      </button>
      {more && (
        <div className="pd-more">
          <p>{inc.description}</p>
          <LevelLog inc={inc} />
          <ol className="timeline">
            {[...inc.history].reverse().slice(0, 12).map((h, i) => (
              <li key={i}>
                <span className="tl-time num">{fmtClock(h.at)}</span>
                <span className="tl-text">{h.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!onClose && (
        <button className="link small" onClick={() => select(null)}>
          К детектору жалоб
        </button>
      )}
    </section>
  );
}

function LevelControl({ inc }: { inc: Incident }) {
  const [p, setP] = useState<Priority>(inc.priority);
  const [reason, setReason] = useState('');
  useEffect(() => setP(inc.priority), [inc.id, inc.priority]);
  return (
    <div className="level-ctl">
      <span className="o-lbl">Уровень вручную</span>
      <select className="fsel" value={p} onChange={(e) => setP(e.target.value as Priority)}>
        {(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((x) => (
          <option key={x} value={x}>
            {PRIORITY_TEXT[x]}
          </option>
        ))}
      </select>
      <input className="inp" placeholder="Причина" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn btn-sm" disabled={p === inc.priority} onClick={() => setLevel(inc.id, p, reason)}>
        Изменить
      </button>
    </div>
  );
}

/** Поиск по справочнику команд (~900). */
export function TeamSearch({ onPick, placeholder = 'Другая команда: поиск по справочнику…' }: { onPick: (id: string) => void; placeholder?: string }) {
  const teams = useStore((s) => s.teams);
  const [q, setQ] = useState('');
  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return teams.filter((t) => t.id !== 'kp' && (t.name.toLowerCase().includes(s) || t.direction.toLowerCase().includes(s))).slice(0, 8);
  }, [q, teams]);
  return (
    <div className="tsearch">
      <input className="inp" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {found.length > 0 && (
        <div className="ts-list">
          {found.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                onPick(t.id);
                setQ('');
              }}
            >
              <b>{t.name}</b>
              <span className="muted">{SCHEDULE_TEXT[t.schedule]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
