// Эвристический ИИ: работает всегда, без ключей и сети, только на полях выгрузки.
// Задачи кейса: кратко объяснить, что случилось; подсказать группу; оценить риск; найти связанные инциденты.
import type { AiBrief, Incident, Insight, Priority, RiskFactor, RiskLevel, TeamScore } from '../shared/types.ts';
import { slaRunning } from '../shared/types.ts';

export interface AiContext {
  now: number;
  incidents: Map<string, Incident>;
  teamLoad: Record<string, number>;
}

export function buildContext(incidents: Map<string, Incident>, now: number): AiContext {
  const teamLoad: Record<string, number> = {};
  for (const inc of incidents.values()) {
    if (!slaRunning(inc) || !inc.teamId) continue;
    teamLoad[inc.teamId] = (teamLoad[inc.teamId] ?? 0) + 1;
  }
  return { now, incidents, teamLoad };
}

/** Группы, которым координатор может передать инцидент: без самих координаторов и автозакрытия. */
const isRoutable = (team: string | null): team is string => !!team && !/координатор/i.test(team) && !/^autoclosed/i.test(team);

export function routableTeams(ctx: AiContext): string[] {
  const s = new Set<string>();
  for (const i of ctx.incidents.values()) if (isRoutable(i.teamId)) s.add(i.teamId);
  return [...s].sort((a, b) => a.localeCompare(b, 'ru'));
}

const PRIO_TEXT: Record<Priority, string> = { P1: 'Наивысший', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' };
const RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const HOUR = 3_600_000;

// ─── Связанные инциденты ───────────────────────────────────────────────────

/** Ближайший по времени раньше этого инцидент, подходящий под условие: сначала тот же сервис, потом продукт. */
function nearestEarlier(inc: Incident, ctx: AiContext, pred: (o: Incident) => boolean, windowH = 72): Incident | undefined {
  const cands = [...ctx.incidents.values()].filter(
    (o) => o.id !== inc.id && pred(o) && o.createdAt <= inc.createdAt && inc.createdAt - o.createdAt <= windowH * HOUR,
  );
  const score = (o: Incident) => (o.service === inc.service ? 0 : o.product === inc.product ? 1 : 2) * 1e13 + (inc.createdAt - o.createdAt);
  return cands.sort((a, b) => score(a) - score(b))[0];
}

/** Рядом по времени и по продукту или сервису — кандидаты в общий сбой. */
function neighbours(inc: Incident, ctx: AiContext): Incident[] {
  return [...ctx.incidents.values()].filter((o) => {
    if (o.id === inc.id) return false;
    const dt = Math.abs(o.createdAt - inc.createdAt);
    return (o.service === inc.service && o.product === inc.product && dt <= 48 * HOUR) || (o.product === inc.product && dt <= 6 * HOUR);
  });
}

export function findCorrelation(inc: Incident, ctx: AiContext): Insight['correlation'] {
  const near = neighbours(inc, ctx);
  const ids = new Set(near.map((o) => o.id));

  if (inc.isDouble) {
    const master = nearestEarlier(inc, ctx, (o) => o.isMaster);
    if (master) ids.add(master.id);
    return {
      rootId: master?.id ?? null,
      ids: [...ids],
      text: master
        ? `Дубль: инцидент с такой причиной уже зарегистрирован. Вероятный мастер-инцидент — ${master.id} «${master.title}» (${master.product}).`
        : 'Дубль: инцидент с такой причиной уже зарегистрирован, но мастер-инцидент в выгрузке не найден.',
    };
  }
  const cause = inc.isReason ? nearestEarlier(inc, ctx, (o) => o.isEffect || o.isMaster) : undefined;
  // Мастер-инцидент может быть и дочерним; если причины нет в выгрузке, показываем его как мастер.
  if (inc.isReason && (cause || !(inc.isMaster || inc.isEffect))) {
    if (cause) ids.add(cause.id);
    return {
      rootId: cause?.id ?? null,
      ids: [...ids],
      text: cause
        ? `Дочерний инцидент. Вероятная первопричина — ${cause.id} «${cause.title}» (${cause.product}), зарегистрирован раньше.`
        : 'Дочерний инцидент, но инцидент-причина в выгрузке не найден.',
    };
  }
  if (inc.isMaster || inc.isEffect) {
    const followers = [...ctx.incidents.values()].filter(
      (o) => o.id !== inc.id && (o.isDouble || o.isReason) && o.createdAt >= inc.createdAt && o.createdAt - inc.createdAt <= 72 * HOUR && (o.product === inc.product || o.service === inc.service),
    );
    for (const f of followers) ids.add(f.id);
    const what = inc.isMaster ? 'Мастер-инцидент: к нему привязываются дубли' : 'Причина дочерних инцидентов';
    return {
      rootId: inc.id,
      ids: [...ids],
      text: followers.length ? `${what}. Рядом ${followers.length} ${plural(followers.length, 'дубль или дочерний', 'дубля или дочерних', 'дублей или дочерних')} по тому же продукту.` : `${what}. Решение закроет и связанные с ним инциденты.`,
    };
  }
  if (!near.length) return null;
  const open = near.filter((o) => o.status !== 'resolved');
  const root = [inc, ...near].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt)[0];
  return {
    rootId: root.id,
    ids: [...ids],
    text: `По продукту «${inc.product}» рядом по времени ещё ${near.length} ${plural(near.length, 'инцидент', 'инцидента', 'инцидентов')}${open.length ? `, открыто ${open.length}` : ''}. Проверьте, не общий ли это сбой.`,
  };
}

