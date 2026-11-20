// Кабинет команды: сотрудник (берёт, решает, просит передать, зовёт на помощь) и руководитель (назначает на смене, видит сигналы пункта).
import { useEffect, useMemo, useState } from 'react';
import { BellRing, CheckCircle2, Coffee, Hand, LifeBuoy, Megaphone, Send, Sparkles, Undo2, X } from 'lucide-react';
import type { Incident, Person } from '../../shared/types';
import { SCHEDULE_TEXT, fmtTz } from '../../shared/schedule';
import { loadRoute, select, setAway, setTab, teamAssign, teamHelp, teamName, teamRelease, teamReport, teamResolve, teamTake, teamTransfer, useStore } from '../store';
import { fmtClock, urgency } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Deadline, Elapsed, PRIO_COLORS, PrioDot } from './ui';
import { Duty, PersonRow, STATUS_TEXT, ScheduleStrip, Spark, isOn, shiftHint } from './kit';
import { TeamSearch } from './IncidentCard';
import { Directory } from './Directory';

type Tab = 'new' | 'work' | 'mine' | 'done';

export function TeamScreen() {
  const me = useStore((s) => s.me)!;
  const team = useStore((s) => (me.teamId ? s.teamIndex.get(me.teamId) : undefined));
  const people = useStore((s) => s.people);
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const signals = useStore((s) => s.signals);
  const tab = useStore((s) => s.tab);
  const now = useNow(15_000);
  const self = people.get(me.personId ?? '');
  const members = useMemo(() => [...people.values()].filter((p) => p.teamId === me.teamId || p.teams?.includes(me.teamId ?? '')), [people, me.teamId]);
  const mineTeam = (i: Incident) => !!me.teamId && (i.teamId === me.teamId || !!self?.teams?.includes(i.teamId ?? ''));
  const list = useMemo(() => [...incidents.values()].filter(mineTeam), [incidents, me.teamId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = selectedId ? incidents.get(selectedId) : undefined;
  const current = sel && mineTeam(sel) ? sel : list.filter((i) => i.status !== 'resolved').sort((a, b) => urgency(b, now) - urgency(a, now))[0];

  if (!team || !self) return <div className="boot">Команда не найдена</div>;
  const on = isOn(self, now);
  const duty = members.filter((p) => p.role === 'engineer' && isOn(p, now));
  const waiting = list.filter((i) => i.status === 'assigned' && !i.assignee).length;
  const mineN = list.filter((i) => i.assignee === me.personId && i.status !== 'resolved').length;
  const flags = [...signals.values()].filter((s) => s.teamId === me.teamId && s.status === 'notified').length;
  const tabs: { id: string; label: string; n?: number; tone?: string; hint: string }[] = [
    { id: 'work', label: 'Работа', n: waiting + mineN, tone: waiting ? 'warn' : undefined, hint: me.role === 'lead' ? 'Инциденты, которые пункт передал команде. Назначьте на инженера, который сейчас на смене.' : 'Инциденты, которые пункт передал команде: возьмите, решите или попросите передать другой команде.' },
    { id: 'team', label: me.role === 'lead' ? 'Команда и сигналы пункта' : 'Команда и смены', n: me.role === 'lead' ? flags : duty.length, tone: flags && me.role === 'lead' ? 'hot' : undefined, hint: me.role === 'lead' ? 'Кто на смене, у кого сколько в работе и на что обратил внимание пункт.' : 'Ваш график и кто из команды сейчас на смене.' },
    { id: 'directory', label: 'Справочник', hint: 'Около 900 команд: если проблема не ваша, найдите, чья она.' },
  ];
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className="teamapp">
      <nav className="stagebar" aria-label="Разделы">
        {tabs.map((t) => (
          <button key={t.id} className={`stab ${cur.id === t.id ? 'on' : ''} ${t.tone ?? ''}`} onClick={() => setTab(t.id)}>
            <span>{t.label}</span>
            {t.n !== undefined && <span className="stage-n num">{t.n}</span>}
          </button>
        ))}
      </nav>
      <div className="stage-hint">{cur.hint}</div>
      <div className="stage-body">
        {cur.id === 'directory' ? (
          <Directory />
        ) : (
    <div className={`teamscr role-${me.role} t-${cur.id}`}>
      <header className="team-head panel">
        <span className="th-main">
          <b>{team.name}</b>
          <span className="muted">
            {team.direction} · {SCHEDULE_TEXT[team.schedule]} · местное время {fmtTz(team.tz)} · на смене {duty.length} из {members.filter((p) => p.role === 'engineer').length}
          </span>
        </span>
        <span className="th-me">
          <Duty on={on} away={self.away} />
          <span className="muted">{shiftHint(self, now)}</span>
          <ScheduleStrip p={self} now={now} />
        </span>
        <button className={`btn btn-sm ${self.away ? 'btn-ok' : ''}`} onClick={() => setAway(!self.away)}>
          <Coffee size={14} /> {self.away ? 'Вернулся' : 'Отошёл'}
        </button>
        <ReportButton />
      </header>
      {cur.id === 'work' ? (
        <>
          <TeamQueue list={list} selected={current?.id ?? null} />
          {current ? <TeamIncident inc={current} self={self} members={members} /> : <section className="panel empty-panel">Инцидентов у команды нет</section>}
        </>
      ) : me.role === 'lead' ? (
        <LeadSide members={members} list={list} />
      ) : (
        <EngineerSide self={self} members={members} />
      )}
    </div>
        )}
      </div>
    </div>
  );
}

function TeamQueue({ list, selected }: { list: Incident[]; selected: string | null }) {
  const me = useStore((s) => s.me)!;
  const now = useNow(10_000);
  const groups: Record<Tab, Incident[]> = {
    new: list.filter((i) => i.status === 'assigned' && !i.assignee),
    work: list.filter((i) => i.status === 'in_progress' || (i.status === 'assigned' && i.assignee)),
    mine: list.filter((i) => i.assignee === me.personId && i.status !== 'resolved'),
    done: list.filter((i) => i.status === 'resolved'),
  };
  const [tab, setTab] = useState<Tab>(() => (groups.new.length ? 'new' : me.role === 'engineer' ? 'mine' : 'work'));
  const rows = groups[tab].sort((a, b) => (tab === 'done' ? (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) : urgency(b, now) - urgency(a, now)));
  const tabs: [Tab, string][] = me.role === 'engineer' ? [['new', 'Новые'], ['mine', 'Мои'], ['work', 'В работе'], ['done', 'Решены']] : [['new', 'Новые'], ['work', 'В работе'], ['done', 'Решены']];
  return (
    <section className="panel plist" aria-label="Инциденты команды">
      <div className="seg seg-sm pl-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label} <span className="num">{groups[id].length}</span>
          </button>
        ))}
      </div>
      <div className="pl-rows">
        {!rows.length && <div className="empty">Пусто</div>}
        {rows.slice(0, 60).map((i) => (
          <div key={i.id} className={`prow p-${i.priority} ${selected === i.id ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(i.id)} onKeyDown={(e) => e.key === 'Enter' && select(i.id)}>
            <PrioDot p={i.priority} />
            <span className="pr-main">
              <span className="pr-title">{i.title}</span>
              <span className="pr-meta">
                {i.assigneeName ? `у ${i.assigneeName}` : STATUS_TEXT[i.status]}
                {i.origin === 'complaints' && <span className="pr-tag cm">{i.complaints} жалоб</span>}
              </span>
            </span>
            <span className="pr-side">
              <Deadline inc={i} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TeamIncident({ inc, self, members }: { inc: Incident; self: Person; members: Person[] }) {
  const me = useStore((s) => s.me)!;
  const now = useNow(5000);
  const signals = useStore((s) => s.signals);
  const [solution, setSolution] = useState('');
  const [form, setForm] = useState<'none' | 'transfer' | 'help'>('none');
  useEffect(() => {
    setForm('none');
    setSolution('');
  }, [inc.id]);
  const on = isOn(self, now);
  const mine = inc.assignee === self.id;
  const open = inc.status !== 'resolved';
  const notified = [...signals.values()].find((s) => s.incidentId === inc.id && s.status === 'notified');
  const duty = members.filter((p) => p.role === 'engineer' && isOn(p, now));
  return (
    <section className={`panel icard p-${inc.priority}`} aria-label={inc.title}>
      <header className="pd-head">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className={`chip-state st-${inc.status}`}>{STATUS_TEXT[inc.status]}</span>
        <span className="pd-sp" />
        <span className="pd-id num">{inc.id}</span>
      </header>
      <h1 className="pd-title">{inc.title}</h1>
      <div className="pd-where">{inc.origin === 'complaints' ? `${inc.service} · ${inc.regionName}` : `${inc.productName} › ${inc.service}`}</div>
      {notified && (
        <div className="sig-box k-stuck">
          <BellRing size={15} /> Пункт указал руководителю: {notified.text}
        </div>
      )}
      <div className="tiles3">
        <div className="tile">
          <span className="t-lbl">Уровень</span>
          <span className="t-val" style={{ color: PRIO_COLORS[inc.priority] }}>
            {inc.priorityText}
          </span>
        </div>
        {inc.origin === 'complaints' ? (
          <div className="tile">
            <span className="t-lbl">Жалоб</span>
            <span className="t-val num">{inc.complaints}</span>
            <Spark values={inc.complaintsSeries ?? []} />
          </div>
        ) : (
          <div className="tile">
            <span className="t-lbl">{inc.startedAt ? 'В работе' : 'С регистрации'}</span>
            <span className="t-val">
              <Elapsed from={inc.startedAt ?? inc.createdAt} to={inc.resolvedAt} />
            </span>
          </div>
        )}
        <div className="tile">
          <span className="t-lbl">До дедлайна</span>
          <span className="t-val">
            <Deadline inc={inc} big />
          </span>
          <span className="t-sub">срок {fmtClock(inc.slaDeadline)} МСК</span>
        </div>
      </div>
      <p className="pd-short">{inc.shortDescription}</p>
      <p className="task-desc">{inc.description}</p>
      <div className="owner two">
        <span className="o-lbl">Ведёт на пункте</span>
        <span className="o-who">{inc.coordinatorName ?? '—'}</span>
        <span className="o-lbl">Исполнитель</span>
        <span className="o-who">{inc.assigneeName ?? 'никто'}</span>
      </div>

      {open && me.role === 'lead' && (
        <div className="level-ctl">
          <span className="o-lbl">Назначить на смене</span>
          <select className="fsel" value={inc.assignee ?? ''} onChange={(e) => e.target.value && teamAssign(inc.id, e.target.value)}>
            <option value="">{duty.length ? 'Выбрать инженера…' : 'На смене никого'}</option>
            {duty.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {shiftHint(p, now)}
              </option>
            ))}
          </select>
        </div>
      )}

      {open && (
        <div className="task-actions">
          {me.role === 'engineer' && !mine && (
            <button className="btn btn-primary" disabled={!on} title={on ? '' : 'Вы сейчас не на смене'} onClick={() => teamTake(inc.id)}>
              <Hand size={16} /> {on ? 'Взять в работу' : 'Вы не на смене'}
            </button>
          )}
          {me.role === 'engineer' && mine && (
            <>
              <input className="inp grow" placeholder="Что сделали (увидит пункт)" value={solution} onChange={(e) => setSolution(e.target.value)} />
              <button className="btn btn-ok" onClick={() => teamResolve(inc.id, solution || 'Причина устранена, сервис восстановлен')}>
                <CheckCircle2 size={16} /> Решено
              </button>
              <button className="btn btn-ghost" onClick={() => teamRelease(inc.id)}>
                <Undo2 size={15} /> В очередь
              </button>
            </>
          )}
          <button className="btn" onClick={() => setForm(form === 'transfer' ? 'none' : 'transfer')}>
            <Send size={15} /> Не наше — передать
          </button>
          {me.role === 'engineer' && mine && (
            <button className="btn btn-warn" onClick={() => setForm(form === 'help' ? 'none' : 'help')}>
              <LifeBuoy size={15} /> Нужна помощь
            </button>
          )}
        </div>
      )}
      {form === 'transfer' && <TransferForm inc={inc} onDone={() => setForm('none')} />}
      {form === 'help' && <HelpForm inc={inc} onDone={() => setForm('none')} />}
      {inc.solution && inc.status === 'resolved' && (
        <p className="task-desc">
          <b>Решение:</b> {inc.solution}
        </p>
      )}
    </section>
  );
}

function TransferForm({ inc, onDone }: { inc: Incident; onDone: () => void }) {
  const route = useStore((s) => s.routes.get(inc.id));
  const me = useStore((s) => s.me)!;
  const [to, setTo] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => void loadRoute(inc.id), [inc.id]);
  const picks = (route?.picks ?? []).filter((p) => p.teamId !== me.teamId).slice(0, 3);
  return (
    <div className="form-box">
      <h3>
        Запрос в пункт: передать в другую команду
        <button className="icon-btn" onClick={onDone} aria-label="Закрыть">
          <X size={14} />
        </button>
      </h3>
      {picks.length > 0 && (
        <div className="ai-note">
          <Sparkles size={13} /> По справочнику подходят:
        </div>
      )}
      <div className="chips">
        {picks.map((p) => (
          <button key={p.teamId} className={`chip-btn ${to === p.teamId ? 'on' : ''}`} onClick={() => setTo(p.teamId)}>
            {teamName(p.teamId)}
          </button>
        ))}
      </div>
      <TeamSearch onPick={setTo} />
      {to && <div className="muted">Передать в: «{teamName(to)}»</div>}
      <input className="inp" placeholder="Почему не ваша зона (обязательно)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn btn-primary" disabled={reason.trim().length < 5} onClick={() => void teamTransfer(inc.id, to, reason).then(onDone)}>
        Отправить в пункт
      </button>
    </div>
  );
}

function HelpForm({ inc, onDone }: { inc: Incident; onDone: () => void }) {
  const [text, setText] = useState('');
  return (
    <div className="form-box">
      <h3>
        Сигнал пункту: нужна помощь
        <button className="icon-btn" onClick={onDone} aria-label="Закрыть">
          <X size={14} />
        </button>
      </h3>
      <input className="inp" placeholder="Что мешает: нет доступа, нужен смежник, не воспроизводится…" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn btn-warn" disabled={text.trim().length < 5} onClick={() => void teamHelp(inc.id, text).then(onDone)}>
        Отправить
      </button>
    </div>
  );
}

function ReportButton() {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const [text, setText] = useState('');
  return (
    <span className="report-wrap">
      <button className="btn btn-sm" onClick={() => setOpen(!open)} title="Сообщить пункту, что проблема у другой команды">
        <Megaphone size={14} /> Проблема у другой команды
      </button>
      {open && (
        <div className="popover report-pop">
          <TeamSearch onPick={setTo} placeholder="У какой команды проблема…" />
          {to && <div className="muted">Команда: «{teamName(to)}»</div>}
          <input className="inp" placeholder="Что видите" value={text} onChange={(e) => setText(e.target.value)} />
          <button
            className="btn btn-primary btn-sm"
            disabled={!to || text.trim().length < 5}
            onClick={() =>
              void teamReport(to!, text).then(() => {
                setOpen(false);
                setText('');
                setTo(null);
              })
            }
          >
            Отправить в пункт
          </button>
        </div>
      )}
    </span>
  );
}

function EngineerSide({ self, members }: { self: Person; members: Person[] }) {
  const now = useNow(30_000);
  return (
    <aside className="panel roster" aria-label="Смена">
      <h3 className="cm-h">Моя смена</h3>
      <PersonRow p={self} now={now} />
      <h3 className="cm-h">Команда</h3>
      <div className="pl-rows">
        {members
          .filter((p) => p.id !== self.id)
          .sort((a, b) => Number(isOn(b, now)) - Number(isOn(a, now)))
          .map((p) => (
            <PersonRow key={p.id} p={p} now={now} />
          ))}
      </div>
    </aside>
  );
}

function LeadSide({ members, list }: { members: Person[]; list: Incident[] }) {
  const me = useStore((s) => s.me)!;
  const signals = useStore((s) => s.signals);
  const incidents = useStore((s) => s.incidents);
  const now = useNow(15_000);
  const busy = new Map<string, number>();
  for (const i of list) if (i.status === 'in_progress' && i.assignee) busy.set(i.assignee, (busy.get(i.assignee) ?? 0) + 1);
  const mySignals = [...signals.values()].filter((s) => s.teamId === me.teamId && s.status !== 'closed');
  return (
    <aside className="panel roster" aria-label="Команда">
      <h3 className="cm-h">
        <BellRing size={14} /> От пункта
      </h3>
      {!mySignals.length && <div className="empty sm">Пункт ничего не отмечал</div>}
      {mySignals.map((s) => (
        <div key={s.id} className={`req sig k-${s.kind}`}>
          <span className={`tag ${s.status === 'notified' ? 'warn' : ''}`}>{s.status === 'notified' ? 'пункт обратил внимание' : s.kind === 'help' ? 'просит помощи' : 'ИИ: застрял'}</span>
          <p className="req-why">{s.text}</p>
          {incidents.get(s.incidentId) && (
            <button className="link" onClick={() => select(s.incidentId)}>
              {incidents.get(s.incidentId)!.title}
            </button>
          )}
        </div>
      ))}
      <h3 className="cm-h">Состав и графики</h3>
      <div className="pl-rows">
        {members
          .sort((a, b) => Number(isOn(b, now)) - Number(isOn(a, now)) || a.crew - b.crew)
          .map((p) => (
            <PersonRow key={p.id} p={p} now={now} right={busy.get(p.id) ? <span className="tag">в работе {busy.get(p.id)}</span> : undefined} />
          ))}
      </div>
    </aside>
  );
}
