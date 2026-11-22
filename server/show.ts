// Показ по кнопкам: «коллеги», команды, случайные сбои и демо-письма на паузе — ситуации запускаются с пульта.
// Каждая кнопка создаёт настоящую ситуацию через модель пункта, поэтому стена, уведомления и Джарвис реагируют как вживую.
import type { Incident } from '../shared/types.ts';
import type { Point } from './point.ts';
import type { Mailbox } from './mail.ts';
import { routeTeams } from './ai-point.ts';
import { POINT_ID, isOn, membersOf, personById, teamById } from './directory.ts';

const MIN = 60_000;
export const SHOW_KINDS = ['crit', 'coord', 'recur', 'mailCrit', 'mailAsk', 'stuck', 'sla', 'pingpong', 'p1ask', 'above', 'teamNotOurs', 'teamHelp', 'leadQ', 'lows', 'teamTake'] as const;
/** Через сколько руководитель отвечает на вопрос пункта в показе. */
export const LEAD_REPLY_MS = 15_000;
export type ShowKind = (typeof SHOW_KINDS)[number];

/** Режим показа: самотёк выключен (или снова включён). */
export function setShow(point: Point, mailbox: Mailbox, on: boolean) {
  point.show = on;
  point.stream.auto = !on;
  if (on) point.stream.outages = [];
  mailbox.demo = !on;
  return { show: on };
}

/** Чистая смена: инцидентов, жалоб, писем и сигналов нет. */
export function clearAll(point: Point, mailbox: Mailbox) {
  point.reset();
  mailbox.clear();
}

/** Команда по совету ИИ (или первая подходящая). */
function teamFor(point: Point, inc: Incident) {
  const pick = routeTeams(inc, point.ctx()).find((p) => p.teamId !== POINT_ID);
  if (!pick) throw new Error('справочник не нашёл команду');
  return pick.teamId;
}
const engineer = (teamId: string) => membersOf(teamId).find((p) => p.role === 'engineer') ?? membersOf(teamId)[0];

