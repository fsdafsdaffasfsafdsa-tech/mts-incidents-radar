// Карточка инцидента для пункта — по шагам: 1) что случилось, 2) что советует ИИ и почему, 3) ваше решение.
import { useEffect, useMemo, useState } from 'react';
import { BellRing, CheckCircle2, ChevronDown, Copy, ExternalLink, Megaphone, RotateCcw, Send, Siren, Star, UserCheck, X } from 'lucide-react';
import { openFav } from './FavDialog';
import type { Incident, Priority } from '../../shared/types';
import { PRIORITY_TEXT } from '../../shared/types';
import { FORECAST_TEXT, forecast } from '../../shared/forecast';
import { SCHEDULE_TEXT } from '../../shared/schedule';
import { answerP1, assignCoordinator, closeSignal, loadRoute, notifyLead, readLocal, resolveAtPoint, routeTo, setLevel, takeAtPoint, useStore, writeLocal, itsmLink, reopenIncident } from '../store';
import { RECUR_MIN } from '../../shared/dash';
import { fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Deadline, PRIO_COLORS, PrioDot } from './ui';
import { EscTimer, STATUS_TEXT, Spark, isOn } from './kit';
import { Chat } from './Chat';
import { CustomerText } from './ShiftTools';

/** Пометка «это сделал или советует ИИ» — одна и та же везде. */
export function AiBadge({ text = 'ИИ' }: { text?: string }) {
  return <span className="ai-badge">{text}</span>;
}

const NEXT: Record<Priority, Priority | null> = { P4: 'P3', P3: 'P2', P2: 'P1', P1: null };

