// Общая шкала сроков для стены («Сроки», «Команды»): растянута у «сейчас» (логарифм) —
// сроки бывают и через час, и через неделю, так видно и то и другое. Левее «сейчас» — просрочено.
import type { Incident } from '../../../shared/types';
import { NOT_TAKEN_MIN, waitingTake } from '../../../shared/dash';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const WEEK = 168 * HOUR;
export const NOW_X = 6; // где на шкале «сейчас» (в процентах)

/** Доля шкалы 0…1 для «осталось до срока»: 15 минут → мало, неделя → 1. */
export const frac = (left: number) => Math.min(1, Math.log(1 + Math.max(0, left) / (15 * MIN)) / Math.log(1 + WEEK / (15 * MIN)));
/** Позиция на шкале в процентах; просроченные — в красной зоне слева. */
export const xOf = (left: number) => (left < 0 ? NOW_X / 2 : NOW_X + frac(left) * (100 - NOW_X));
export const TICKS: [string, number][] = [
  ['сейчас', 0],
  ['1ч', HOUR],
  ['4ч', 4 * HOUR],
  ['1д', 24 * HOUR],
  ['3д', 72 * HOUR],
  ['7д', WEEK],
];
/** «23м», «3ч», «2д»; просрочено — с минусом. */
export const cd = (left: number) => {
  const m = Math.round(Math.abs(left) / MIN);
  const t = m < 60 ? `${m}м` : m < 2880 ? `${Math.floor(m / 60)}ч` : `${Math.floor(m / 1440)}д`;
  return left < 0 ? `−${t}` : t;
};
/** Команда не берёт инцидент дольше порога. */
export const isStuck = (i: Incident, now: number) => (waitingTake(i, now) ?? 0) > NOT_TAKEN_MIN * MIN;
