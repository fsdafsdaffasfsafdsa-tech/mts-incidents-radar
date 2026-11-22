// Справочник координирующего пункта: ~900 команд по направлениям и регионам, люди с графиками.
// Генерация детерминированная (по зерну): после перезапуска те же команды, люди и логины.
// Группы из выгрузки ITSM входят в справочник как есть, вместе с их сотрудниками.
import { ETERNAL_SHIFT, onDuty } from '../shared/schedule.ts';
import type { Person, Team } from '../shared/types.ts';
import { COORDINATORS_GROUP, EMPLOYEES, GROUPS } from './catalog.ts';
import { DISTRICTS, DISTRICT_CITY, DISTRICT_TZ, REGIONS } from './regions.ts';

// ─── сервисы абонентов ─────────────────────────────────────────────────────

export interface ServiceDef {
  name: string;
  weight: number; // доля в фоне жалоб
  critical: boolean;
  regional: boolean; // сбой обычно локальный (сеть в регионе), иначе — центральная платформа
  texts: string[];
}

export const SERVICES: ServiceDef[] = [
  { name: 'Мобильный интернет', weight: 0.24, critical: true, regional: true, texts: ['Нет мобильного интернета', 'Интернет очень медленный, страницы не грузятся', 'Пропадает 4G, переключается на 3G', 'Интернет не работает после пополнения'] },
  { name: 'Мобильная связь', weight: 0.16, critical: true, regional: true, texts: ['Не проходят исходящие звонки', 'Нет сети', 'Звонки обрываются через минуту', 'Собеседник меня не слышит'] },
  { name: 'Домашний интернет', weight: 0.14, critical: false, regional: true, texts: ['Нет домашнего интернета', 'Роутер не получает адрес', 'Скорость ниже тарифа', 'Интернет пропадает каждые полчаса'] },
  { name: 'Мой МТС', weight: 0.1, critical: false, regional: false, texts: ['Не входит в приложение Мой МТС', 'Приложение показывает ошибку', 'Не загружается баланс в приложении', 'Не приходит код для входа'] },
  { name: 'Оплата и баланс', weight: 0.08, critical: true, regional: false, texts: ['Деньги списались, баланс не пополнился', 'Не проходит оплата картой', 'Неверное списание за услугу', 'Автоплатёж не сработал'] },
  { name: 'KION', weight: 0.06, critical: false, regional: false, texts: ['KION не воспроизводит видео', 'Ошибка загрузки каталога KION', 'Пропала подписка KION', 'Фильм зависает на телевизоре'] },
  { name: 'Домашнее ТВ', weight: 0.05, critical: false, regional: true, texts: ['Нет сигнала на каналах', 'Каналы IPTV не загружаются', 'Приставка не включается в меню'] },
  { name: 'МТС Банк', weight: 0.05, critical: true, regional: false, texts: ['Не проходит перевод по СБП', 'Не входит в мобильный банк', 'Карта отклоняет оплату'] },
  { name: 'SMS', weight: 0.04, critical: false, regional: false, texts: ['Не приходят SMS', 'SMS отправляются с задержкой', 'Не приходят коды подтверждения'] },
  { name: 'МТС Music', weight: 0.03, critical: false, regional: false, texts: ['Музыка не воспроизводится', 'Пропали плейлисты'] },
  { name: 'Личный кабинет', weight: 0.03, critical: false, regional: false, texts: ['Не открывается личный кабинет на сайте', 'Не загружается детализация'] },
  { name: 'B2B-каналы', weight: 0.02, critical: true, regional: true, texts: ['Упал канал VPN в офис', 'Нет связи с филиалом компании', 'Потери пакетов на корпоративном канале'] },
];
export const serviceDef = (name: string) => SERVICES.find((s) => s.name === name);

// ─── центральные продукты ──────────────────────────────────────────────────

interface ProductDef {
  id: string;
  name: string;
  services: string[];
  critical: boolean;
  subs: string[];
  itsm?: string; // группа из выгрузки, которая и есть L2 этого продукта
}