/** Запустить ситуацию. Возвращает короткую подпись для пульта. */
export function runShow(point: Point, mailbox: Mailbox, kind: ShowKind, actor: string): { text: string; id?: string } {
  switch (kind) {
    case 'crit': {
      // Новый критический: всплеск жалоб на мобильную связь в Москве, сбой продолжается
      const inc = point.scenarioIncident({ service: 'Мобильная связь', regionId: 'msk', n: 46, priority: 'P1', reason: 'ИИ: массовый всплеск на критичном сервисе' });
      point.outage('Мобильная связь', ['msk'], 6, 1.2);
      return { text: `Новый критический: ${inc.title}`, id: inc.id };
    }
    case 'coord': {
      // Инцидент ждёт распределения, ИИ уже советует команду
      const inc = point.scenarioIncident({ service: 'Домашний интернет', regionId: 'krd', n: 18, priority: 'P2' });
      return { text: `На распределение: ${inc.title}`, id: inc.id };
    }
    case 'recur': {
      // Решили, а жалобы снова: инцидент у команды → команда закрывает → сбой продолжается
      const inc = point.scenarioIncident({ service: 'KION', regionId: 'tom', n: 22, priority: 'P2' });
      const team = teamFor(point, inc);
      point.route(inc.id, team, actor);
      const people = membersOf(team).filter((p) => p.role === 'engineer');
      const eng = people.find((p) => isOn(p, Date.now())) ?? people[0] ?? engineer(team);
      if (!eng) throw new Error('в команде нет инженеров');
      try {
        point.take(inc.id, eng.id); // кто не на смене — сразу «решил», без «взял»
      } catch {
        /* не на смене */
      }
      point.resolveByTeam(inc.id, eng.id, 'Перезапустили сервис, жалобы прекратились');
      point.outage('KION', ['tom'], 5, 1.6);
      return { text: `Решили, а жалобы снова: ${inc.title}`, id: inc.id };
    }
    case 'mailCrit': {
      const m = mailbox.inject({
        from: 'monitoring@corp.local',
        fromName: 'Zabbix',
        subject: 'PROBLEM: Недоступен узел BRAS-SPB-02',
        body: 'Trigger: Host unreachable\nHost region: Санкт-Петербург\nSeverity: Disaster\nStarted: только что\nАбоненты домашнего интернета в Санкт-Петербурге без доступа.',
      });
      return { text: 'Срочное письмо: недоступен узел BRAS-SPB-02', id: m.id };
    }
    case 'mailAsk': {
      // Письмо руководителя команды: «это не к нам, переназначьте»
      let inc = [...point.incidents.values()].find((i) => i.status === 'assigned' || i.status === 'in_progress');
      if (!inc) {
        inc = point.scenarioIncident({ service: 'Мой МТС', regionId: 'spb', n: 14, priority: 'P2' });
        point.route(inc.id, teamFor(point, inc), actor);
      }
      const team = teamById(inc.teamId);
      const m = mailbox.inject({
        from: 'lead@corp.local',
        fromName: `Руководитель группы (${team?.name ?? 'команда'})`,
        subject: `${inc.id}: просим переназначить`,
        body: `Добрый день. По ${inc.id} «${inc.title}» — по логам это не к нам: проблема на стороне платформы авторизации. Просим передать в профильную команду.`,
      });
      return { text: `Письмо: просят переназначить ${inc.title}`, id: m.id };
    }
    case 'stuck': {
      // Команда не берёт: передан 12 минут назад, никто не взял, руководителю пора сказать
      const inc = point.scenarioIncident({ service: 'Мой МТС', regionId: 'spb', n: 16, priority: 'P2' });
      point.route(inc.id, teamFor(point, inc), actor);
      point.patch(inc.id, (i) => {
        i.routedAt = Date.now() - 12 * MIN;
      });
      point.runTimers();
      return { text: `Команда не берёт: ${inc.title}`, id: inc.id };
    }
    case 'sla': {
      const inc = point.scenarioIncident({ service: 'МТС Банк', regionId: 'sam', n: 12, priority: 'P2', slaMin: 14 });
      return { text: `Срок горит: ${inc.title} — 14 мин`, id: inc.id };
    }
    case 'pingpong': {
      // Передают по кругу: команда A → B → A
      const inc = point.scenarioIncident({ service: 'Оплата и баланс', regionId: 'nsk', n: 14, priority: 'P3' });
      const picks = routeTeams(inc, point.ctx()).filter((p) => p.teamId !== POINT_ID);
      const a = picks[0]?.teamId;
      const b = picks[1]?.teamId ?? picks[0]?.teamId;
      if (!a || !b) throw new Error('справочник не нашёл команды');
      point.route(inc.id, a, actor);
      point.route(inc.id, b, `Руководитель «${teamById(a)?.name}»`);
      point.route(inc.id, a, `Руководитель «${teamById(b)?.name}»`);
      return { text: `Передают по кругу: ${inc.title}`, id: inc.id };
    }
    case 'p1ask': {
      const inc = point.scenarioIncident({ service: 'Мобильный интернет', regionId: 'nsk', n: 34, priority: 'P2' });
      point.patch(inc.id, (i) => {
        i.p1Proposal = 'ИИ предлагает «Наивысший»: жалобы растут быстрее порога, сервис критичный — нужно подтверждение дежурного.';
      });
      return { text: `ИИ предлагает «Наивысший»: ${inc.title}`, id: inc.id };
    }
    case 'teamNotOurs': {
      // Вопрос команды: «это не наше — передайте», ИИ сверил со справочником и советует, кому
      const inc = point.scenarioIncident({ service: 'Домашний интернет', regionId: 'spb', n: 15, priority: 'P2' });
      const team = teamFor(point, inc);
      point.route(inc.id, team, actor);
      const eng = engineer(team);
      if (!eng) throw new Error('в команде нет сотрудников');
      point.requestTransfer(inc.id, eng.id, null, 'Не наша зона: по логам проблема на стороне платформы авторизации');
      return { text: `Команда просит передать: ${inc.title}`, id: inc.id };
    }
    case 'teamHelp': {
      // Вопрос команды: взяли, но нужна помощь
      const inc = point.scenarioIncident({ service: 'Мобильная связь', regionId: 'sam', n: 19, priority: 'P2' });
      const team = teamFor(point, inc);
      point.route(inc.id, team, actor);
      const eng = engineer(team);
      if (!eng) throw new Error('в команде нет сотрудников');
      try {
        point.take(inc.id, eng.id);
      } catch {
        /* уже у кого-то */
      }
      point.help(inc.id, eng.id, 'нет доступа к оборудованию узла, нужен инженер L2 по базовым станциям');
      return { text: `Команда просит помощи: ${inc.title}`, id: inc.id };
    }
    case 'leadQ': {
      // Пункт спрашивает руководителя команды; через 15 секунд руководитель отвечает в переписке
      const inc = point.scenarioIncident({ service: 'Мобильный интернет', regionId: 'krd', n: 17, priority: 'P2', slaMin: 35 });
      const team = teamFor(point, inc);
      point.route(inc.id, team, actor);
      point.messageLead(inc.id, actor, 'Сколько ещё до восстановления? Срок через 35 минут — успеваете?');
      const lead = personById(teamById(team)?.leadId);
      setTimeout(() => {
        if (!point.incidents.has(inc.id)) return; // смену очистили
        try {
          point.comment(inc.id, { name: lead?.name ?? 'Руководитель группы', personId: lead?.id ?? null, side: 'team', teamId: team }, 'Инженер уже на узле, восстановим минут за 20 — успеваем.');
        } catch {
          /* инцидент закрыт */
        }
      }, LEAD_REPLY_MS).unref(); // не держит процесс (тесты, остановка сервера)
      return { text: `Спросили руководителя: ${inc.title}`, id: inc.id };
    }
    case 'lows': {
      // Мелочь на распределение: два низких и средний, у которого до срока — как раз столько, сколько нужно команде.
      // Пока горит критический, ИИ раздаст их сам (Point.autoRoute): низкие — сразу, средний — когда подойдёт срок.
      point.scenarioIncident({ service: 'МТС Music', regionId: 'tom', n: 9, priority: 'P4' });
      point.scenarioIncident({ service: 'Домашнее ТВ', regionId: 'krd', n: 9, priority: 'P4' });
      const mid = point.scenarioIncident({ service: 'Мой МТС', regionId: 'nsk', n: 10, priority: 'P3', slaMin: 77 });
      return { text: 'Мелкие: два низких и средний — при критическом ИИ раздаст их сам', id: mid.id };
    }
    case 'teamTake': {
      // Команда взяла в работу: из переданных и ещё не взятых — самый важный, при равных — дольше всех ждёт
      const RANK = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
      const waiting = [...point.incidents.values()]
        .filter((i) => i.status === 'assigned' && i.teamId && i.teamId !== POINT_ID)
        .sort((a, b) => RANK[a.priority] - RANK[b.priority] || (a.routedAt ?? a.createdAt) - (b.routedAt ?? b.createdAt));
      const inc = waiting[0];
      if (!inc) throw new Error('нет инцидентов, которые ждут команду: сначала передайте инцидент команде');
      const people = membersOf(inc.teamId!).filter((x) => x.role === 'engineer');
      const eng = people.find((x) => isOn(x, Date.now())) ?? people[0] ?? engineer(inc.teamId!);
      if (!eng) throw new Error('в команде нет инженеров');
      point.take(inc.id, eng.id);
      return { text: `«${teamById(inc.teamId)?.name ?? 'Команда'}» взяла в работу: ${inc.title}`, id: inc.id };
    }
    case 'above': {
      // Важнее критического: у критического срок далеко, у высокого — через 12 минут
      point.scenarioIncident({ service: 'SMS', regionId: 'sam', n: 26, priority: 'P1', slaMin: 240 });
      const inc = point.scenarioIncident({ service: 'Личный кабинет', regionId: 'msk', n: 14, priority: 'P2', slaMin: 12 });
      return { text: `Важнее критического: ${inc.title} — срок через 12 мин`, id: inc.id };
    }
  }
}