export function IncidentCard({ inc, onClose }: { inc: Incident; onClose?: () => void }) {
  const me = useStore((s) => s.me)!;
  const route = useStore((s) => s.routes.get(inc.id));
  const teamIndex = useStore((s) => s.teamIndex);
  const staff = useStore((s) => s.staff);
  const signals = useStore((s) => s.signals);
  const complaints = useStore((s) => s.complaints);
  const rules = useStore((s) => s.config?.rules);
  const itsmUrl = useStore((s) => s.config?.itsmUrl ?? null);
  const now = useNow(5000);
  const [alt, setAlt] = useState(false);
  const [manual, setManual] = useState(false);
  const [hist, setHist] = useState(false);
  const [cust, setCust] = useState(false);
  useEffect(() => {
    setAlt(false);
    setManual(false);
    setHist(false);
    setCust(false);
  }, [inc.id]);
  useEffect(() => {
    void loadRoute(inc.id);
    const t = setInterval(() => void loadRoute(inc.id), 15_000);
    return () => clearInterval(t);
  }, [inc.id, inc.status, inc.teamId]);

  const team = inc.teamId && inc.teamId !== 'kp' ? teamIndex.get(inc.teamId) : undefined;
  const open = inc.status !== 'resolved';
  const mine = inc.coordinatorId === me.personId;
  const sigs = useMemo(() => [...signals.values()].filter((s) => s.incidentId === inc.id && s.status !== 'closed'), [signals, inc.id]);
  const n30 = useMemo(() => complaints.filter((c) => c.incidentId === inc.id && now - c.at < 30 * 60_000).length, [complaints, inc.id, now]);
  const coordinators = staff.filter((p) => p.role === 'coordinator' && isOn(p, now));
  const best = route?.picks[0];
  const bestTeam = best ? teamIndex.get(best.teamId) : undefined;
  const routedToBest = best && inc.teamId === best.teamId;
  // Шаги карточки можно свернуть — дежурный сам решает, что держать перед глазами (запоминается).
  const [closed, setClosed] = useState<Set<string>>(() => new Set(readLocal<string[]>('radar.card.closed', [])));
  const toggle = (k: string) =>
    setClosed((c) => {
      const n = new Set(c);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      writeLocal('radar.card.closed', [...n]);
      return n;
    });
  const stepH = (k: string) => ({ role: 'button', tabIndex: 0, onClick: () => toggle(k), onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && toggle(k), 'aria-expanded': !closed.has(k) });
  // Одна главная кнопка в шапке — самое нужное сейчас действие.
  const recurring = !open && !!inc.recur && inc.recur.count >= RECUR_MIN;
  const primary =
    recurring && me.role === 'coordinator'
      ? { label: `Снова жалобы (${inc.recur!.count}) — вернуть в работу`, cls: 'btn-danger', icon: RotateCcw, run: () => void reopenIncident(inc.id) }
      : !open || me.role !== 'coordinator'
      ? null
      : inc.p1Proposal && inc.priority !== 'P1'
        ? { label: 'Поднять до «Наивысшего»', cls: 'btn-danger', icon: Siren, run: () => answerP1(inc.id, true) }
        : inc.status === 'coordinators' && best && bestTeam && !routedToBest
          ? { label: `Передать в «${bestTeam.name}»`, cls: 'btn-ai', icon: Send, run: () => void routeTo(inc.id, best.teamId) }
          : inc.status === 'coordinators' && !mine
            ? { label: 'Взять себе', cls: 'btn-primary', icon: UserCheck, run: () => takeAtPoint(inc.id) }
            : null;

  return (
    <section className={`panel icard p-${inc.priority}`} aria-label={inc.title}>
      <div className="icard-top">
      <header className="pd-head" data-jv="top">
        <PrioDot p={inc.priority} text={inc.priorityText} />
        <span className={`chip-state st-${inc.status}`}>{STATUS_TEXT[inc.status]}</span>
        {inc.origin === 'complaints' ? (
          <span className="chip-origin o-complaints">
            <AiBadge /> собран из жалоб
          </span>
        ) : (
          <span className="chip-origin">из выгрузки ITSM</span>
        )}
        <span className="pd-sp" />
        <button className={`icon-btn ${inc.pin ? 'pin-on' : ''}`} onClick={() => openFav(inc.id)} title={inc.pin ? `В избранном смены: ${inc.pin.note || 'без заметки'}` : 'В избранное смены — с заметкой и напоминанием'}>
          <Star size={15} />
        </button>
        <a className="icon-btn" href={itsmLink(inc.id)} target="_blank" rel="noopener noreferrer" title={itsmUrl ? 'Открыть в ITSM' : 'Открыть ITSM-карточку (демо)'}>
          <ExternalLink size={15} />
        </a>
        <button className="icon-btn" onClick={() => void navigator.clipboard?.writeText(inc.id)} title={`Скопировать номер ${inc.id}`}>
          <Copy size={15} />
        </button>
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        )}
      </header>
      <h1 className="pd-title">{inc.title}</h1>
      <div className="icard-bar">
        <span className="ib-dl">
          до дедлайна <Deadline inc={inc} />
        </span>
        <span className="ib-who">{team ? `у «${team.name}»` : inc.coordinatorName ? `ведёт ${inc.coordinatorName}` : 'дежурного нет'}</span>
        <span className="pd-sp" />
        {primary && (
          <button className={`btn ${primary.cls} ib-main`} onClick={primary.run}>
            <primary.icon size={15} /> {primary.label}
          </button>
        )}
      </div>
      </div>

      {/* 1. Что случилось */}
      <div className={`step ${closed.has('what') ? 'closed' : ''}`}>
        <h3 className="step-h" {...stepH('what')}>
          <span className="step-n">1</span> Что случилось <ChevronDown size={15} className="step-chev" />
        </h3>
        <div className="facts" data-jv="level">
          {inc.origin === 'complaints' ? (
            <div className="fact">
              <span className="f-lbl">Жалоб</span>
              <span className="f-val num">{inc.complaints ?? 0}</span>
              <Spark values={inc.complaintsSeries ?? []} width={90} height={22} />
            </div>
          ) : (
            <div className="fact">
              <span className="f-lbl">Продукт</span>
              <span className="f-val sm">{inc.productName}</span>
            </div>
          )}
          <div className="fact">
            <span className="f-lbl">Уровень</span>
            <span className="f-val" style={{ color: PRIO_COLORS[inc.priority] }}>
              {inc.priorityText}
            </span>
          </div>
          <div className="fact">
            <span className="f-lbl">До дедлайна</span>
            <span className="f-val">
              <Deadline inc={inc} />
            </span>
          </div>
        </div>
        <p className="step-text">
          {inc.origin === 'complaints' ? `${inc.service} · ${inc.regionName}. ` : `${inc.service}. `}
          {inc.shortDescription}
        </p>
        <div className="who-line" data-jv="who">
          <span>
            Ведёт на пункте: <b>{inc.coordinatorName ?? 'никто'}</b>
            {mine && <span className="tag">вы</span>}
          </span>
          {team && (
            <span>
              Команда: <b>{team.name}</b> · {inc.assigneeName ? `у ${inc.assigneeName}` : inc.status === 'assigned' ? 'ещё не взяли' : STATUS_TEXT[inc.status]}
            </span>
          )}
        </div>
        <EscTimer inc={inc} now={now} />
      </div>

      {/* 2. Что советует ИИ */}
      {open && (
        <div className={`step ai-step ${closed.has('ai') ? 'closed' : ''}`}>
          <h3 className="step-h" {...stepH('ai')}>
            <span className="step-n">2</span> ИИ советует <AiBadge text="подсказка, решаете вы" /> <ChevronDown size={15} className="step-chev" />
          </h3>

          {inc.p1Proposal && (
            <div className="advice danger" data-jv="p1">
              <div className="adv-h">Поднять до «Наивысшего»</div>
              <div className="adv-why">{inc.p1Proposal.replace(/^ИИ предлагает «Наивысший»: /, 'Почему: ')}</div>
              <div className="adv-act">
                <button className="btn btn-sm btn-danger" onClick={() => answerP1(inc.id, true)}>
                  Поднять
                </button>
                <button className="btn btn-sm" onClick={() => answerP1(inc.id, false)}>
                  Не нужно
                </button>
              </div>
            </div>
          )}

          {sigs.map((s) => (
            <div key={s.id} className="advice warn" data-jv="signal">
              <div className="adv-h">
                <BellRing size={14} /> {s.kind === 'help' ? 'Сотрудник просит помощи' : s.kind === 'timer' ? 'Автоэскалация: команда не взяла' : 'Инцидент застрял'}
              </div>
              <div className="adv-why">{s.text.replace(/^ИИ: /, '')}</div>
              <div className="adv-act">
                {s.status === 'open' ? (
                  <button className="btn btn-sm btn-warn" onClick={() => notifyLead(s.id)}>
                    Указать руководителю команды
                  </button>
                ) : (
                  <span className="tag ok">руководитель уведомлён</span>
                )}
                {s.kind === 'timer' && team?.backupId && (inc.escalation ?? 0) >= 3 && (
                  <button className="btn btn-sm btn-ai" onClick={() => void routeTo(inc.id, team.backupId!)}>
                    <Send size={13} /> Передать дежурной смене
                  </button>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => closeSignal(s.id)}>
                  Снять
                </button>
              </div>
            </div>
          ))}

          {inc.status === 'coordinators' && route?.coordinator && route.coordinator.personId !== inc.coordinatorId && (
            <div className="advice">
              <div className="adv-h">
                Кому из дежурных: {route.coordinator.personId === me.personId ? 'вам' : staff.find((p) => p.id === route.coordinator!.personId)?.name}
              </div>
              <div className="adv-why">Почему: {route.coordinator.why}. Распределяете вы — это только подсказка.</div>
              <div className="adv-act">
                {route.coordinator.personId === me.personId ? (
                  <button className="btn btn-sm btn-ai" onClick={() => takeAtPoint(inc.id)}>
                    <UserCheck size={13} /> Взять себе
                  </button>
                ) : (
                  <button className="btn btn-sm btn-ai" onClick={() => assignCoordinator(inc.id, route.coordinator!.personId)}>
                    <Send size={13} /> Передать коллеге
                  </button>
                )}
              </div>
            </div>
          )}

          {best && bestTeam && (
            <div className={`advice ${routedToBest ? 'done' : ''}`} data-jv="route">
              <div className="adv-h">
                {routedToBest ? 'Передано туда, куда советовал ИИ: ' : 'Передать: '}«{bestTeam.name}»
                <span className="score" title="Балл подбора, 0–100">
                  {best.score}
                </span>
              </div>
              <ul className="adv-list">
                {best.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {!routedToBest && (
                <div className="adv-act">
                  <button className="btn btn-sm btn-ai" onClick={() => void routeTo(inc.id, best.teamId)}>
                    <Send size={13} /> Передать
                  </button>
                  {route!.picks.length > 1 && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setAlt(!alt)}>
                      Другие варианты ({route!.picks.length - 1}) <ChevronDown size={13} className={alt ? 'rot' : ''} />
                    </button>
                  )}
                </div>
              )}
              {alt &&
                route!.picks.slice(1).map((p) => {
                  const t = teamIndex.get(p.teamId);
                  if (!t) return null;
                  return (
                    <div key={p.teamId} className={`pick ${p.onDuty ? '' : 'off'}`}>
                      <span className="pk-score num">{p.score}</span>
                      <span className="pk-main">
                        <b>{t.name}</b>
                        <span className="muted">{p.reasons.join(' · ')}</span>
                      </span>
                      <button className="btn btn-sm" onClick={() => void routeTo(inc.id, p.teamId)}>
                        Передать
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
          {!route && <div className="empty sm">ИИ считает подбор…</div>}

          {inc.origin === 'complaints' && rules && <LevelAdvice inc={inc} n30={n30} />}
        </div>
      )}

      {/* 3. Решение */}
      {open && (
        <div className={`step ${closed.has('decide') ? 'closed' : ''}`}>
          <h3 className="step-h" {...stepH('decide')}>
            <span className="step-n">3</span> Ваше решение <ChevronDown size={15} className="step-chev" />
          </h3>
          <div className="decide" data-jv="decide">
            {me.role === 'coordinator' && !mine && (
              <button className="btn btn-primary" onClick={() => takeAtPoint(inc.id)}>
                <UserCheck size={15} /> Взять себе
              </button>
            )}
            {coordinators.some((p) => p.id !== me.personId) && (
              <select className="fsel" value="" onChange={(e) => e.target.value && assignCoordinator(inc.id, e.target.value)} title="Например, в конце смены или по специализации">
                <option value="">Передать другому дежурному…</option>
                {coordinators.filter((p) => p.id !== me.personId && p.id !== inc.coordinatorId).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.spec}
                  </option>
                ))}
              </select>
            )}
            <TeamSearch onPick={(id) => void routeTo(inc.id, id)} placeholder="Передать в другую команду…" />
            <button className="btn btn-sm btn-ghost" onClick={() => setManual(!manual)}>
              Изменить уровень <ChevronDown size={13} className={manual ? 'rot' : ''} />
            </button>
            {inc.origin === 'complaints' && (
              <button className="btn btn-sm btn-ghost" onClick={() => setCust(!cust)}>
                <Megaphone size={13} /> Текст для абонентов
              </button>
            )}
            <button className="btn btn-sm btn-ok" onClick={() => resolveAtPoint(inc.id)}>
              <CheckCircle2 size={14} /> Закрыть инцидент
            </button>
          </div>
          {manual && <LevelControl inc={inc} />}
          {cust && <CustomerText inc={inc} />}
        </div>
      )}

      <Chat inc={inc} />

      <button className="more-toggle" onClick={() => setHist((v) => !v)} aria-expanded={hist}>
        История и описание <ChevronDown size={14} className={hist ? 'rot' : ''} />
      </button>
      {hist && (
        <div className="pd-more">
          <p>{inc.description}</p>
          <ol className="timeline">
            {[...inc.history].reverse().slice(0, 20).map((h, i) => (
              <li key={i} className={h.kind === 'ai' ? 'ai' : ''}>
                <span className="tl-time num">{fmtClock(h.at)}</span>
                <span className="tl-text">
                  {h.kind === 'ai' && <AiBadge />} {h.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** Уровень: что сделает ИИ дальше и сколько жалоб до следующей ступени. */
function LevelAdvice({ inc, n30 }: { inc: Incident; n30: number }) {
  const rules = useStore((s) => s.config!.rules);
  const complaints = useStore((s) => s.complaints);
  const f = forecast(inc, complaints, rules, Date.now());
  const regions = inc.regionIds?.length ?? 1;
  const next = NEXT[inc.priority];
  const need = next === 'P3' ? rules.p3 : next === 'P2' ? (regions >= 2 ? rules.p2multi : rules.p2) : next === 'P1' ? rules.p1 : null;
  const ceiling = inc.priority === rules.ceiling || inc.priority === 'P1';
  return (
    <div className="advice rules">
      <div className="adv-h">Уровень: {ceiling ? `«${inc.priorityText}» — выше ИИ сам не поднимает` : `пока «${inc.priorityText}»`}</div>
      {need && next && (
        <>
          <div className="meter">
            {f && f.in15 > n30 && <b className="meter-fc" style={{ width: `${Math.min(100, (f.in15 / need) * 100)}%` }} title={`Через 15 мин по темпу: ~${f.in15}`} />}
            <i style={{ width: `${Math.min(100, (n30 / need) * 100)}%` }} />
          </div>
          {f && (
            <div className={`fc-line ${f.next?.level === 'P1' ? 'hot' : f.next ? 'warn' : ''}`}>
              Прогноз: {f.rate} жалоб/мин, {f.trend === 'up' ? 'растёт' : f.trend === 'down' ? 'спадает' : 'ровно'}.{' '}
              {f.next ? (
                <b>
                  {FORECAST_TEXT[f.next.level]} — примерно через {f.next.inMin} мин
                </b>
              ) : f.trend === 'down' ? (
                'Уровень, скорее всего, не вырастет.'
              ) : (
                'В ближайший час порог не наберётся.'
              )}
            </div>
          )}
          <div className="adv-why">
            {next === 'P1'
              ? `«Наивысший» ИИ только предложит при ${rules.p1}+ жалоб за ${rules.windowMin} мин или ${rules.p1regions}+ регионах. Сейчас ${n30}, регионов ${regions}.`
              : n30 >= need
                ? `Порог «${PRIORITY_TEXT[next]}» пройден (${n30} из ${need} жалоб за ${rules.windowMin} мин) — ИИ поднимет в течение ${rules.gapMin} мин после прошлого повышения.`
                : `Поднимет до «${PRIORITY_TEXT[next]}» при ${need} жалобах за ${rules.windowMin} мин${regions >= 2 && next === 'P2' ? ' (уже 2+ региона)' : ''}. Сейчас ${n30}.`}
          </div>
        </>
      )}
      <div className="adv-why muted">Только вверх, не чаще раза в {rules.gapMin} мин. Понизить можете только вы.</div>
    </div>
  );
}

function LevelControl({ inc }: { inc: Incident }) {
  const [p, setP] = useState<Priority>(inc.priority);
  const [reason, setReason] = useState('');
  useEffect(() => setP(inc.priority), [inc.id, inc.priority]);
  return (
    <div className="level-ctl">
      <select className="fsel" value={p} onChange={(e) => setP(e.target.value as Priority)}>
        {(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((x) => (
          <option key={x} value={x}>
            {PRIORITY_TEXT[x]}
          </option>
        ))}
      </select>
      <input className="inp" placeholder="Причина (видна в истории)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn btn-sm" disabled={p === inc.priority} onClick={() => setLevel(inc.id, p, reason)}>
        Применить
      </button>
    </div>
  );
}

/** Поиск по справочнику команд (~900). */
export function TeamSearch({ onPick, placeholder = 'Поиск по справочнику команд…' }: { onPick: (id: string) => void; placeholder?: string }) {
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