// ─── Подсказка группы ──────────────────────────────────────────────────────

/** Какая группа раньше решала инциденты с тем же сценарием, сервисом и продуктом. */
export function recommendTeams(inc: Incident, ctx: AiContext, corr = findCorrelation(inc, ctx)): TeamScore[] {
  const acc = new Map<string, { s: number; scen: number; serv: number; prod: number; total: number }>();
  for (const o of ctx.incidents.values()) {
    if (o.id === inc.id || !isRoutable(o.teamId)) continue;
    const a = acc.get(o.teamId) ?? { s: 0, scen: 0, serv: 0, prod: 0, total: 0 };
    a.total++;
    a.s += 0.08; // общий опыт группы — слабый сигнал
    if (o.service === inc.service && o.product === inc.product) {
      if (o.scenario && o.scenario === inc.scenario) {
        a.scen++;
        a.s += 2.2;
      } else {
        a.serv++;
        a.s += 1.1;
      }
    } else if (o.product === inc.product) {
      a.prod++;
      a.s += 0.45;
    }
    if (o.priority === inc.priority) a.s += 0.05;
    acc.set(o.teamId, a);
  }
  const root = corr?.rootId && corr.rootId !== inc.id ? ctx.incidents.get(corr.rootId) : undefined;
  if (root && isRoutable(root.teamId)) {
    const a = acc.get(root.teamId) ?? { s: 0, scen: 0, serv: 0, prod: 0, total: 0 };
    a.s += 1.4;
    acc.set(root.teamId, a);
  }
  if (!acc.size) return [];

  const scored = [...acc.entries()].map(([teamId, a]) => {
    const reasons: string[] = [];
    if (root && root.teamId === teamId) reasons.push(`Решала связанный инцидент ${root.id}`);
    if (a.scen) reasons.push(`Решала тот же сценарий «${inc.scenario}»: ${a.scen} ${plural(a.scen, 'инцидент', 'инцидента', 'инцидентов')}`);
    if (a.serv) reasons.push(`Работала с сервисом «${inc.service}»: ${a.serv}`);
    if (a.prod) reasons.push(`Инциденты продукта «${inc.product}»: ${a.prod}`);
    if (!reasons.length) reasons.push(`Всего инцидентов в выгрузке: ${a.total}`);
    const load = ctx.teamLoad[teamId] ?? 0;
    let s = a.s;
    if (load >= 5) {
      s -= Math.min(0.4, (load - 4) * 0.08);
      reasons.push(`Загружена: ${load} в работе`);
    } else if (load) reasons.push(`Сейчас в работе: ${load}`);
    return { teamId, s, reasons };
  });

  const T = 0.7;
  const max = Math.max(...scored.map((x) => x.s));
  const exps = scored.map((x) => Math.exp((x.s - max) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  return scored
    .map((x, i) => ({ teamId: x.teamId, confidence: exps[i] / sum, reasons: x.reasons }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .filter((t, i) => i === 0 || t.confidence >= 0.04);
}

// ─── Риск эскалации ────────────────────────────────────────────────────────

const PRIO_W: Record<Priority, number> = { P1: 1.6, P2: 0.8, P3: 0, P4: -0.6 };

export function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Риск, что инцидент станет критическим или сорвёт срок. Для устранённых — только остаточный. */
export function assessRisk(inc: Incident, ctx: AiContext, corr = findCorrelation(inc, ctx)): Insight['risk'] {
  const factors: RiskFactor[] = [];
  const add = (label: string, weight: number) => {
    if (Math.abs(weight) >= 0.12) factors.push({ label, weight: Math.round(weight * 100) / 100 });
    return weight;
  };
  let z = -1.8;
  z += add(`Приоритет «${PRIO_TEXT[inc.priority]}»`, PRIO_W[inc.priority]);
  if (inc.urgencyId) z += add(`Срочность «${inc.urgency ?? inc.urgencyId}»`, (inc.urgencyId - 2) * 0.3);
  if (inc.impactId) z += add(`Влияние «${inc.impact ?? inc.impactId}»`, (inc.impactId - 2) * 0.35);

  const running = slaRunning(inc);
  let remaining: number | null = null;
  if (!running) {
    z += add(inc.status === 'research' ? 'Сбой устранён, идёт разбор причин' : 'Инцидент решён', -2.6);
  } else if (inc.slaDeadline === null) {
    z += add('Дедлайн не задан', 0.3);
  } else {
    remaining = inc.slaDeadline - ctx.now;
    const total = Math.max(1, inc.slaDeadline - inc.createdAt);
    if (remaining <= 0) z += add('Дедлайн уже прошёл', 2.2 + Math.min(0.8, (-remaining / HOUR) * 0.1));
    else {
      const f = (ctx.now - inc.createdAt) / total;
      z += add(`Прошло ${Math.round(f * 100)}% времени до дедлайна`, 2.2 * Math.pow(Math.min(1, Math.max(0, (f - 0.4) / 0.6)), 1.5));
    }
  }

  const st = (inc.serviceType ?? '').toLowerCase();
  if (st.startsWith('клиент')) z += add('Клиентский сервис: влияет на клиентов', 0.6);
  else if (st.startsWith('пользоват')) z += add('Пользовательский сервис', 0.3);
  else if (st.startsWith('технолог')) z += add('Технологический сервис: клиенты напрямую не затронуты', -0.3);

  if (running) {
    if (inc.onCoordinators) z += add('На координаторах — группа не выбрана', 0.6);
    else if (inc.status === 'assigned') z += add('Группа ещё не взяла в работу', 0.3);
    else if (inc.status === 'in_progress') z += add('Уже в работе', -0.4);
  }
  if (inc.isMaster) z += add('Мастер-инцидент: к нему привязаны дубли', 0.5);
  if (inc.isEffect) z += add('Причина дочерних инцидентов', 0.5);
  const relatedCount = corr?.ids.length ?? 0;
  if (relatedCount > 0) z += add(`${relatedCount} ${plural(relatedCount, 'связанный инцидент', 'связанных инцидента', 'связанных инцидентов')} рядом`, 0.25 * Math.min(4, relatedCount));

  // У решённого инцидента риска эскалации нет, сколько бы ни весили приоритет и влияние.
  if (inc.status === 'resolved') z = Math.min(z, -2.4);
  const score = Math.round(100 / (1 + Math.exp(-z)));
  const level = riskLevel(score);
  factors.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const minutesToBreach = remaining === null ? null : Math.round(remaining / 60_000);

  let note: string;
  if (!running) note = inc.status === 'research' ? 'Сбой устранён. Важно не упустить итоги разбора причин.' : 'Инцидент решён.';
  else if (minutesToBreach !== null && minutesToBreach <= 0) note = `Дедлайн прошёл ${fmtMin(-minutesToBreach)} назад. Нужна эскалация.`;
  else if ((level === 'critical' || level === 'high') && inc.priority !== 'P1') note = `Высокий риск: может перерасти в критический. ${minutesToBreach !== null ? `До дедлайна ${fmtMin(minutesToBreach)}.` : ''}`.trim();
  else if (level === 'critical' || level === 'high') note = minutesToBreach !== null ? `До дедлайна ${fmtMin(minutesToBreach)}. Держать на контроле.` : 'Держать на контроле.';
  else if (level === 'medium') note = 'Ситуация под контролем, проверить статус позже.';
  else note = 'Риск низкий, обычный порядок работы.';

  return { score, level, factors: factors.slice(0, 6), minutesToBreach, note };
}

// ─── Резюме ────────────────────────────────────────────────────────────────

export function heuristicInsight(inc: Incident, ctx: AiContext, started = Date.now()): Insight {
  const corr = findCorrelation(inc, ctx);
  const teams = recommendTeams(inc, ctx, corr);
  const risk = assessRisk(inc, ctx, corr);

  const parts: string[] = [];
  const firstSentence = inc.description.split(/(?<=[.!?])\s/)[0] ?? inc.description;
  parts.push(`${inc.product} › ${inc.service}${inc.scenario ? ` (${inc.scenario})` : ''}: ${lowerFirst(inc.shortDescription || firstSentence)}`);
  if (inc.serviceType) parts.push(`Тип сервиса — ${inc.serviceType.toLowerCase()}, влияние ${(inc.impact ?? '—').toLowerCase()}.`);
  const who =
    inc.status === 'resolved'
      ? `Инцидент ${inc.state.toLowerCase()}${inc.stateReason && inc.stateReason !== 'Нет' ? ` (${inc.stateReason.toLowerCase()})` : ''}`
      : inc.status === 'research'
        ? `Сбой устранён, группа «${inc.teamId ?? '—'}» исследует причины`
        : inc.onCoordinators
          ? 'Инцидент на координаторах: нужно выбрать группу'
          : inc.status === 'in_progress'
            ? `Решает ${inc.assignee ?? 'исполнитель'} (${inc.teamId ?? '—'})`
            : `Назначен на «${inc.teamId ?? '—'}», в работу ещё не взят`;
  const sla =
    risk.minutesToBreach === null ? (slaRunning(inc) ? '; дедлайн не задан' : '') : risk.minutesToBreach > 0 ? `; до дедлайна ${fmtMin(risk.minutesToBreach)}` : '; дедлайн прошёл';
  parts.push(`${who}${sla}.`);

  const rootInc = corr?.rootId && corr.rootId !== inc.id ? ctx.incidents.get(corr.rootId) : undefined;
  const cause = rootInc
    ? `Вероятно, связан с ${rootInc.id}: «${rootInc.title}».`
    : inc.status !== 'assigned' && inc.solution
      ? `Решение: ${inc.solution}`
      : null;

  const steps: string[] = [];
  const top = teams[0];
  if (inc.onCoordinators && slaRunning(inc) && top) steps.push(`Передать группе «${top.teamId}» (уверенность ${Math.round(top.confidence * 100)}%)`);
  if (rootInc && inc.isDouble) steps.push(`Привязать как дубль к ${rootInc.id}`);
  if (rootInc && inc.isReason) steps.push(`Сверить ход работ с первопричиной ${rootInc.id}`);
  if (risk.minutesToBreach !== null && risk.minutesToBreach <= 0) steps.push('Эскалировать: дедлайн прошёл');
  else if (risk.minutesToBreach !== null && risk.minutesToBreach <= 30) steps.push(`Предупредить руководителя смены: дедлайн через ${fmtMin(risk.minutesToBreach)}`);
  if ((risk.level === 'high' || risk.level === 'critical') && inc.priority === 'P2' && slaRunning(inc)) steps.push('Следить: может перерасти в критический');
  if (inc.status === 'assigned' && !inc.onCoordinators) steps.push(`Напомнить группе «${inc.teamId ?? '—'}»: инцидент не взят в работу`);
  if (inc.status === 'research') steps.push('Запросить у группы итоги разбора причин');
  if (inc.isNeedUp) steps.push('Проконтролировать устранение последствий');

  return {
    incidentId: inc.id,
    source: 'heuristic',
    summary: parts.join(' '),
    cause,
    nextSteps: steps.slice(0, 4),
    teams,
    risk,
    correlation: corr,
    generatedAt: Date.now(),
    latencyMs: Date.now() - started,
  };
}

export function briefOf(inc: Incident, ctx: AiContext): AiBrief {
  const corr = findCorrelation(inc, ctx);
  const risk = assessRisk(inc, ctx, corr);
  const teams = recommendTeams(inc, ctx, corr);
  return { risk: risk.score, level: risk.level, teamId: teams[0]?.teamId ?? null, confidence: teams[0]?.confidence ?? 0 };
}

// ─── Форматирование ────────────────────────────────────────────────────────

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)} д ${h % 24} ч`;
  const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
