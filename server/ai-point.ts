// ИИ координирующего пункта: подсказывает, а решает человек.
//  • кому передать инцидент — по справочнику, региону, графику команды и её загрузке;
//  • как распределить новые инциденты между дежурными смены (венгерский алгоритм);
//  • какой инцидент застрял у команды;
//  • проверяет запросы команд «это не наше» по справочнику.
import { SCHEDULE_TEXT } from '../shared/schedule.ts';
import type { Incident, Person, TeamPick } from '../shared/types.ts';
import { groupForService } from './catalog.ts';
import { POINT_ID, TEAMS, isOn, itsmTeam, onShift, productL2, serviceDef, teamById, teamOnDuty } from './directory.ts';
import { hungarian } from './ai-heuristic.ts';
import { regionById } from './regions.ts';

const MIN = 60_000;

export interface PointCtx {
  now: number;
  load: Map<string, number>; // открытых инцидентов у команды
}

const NETWORK = new Set(['Мобильный интернет', 'Мобильная связь', 'Домашний интернет', 'Домашнее ТВ']);

/** Специализация инцидента для дежурного пункта. */
export function specOf(inc: Incident): string {
  if (inc.origin === 'complaints') return NETWORK.has(inc.service) ? 'Сеть' : inc.service === 'B2B-каналы' ? 'B2B и корпоративные' : 'ИТ-продукты';
  return /VPN|ББ|B2B|Active Directory/i.test(inc.groupName) ? 'B2B и корпоративные' : /SAN|DC-NET|ОГЭ|МЦОД/i.test(inc.groupName) ? 'Сеть' : 'ИТ-продукты';
}

// ─── кому передать ─────────────────────────────────────────────────────────

