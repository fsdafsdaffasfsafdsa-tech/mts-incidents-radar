// Что показать дежурному и насколько громко. Дежурный занят своим — стена зовёт его только когда надо:
//   «Срочно»   — на весь экран, звук, помощник говорит голосом; висит, пока не приняли или пока ситуация не ушла;
//   «Внимание» — полосой сверху, мягкий звук, уходит сама;
//   «Инфо»     — тихой строкой, без звука: мелочи, о которых достаточно знать.
// Чистые функции: их используют стена в браузере и тесты.
import type { Incident } from './types.ts';
import { NOT_TAKEN_MIN, fmtShort, isRecurring, transferCount, waitingTake } from './dash.ts';

const MIN = 60_000;

export type Level = 'urgent' | 'attention' | 'info';
export type AlertKind =
  | 'crit' // новый критический
  | 'recur' // решили, а жалобы снова идут
  | 'p1ask' // ИИ предлагает «Наивысший»
  | 'critStuck' // критический не берут
  | 'critSla' // срок критического на исходе
  | 'coord' // назначен на координаторов — распределить
  | 'resolvedCrit' // критический решён
  | 'slaHigh' // у высокого срок близко
  | 'notTaken' // высокий не берут
  | 'pingpong' // передают по кругу
  | 'remind' // напоминание из избранного
  | 'fav' // изменился инцидент из избранного
  | 'forgot' // «не забудьте»
  | 'resolved' // решён (не критический)
  | 'routed' // передан команде
  | 'taken' // команда взяла в работу
  | 'created' // новый некритический у команды
  | 'levelDown'; // уровень понизили

export const ALERT_META: Record<AlertKind, { title: string; todo: string }> = {
  crit: { title: 'Новый критический', todo: 'Взять на себя и передать команде' },
  recur: { title: 'Решили, а жалобы снова идут', todo: 'Вернуть в работу команде' },
  p1ask: { title: 'ИИ предлагает «Наивысший»', todo: 'Подтвердить или отклонить' },
  critStuck: { title: 'Критический не берут', todo: 'Указать руководителю команды' },
  critSla: { title: 'Срок критического на исходе', todo: 'Проверить, успевает ли команда' },
  coord: { title: 'Распределить', todo: 'Передать в команду' },
  resolvedCrit: { title: 'Критический решён', todo: '' },
  slaHigh: { title: 'Срок близко', todo: 'Проверить у команды' },
  notTaken: { title: 'Команда не берёт', todo: 'Напомнить команде' },
  pingpong: { title: 'Передают по кругу', todo: 'Разобраться, чья зона' },
  remind: { title: 'Напоминание из избранного', todo: '' },
  fav: { title: 'Избранное', todo: '' },
  forgot: { title: 'Не забудьте', todo: '' },
  resolved: { title: 'Решён', todo: '' },
  routed: { title: 'Передан команде', todo: '' },
  taken: { title: 'Взяли в работу', todo: '' },
  created: { title: 'Новый', todo: '' },
  levelDown: { title: 'Уровень ниже', todo: '' },
};

/** Насколько громко: зависит от вида и уровня инцидента. */
export function levelOf(kind: AlertKind, inc: Incident): Level {
  switch (kind) {
    case 'crit':
    case 'recur':
    case 'p1ask':
    case 'critStuck':
    case 'critSla':
      return 'urgent';
    case 'coord':
      return inc.priority === 'P1' || inc.priority === 'P2' ? 'urgent' : 'attention';
    case 'resolvedCrit':
    case 'slaHigh':
    case 'notTaken':
    case 'pingpong':
    case 'remind':
    case 'fav':
    case 'forgot':
      return 'attention';
    default:
      return 'info';
  }
}

/** Снимок инцидента для сравнения «было — стало». */
export interface Sig {
  st: Incident['status'];
  pr: Incident['priority'];
  p1: boolean;
  recur: boolean;
}
export const sigOf = (i: Incident, now: number): Sig => ({ st: i.status, pr: i.priority, p1: !!i.p1Proposal, recur: isRecurring(i, now) });

export interface Found {
  kind: AlertKind;
  inc: Incident;
  text?: string;
}

