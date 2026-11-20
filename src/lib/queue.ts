import { useMemo } from 'react';
import type { Incident } from '../../shared/types';
import { AT_RISK_MIN, isOpen, slaRunning } from '../../shared/types';
import { useStore, type QueueFilter, type State } from '../store';
import { urgency } from './format';
import { useNow } from './hooks';

/** Решённый критический ещё сутки остаётся в группе «Критические» с пометкой «решён». */
const CRITICAL_RESOLVED_KEEP = 24 * 3_600_000;

/** Четыре группы ТЗ. Один инцидент может входить в несколько. */
export const GROUPS = [
  { id: 'critical', label: 'Критические', hint: 'приоритет «Наивысший»: статус и сроки', tone: 'p1' },
  { id: 'coordinators', label: 'На координаторах', hint: 'нужно передать в нужную группу', tone: 'coord' },
  { id: 'high', label: 'Высокий приоритет', hint: 'может перерасти в критический', tone: 'p2' },
  { id: 'research', label: 'Исследование ситуации', hint: 'сбой устранён, идёт разбор причин', tone: 'ai' },
] as const satisfies readonly { id: QueueFilter; label: string; hint: string; tone: string }[];

export function groupsOf(i: Incident, now: number): QueueFilter[] {
  return GROUPS.filter((g) => matches(i, g.id, new Set(), now)).map((g) => g.id);
}

export function matches(i: Incident, f: QueueFilter, attention: Set<string>, now: number): boolean {
  const open = isOpen(i);
  switch (f) {
    case 'open':
      return open;
    case 'attention':
      return open && attention.has(i.id);
    case 'critical':
      return i.priority === 'P1' && (open || (i.resolvedAt !== null && now - i.resolvedAt <= CRITICAL_RESOLVED_KEEP));
    case 'coordinators':
      return open && i.onCoordinators;
    case 'high':
      return open && i.priority === 'P2';
    case 'research':
      return i.status === 'research';
    case 'risk': {
      if (!slaRunning(i) || i.slaDeadline === null) return false;
      const r = i.slaDeadline - now;
      return r > 0 && r <= AT_RISK_MIN * 60_000;
    }
    case 'breach':
      return slaRunning(i) && i.slaDeadline !== null && i.slaDeadline <= now;
    case 'resolved':
      return !open;
  }
}

function searchText(s: State, i: Incident) {
  const team = s.teams.find((x) => x.id === i.teamId);
  return `${i.id} ${i.title} ${i.product} ${i.service} ${i.scenario} ${team?.name ?? ''} ${i.assignee ?? ''} ${i.state}`.toLowerCase();
}

export function sortByUrgency(list: Incident[], now: number): Incident[] {
  const score = new Map(list.map((i) => [i.id, urgency(i, now)]));
  return list.sort((a, b) => score.get(b.id)! - score.get(a.id)!);
}

/** Отфильтрованная и отсортированная по срочности очередь. Порядок пересчитывается при изменениях и раз в 10 с. */
export function useQueue(): Incident[] {
  const incidents = useStore((s) => s.incidents);
  const filter = useStore((s) => s.filter);
  const systemFilter = useStore((s) => s.systemFilter);
  const search = useStore((s) => s.search);
  const attention = useStore((s) => s.attention);
  const systems = useStore((s) => s.systems);
  const teams = useStore((s) => s.teams);
  const now = useNow(10_000);

  return useMemo(() => {
    const att = new Set(attention);
    const q = search.trim().toLowerCase();
    const st = { systems, teams } as State;
    const list = [...incidents.values()].filter(
      (i) => matches(i, filter, att, now) && (!systemFilter || i.systemId === systemFilter) && (!q || searchText(st, i).includes(q)),
    );
    return sortByUrgency(list, now);
  }, [incidents, filter, systemFilter, search, attention, systems, teams, now]);
}
