// Собственные настройки каждого блока стены — в редакторе блока («Изменить блоки» → нажать на блок).
import type { BlockId } from '../../../shared/dash';
import { PERSONAS } from '../../../shared/personas';

export type BlockOpt =
  | { key: string; label: string; type: 'bool'; def: boolean }
  | { key: string; label: string; type: 'range'; def: number; min: number; max: number; step?: number; unit?: string }
  | { key: string; label: string; type: 'choice'; def: string; choices: { id: string; name: string }[] }
  | { key: string; label: string; type: 'text'; def: string };

const GROUP_CHOICES = [
  { id: 'crit', name: 'Критические' },
  { id: 'coord', name: 'На координаторах' },
  { id: 'high', name: 'Высокий приоритет' },
  { id: 'research', name: 'Исследование ситуации' },
];

export const BLOCK_OPTS: Partial<Record<BlockId, BlockOpt[]>> = {
  action: [
    { key: 'resolved', label: 'Решённые критические (15 минут)', type: 'bool', def: true },
    { key: 'compact', label: 'Компактные карточки', type: 'bool', def: false },
    { key: 'ai', label: 'Совет ИИ на карточке', type: 'bool', def: false },
    { key: 'page', label: 'Листать каждые', type: 'range', def: 15, min: 6, max: 60, unit: ' с' },
  ],
  work: [
    { key: 'cTime', label: 'Колонка «В работе»', type: 'bool', def: true },
    { key: 'cSla', label: 'Колонка «До срока»', type: 'bool', def: true },
    { key: 'cTr', label: 'Колонка «Передачи»', type: 'bool', def: true },
    { key: 'cTeam', label: 'Колонка «Команда»', type: 'bool', def: true },
    { key: 'page', label: 'Листать каждые', type: 'range', def: 15, min: 6, max: 60, unit: ' с' },
  ],
  groups: [
    { key: 'g_crit', label: 'Критические', type: 'bool', def: true },
    { key: 'g_coord', label: 'На координаторах', type: 'bool', def: true },
    { key: 'g_high', label: 'Высокий приоритет', type: 'bool', def: true },
    { key: 'g_research', label: 'Исследование ситуации', type: 'bool', def: true },
  ],
  group: [{ key: 'group', label: 'Какая группа', type: 'choice', def: 'crit', choices: GROUP_CHOICES }],
  character: [
    { key: 'persona', label: 'Персонаж', type: 'choice', def: 'jarvis', choices: PERSONAS.map((p) => ({ id: p.id, name: p.name })) },
    { key: 'every', label: 'Говорит каждые', type: 'range', def: 60, min: 30, max: 300, step: 15, unit: ' с' },
  ],
  assistant: [
    { key: 'risks', label: 'Риск стать критическим', type: 'bool', def: true },
    { key: 'route', label: 'Кому передать', type: 'bool', def: true },
    { key: 'ask', label: 'Строка для команд Джарвису', type: 'bool', def: true },
  ],
  risk: [{ key: 'count', label: 'Сколько показывать', type: 'range', def: 6, min: 2, max: 12 }],
  route: [{ key: 'count', label: 'Сколько показывать', type: 'range', def: 6, min: 2, max: 12 }],
  teams: [{ key: 'count', label: 'Сколько команд', type: 'range', def: 8, min: 3, max: 15 }],
  transfers: [{ key: 'count', label: 'Сколько инцидентов', type: 'range', def: 6, min: 2, max: 12 }],
  stats: [
    { key: 'tiles', label: 'Цифры', type: 'bool', def: true },
    { key: 'spark', label: 'Жалобы за час', type: 'bool', def: true },
    { key: 'bars', label: 'Полосы по группам', type: 'bool', def: true },
  ],
  events: [{ key: 'count', label: 'Сколько событий', type: 'range', def: 18, min: 5, max: 40 }],
  note: [
    { key: 'title', label: 'Заголовок', type: 'text', def: 'Заметка' },
    { key: 'text', label: 'Текст', type: 'text', def: 'Нажмите «Изменить блоки», затем на эту заметку — и напишите свой текст: телефоны дежурных, напоминание смене.' },
  ],
  rotate: [
    { key: 'r_assistant', label: 'ИИ-помощник', type: 'bool', def: true },
    { key: 'r_transfers', label: 'История передач', type: 'bool', def: true },
    { key: 'r_stats', label: 'Смена в цифрах', type: 'bool', def: true },
    { key: 'r_events', label: 'Лента событий', type: 'bool', def: true },
    { key: 'sec', label: 'Менять каждые', type: 'range', def: 20, min: 8, max: 90, unit: ' с' },
  ],
};