const RANK = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
/** 1 жалоба, 3 жалобы, 7 жалоб. */
export const complaintsWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'жалоба' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'жалобы' : 'жалоб');
export const recurText = (i: Incident, now: number) =>
  `${i.recur?.team ? `«${i.recur.team}» решила` : 'решён'} ${fmtShort(now - (i.resolvedAt ?? now))} назад · снова ${i.recur?.count ?? 0} ${complaintsWord(i.recur?.count ?? 0)}`;

/**
 * Что случилось между двумя снимками, и состояния, о которых говорим один раз на инцидент (fired).
 * Первый снимок (prev = null) ничего не объявляет: то, что было до входа, — не новость.
 */
export function detect(prev: Map<string, Sig> | null, all: Incident[], now: number, fired: Set<string>): { found: Found[]; next: Map<string, Sig> } {
  const next = new Map(all.map((i) => [i.id, sigOf(i, now)]));
  const found: Found[] = [];
  const once = (kind: AlertKind, inc: Incident, cond: boolean, text?: string) => {
    if (!cond) return;
    const k = `${kind}:${inc.id}`;
    if (fired.has(k)) return;
    fired.add(k);
    if (prev) found.push({ kind, inc, text });
  };
  for (const i of all) {
    const s = next.get(i.id)!;
    const p = prev?.get(i.id);
    if (prev && !p) {
      if (i.status !== 'resolved') {
        if (s.pr === 'P1') found.push({ kind: 'crit', inc: i });
        else if (s.st === 'coordinators') found.push({ kind: 'coord', inc: i });
        else found.push({ kind: 'created', inc: i });
      }
    } else if (p) {
      if (s.pr === 'P1' && p.pr !== 'P1' && s.st !== 'resolved') found.push({ kind: 'crit', inc: i });
      if (s.st === 'resolved' && p.st !== 'resolved') found.push({ kind: s.pr === 'P1' ? 'resolvedCrit' : 'resolved', inc: i });
      if (s.recur && !p.recur) found.push({ kind: 'recur', inc: i, text: recurText(i, now) });
      if (s.p1 && !p.p1 && s.st !== 'resolved') found.push({ kind: 'p1ask', inc: i, text: i.p1Proposal ?? undefined });
      if (s.st === 'coordinators' && p.st !== 'coordinators' && s.pr !== 'P1') found.push({ kind: 'coord', inc: i, text: p.st === 'resolved' ? 'вернулся на пункт' : undefined });
      if (p.st === 'coordinators' && (s.st === 'assigned' || s.st === 'in_progress')) found.push({ kind: 'routed', inc: i, text: i.groupName ?? undefined });
      if (p.st === 'assigned' && s.st === 'in_progress') found.push({ kind: 'taken', inc: i, text: i.assigneeName ?? undefined });
      if (s.st !== 'resolved' && RANK[s.pr] > RANK[p.pr]) found.push({ kind: 'levelDown', inc: i, text: i.priorityText });
    }
    if (i.status === 'resolved') continue;
    const w = waitingTake(i, now);
    const left = i.slaDeadline - now;
    const t = transferCount(i);
    once('critStuck', i, i.priority === 'P1' && w !== null && w > NOT_TAKEN_MIN * MIN, `не берут ${fmtShort(w ?? 0)}`);
    once('critSla', i, i.priority === 'P1' && left < 15 * MIN, left > 0 ? `осталось ${fmtShort(left)}` : `просрочен на ${fmtShort(-left)}`);
    once('slaHigh', i, i.priority === 'P2' && left < 30 * MIN, left > 0 ? `осталось ${fmtShort(left)}` : `просрочен на ${fmtShort(-left)}`);
    once('notTaken', i, i.priority === 'P2' && w !== null && w > NOT_TAKEN_MIN * MIN, `не берут ${fmtShort(w ?? 0)}`);
    once('pingpong', i, t >= 3, `${t} передачи между командами`);
  }
  return { found, next };
}