export function routeTeams(inc: Incident, ctx: PointCtx, limit = 5): TeamPick[] {
  const cand = new Map<string, { base: number; why: string }>();
  const add = (id: string | null | undefined, base: number, why: string) => {
    if (!id || id === POINT_ID || !teamById(id)) return;
    const prev = cand.get(id);
    if (!prev || prev.base < base) cand.set(id, { base, why });
  };

  if (inc.origin === 'complaints') {
    const s = inc.service;
    const regions = inc.regionIds?.length ? inc.regionIds : inc.regionId ? [inc.regionId] : [];
    const districts = new Set(regions.map((r) => regionById(r)?.district));
    const def = serviceDef(s);
    if (regions.length === 1) {
      const r = regions[0];
      for (const t of TEAMS) if (t.regionId === r && t.services.includes(s)) add(t.id, t.kind === 'opt' ? 52 : 70, `«${s}» в одном регионе — команда филиала`);
      add(`noc-${regionById(r)?.district}`, 48, 'центр управления сетью округа');
    } else if (districts.size === 1) {
      add(`noc-${[...districts][0]}`, 72, `${regions.length} региона одного округа — центр управления сетью`);
      if (s === 'Мобильный интернет' || s === 'Мобильная связь') add(`core-${[...districts][0]}`, 62, 'несколько регионов — возможна проблема ядра сети');
    }
    const l2 = productL2(s);
    const platformBase = def && !def.regional ? 78 : regions.length > 1 && districts.size > 1 ? 74 : 45;
    if (l2) add(l2, platformBase, def && !def.regional ? `«${s}» — центральная платформа` : 'платформа сервиса (если сбой шире региона)');
    // Другие платформы того же сервиса (например, оплата: биллинг и МТС Pay).
    for (const t of TEAMS) if ((t.kind === 'l2' || t.itsm) && t.id !== l2 && t.services.includes(s)) add(t.id, platformBase - 10, `тоже обслуживает «${s}»`);
  } else {
    // Инцидент из выгрузки: по истории выгрузки — кто решал тот же продукт и сервис.
    const g = itsmTeam(groupForService(inc.productName, inc.service));
    add(g, 74, 'по истории выгрузки решала этот сервис');
    const own = inc.teamId && inc.teamId !== POINT_ID ? inc.teamId : null;
    add(own, 60, 'группа, указанная в выгрузке');
    for (const t of TEAMS) if (t.itsm && t.name.toLowerCase().includes(inc.productName.toLowerCase().split(' ')[0])) add(t.id, 50, 'группа продукта');
  }

  // Команда не на смене — предлагаем её дежурную замену.
  for (const [id, c] of [...cand]) {
    const t = teamById(id)!;
    if (!teamOnDuty(id, ctx.now) && t.backupId) add(t.backupId, c.base - 4, `${t.name} сейчас не работает (${SCHEDULE_TEXT[t.schedule]}) — дежурная замена`);
  }

  const picks: TeamPick[] = [...cand].map(([id, c]) => {
    const t = teamById(id)!;
    const on = onShift(id, ctx.now).filter((p) => p.role === 'engineer');
    const duty = on.length > 0;
    const load = ctx.load.get(id) ?? 0;
    const reasons = [c.why];
    let score = c.base;
    if (duty) {
      score += 12;
      reasons.push(`на смене ${on.length} из ${t.size - 1}`);
    } else {
      score -= 35;
      reasons.push(`сейчас никого — ${SCHEDULE_TEXT[t.schedule]}`);
    }
    if (load) {
      score -= Math.min(18, load * 5);
      reasons.push(`в работе: ${load}`);
    }
    if (t.schedule === '24/7') reasons.push('круглосуточно');
    const backupFor = TEAMS.find((x) => x.backupId === id && cand.has(x.id) && !teamOnDuty(x.id, ctx.now))?.id ?? null;
    return { teamId: id, score: Math.max(0, Math.min(100, Math.round(score))), reasons, onDuty: duty, onDutyCount: on.length, load, backupFor };
  });
  return picks.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── распределение между дежурными пункта ──────────────────────────────────

export interface PointPlanItem {
  incidentId: string;
  personId: string;
  why: string;
}

/** Каждый дежурный получает не больше трёх новых, с учётом специализации и того, что у него уже есть. */
export function planPoint(incidents: Incident[], staff: Person[], owned: Map<string, number>, now: number): PointPlanItem[] {
  const duty = staff.filter((p) => p.role === 'coordinator' && isOn(p, now));
  if (!duty.length || !incidents.length) return [];
  const PR = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
  const rows = [...incidents].sort((a, b) => PR[a.priority] - PR[b.priority] || a.createdAt - b.createdAt);
  const slots: { p: Person; k: number }[] = [];
  for (const p of duty) for (let k = 0; k < 3; k++) slots.push({ p, k });
  const take = rows.slice(0, slots.length);
  const cost = take.map((inc) =>
    slots.map(({ p, k }) => (owned.get(p.id) ?? 0) * 3 + k * 4 + (p.spec === specOf(inc) ? 0 : 6) + (PR[inc.priority] === 0 && k > 0 ? 3 : 0)),
  );
  const match = hungarian(cost);
  return match
    .map((j, i) => {
      if (j < 0) return null;
      const { p } = slots[j];
      const inc = take[i];
      const fit = p.spec === specOf(inc);
      return { incidentId: inc.id, personId: p.id, why: fit ? `специализация «${p.spec}»` : `свободнее остальных (${owned.get(p.id) ?? 0} в работе)` };
    })
    .filter((x): x is PointPlanItem => !!x);
}

// ─── застрявшие инциденты ──────────────────────────────────────────────────

export const STUCK = { idleMin: 8, slaShare: 0.6 };

/** Автоэскалация: команда не взяла инцидент — через 10 мин напоминание, через 20 — руководителю, через 30 — дежурная смена. */
export const TIMERS = [10, 20, 30];

export function stuckReason(inc: Incident, now: number, assigneeName: string | null): string | null {
  if (inc.status !== 'in_progress' && inc.status !== 'assigned') return null;
  if (!inc.teamId || inc.teamId === POINT_ID) return null;
  const idle = (now - inc.updatedAt) / MIN;
  const share = (now - inc.createdAt) / Math.max(1, inc.slaDeadline - inc.createdAt);
  const who = assigneeName ? `у ${assigneeName}` : 'у команды, никто не взял';
  if (share >= STUCK.slaShare && inc.status === 'in_progress') return `В работе ${who}, прошло ${Math.round(share * 100)}% срока`;
  if (idle >= STUCK.idleMin) return `${Math.round(idle)} мин без движения ${who}`;
  return null;
}

// ─── проверка запроса команды ──────────────────────────────────────────────

export function checkTransfer(inc: Incident | null, toTeamId: string | null, ctx: PointCtx): { note: string; teamId: string | null } {
  if (!inc) {
    const t = teamById(toTeamId);
    return { note: t ? `Проверить с командой «${t.name}»: ${teamOnDuty(t.id, ctx.now) ? 'на смене есть дежурные' : 'сейчас не работает'}` : 'Команда не указана', teamId: toTeamId };
  }
  const picks = routeTeams(inc, ctx, 5);
  const best = picks[0];
  if (!toTeamId) return { note: best ? `По справочнику подходит «${teamById(best.teamId)?.name}»` : 'Справочник не подсказал команду', teamId: best?.teamId ?? null };
  const k = picks.findIndex((p) => p.teamId === toTeamId);
  const to = teamById(toTeamId);
  if (k === 0) return { note: `Совпадает со справочником: «${to?.name}» — лучший вариант`, teamId: toTeamId };
  if (k > 0) return { note: `Справочник допускает «${to?.name}» (вариант ${k + 1}); лучший — «${teamById(best.teamId)?.name}»`, teamId: best.teamId };
  return { note: `В справочнике «${to?.name ?? toTeamId}» не обслуживает этот сервис. Лучше «${best ? teamById(best.teamId)?.name : '—'}»`, teamId: best?.teamId ?? null };
}