const PRODUCTS: ProductDef[] = [
  { id: 'mymts', name: 'Мой МТС', services: ['Мой МТС'], critical: true, subs: ['Авторизация', 'Главный экран', 'Платежи в приложении', 'Push-уведомления', 'Каталог тарифов', 'Чат поддержки'], itsm: 'КЦ ИТ Мой МТС' },
  { id: 'lk', name: 'Личный кабинет', services: ['Личный кабинет'], critical: false, subs: ['Авторизация и SSO', 'Детализация', 'Подключение услуг'] },
  { id: 'bill', name: 'Биллинг', services: ['Оплата и баланс'], critical: true, subs: ['Тарификация', 'Платежи и баланс', 'Счета B2B', 'Роуминг', 'Интерконнект', 'Подписки'], itsm: 'КЦ ИТ ЦП Billing Platform' },
  { id: 'crm', name: 'CRM', services: [], critical: true, subs: ['Карточка абонента', 'Заявки', 'Смена тарифа', 'Перенос номера (MNP)'] },
  { id: 'kion', name: 'KION', services: ['KION'], critical: false, subs: ['Плеер', 'Каталог', 'Подписки', 'Смарт-ТВ', 'CDN-доставка'], itsm: 'КЦ ИТ Media L2 KION' },
  { id: 'music', name: 'МТС Music', services: ['МТС Music'], critical: false, subs: ['Плеер', 'Подписки', 'Рекомендации'] },
  { id: 'bank', name: 'МТС Банк (ДБО)', services: ['МТС Банк'], critical: true, subs: ['Мобильный банк', 'Переводы СБП', 'Карты', 'Кредиты'] },
  { id: 'pay', name: 'МТС Pay', services: ['Оплата и баланс'], critical: true, subs: ['Эквайринг', 'Автоплатёж', 'Кошелёк'] },
  { id: 'sms', name: 'SMS и USSD-платформа', services: ['SMS'], critical: true, subs: ['SMSC', 'USSD-шлюз', 'A2P-рассылки'] },
  { id: 'voice', name: 'Голосовая связь (ядро CS/IMS)', services: ['Мобильная связь'], critical: true, subs: ['VoLTE', 'VoWiFi', 'MSC', 'Интерконнект голоса'] },
  { id: 'data', name: 'Мобильный интернет (ядро PS)', services: ['Мобильный интернет'], critical: true, subs: ['PGW/SGW', 'DPI', 'APN для бизнеса', '5G NSA'] },
  { id: 'home', name: 'Домашний интернет и ТВ (платформа)', services: ['Домашний интернет', 'Домашнее ТВ'], critical: false, subs: ['BRAS', 'IPTV middleware', 'Абонентские устройства (ACS)'] },
  { id: 'shop', name: 'Интернет-магазин', services: [], critical: false, subs: ['Витрина', 'Корзина и оплата', 'Доставка'] },
  { id: 'mws', name: 'Облако MWS', services: [], critical: true, subs: ['Виртуальные машины', 'Kubernetes', 'Объектное хранилище', 'Сеть облака'] },
  { id: 'sec', name: 'Антифрод и безопасность', services: [], critical: true, subs: ['Антиспам звонков', 'Антифрод платежей', 'SOC'] },
  { id: 'corp', name: 'Корпоративные сервисы', services: [], critical: false, subs: ['Почта', 'Active Directory', 'VPN сотрудников', 'Service Desk'] },
  { id: 'iot', name: 'IoT и M2M', services: [], critical: false, subs: ['IoT-платформа', 'Телематика'] },
  { id: 'api', name: 'API-шлюз и интеграции', services: [], critical: true, subs: ['API Gateway', 'Шина ESB'] },
  { id: 'dwh', name: 'Хранилище данных и отчётность', services: [], critical: false, subs: ['DWH', 'BI'] },
  { id: 'ccp', name: 'Платформа контакт-центра', services: [], critical: true, subs: ['Телефония КЦ', 'Чат-бот', 'IVR'] },
  { id: 'premium', name: 'МТС Premium', services: [], critical: false, subs: ['Подписки', 'Кешбэк'] },
  { id: 'b2bnet', name: 'B2B: VPN и каналы (опорная сеть)', services: ['B2B-каналы'], critical: true, subs: ['MPLS VPN', 'Интернет для бизнеса'] },
];

// ─── генератор имён ────────────────────────────────────────────────────────

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261120);
const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

