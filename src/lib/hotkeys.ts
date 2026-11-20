// Горячие клавиши. Привязка по физической клавише (KeyboardEvent.code) — работает и на русской раскладке.
export type HotAction = 'next' | 'prev' | 'take' | 'route' | 'lead' | 'chat' | 'search' | 'settings' | 'jarvis' | 'tab1' | 'tab2' | 'tab3' | 'tab4' | 'tab5' | 'tab6' | 'tab7' | 'tab8' | 'tab9';

export const HOT_ACTIONS: { id: HotAction; text: string; point?: boolean }[] = [
  { id: 'next', text: 'Следующий инцидент в списке' },
  { id: 'prev', text: 'Предыдущий инцидент в списке' },
  { id: 'take', text: 'Взять выбранный инцидент себе' },
  { id: 'route', text: 'Передать команде по совету ИИ', point: true },
  { id: 'lead', text: 'Указать руководителю (по сигналу)', point: true },
  { id: 'chat', text: 'Написать в переписку инцидента' },
  { id: 'search', text: 'Быстрый поиск' },
  { id: 'settings', text: 'Открыть настройки' },
  { id: 'jarvis', text: 'Говорить с Джарвисом (голосовой помощник)', point: true },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `tab${n}` as HotAction, text: `Вкладка №${n}` })),
];

export const DEFAULT_HOTKEYS: Record<HotAction, string> = {
  next: 'KeyJ',
  prev: 'KeyK',
  take: 'KeyT',
  route: 'KeyR',
  lead: 'KeyE',
  chat: 'KeyC',
  search: 'Slash',
  settings: 'Comma',
  jarvis: 'KeyV',
  tab1: 'Digit1',
  tab2: 'Digit2',
  tab3: 'Digit3',
  tab4: 'Digit4',
  tab5: 'Digit5',
  tab6: 'Digit6',
  tab7: 'Digit7',
  tab8: 'Digit8',
  tab9: 'Digit9',
};

const NAMED: Record<string, string> = { Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '−', Equal: '=', Space: 'Пробел', Backslash: '\\' };
export function keyLabel(code: string) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return NAMED[code] ?? code;
}

/** Что сейчас на экране: порядок инцидентов в списке и вкладок — для «следующий», «вкладка №N». */
export const hotNav = { list: [] as string[], tabs: [] as string[] };
