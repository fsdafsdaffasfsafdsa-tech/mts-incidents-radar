// Карточка инцидента — боковая шторка. Дашборд — визуальный слой: работа с инцидентом идёт в ITSM.
import { useState } from 'react';
import { ChevronDown, ExternalLink, Eye, MapPin, Radio, User, X } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { ack, openItsm, select, useStore } from '../store';
import { PRIO_LABEL, STATUS_LABEL, fmtAgo, fmtClock, fmtDateTime } from '../lib/format';
import { groupsOf, GROUPS } from '../lib/queue';
import { useNow } from '../lib/hooks';
import { Avatar, Flags, Prio, SlaTimer } from './bits';
import { AiPanel } from './AiPanel';

export function IncidentSheet() {
  const inc = useStore((s) => (s.selectedId ? s.incidents.get(s.selectedId) : undefined));
  if (!inc) return null;
  return <Sheet key={inc.id} inc={inc} />;
}

function Sheet({ inc }: { inc: Incident }) {
  const now = useNow(1000);
  const itsm = useStore((s) => !!s.itsmUrl);
  const [details, setDetails] = useState(false);
  const resolved = inc.status === 'resolved';
  const groups = groupsOf(inc, now).map((g) => GROUPS.find((x) => x.id === g)!);

  return (
    <section className={`sheet p-${inc.priority}`} aria-label={`Инцидент ${inc.id}`}>
      <div className="sheet-scroll">
        <header className="sh-head">
          <div className="sh-tags">
            <Prio p={inc.priority} size="lg" />
            <span className="sh-prio">{PRIO_LABEL[inc.priority]}</span>
            <span className={`pill st st-${inc.status}`} title={STATUS_LABEL[inc.status]}>
              {inc.state}
            </span>
            {!inc.acknowledged && !resolved && <span className="pill pill-unack">новый</span>}
            <span className="grow" />
            <button className="icon-btn" onClick={() => select(null)} aria-label="Закрыть карточку" title="Закрыть (Esc)">
              <X size={18} />
            </button>
          </div>
          <h1 className="sh-title">{inc.title}</h1>
          <div className="sh-where">
            <span className="sh-sys">{inc.product}</span>
            <span className="sep">›</span>
            <span>{inc.service}</span>
            {inc.scenario && (
              <>
                <span className="sep">·</span>
                <span>{inc.scenario}</span>
              </>
            )}
          </div>
          <div className="sh-meta num">
            {inc.id} · создан {fmtDateTime(inc.createdAt)} ({fmtAgo(now - inc.createdAt)})
          </div>
          {(groups.length > 0 || inc.isMaster || inc.isDouble || inc.isEffect || inc.isReason || inc.isNeedUp) && (
            <div className="sh-groups">
              {groups.map((g) => (
                <span key={g.id} className={`grp-chip tone-${g.tone}`}>
                  {g.label}
                </span>
              ))}
              <Flags inc={inc} />
            </div>
          )}
        </header>

        <div className="sh-eta">
          <div className="eta-sla">
            <span className="eta-label">{resolved || inc.status === 'research' ? 'Решён' : 'До дедлайна'}</span>
            <SlaTimer inc={inc} big />
            <span className="eta-sub">
              {inc.resolvedAt ? fmtDateTime(inc.resolvedAt) : inc.slaDeadline ? `дедлайн ${fmtDateTime(inc.slaDeadline)}` : 'дедлайн не задан'}
            </span>
          </div>
          <div className="eta-who">
            <span className="eta-label">Кто решает</span>
            <span className={`who-main ${inc.onCoordinators ? 'coord' : ''}`}>{inc.teamId ?? '—'}</span>
            <span className="eta-sub person">
              {inc.assignee ? (
                <>
                  <Avatar name={inc.assignee} /> {inc.assignee}
                </>
              ) : (
                <span className="warn">исполнитель не назначен</span>
              )}
            </span>
          </div>
        </div>

        <dl className="sh-facts">
          <div>
            <dt>Влияние</dt>
            <dd>{inc.impact ?? '—'}</dd>
          </div>
          <div>
            <dt>Срочность</dt>
            <dd>{inc.urgency ?? '—'}</dd>
          </div>
          <div>
            <dt>Тип сервиса</dt>
            <dd>{inc.serviceType ?? '—'}</dd>
          </div>
          <div>
            <dt>
              <Radio size={12} /> Канал
            </dt>
            <dd>{inc.channel ?? '—'}</dd>
          </div>
          <div>
            <dt>
              <User size={12} /> Инициатор
            </dt>
            <dd>{inc.initiator ?? '—'}</dd>
          </div>
          {inc.stateReason && inc.stateReason !== 'Нет' && (
            <div>
              <dt>Подстатус</dt>
              <dd>{inc.stateReason}</dd>
            </div>
          )}
        </dl>

        <AiPanel inc={inc} />

        <button className="sh-details-toggle" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
          Описание, решение и хронология <ChevronDown size={15} className={details ? 'rot' : ''} />
        </button>
        {details && (
          <div className="sh-details">
            <p className="desc">{inc.description || inc.shortDescription || 'Описания нет'}</p>
            {inc.solution && inc.status !== 'assigned' && (
              <p className="desc">
                <b>Решение:</b> {inc.solution}
              </p>
            )}
            <p className="desc muted">
              <MapPin size={12} /> На карте: {inc.region} — расположение условное, в выгрузке нет координат.
            </p>
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

      <footer className="sh-actions">
        {!resolved &&
          (!inc.acknowledged ? (
            <button className="btn btn-primary" onClick={() => void ack(inc.id)} title="A">
              <Eye size={15} /> Взять на контроль
            </button>
          ) : (
            <span className="sh-acked">
              <Eye size={14} /> на контроле
            </span>
          ))}
        <span className="grow" />
        <button className="btn btn-itsm" onClick={() => openItsm(inc.id)} title={itsm ? 'Открыть инцидент в ITSM (O)' : 'Адрес ITSM не настроен: скопировать номер (O)'}>
          <ExternalLink size={15} /> Открыть в ITSM
        </button>
      </footer>
    </section>
  );
}
