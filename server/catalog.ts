// Каталог из набора данных МТС (data/character_problems.json): продукты, группы, сотрудники, офисы.
// Описание полей — data/incidents_attributes.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Office, Priority, WorkMode } from '../shared/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface RawIncident {
  id: string;
  state: string;
  stateId: number;
  stateReason: string | null;
  submitDate: string;
  deadline: string | null;
  completionDate: string | null;
  header: string;
  description: string;
  shortDescription: string;
  solution: string | null;
  assignedGroupName: string | null;
  assignedEmployee: string | null;
  assignedEmployeeLogin?: string | null;
  isEffect: boolean;
  isReason: boolean;
  isDouble: boolean;
  isMaster: boolean;
  serviceType: string;
  priorityId: number;
  priority: string;
  urgency: string;
  impact: string;
  productName: string;
  service: string;
  scenarioName: string;
  isNeedUp: boolean | null;
  receivingChannel: string;
}

export const RAW: RawIncident[] = JSON.parse(fs.readFileSync(path.join(root, 'data', 'character_problems.json'), 'utf8'));

// ─── продукты, сервисы, сценарии ───────────────────────────────────────────

export interface ProductDef {
  id: string;
  name: string;
  short: string;
  icon: string;
  services: { name: string; scenarios: string[] }[];
}

const ICON_BY_WORD: [RegExp, string][] = [
  [/tictok|просматр/i, 'Camera'],
  [/акваланг/i, 'Waves'],
  [/ковер|ковёр/i, 'Wind'],
  [/хомяч|страхов/i, 'ShieldCheck'],
  [/зажигалк/i, 'Flame'],
];

/** «[Продукт] Сервис» → «Сервис». */
export const serviceName = (s: string) => s.replace(/^\[[^\]]*\]\s*/, '');

export const PRODUCTS: ProductDef[] = [];
for (const r of RAW) {
  let p = PRODUCTS.find((x) => x.name === r.productName);
  if (!p) {
    p = {
      id: `p${PRODUCTS.length + 1}`,
      name: r.productName,
      short: r.productName.replace(/^Автопросматриватель\s*/i, 'Авто-просмотр '),
      icon: ICON_BY_WORD.find(([re]) => re.test(r.productName))?.[1] ?? 'Box',
      services: [],
    };
    PRODUCTS.push(p);
  }
  const svc = serviceName(r.service);
  let s = p.services.find((x) => x.name === svc);
  if (!s) p.services.push((s = { name: svc, scenarios: [] }));
  if (!s.scenarios.includes(r.scenarioName)) s.scenarios.push(r.scenarioName);
}

export const productByName = (name: string) => PRODUCTS.find((p) => p.name === name);
export const productById = (id: string) => PRODUCTS.find((p) => p.id === id);

// ─── группы ────────────────────────────────────────────────────────────────

export interface GroupDef {
  id: string;
  name: string;
  short: string;
  offline: boolean;
}

export const GROUPS: GroupDef[] = [];
for (const r of RAW) {
  const name = r.assignedGroupName ?? 'Без группы';
  if (!GROUPS.some((g) => g.name === name)) {
    GROUPS.push({ id: `g${GROUPS.length + 1}`, name, short: name.replace(/^КЦ\s+/, ''), offline: /ОГЭ/.test(name) });
  }
}
export const COORDINATORS_GROUP = GROUPS.find((g) => /Координатор/i.test(g.name))?.id ?? GROUPS[0].id;
export const groupByName = (name: string | null) => GROUPS.find((g) => g.name === (name ?? 'Без группы'));
export const groupById = (id: string | null | undefined) => GROUPS.find((g) => g.id === id);

// ─── онлайн или офлайн ─────────────────────────────────────────────────────

/** Офлайн — когда в описании просят выезд специалиста или заявка у групп ОГЭ (выездная эксплуатация). */
export function isOfflineRecord(r: Pick<RawIncident, 'description' | 'assignedGroupName'>): boolean {
  return /выезд/i.test(r.description ?? '') || /ОГЭ/.test(r.assignedGroupName ?? '');
}

// ─── офисы МТС для выездных ────────────────────────────────────────────────

export const OFFICES: Office[] = [
  { id: 'rnd', city: 'Ростов-на-Дону', lat: 47.2225, lon: 39.7187 },
  { id: 'krd', city: 'Краснодар', lat: 45.0393, lon: 38.9872 },
  { id: 'vlg', city: 'Волгоград', lat: 48.7071, lon: 44.5169 },
  { id: 'ast', city: 'Астрахань', lat: 46.3497, lon: 48.0408 },
  { id: 'aer', city: 'Сочи', lat: 43.5853, lon: 39.7203 },
];

