// Экран дежурного пункта: слева инциденты / запросы команд / сигналы, в центре карта жалоб, справа карточка или детектор.
import { useMemo, useState } from 'react';
import { Activity, BellRing, Inbox, Sparkles, X } from 'lucide-react';
import type { Incident, Signal, TeamRequest } from '../../shared/types';
import { answerRequest, closeSignal, createFromCluster, notifyLead, openIncident, regionName, select, setPointTab, teamName, useStore } from '../store';
import { urgency, fmtAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Deadline, Initials, PrioDot } from './ui';
import { RFMap } from './RFMap';
import { IncidentCard, TeamSearch } from './IncidentCard';
import { STATUS_TEXT } from './kit';

type Scope = 'mine' | 'all' | 'free';
const TZ: { id: string; label: string; test: (i: Incident) => boolean }[] = [
  { id: 'crit', label: 'Критические', test: (i) => i.priority === 'P1' },
  { id: 'coord', label: 'На пункте', test: (i) => i.status === 'coordinators' },
  { id: 'high', label: 'Высокий', test: (i) => i.priority === 'P2' },
  { id: 'research', label: 'Исследование', test: (i) => /исследован/i.test(i.stateText) },
];

export function PointScreen() {
  const sel = useStore((s) => (s.selectedId ? s.incidents.get(s.selectedId) : undefined));
  return (
    <div className="point">
      <LeftPanel />
      <div className="map-col">
        <RFMap />
      </div>
      {sel ? <IncidentCard inc={sel} /> : <Detector />}
    </div>
  );
}

function LeftPanel() {
  const tab = useStore((s) => s.pointTab);
  const requests = useStore((s) => s.requests);
  const signals = useStore((s) => s.signals);
  const pendingReq = [...requests.values()].filter((r) => r.status === 'pending');
  const openSig = [...signals.values()].filter((s) => s.status === 'open');
  return (
    <section className="panel plist" aria-label="Работа пункта">
      <div className="seg seg-sm ptabs">
        <button className={tab === 'incidents' ? 'on' : ''} onClick={() => setPointTab('incidents')}>
          <Inbox size={13} /> Инциденты
        </button>
        <button className={tab === 'requests' ? 'on' : ''} onClick={() => setPointTab('requests')}>
          Запросы {pendingReq.length > 0 && <span className="badge">{pendingReq.length}</span>}
        </button>
        <button className={tab === 'signals' ? 'on' : ''} onClick={() => setPointTab('signals')}>
          <BellRing size={13} /> Сигналы {openSig.length > 0 && <span className="badge warn">{openSig.length}</span>}
        </button>
      </div>
      {tab === 'incidents' ? <IncidentList /> : tab === 'requests' ? <Requests list={[...requests.values()]} /> : <Signals list={[...signals.values()]} />}
    </section>
  );
}

