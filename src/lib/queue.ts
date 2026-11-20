import { useMemo } from 'react';
import type { Incident } from '../../shared/types';
import { AT_RISK_MIN } from '../../shared/types';
import { useStore, type QueueFilter, type State } from '../store';
import { urgency } from './format';
import { useNow } from './hooks';

export function matches(i: Incident, f: QueueFilter, attention: Set<string>, now: number): boolean {
  const open = i.status !== 'resolved';
  switch (f) {
    case 'open':
      return open;
    case 'attention':
      return open && attention.has(i.id);
    case 'coordinators':
      return i.status === 'coordinators';
    case 'critical':
      return open && i.priority <= 'P2';
    case 'risk': {
      const r = i.slaDeadline - now;
      return open && r > 0 && r <= AT_RISK_MIN * 60_000;
    }
    case 'breach':
      return open && i.slaDeadline <= now;
    case 'resolved':
      return !open;
  }
}

function searchText(s: State, i: Incident) {
  const sys = s.systems.find((x) => x.id === i.systemId);
  const team = s.teams.find((x) => x.id === i.teamId);
  return `${i.id} ${i.title} ${sys?.name ?? ''} ${i.service} ${i.region} ${team?.name ?? ''} ${i.assignee ?? ''}`.toLowerCase();
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
    const score = new Map(list.map((i) => [i.id, urgency(i, now)]));
    list.sort((a, b) => score.get(b.id)! - score.get(a.id)!);
    return list;
  }, [incidents, filter, systemFilter, search, attention, systems, teams, now]);
}