/** Населённые пункты ЮФО, где стоят площадки (БС, узлы связи), — по зоне ответственности офиса. */
export interface Site {
  city: string;
  code: string; // код региона для номера площадки
  lat: number;
  lon: number;
  spread: number; // радиус разброса площадок, км
}
export const SITES: Record<string, Site[]> = {
  rnd: [
    { city: 'Ростов-на-Дону', code: '61', lat: 47.2357, lon: 39.7015, spread: 7 },
    { city: 'Таганрог', code: '61', lat: 47.2362, lon: 38.8969, spread: 3 },
    { city: 'Новочеркасск', code: '61', lat: 47.4222, lon: 40.0939, spread: 3 },
    { city: 'Шахты', code: '61', lat: 47.7085, lon: 40.216, spread: 3 },
    { city: 'Батайск', code: '61', lat: 47.1383, lon: 39.7448, spread: 2 },
    { city: 'Азов', code: '61', lat: 47.1121, lon: 39.4232, spread: 2 },
    { city: 'Аксай', code: '61', lat: 47.2676, lon: 39.8756, spread: 2 },
    { city: 'Волгодонск', code: '61', lat: 47.5136, lon: 42.1514, spread: 3 },
  ],
  krd: [
    { city: 'Краснодар', code: '23', lat: 45.0355, lon: 38.9753, spread: 7 },
    { city: 'Новороссийск', code: '23', lat: 44.7235, lon: 37.7686, spread: 3 },
    { city: 'Анапа', code: '23', lat: 44.8948, lon: 37.3167, spread: 2.5 },
    { city: 'Армавир', code: '23', lat: 44.9892, lon: 41.1234, spread: 3 },
    { city: 'Майкоп', code: '01', lat: 44.6098, lon: 40.1006, spread: 3 },
    { city: 'Ейск', code: '23', lat: 46.7106, lon: 38.2764, spread: 2 },
    { city: 'Кропоткин', code: '23', lat: 45.4375, lon: 40.5756, spread: 2 },
    { city: 'Тихорецк', code: '23', lat: 45.8546, lon: 40.1256, spread: 2 },
  ],
  vlg: [
    { city: 'Волгоград', code: '34', lat: 48.708, lon: 44.5133, spread: 8 },
    { city: 'Волжский', code: '34', lat: 48.7858, lon: 44.7797, spread: 3 },
    { city: 'Камышин', code: '34', lat: 50.0983, lon: 45.416, spread: 2.5 },
    { city: 'Михайловка', code: '34', lat: 50.06, lon: 43.2378, spread: 2 },
    { city: 'Калач-на-Дону', code: '34', lat: 48.6889, lon: 43.5306, spread: 1.5 },
    { city: 'Урюпинск', code: '34', lat: 50.7955, lon: 42.0058, spread: 1.5 },
  ],
  ast: [
    { city: 'Астрахань', code: '30', lat: 46.3479, lon: 48.0336, spread: 6 },
    { city: 'Ахтубинск', code: '30', lat: 48.2789, lon: 46.1664, spread: 2 },
    { city: 'Знаменск', code: '30', lat: 48.5853, lon: 45.7372, spread: 1.5 },
    { city: 'Камызяк', code: '30', lat: 46.1103, lon: 48.0731, spread: 1.5 },
    { city: 'Элиста', code: '08', lat: 46.3078, lon: 44.2558, spread: 2.5 },
  ],
  aer: [
    { city: 'Сочи', code: '23', lat: 43.5855, lon: 39.7231, spread: 4 },
    { city: 'Адлер', code: '23', lat: 43.4285, lon: 39.9239, spread: 2.5 },
    { city: 'Хоста', code: '23', lat: 43.5153, lon: 39.8697, spread: 1.5 },
    { city: 'Красная Поляна', code: '23', lat: 43.6797, lon: 40.2058, spread: 2 },
    { city: 'Туапсе', code: '23', lat: 44.0956, lon: 39.0747, spread: 2 },
    { city: 'Геленджик', code: '23', lat: 44.5622, lon: 38.0768, spread: 2.5 },
  ],
};

/** Границы ЮФО для карты: [[запад, юг], [восток, север]]. */
export const REGION_BOUNDS: [[number, number], [number, number]] = [[36.2, 42.9], [49.6, 51.4]];
export const officeById = (id: string | null | undefined) => OFFICES.find((o) => o.id === id);

// ─── сотрудники ────────────────────────────────────────────────────────────

export interface EmployeeDef {
  id: string; // логин
  name: string;
  mode: WorkMode;
  groups: string[];
  office: string | null;
}