export function IncidentList({ onPick, forceScope }: { onPick?: (id: string) => void; forceScope?: Scope }) {
  const incidents = useStore((s) => s.incidents);
  const me = useStore((s) => s.me)!;
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(10_000);
  const [scope, setScope] = useState<Scope>(forceScope ?? (me.role === 'coordinator' ? 'mine' : 'free'));
  const [tz, setTz] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const all = useMemo(() => [...incidents.values()], [incidents]);
  const open = all.filter((i) => (done ? i.status === 'resolved' : i.status !== 'resolved'));
  const counts = {
    mine: open.filter((i) => i.coordinatorId === me.personId).length,
    all: open.length,
    free: open.filter((i) => i.status === 'coordinators' && !i.coordinatorId).length,
  };
  const g = TZ.find((x) => x.id === tz);
  const list = open
    .filter((i) => (scope === 'mine' ? i.coordinatorId === me.personId : scope === 'free' ? i.status === 'coordinators' && !i.coordinatorId : true))
    .filter((i) => !g || g.test(i))
    .sort((a, b) => (done ? (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) : urgency(b, now) - urgency(a, now)));
  return (
    <>
      <div className="seg seg-sm pl-tabs">
        {(
          [
            ['mine', 'Мои'],
            ['free', 'Без дежурного'],
            ['all', 'Все'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={scope === id ? 'on' : ''} onClick={() => setScope(id)}>
            {label} <span className="num">{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="tz-chips">
        {TZ.map((x) => {
          const n = open.filter(x.test).length;
          return (
            <button key={x.id} className={`tz-chip tz-${x.id} ${tz === x.id ? 'on' : ''}`} disabled={!n && tz !== x.id} onClick={() => setTz(tz === x.id ? null : x.id)}>
              {x.label} <span className="num">{n}</span>
            </button>
          );
        })}
        <button className={`tz-chip ${done ? 'on' : ''}`} onClick={() => setDone(!done)}>
          Решённые
        </button>
      </div>
      <div className="pl-rows">
        {!list.length && <div className="empty">{scope === 'mine' ? 'У вас нет инцидентов. ИИ распределит новые, или возьмите из «Без дежурного»' : 'Пусто'}</div>}
        {list.slice(0, 80).map((i) => (
          <IncidentRow key={i.id} inc={i} sel={i.id === selectedId} onClick={() => (onPick ? onPick(i.id) : select(i.id))} />
        ))}
      </div>
    </>
  );
}

export function IncidentRow({ inc, sel, onClick }: { inc: Incident; sel: boolean; onClick: () => void }) {
  const signals = useStore((s) => s.signals);
  const flagged = [...signals.values()].some((s) => s.incidentId === inc.id && s.status === 'open');
  const now = useNow(15_000);
  // Сколько инцидент ждёт на пункте: для новых — с появления, для записей выгрузки — с запуска.
  const waitMin = Math.max(0, Math.floor((now - (inc.origin === 'dataset' ? inc.updatedAt : inc.createdAt)) / 60_000));
  const fresh = now - inc.createdAt < 8000;
  return (
    <div className={`prow p-${inc.priority} ${sel ? 'sel' : ''} ${fresh ? 'is-new' : ''}`} role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <PrioDot p={inc.priority} />
      <span className="pr-main">
        <span className="pr-title">{inc.title}</span>
        <span className="pr-meta">
          {inc.origin === 'complaints' ? <span className="pr-tag cm">{inc.complaints} жалоб</span> : <span className="pr-tag">ITSM</span>}
          {inc.status === 'coordinators' ? STATUS_TEXT[inc.status] : teamName(inc.teamId)}
          {inc.p1Proposal && <span className="pr-tag p1">ИИ: P1?</span>}
          {flagged && <span className="pr-tag warn">сигнал</span>}
          {inc.status === 'coordinators' && waitMin >= 0 && waitMin < 24 * 60 && <span className={`wait ${waitMin >= 5 ? 'long' : ''}`}>ждёт {waitMin} мин</span>}
        </span>
      </span>
      <span className="pr-side">
        <Deadline inc={inc} />
        {inc.coordinatorName ? (
          <span className="pr-who" title={`Ведёт: ${inc.coordinatorName}`}>
            <Initials name={inc.coordinatorName} />
          </span>
        ) : (
          <span className="pr-wait" title="Без дежурного">
            ?
          </span>
        )}
      </span>
    </div>
  );
}

export function Requests({ list }: { list: TeamRequest[] }) {
  const pending = list.filter((r) => r.status === 'pending').sort((a, b) => a.at - b.at);
  const done = list.filter((r) => r.status !== 'pending').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 15);
  return (
    <div className="pl-rows pad">
      {!pending.length && <div className="empty">Новых запросов от команд нет</div>}
      {pending.map((r) => (
        <RequestCard key={r.id} r={r} />
      ))}
      {done.length > 0 && <h3 className="cm-h">Обработанные</h3>}
      {done.map((r) => (
        <div key={r.id} className="req done">
          <b>{teamName(r.fromTeamId)}</b>
          <span className="muted">
            {r.status === 'approved' ? `передано · ${r.doneBy}` : `отклонено · ${r.doneBy}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RequestCard({ r }: { r: TeamRequest }) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);
  const [other, setOther] = useState<string | null>(null);
  const inc = r.incidentId ? incidents.get(r.incidentId) : undefined;
  const target = other ?? r.aiTeamId ?? r.toTeamId;
  return (
    <div className="req">
      <div className="req-top">
        <span className={`tag ${r.kind}`}>{r.kind === 'transfer' ? 'не наше — передать' : 'проблема у другой команды'}</span>
        <span className="muted">{fmtAgo(now - r.at)}</span>
      </div>
      <b>{teamName(r.fromTeamId)}</b>
      {inc && (
        <button className="link" onClick={() => openIncident(inc.id)}>
          {inc.title}
        </button>
      )}
      <p className="req-why">«{r.reason}»{r.toTeamId && <> → просят в «{teamName(r.toTeamId)}»</>}</p>
      <div className="ai-note">
        <Sparkles size={13} /> {r.aiNote}
      </div>
      <TeamSearch onPick={setOther} placeholder="Передать в другую команду…" />
      <div className="req-act">
        <button className="btn btn-sm btn-ai" disabled={!target} onClick={() => answerRequest(r.id, true, target ?? undefined)}>
          Передать в «{target ? teamName(target) : '—'}»
        </button>
        <button className="btn btn-sm" onClick={() => answerRequest(r.id, false, undefined, 'Остаётся у команды: по справочнику ваша зона')}>
          Отклонить
        </button>
      </div>
    </div>
  );
}

export function Signals({ list }: { list: Signal[] }) {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(10_000);
  const open = list.filter((s) => s.status !== 'closed').sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open') || b.at - a.at);
  return (
    <div className="pl-rows pad">
      {!open.length && <div className="empty">Никто не застрял, просьб о помощи нет</div>}
      {open.map((s) => {
        const inc = incidents.get(s.incidentId);
        return (
          <div key={s.id} className={`req sig k-${s.kind}`}>
            <div className="req-top">
              <span className={`tag ${s.kind}`}>{s.kind === 'help' ? 'просит помощи' : 'ИИ: застрял'}</span>
              <span className="muted">{fmtAgo(now - s.at)}</span>
            </div>
            <b>{teamName(s.teamId)}</b>
            {inc && (
              <button className="link" onClick={() => openIncident(inc.id)}>
                {inc.title}
              </button>
            )}
            <p className="req-why">{s.text}</p>
            <div className="req-act">
              {s.status === 'open' ? (
                <button className="btn btn-sm btn-warn" onClick={() => notifyLead(s.id)}>
                  Указать руководителю
                </button>
              ) : (
                <span className="tag ok">руководитель уведомлён {s.notifiedBy ? `· ${s.notifiedBy}` : ''}</span>
              )}
              <button className="icon-btn" onClick={() => closeSignal(s.id)} aria-label="Снять">
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Когда инцидент не выбран: что видит детектор жалоб прямо сейчас. */
export function Detector() {
  const clusters = useStore((s) => s.clusters);
  const stats = useStore((s) => s.stats);
  const rules = useStore((s) => s.config?.rules);
  const complaints = useStore((s) => s.complaints);
  const incidents = useStore((s) => s.incidents);
  const now = useNow(5000);
  const lastHour = complaints.length;
  const linked = complaints.filter((c) => c.incidentId).length;
  const active = [...incidents.values()].filter((i) => i.origin === 'complaints' && i.status !== 'resolved').length;
  return (
    <aside className="panel detector" aria-label="Детектор жалоб">
      <h2>
        <Activity size={16} /> Детектор жалоб
      </h2>
      <div className="det-kpi">
        <div>
          <span className="num">{stats?.flowPerMin ?? 0}</span>жалоб/мин
        </div>
        <div>
          <span className="num">{lastHour}</span>за час
        </div>
        <div>
          <span className="num">{lastHour ? Math.round((linked / lastHour) * 100) : 0}%</span>в инцидентах
        </div>
        <div>
          <span className="num">{active}</span>инцидентов из жалоб
        </div>
      </div>
      <h3 className="cm-h">Подозрительные всплески</h3>
      {!clusters.length && <div className="empty">Всё в пределах нормы</div>}
      {clusters.slice(0, 8).map((c) => (
        <div key={c.key} className="cluster">
          <span className="cl-main">
            <b>{c.service}</b>
            <span className="muted">
              {regionName(c.regionId)} · {c.count} за 10 мин при норме ≈{c.expected}
            </span>
          </span>
          <button className="btn btn-sm" onClick={() => createFromCluster(c.key)}>
            Создать инцидент
          </button>
        </div>
      ))}
      <p className="rp-note">
        {rules ? `ИИ создаёт инцидент сам при 6+ жалобах за 10 минут сверх нормы. Подозрительные всплески ниже порога — здесь, решаете вы.` : ''} Обновлено{' '}
        {new Date(now).toLocaleTimeString('ru-RU')}
      </p>
    </aside>
  );
}