const MALE = ['Алексей', 'Андрей', 'Артём', 'Борис', 'Вадим', 'Виктор', 'Владимир', 'Дмитрий', 'Евгений', 'Егор', 'Иван', 'Игорь', 'Илья', 'Кирилл', 'Максим', 'Михаил', 'Никита', 'Олег', 'Павел', 'Роман', 'Сергей', 'Станислав', 'Тимур', 'Фёдор', 'Юрий', 'Ярослав', 'Антон', 'Глеб', 'Денис', 'Руслан'];
const FEMALE = ['Алина', 'Анастасия', 'Анна', 'Валерия', 'Вера', 'Дарья', 'Екатерина', 'Елена', 'Ирина', 'Ксения', 'Мария', 'Марина', 'Наталья', 'Ольга', 'Полина', 'Светлана', 'Софья', 'Татьяна', 'Юлия', 'Виктория'];
const SURNAMES = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров', 'Зайцев', 'Соловьёв', 'Борисов', 'Яковлев', 'Григорьев', 'Романов', 'Воробьёв', 'Сергеев', 'Кузьмин', 'Фролов', 'Александров', 'Дмитриев', 'Королёв', 'Гусев', 'Киселёв', 'Ильин', 'Максимов', 'Поляков', 'Сорокин', 'Виноградов', 'Ковалёв', 'Белов', 'Медведев', 'Антонов', 'Тарасов', 'Жуков', 'Баранов', 'Филиппов', 'Комаров', 'Давыдов', 'Беляев', 'Герасимов', 'Богданов', 'Осипов', 'Сидоров', 'Матвеев', 'Титов', 'Марков', 'Миронов', 'Крылов', 'Куликов', 'Карпов', 'Власов', 'Мельников', 'Денисов', 'Гаврилов', 'Тихонов', 'Казаков', 'Афанасьев', 'Данилов', 'Савельев', 'Тимофеев', 'Фомин', 'Чернов', 'Абрамов', 'Мартынов', 'Ефимов', 'Федотов', 'Щербаков', 'Назаров', 'Калинин', 'Исаев', 'Быков', 'Маслов', 'Родионов', 'Коновалов', 'Лазарев', 'Воронин', 'Климов', 'Филатов', 'Голубев', 'Прохоров', 'Наумов', 'Потапов', 'Журавлёв', 'Трофимов', 'Леонов', 'Соболев', 'Ермаков', 'Колесников', 'Гончаров', 'Покровский', 'Никольский', 'Черных', 'Седых'];
const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s: string) => [...s.toLowerCase()].map((c) => TR[c] ?? c).join('');
const female = (sur: string) =>
  /(ов|ев|ёв|ин|ын)$/.test(sur) ? `${sur}а` : /ский$/.test(sur) ? sur.replace(/ий$/, 'ая') : sur;

const usedLogins = new Set<string>(EMPLOYEES.map((e) => e.id));
function makePerson(teamId: string, role: Person['role'], schedule: Team['schedule'], crew: number, tz: number, spec?: string): Person {
  const isF = rand() < 0.38;
  const first = isF ? pick(FEMALE) : pick(MALE);
  const sur0 = pick(SURNAMES);
  const sur = isF ? female(sur0) : sur0;
  const base = `${translit(sur0)}.${translit(first)[0]}`;
  let login = base;
  for (let i = 2; usedLogins.has(login); i++) login = `${base}${i}`;
  usedLogins.add(login);
  return { id: login, name: `${sur} ${first}`, teamId, role, schedule, crew, tz, ...(spec ? { spec } : {}) };
}

// ─── сборка справочника ────────────────────────────────────────────────────

export const TEAMS: Team[] = [];
export const PEOPLE: Person[] = [];

function addTeam(t: Omit<Team, 'leadId' | 'size'>, perCrew: number) {
  const team: Team = { ...t, leadId: null, size: 0 };
  const lead = makePerson(team.id, 'lead', '5/2', 0, team.tz);
  team.leadId = lead.id;
  const crews = t.schedule === '24/7' ? 4 : t.schedule === '8-22' ? 2 : 1;
  const members: Person[] = [lead];
  for (let c = 0; c < crews; c++) for (let k = 0; k < perCrew; k++) members.push(makePerson(team.id, 'engineer', t.schedule, c, team.tz));
  team.size = members.length;
  TEAMS.push(team);
  PEOPLE.push(...members);
  return team;
}