const parseEmployee = (s: string) => {
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { name: m[1].trim(), login: m[2].trim() } : { name: s, login: s };
};

// Офис выездного: группа ОГЭ подсказывает город, остальных распределяем по офисам (условно, в данных адресов нет).
const OFFICE_HINTS: [RegExp, string][] = [
  [/Приморье/i, 'aer'],
  [/Санкт-Петербург/i, 'rnd'],
];
const FALLBACK_OFFICES = ['krd', 'vlg', 'ast', 'rnd', 'krd', 'vlg'];

export const EMPLOYEES: EmployeeDef[] = (() => {
  const by = new Map<string, { name: string; groups: Set<string>; total: number; field: number; officeHint: string | null }>();
  for (const r of RAW) {
    if (!r.assignedEmployee) continue;
    const { name, login } = parseEmployee(r.assignedEmployee);
    const e = by.get(login) ?? { name, groups: new Set<string>(), total: 0, field: 0, officeHint: null };
    const g = groupByName(r.assignedGroupName);
    if (g) e.groups.add(g.id);
    e.total++;
    if (isOfflineRecord(r)) e.field++;
    const hint = OFFICE_HINTS.find(([re]) => re.test(r.assignedGroupName ?? ''));
    if (hint) e.officeHint = hint[1];
    by.set(login, e);
  }
  let fallback = 0;
  return [...by.entries()].map(([login, e]) => {
    // Выездной — если есть группа ОГЭ или хотя бы половина его заявок с выездом.
    const offline = e.officeHint !== null || e.field / e.total >= 0.5;
    return {
      id: login,
      name: e.name,
      mode: offline ? 'offline' : 'online',
      groups: [...e.groups],
      office: offline ? e.officeHint ?? FALLBACK_OFFICES[fallback++ % FALLBACK_OFFICES.length] : null,
    } satisfies EmployeeDef;
  });
})();

export const employeeById = (id: string | null | undefined) => EMPLOYEES.find((e) => e.id === id);
export const employeeLogin = (raw: string | null) => (raw ? parseEmployee(raw).login : null);

// ─── приоритеты и статусы ──────────────────────────────────────────────────

export function priorityFromId(id: number): Priority {
  return id >= 4 ? 'P1' : id === 3 ? 'P2' : id === 2 ? 'P3' : 'P4';
}

// ─── словарь для живого потока (по образцу набора) ─────────────────────────

export const HEADER_TEMPLATES = ['Отказ {s} ({svc})', 'Неисправность: {s}', 'Проблема с {s}', 'Аномалия в {s}', 'Сбой {s} на {svc}'];
export const SHORT_TEMPLATES = [
  'Зафиксировано отклонение в работе {s}.',
  '{s} перестал выполнять свои функции.',
  '{s} работает нестабильно, пользователи жалуются.',
  '{s} не отвечает, требуется диагностика.',
  'Выявлена неисправность {s} на {svc}.',
];
export const DESCRIPTION_TEMPLATES = [
  'Автоматический алерт: {s} ({svc}) в продукте {p} показывает отклонения от нормы. Требуется реакция.',
  'В системе {p} на узле {svc} обнаружена аномалия в {s}. Событие зарегистрировано автоматически. Необходим анализ и устранение.',
  'На {p}, компонент {svc}: зафиксирована проблема с {s}. Пользователи сообщают о сбоях. Требуется проверка и восстановление.',
];
export const FIELD_DESCRIPTION = 'Жалоба на {p}: {s} в составе {svc} работает с ошибками. Требуется выезд специалиста и диагностика.';
export const SOLUTION_TEMPLATES = [
  'Отрегулирован {s}, инцидент закрыт.',
  'Перезапущен {s}, работоспособность подтверждена.',
  'Проведена диагностика, {s} исправлен.',
  'Заменён {s}, система восстановлена.',
  'Запасной {s} установлен, система работает штатно.',
];

/** Сколько раз сотрудник в данных решал этот сервис / продукт — опыт для подсказки ИИ. */
export function experience(login: string, product: string, service: string) {
  let sameService = 0;
  let sameProduct = 0;
  for (const r of RAW) {
    if (employeeLogin(r.assignedEmployee) !== login) continue;
    if (r.productName === product) sameProduct++;
    if (serviceName(r.service) === service) sameService++;
  }
  return { sameService, sameProduct };
}

/** Какая группа чаще всего решала этот сервис в данных. */
export function groupForService(product: string, service: string): string | null {
  const counts = new Map<string, number>();
  for (const r of RAW) {
    if (r.productName !== product || serviceName(r.service) !== service) continue;
    const g = groupByName(r.assignedGroupName);
    if (g && !/AutoClosed/i.test(g.name)) counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
