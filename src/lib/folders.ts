// Папки слева: что в какой папке лежит и как она называется.
import { AlarmClock, CheckCircle2, Flame, Inbox, Siren, TimerOff, Users, type LucideIcon } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { AT_RISK_MIN } from '../../shared/types';
import type { FolderId, State } from '../store';

export interface ShiftFolder {
  id: FolderId;
  label: string;
  icon: LucideIcon;
  tone: 'p1' | 'warn' | 'coord' | 'ok' | 'neutral' | 'breach';
}

export const SHIFT_FOLDERS: ShiftFolder[] = [
  { id: 'urgent', label: 'Требуют решения', icon: Flame, tone: 'p1' },
  { id: 'coordinators', label: 'На координаторах', icon: Users, tone: 'coord' },
  { id: 'risk', label: 'SLA истекает', icon: AlarmClock, tone: 'warn' },
  { id: 'breach', label: 'SLA нарушен', icon: TimerOff, tone: 'breach' },
  { id: 'critical', label: 'P1 и P2', icon: Siren, tone: 'p1' },
  { id: 'open', label: 'Все открытые', icon: Inbox, tone: 'neutral' },
  { id: 'resolved', label: 'Решённые', icon: CheckCircle2, tone: 'ok' },
];

/** Лежит ли инцидент в папке. */
export function inFolder(inc: Incident, folder: FolderId, now: number): boolean {
  const open = inc.status !== 'resolved';
  if (folder.startsWith('sys:')) return open && inc.systemId === folder.slice(4);
  if (folder.startsWith('team:')) return open && inc.teamId === folder.slice(5);
  const rem = inc.slaDeadline - now;
  switch (folder) {
    case 'urgent':
      // То, что требует решения координатора прямо сейчас.
      return open && (inc.status === 'coordinators' || inc.priority === 'P1' || rem <= AT_RISK_MIN * 60_000 || (!inc.acknowledged && inc.priority === 'P2'));
    case 'coordinators':
      return inc.status === 'coordinators';
    case 'risk':
      return open && rem > 0 && rem <= AT_RISK_MIN * 60_000;
    case 'breach':
      return open && rem <= 0;
    case 'critical':
      return open && inc.priority <= 'P2';
    case 'open':
      return open;
    case 'resolved':
      return !open;
    default:
      return false;
  }
}

export function folderTitle(s: Pick<State, 'systems' | 'teams'>, folder: FolderId): string {
  if (folder.startsWith('sys:')) return s.systems.find((x) => x.id === folder.slice(4))?.name ?? 'Система';
  if (folder.startsWith('team:')) return s.teams.find((x) => x.id === folder.slice(5))?.name ?? 'Команда';
  if (folder === 'feed') return 'Лента событий';
  return SHIFT_FOLDERS.find((f) => f.id === folder)?.label ?? 'Папка';
}
