// Графики работы. Общий модуль: им пользуются и сервер (кому можно назначить), и экраны (кто на смене).
//   24/7 — четыре смены 2/2 по 12 часов: день 08–20, ночь 20–08 (смены 0 и 2 — дневные, 1 и 3 — ночные).
//   8-22 — каждый день, две смены: 08–15 (смена 0) и 15–22 (смена 1).
//   5/2  — понедельник–пятница 09–18.
// Время везде местное для сотрудника: tz — смещение от UTC в часах.
export type ScheduleKind = '24/7' | '8-22' | '5/2';

const H = 3_600_000;
const DAY = 86_400_000;

export function localTime(at: number, tz: number) {
  const t = at + tz * H;
  const day = Math.floor(t / DAY);
  const hour = (t - day * DAY) / H;
  const weekday = (((day + 3) % 7) + 7) % 7; // 1970-01-01 — четверг; 0 = понедельник
  return { day, hour, weekday };
}

const block = (day: number) => Math.floor(day / 2) % 2;

export function onDuty(kind: ScheduleKind, crew: number, tz: number, at: number): boolean {
  const { day, hour, weekday } = localTime(at, tz);
  switch (kind) {
    case '24/7': {
      if (hour >= 8 && hour < 20) return crew === (block(day) === 0 ? 0 : 2);
      const d = hour >= 20 ? day : day - 1;
      return crew === (block(d) === 0 ? 1 : 3);
    }
    case '8-22':
      return crew === 0 ? hour >= 8 && hour < 15 : hour >= 15 && hour < 22;
    case '5/2':
      return weekday < 5 && hour >= 9 && hour < 18;
  }
}

export function shiftLabel(kind: ScheduleKind, crew: number): string {
  switch (kind) {
    case '24/7':
      return `смена ${'АБВГ'[crew] ?? crew + 1}: ${crew % 2 === 0 ? 'день 08–20' : 'ночь 20–08'}, 2/2`;
    case '8-22':
      return crew === 0 ? 'утро 08–15, ежедневно' : 'вечер 15–22, ежедневно';
    case '5/2':
      return 'пн–пт 09–18';
  }
}

export const SCHEDULE_TEXT: Record<ScheduleKind, string> = {
  '24/7': 'круглосуточно',
  '8-22': '08–22 ежедневно',
  '5/2': 'пн–пт 09–18',
};

/** Когда в следующий раз изменится «на смене / не на смене» (шаг 15 минут, до 8 суток вперёд). */
export function nextChange(kind: ScheduleKind, crew: number, tz: number, at: number): number {
  const now = onDuty(kind, crew, tz, at);
  const step = 15 * 60_000;
  const start = Math.ceil(at / step) * step;
  for (let t = start; t < at + 8 * DAY; t += step) if (onDuty(kind, crew, tz, t) !== now) return t;
  return at + 8 * DAY;
}

/** Полоса на сутки вперёд: true — на смене, шаг 30 минут (48 ячеек). */
export function dutySlots(kind: ScheduleKind, crew: number, tz: number, from: number, hours = 24): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < hours * 2; i++) out.push(onDuty(kind, crew, tz, from + i * 30 * 60_000));
  return out;
}

export function fmtTz(tz: number) {
  const msk = tz - 3;
  return msk === 0 ? 'МСК' : `МСК${msk > 0 ? '+' : '−'}${Math.abs(msk)}`;
}