// Координирующий пункт: круглосуточно, 4 смены, в каждой трое дежурных разной специализации. Новые инциденты распределяет ИИ.
export const POINT_ID = 'kp';
const SPECS = ['Сеть', 'ИТ-продукты', 'B2B и корпоративные'];
{
  const team: Team = {
    id: POINT_ID,
    name: 'Координирующий пункт ИТ',
    direction: 'Координация массовых инцидентов',
    kind: 'point',
    services: [],
    regionId: 'msk',
    district: 'cfo',
    schedule: '24/7',
    tz: 3,
    leadId: null,
    backupId: null,
    size: 0,
  };
  const head = makePerson(POINT_ID, 'lead', '5/2', 0, 3);
  team.leadId = head.id;
  PEOPLE.push(head);
  for (let c = 0; c < 4; c++) {
    // Роли командира больше нет. Генератор всё равно вызываем, чтобы имена и логины остальных не сдвинулись.
    makePerson(POINT_ID, 'coordinator', '24/7', c, 3);
    for (const spec of SPECS) PEOPLE.push(makePerson(POINT_ID, 'coordinator', '24/7', c, 3, spec));
  }
  team.size = PEOPLE.filter((p) => p.teamId === POINT_ID).length;
  TEAMS.push(team);
}

// Дежурные смены центральных направлений — запасные для команд, которые сейчас не работают.
const DUTY = {
  itsup: addTeam({ id: 'itsup-duty', name: 'ИТ-поддержка · дежурная смена', direction: 'ИТ-поддержка', kind: 'duty', services: [], regionId: 'msk', district: 'cfo', schedule: '24/7', tz: 3, backupId: null }, 2),
  b2b: addTeam({ id: 'b2b-duty', name: 'B2B · дежурная смена', direction: 'B2B-сервисы', kind: 'duty', services: ['B2B-каналы'], regionId: 'msk', district: 'cfo', schedule: '24/7', tz: 3, backupId: null }, 2),
  infra: addTeam({ id: 'infra-duty', name: 'Инфраструктура · дежурная смена', direction: 'Инфраструктура ЦОД', kind: 'duty', services: [], regionId: 'msk', district: 'cfo', schedule: '24/7', tz: 3, backupId: null }, 2),
};

// Окружные команды.
for (const [d, label] of Object.entries(DISTRICTS)) {
  const tz = DISTRICT_TZ[d];
  addTeam({ id: `noc-${d}`, name: `Центр управления сетью · ${label}`, direction: 'Управление сетью', kind: 'noc', services: ['Мобильная связь', 'Мобильный интернет', 'Домашний интернет', 'Домашнее ТВ', 'B2B-каналы'], regionId: null, district: d, schedule: '24/7', tz, backupId: null }, 2);
  addTeam({ id: `core-${d}`, name: `Ядро сети (PS/CS) · ${label}`, direction: 'Ядро сети', kind: 'core', services: ['Мобильная связь', 'Мобильный интернет'], regionId: null, district: d, schedule: '24/7', tz, backupId: null }, 1);
  addTeam({ id: `dc-${d}`, name: `ЦОД ${DISTRICT_CITY[d]} · ${label}`, direction: 'Инфраструктура ЦОД', kind: 'dc', services: [], regionId: null, district: d, schedule: '24/7', tz, backupId: null }, 1);
  addTeam({ id: `cc-${d}`, name: `Контакт-центр, ИТ-линия · ${label}`, direction: 'Контакт-центр', kind: 'cc', services: [], regionId: null, district: d, schedule: '8-22', tz, backupId: DUTY.itsup.id }, 2);
}