/** Срочное висит, пока ситуация не ушла: взяли, вернули в работу, ответили на предложение ИИ… */
export function stillUrgent(kind: AlertKind, inc: Incident | undefined, now: number, coordAtStart: string | null): boolean {
  if (!inc) return false;
  switch (kind) {
    case 'crit':
      return inc.status !== 'resolved' && (inc.coordinatorId ?? null) === coordAtStart;
    case 'coord':
      return inc.status === 'coordinators' && !inc.coordinatorId;
    case 'recur':
      return isRecurring(inc, now);
    case 'p1ask':
      return !!inc.p1Proposal && inc.status !== 'resolved';
    case 'critStuck':
      return waitingTake(inc, now) !== null;
    case 'critSla':
      return inc.status !== 'resolved';
    default:
      return inc.status !== 'resolved';
  }
}

/**
 * Что Джарвис скажет о событии: коротко и с вопросом — дежурный отвечает голосом («да», «передай», «верни в работу»).
 * Обращение («Сэр, …») добавляет сам Джарвис по выбранному персонажу. teamOf — имя команды по id (для совета ИИ).
 */
export function voiceLine(kind: AlertKind, inc: Incident, now: number, teamOf: (id: string) => string = (id) => id): string {
  const t = `«${inc.title.replace(/^Жалобы: /, 'жалобы: ')}»`;
  const left = inc.slaDeadline - now;
  const short = (n: string) => n.split(' · ')[0]; // «SMS и USSD-платформа · L2, дежурная смена» → «SMS и USSD-платформа»
  const ai = inc.ai?.teamId ? short(teamOf(inc.ai.teamId)) : null;
  switch (kind) {
    case 'crit':
      return `новый критический — ${t}. ${inc.status === 'coordinators' && ai ? `ИИ советует «${ai}». Передать?` : 'Что будем делать?'}`;
    case 'coord':
      return `новый инцидент на распределение — ${t}. ${ai ? `ИИ советует «${ai}». Передать?` : 'Взять на себя?'}`;
    case 'recur':
      return `${inc.recur?.team ? `команда «${short(inc.recur.team)}»` : 'команда'} закрыла ${t}, но жалобы снова идут — уже ${inc.recur?.count ?? 0} ${complaintsWord(inc.recur?.count ?? 0)}. Вернуть в работу?`;
    case 'p1ask':
      return `ИИ предлагает поднять ${t} до наивысшего. Подтверждаем?`;
    case 'critStuck':
      return `критический ${t} не берут уже ${fmtShort(waitingTake(inc, now) ?? 0)}. Указать руководителю команды?`;
    case 'critSla':
      return `у критического ${t} срок на исходе. Что будем делать?`;
    case 'slaHigh':
      return left > 0 ? `у ${t} срок через ${fmtShort(left)}. Проверить у команды?` : `${t} просрочен. Что будем делать?`;
    case 'notTaken':
      return `${t} не берут уже ${fmtShort(waitingTake(inc, now) ?? 0)}. Напомнить команде?`;
    case 'pingpong':
      return `${t} передают по кругу — уже ${transferCount(inc)} раза. Разберёмся, чья зона?`;
    case 'resolvedCrit':
      return `критический ${t} решён за ${fmtShort((inc.resolvedAt ?? now) - inc.createdAt)}.`;
    case 'remind':
      return `напоминание по ${t}${inc.pin?.note ? `: ${inc.pin.note}` : ''}.`;
    case 'forgot':
      return `${t} давно без внимания. Посмотрим?`;
    case 'fav':
      return `по избранному ${t} есть изменения.`;
    default:
      return `${ALERT_META[kind].title.toLowerCase()}: ${t}.`;
  }
}

/** Насколько ярко показать инцидент: 0 — спокойный, 4 — самый срочный. Чем важнее — тем ярче. */
export function heat(score: number): 0 | 1 | 2 | 3 | 4 {
  return score >= 140 ? 4 : score >= 100 ? 3 : score >= 70 ? 2 : score >= 45 ? 1 : 0;
}
/** Яркость инцидента: средний и низкий даже просроченные не ярче оранжевого — красным горят только важные. */
export function heatFor(i: Incident, score: number): 0 | 1 | 2 | 3 | 4 {
  const h = heat(score);
  return (i.priority === 'P3' || i.priority === 'P4') && i.status !== 'resolved' ? (Math.min(h, 2) as 0 | 1 | 2) : h;
}