// Региональные команды филиалов.
for (const r of REGIONS) {
  const noc = `noc-${r.district}`;
  const big = r.weight >= 2;
  const reg = { regionId: r.id, district: r.district, tz: r.tz };
  addTeam({ id: `ran-${r.id}`, name: `Радиосеть · ${r.name}`, direction: 'Радиосеть (RAN)', kind: 'ran', services: ['Мобильная связь', 'Мобильный интернет'], schedule: '24/7', backupId: noc, ...reg }, big ? 2 : 1);
  addTeam({ id: `fix-${r.id}`, name: `Домашний интернет (GPON) · ${r.name}`, direction: 'Фиксированный доступ', kind: 'fix', services: ['Домашний интернет'], schedule: '8-22', backupId: noc, ...reg }, big ? 2 : 1);
  addTeam({ id: `tv-${r.id}`, name: `Домашнее ТВ и IPTV · ${r.name}`, direction: 'Фиксированный доступ', kind: 'tv', services: ['Домашнее ТВ'], schedule: '8-22', backupId: noc, ...reg }, 1);
  addTeam({ id: `trn-${r.id}`, name: `Транспортная сеть · ${r.name}`, direction: 'Транспортная сеть', kind: 'trn', services: [], schedule: '5/2', backupId: noc, ...reg }, big ? 3 : 2);
  addTeam({ id: `opt-${r.id}`, name: `Оптимизация радиосети · ${r.name}`, direction: 'Радиосеть (RAN)', kind: 'opt', services: ['Мобильный интернет'], schedule: '5/2', backupId: `ran-${r.id}`, ...reg }, 2);
  addTeam({ id: `b2b-${r.id}`, name: `B2B-сервисы · ${r.name}`, direction: 'B2B-сервисы', kind: 'b2b', services: ['B2B-каналы'], schedule: '5/2', backupId: DUTY.b2b.id, ...reg }, big ? 3 : 2);
  addTeam({ id: `itsup-${r.id}`, name: `ИТ-поддержка филиала · ${r.name}`, direction: 'ИТ-поддержка', kind: 'itsup', services: [], schedule: '5/2', backupId: DUTY.itsup.id, ...reg }, 2);
  addTeam({ id: `cs-${r.id}`, name: `Абонентский сервис, ИТ · ${r.name}`, direction: 'Контакт-центр', kind: 'cs', services: [], schedule: '8-22', backupId: `cc-${r.district}`, ...reg }, 1);
  addTeam({ id: `sale-${r.id}`, name: `Розница и салоны, ИТ · ${r.name}`, direction: 'Розница', kind: 'sale', services: [], schedule: '8-22', backupId: DUTY.itsup.id, ...reg }, 1);
}

// Группы из выгрузки ITSM: сотрудники из выгрузки + дежурные, чтобы у круглосуточных были все смены.
const ITSM_TEAM = new Map<string, string>(); // id группы выгрузки → id команды
for (const g of GROUPS) {
  if (g.id === COORDINATORS_GROUP) {
    ITSM_TEAM.set(g.id, POINT_ID);
    continue;
  }
  const allDay = /Аварии|Дежурная|ОГЭ|L2|OPS|Мой МТС|AutoClosed/i.test(g.name);
  const team: Team = {
    id: g.id,
    name: g.name,
    direction: 'Группа из выгрузки ITSM',
    kind: 'itsm',
    services: [],
    regionId: /Приморье/.test(g.name) ? 'prim' : /Санкт-Петербург/.test(g.name) ? 'spb' : 'msk',
    district: /Приморье/.test(g.name) ? 'dfo' : /Санкт-Петербург/.test(g.name) ? 'szfo' : 'cfo',
    schedule: allDay ? '24/7' : '5/2',
    tz: /Приморье/.test(g.name) ? 10 : 3,
    leadId: null,
    backupId: allDay ? null : DUTY.itsup.id,
    size: 0,
    itsm: true,
  };
  TEAMS.push(team);
  ITSM_TEAM.set(g.id, team.id);
  const lead = makePerson(team.id, 'lead', '5/2', 0, team.tz);
  team.leadId = lead.id;
  PEOPLE.push(lead);
  const crews = allDay ? 4 : 1;
  for (let c = 0; c < crews; c++) PEOPLE.push(makePerson(team.id, 'engineer', team.schedule, c, team.tz));
}
let k = 0;
for (const e of EMPLOYEES) {
  const groups = e.groups.map((g) => ITSM_TEAM.get(g)).filter((t): t is string => !!t && t !== POINT_ID);
  if (!groups.length) continue;
  const team = TEAMS.find((t) => t.id === groups[0])!;
  PEOPLE.push({ id: e.id, name: e.name, teamId: team.id, role: 'engineer', schedule: team.schedule, crew: team.schedule === '24/7' ? k++ % 4 : 0, tz: team.tz, teams: groups.slice(1) });
}
export const itsmTeam = (groupId: string | null | undefined) => (groupId ? ITSM_TEAM.get(groupId) ?? null : null);

// Центральные продукты: L2 (дежурная смена или группа из выгрузки), разработка по подсистемам, БД, релизы.
const PRODUCT_L2 = new Map<string, string>();
for (const p of PRODUCTS) {
  const itsmGroup = p.itsm ? GROUPS.find((g) => g.name === p.itsm) : undefined;
  let l2 = itsmGroup ? TEAMS.find((t) => t.id === itsmTeam(itsmGroup.id)) : undefined;
  if (l2) l2.services = [...new Set([...l2.services, ...p.services])];
  else
    l2 = addTeam(
      { id: `l2-${p.id}`, name: `${p.name} · L2, дежурная смена`, direction: p.name, kind: 'l2', services: p.services, regionId: 'msk', district: 'cfo', schedule: p.critical ? '24/7' : '8-22', tz: 3, backupId: p.critical ? null : DUTY.itsup.id },
      p.critical ? 1 : 2,
    );
  PRODUCT_L2.set(p.id, l2.id);
  p.subs.forEach((s, i) =>
    addTeam({ id: `dev-${p.id}-${i + 1}`, name: `${p.name} · ${s}`, direction: p.name, kind: 'dev', services: [], regionId: 'msk', district: 'cfo', schedule: '5/2', tz: 3, backupId: l2!.id }, 2 + (i % 3)),
  );
  addTeam({ id: `dba-${p.id}`, name: `${p.name} · эксплуатация БД`, direction: p.name, kind: 'dba', services: [], regionId: 'msk', district: 'cfo', schedule: '5/2', tz: 3, backupId: DUTY.infra.id }, 2);
  addTeam({ id: `qa-${p.id}`, name: `${p.name} · релизы и тестирование`, direction: p.name, kind: 'qa', services: [], regionId: 'msk', district: 'cfo', schedule: '5/2', tz: 3, backupId: l2.id }, 2);
}
export const productL2 = (service: string) => {
  const p = PRODUCTS.find((x) => x.services.includes(service));
  return p ? PRODUCT_L2.get(p.id) ?? null : null;
};

// Инфраструктура.
for (let i = 1; i <= 12; i++) addTeam({ id: `k8s-${i}`, name: `Kubernetes-кластер ${String(i).padStart(2, '0')}`, direction: 'Инфраструктура ЦОД', kind: 'infra', services: [], regionId: 'msk', district: 'cfo', schedule: '8-22', tz: 3, backupId: DUTY.infra.id }, 1);
for (const [code, label] of [['san', 'СХД и SAN'], ['dcn', 'Сети ЦОД'], ['virt', 'Виртуализация'], ['bkp', 'Резервное копирование']] as const) {
  for (const d of ['cfo', 'szfo', 'pfo', 'ufo', 'sfo']) addTeam({ id: `${code}-${d}`, name: `${label} · ${DISTRICTS[d]}`, direction: 'Инфраструктура ЦОД', kind: 'infra', services: [], regionId: null, district: d, schedule: '5/2', tz: DISTRICT_TZ[d], backupId: DUTY.infra.id }, 2);
}
addTeam({ id: 'mon', name: 'Мониторинг и наблюдаемость', direction: 'Инфраструктура ЦОД', kind: 'infra', services: [], regionId: 'msk', district: 'cfo', schedule: '24/7', tz: 3, backupId: null }, 1);
addTeam({ id: 'soc', name: 'Центр мониторинга ИБ (SOC)', direction: 'Антифрод и безопасность', kind: 'infra', services: [], regionId: 'msk', district: 'cfo', schedule: '24/7', tz: 3, backupId: null }, 2);

export const teamById = (id: string | null | undefined) => (id ? TEAM_INDEX.get(id) : undefined);
export const personById = (id: string | null | undefined) => (id ? PERSON_INDEX.get(id) : undefined);
const TEAM_INDEX = new Map(TEAMS.map((t) => [t.id, t]));
const PERSON_INDEX = new Map(PEOPLE.map((p) => [p.id, p]));

const MEMBERS = new Map<string, Person[]>();
for (const p of PEOPLE) for (const t of [p.teamId, ...(p.teams ?? [])]) MEMBERS.set(t, [...(MEMBERS.get(t) ?? []), p]);
for (const t of TEAMS) t.size = MEMBERS.get(t.id)?.length ?? t.size;
export const membersOf = (teamId: string) => MEMBERS.get(teamId) ?? [];

export const isOn = (p: Person, at: number) => ETERNAL_SHIFT || (!p.away && onDuty(p.schedule, p.crew, p.tz, at)); // вечная смена — на связи все и всегда
/** Кто из команды сейчас на смене (руководитель — в рабочие часы). */
export const onShift = (teamId: string, at: number) => membersOf(teamId).filter((p) => isOn(p, at));
export const teamOnDuty = (teamId: string, at: number) => onShift(teamId, at).some((p) => p.role === 'engineer' || teamId === POINT_ID);

export const POINT_STAFF = PEOPLE.filter((p) => p.teamId === POINT_ID);
