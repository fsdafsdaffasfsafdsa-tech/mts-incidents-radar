// Каталог: системы МТС, команды поддержки и шаблоны инцидентов для генератора.
// Все данные синтетические: имена, хосты и цифры выдуманы.
import type { Priority, Source, SystemInfo, TeamInfo } from '../shared/types.ts';

export interface SystemDef extends SystemInfo {
  services: string[];
  owners: string[]; // команды-владельцы: первая — основная
}

export const SYSTEMS: SystemDef[] = [
  { id: 'billing', name: 'Биллинг', short: 'Биллинг', icon: 'Receipt', dependsOn: ['dc'], owners: ['billing_l2', 'dba'],
    services: ['Тарификация CDR', 'Списание абонплаты', 'Баланс и лимиты', 'Роуминг (TAP)', 'Счета B2B'] },
  { id: 'ran', name: 'Мобильная сеть (RAN)', short: 'Мобильная сеть', icon: 'RadioTower', dependsOn: [], owners: ['ran_ops', 'transport'],
    services: ['Базовые станции LTE', '5G NR', '2G/3G', 'Транспорт до БС'] },
  { id: 'core', name: 'Ядро сети', short: 'Ядро сети', icon: 'Network', dependsOn: ['dc'], owners: ['core_net'],
    services: ['EPC / MME', 'IMS / VoLTE', 'HLR / HSS', 'DNS абонентов', 'SMSC'] },
  { id: 'app', name: 'Приложение «Мой МТС»', short: 'Мой МТС', icon: 'Smartphone', dependsOn: ['api', 'billing', 'sms'], owners: ['mobile_app'],
    services: ['Вход по SMS', 'Главный экран и баланс', 'Подключение услуг', 'Push-уведомления'] },
  { id: 'lk', name: 'Личный кабинет (web)', short: 'Личный кабинет', icon: 'MonitorSmartphone', dependsOn: ['api', 'billing'], owners: ['web_front'],
    services: ['Авторизация', 'Детализация', 'Оплата картой', 'Смена тарифа'] },
  { id: 'payments', name: 'Платежи', short: 'Платежи', icon: 'CreditCard', dependsOn: ['billing', 'api'], owners: ['payments'],
    services: ['Эквайринг', 'Автоплатёж', 'СБП', 'Шлюз партнёров'] },
  { id: 'dc', name: 'ЦОД и инфраструктура', short: 'ЦОД', icon: 'Server', dependsOn: [], owners: ['dc_infra'],
    services: ['ЦОД Москва-Север', 'ЦОД Санкт-Петербург', 'ЦОД Екатеринбург', 'СХД', 'Электропитание и охлаждение'] },
  { id: 'api', name: 'API-шлюз и интеграции', short: 'API и интеграции', icon: 'Workflow', dependsOn: ['dc'], owners: ['platform_sre'],
    services: ['API Gateway', 'Шина ESB', 'Kafka', 'SSO / OAuth'] },
  { id: 'kion', name: 'KION (видео)', short: 'KION', icon: 'Clapperboard', dependsOn: ['dc', 'billing'], owners: ['media'],
    services: ['VOD-стриминг', 'Телеканалы (live)', 'CDN', 'Подписки'] },
  { id: 'home', name: 'Домашний интернет и ТВ', short: 'Домашний интернет', icon: 'Router', dependsOn: ['core'], owners: ['fixed_net'],
    services: ['GPON-доступ', 'BRAS / PPPoE', 'IPTV', 'Роутеры (TR-069)'] },
  { id: 'crm', name: 'CRM и контакт-центр', short: 'Контакт-центр', icon: 'Headset', dependsOn: ['api'], owners: ['crm_team'],
    services: ['CRM оператора', 'IVR 0890', 'Чат поддержки', 'Заявки на подключение'] },
  { id: 'sms', name: 'SMS и уведомления', short: 'SMS', icon: 'MessageSquareText', dependsOn: ['core'], owners: ['messaging'],
    services: ['SMS-шлюз', 'OTP-коды', 'Рассылки B2B'] },
];

export interface TeamDef extends TeamInfo {
  keywords: string[]; // корни слов в нижнем регистре
  capacity: number; // сколько инцидентов команда спокойно держит в работе
}

export const COORDINATORS_ID = 'coord';

export const TEAMS: TeamDef[] = [
  { id: COORDINATORS_ID, name: 'Координаторы ДИТ', short: 'Координаторы', isCoordinators: true, capacity: 999, keywords: [],
    members: ['А. Корнеева', 'Д. Лебедев', 'М. Ахмедова'] },
  { id: 'billing_l2', name: 'Биллинг L2', short: 'Биллинг L2', capacity: 14,
    keywords: ['тарификац', 'cdr', 'списан', 'баланс', 'абонплат', 'tap', 'счет', 'счёт', 'начислен', 'rating', 'биллинг'],
    members: ['И. Соколов', 'Е. Морозова', 'П. Волков', 'Т. Зайцева'] },
  { id: 'dba', name: 'DBA (Oracle / Postgres)', short: 'DBA', capacity: 8,
    keywords: ['бд', 'базы данных', 'база данных', 'oracle', 'postgres', 'репликац', 'блокировк', 'запросы к бд', 'медленные запросы', 'tablespace', 'индекс'],
    members: ['Р. Гусев', 'Н. Белова', 'С. Орлов'] },
  { id: 'ran_ops', name: 'RAN Ops', short: 'RAN Ops', capacity: 16,
    keywords: ['бс', 'базов', 'сектор', 'lte', '5g', 'enodeb', 'gnodeb', 'покрыт', 'сигнал', 'площадк', 'скорост'],
    members: ['А. Никитин', 'О. Медведева', 'К. Фёдоров', 'Ю. Павлова'] },
  { id: 'transport', name: 'Транспортная сеть', short: 'Транспорт', capacity: 8,
    keywords: ['магистрал', 'волс', 'оптик', 'волокн', 'dwdm', 'обрыв', 'mpls', 'канал связи', 'транспорт'],
    members: ['В. Егоров', 'Л. Тихонова', 'Г. Комаров'] },
  { id: 'core_net', name: 'Ядро сети (Core)', short: 'Core', capacity: 10,
    keywords: ['mme', 'ims', 'volte', 'hlr', 'hss', 'регистрац', 'attach', 'вызов', 'dns', 'epc'],
    members: ['М. Ершов', 'А. Киселёва', 'Б. Широков'] },
  { id: 'mobile_app', name: 'Мобильное приложение', short: 'Mobile', capacity: 10,
    keywords: ['приложени', 'ios', 'android', 'краш', 'crash', 'push', 'релиз', 'экран'],
    members: ['Д. Андреев', 'С. Ковалёва', 'Ф. Ильин', 'Е. Полякова'] },
  { id: 'web_front', name: 'Web / Frontend', short: 'Web', capacity: 8,
    keywords: ['страниц', 'web', 'сайт', 'фронтенд', 'frontend', 'белый экран', 'верстк', 'браузер'],
    members: ['Н. Карпов', 'В. Сорокина', 'И. Блинов'] },
  { id: 'payments', name: 'Платёжные сервисы', short: 'Платежи', capacity: 10,
    keywords: ['платеж', 'платёж', 'эквайр', 'картой', 'карты', 'сбп', 'автоплат', 'транзакц', '3-d secure', 'банк-партн', 'зачислен'],
    members: ['К. Мельникова', 'А. Голубев', 'Р. Виноградова'] },
  { id: 'dc_infra', name: 'Инфраструктура ЦОД', short: 'ЦОД', capacity: 10,
    keywords: ['цод', 'стойк', 'электропит', 'ибп', 'охлажд', 'перегрев', 'схд', 'гипервизор', 'вм', 'машзал'],
    members: ['Е. Савельев', 'Т. Крылова', 'Д. Яковлев'] },
  { id: 'platform_sre', name: 'Платформа / SRE', short: 'SRE', capacity: 12,
    keywords: ['kubernetes', 'k8s', 'кластер', 'api gateway', 'api', 'шлюз', '5xx', '504', 'kafka', 'лаг', 'сертификат', 'sso', 'токен', 'latency'],
    members: ['А. Романов', 'М. Козлова', 'Г. Степанов', 'Л. Фролова'] },
  { id: 'media', name: 'Медиаплатформа KION', short: 'KION', capacity: 8,
    keywords: ['видео', 'стрим', 'vod', 'телеканал', 'cdn', 'буфериз', 'drm', 'smart tv'],
    members: ['О. Баранов', 'Ю. Кудрявцева', 'С. Титов'] },
  { id: 'fixed_net', name: 'Фиксированная сеть (ШПД)', short: 'ШПД', capacity: 10,
    keywords: ['gpon', 'olt', 'bras', 'pppoe', 'iptv', 'роутер', 'мультикаст', 'домашн'],
    members: ['П. Афанасьев', 'И. Дмитриева', 'В. Лазарев'] },
  { id: 'crm_team', name: 'CRM и контакт-центр', short: 'CRM', capacity: 8,
    keywords: ['crm', 'ivr', 'оператор', 'обращени', 'чат поддержки', 'заявк', '0890', 'карточк'],
    members: ['Е. Гаврилова', 'Н. Филиппов', 'А. Маркова'] },
  { id: 'messaging', name: 'SMS-платформа', short: 'SMS', capacity: 8,
    keywords: ['sms', 'смс', 'otp', 'рассылк', 'коды', 'код подтвержд', 'smpp', 'smsc'],
    members: ['Р. Тарасов', 'К. Белоусова', 'М. Жуков'] },
  { id: 'soc', name: 'SOC (информационная безопасность)', short: 'SOC', capacity: 6,
    keywords: ['ddos', 'атак', 'waf', 'подозрит', 'аномальн', 'брутфорс', 'фишинг', 'бот'],
    members: ['Д. Соловьёв', 'А. Зуева', 'Т. Мухин'] },
];

export const REGIONS = [
  'Москва', 'Санкт-Петербург', 'Екатеринбург', 'Новосибирск', 'Казань', 'Нижний Новгород',
  'Краснодар', 'Ростов-на-Дону', 'Самара', 'Уфа', 'Пермь', 'Воронеж', 'Красноярск', 'Тюмень',
];

export interface Template {
  system: string;
  region?: string; // привязка к городу (ЦОД)
  pathTo?: string; // второй конец линии на карте
  team: string; // «правда» генератора: кто на самом деле должен решать
  service?: string;
  title: string;
  description: string;
  signals: string[];
  prio: Priority[]; // из чего выбирать (первый — чаще)
  users: [number, number];
  source?: Source;
  host?: string; // шаблон имени компонента
}

// Плейсхолдеры: {region} {region2} {n} {pct} {ms} {k} {host} {ver} {t} {partner} {channel}
export const TEMPLATES: Template[] = [
  // ── Биллинг
  { system: 'billing', team: 'billing_l2', service: 'Тарификация CDR', host: 'bill-rt-{n2}',
    title: 'Очередь CDR растёт: задержка тарификации {n} мин',
    description: 'Записи о звонках и трафике тарифицируются с задержкой. Абоненты видят неактуальный баланс, возможны ошибочные блокировки по лимиту.',
    signals: ['Лаг консьюмера cdr-rating: {n} мин', 'Очередь rating-in: {k} тыс. записей'], prio: ['P2', 'P3'], users: [40_000, 900_000] },
  { system: 'billing', team: 'billing_l2', service: 'Списание абонплаты', host: 'bill-charge-{n2}',
    title: 'Двойное списание абонплаты у части абонентов ({region})',
    description: 'Поступают обращения о повторном списании ежемесячного платежа. Затронуты тарифы линейки «Для своих».',
    signals: ['Дубли транзакций списания: {k} шт.', 'Рост обращений «двойное списание» ×{x}'], prio: ['P2', 'P1'], users: [5_000, 120_000], source: 'support' },
  { system: 'billing', team: 'dba', service: 'Баланс и лимиты', host: 'ora-bill-{n2}',
    title: 'Медленные запросы к БД биллинга: p95 {ms} мс',
    description: 'Запросы баланса выполняются медленно, в базе данных растёт число блокировок на таблице лицевых счетов.',
    signals: ['Oracle: ожидания enq: TX row lock {pct}%', 'p95 запроса balance_get: {ms} мс'], prio: ['P2', 'P3'], users: [20_000, 600_000] },
  { system: 'billing', team: 'billing_l2', service: 'Счета B2B', host: 'bill-inv-{n2}',
    title: 'Не формируются счета B2B за прошлый период',
    description: 'Пакетное задание выставления счетов корпоративным клиентам завершилось с ошибкой на этапе начисления.',
    signals: ['Job invoice_monthly: FAILED', 'Не выставлено счетов: {k} тыс.'], prio: ['P3', 'P4'], users: [300, 6_000], source: 'support' },
  { system: 'billing', team: 'billing_l2', service: 'Роуминг (TAP)', host: 'tap-gw-{n2}',
    title: 'Ошибки разбора TAP-файлов от роуминг-партнёра {partner}',
    description: 'Входящие TAP-файлы отклоняются валидатором, начисления за роуминг не поступают.',
    signals: ['Отклонено TAP-файлов: {n}', 'Ошибка валидации: неверная версия TAP 3.12'], prio: ['P3', 'P4'], users: [1_000, 30_000], source: 'partner' },

  // ── Мобильная сеть
  { system: 'ran', team: 'ran_ops', service: 'Базовые станции LTE', host: 'enb-{reg}-{n3}',
    title: 'Авария БС: {n} секторов LTE недоступны ({region})',
    description: 'Базовые станции не отвечают системе управления. Абоненты в районе переходят в 3G или теряют связь.',
    signals: ['eNodeB alarm: S1 link down ×{n}', 'Падение трафика в кластере на {pct}%'], prio: ['P2', 'P3'], users: [8_000, 140_000] },
  { system: 'ran', team: 'ran_ops', service: 'Базовые станции LTE', host: 'cluster-{reg}-{n2}',
    title: 'Деградация скорости 4G в {region}: −{pct}% к норме',
    description: 'Средняя скорость передачи данных в часы нагрузки заметно ниже нормы, растёт число жалоб на медленный интернет.',
    signals: ['DL throughput −{pct}%', 'PRB utilization 96%'], prio: ['P3', 'P4'], users: [20_000, 300_000] },
  { system: 'ran', team: 'transport', service: 'Транспорт до БС', host: 'dwdm-{reg}-{n2}',
    title: 'Обрыв магистральной ВОЛС {region} — {region2}',
    description: 'Пропал оптический канал на магистрали, трафик ушёл на резервное кольцо с меньшей ёмкостью.',
    signals: ['DWDM: LOS на линии {region}–{region2}', 'Резервный канал загружен на {pct}%'], prio: ['P1', 'P2'], users: [150_000, 1_500_000] },
  { system: 'ran', team: 'ran_ops', service: '2G/3G', host: 'bts-{reg}-{n3}',
    title: 'Пропало питание на {n} площадках БС ({region})',
    description: 'Площадки работают от аккумуляторов, ресурс АКБ — около {n2} минут. Нужен выезд с генератором.',
    signals: ['Mains failure ×{n}', 'Battery discharge alarm'], prio: ['P2', 'P3'], users: [5_000, 60_000] },

  // ── Ядро сети
  { system: 'core', team: 'core_net', service: 'IMS / VoLTE', host: 'ims-pcscf-{n2}',
    title: 'Рост отказов регистрации VoLTE: {pct}%',
    description: 'Часть абонентов не регистрируется в IMS, звонки уходят в 3G/2G с потерей качества.',
    signals: ['P-CSCF: REGISTER 503 — {pct}%', 'Падение VoLTE-вызовов на {pct}%'], prio: ['P1', 'P2'], users: [100_000, 2_000_000] },
  { system: 'core', team: 'core_net', service: 'EPC / MME', host: 'mme-{reg}-{n2}',
    title: 'MME: всплеск Attach Reject в {region}',
    description: 'Абоненты не могут подключиться к мобильному интернету после перезагрузки телефона.',
    signals: ['Attach Reject cause #19 ×{k}', 'Нагрузка MME {pct}%'], prio: ['P2', 'P1'], users: [30_000, 400_000] },
  { system: 'core', team: 'messaging', service: 'SMSC', host: 'smsc-{n2}',
    title: 'SMSC: задержка доставки SMS до {n} мин',
    description: 'Сообщения копятся в очереди центра SMS. Задерживаются в том числе коды подтверждения.',
    signals: ['Очередь SMSC: {k} тыс.', 'Доставка SMS p95: {n} мин'], prio: ['P2', 'P3'], users: [50_000, 700_000] },
  { system: 'core', team: 'core_net', service: 'DNS абонентов', host: 'dns-{reg}-{n2}',
    title: 'DNS абонентов: таймауты {pct}% запросов',
    description: 'Сайты открываются с задержкой или не открываются, хотя мобильный интернет подключён.',
    signals: ['DNS timeout rate {pct}%', 'QPS выше нормы ×{x}'], prio: ['P2', 'P3'], users: [80_000, 900_000] },

  // ── Мой МТС
  { system: 'app', team: 'mobile_app', service: 'Главный экран и баланс', host: 'android {ver}',
    title: 'Краши «Мой МТС» на Android после релиза {ver}',
    description: 'После обновления приложение закрывается при открытии раздела «Услуги». Затронуты Android 12–14.',
    signals: ['Crash-free sessions: {cf}%', 'Новый тип краша: NullPointerException в ServicesFragment'], prio: ['P2', 'P3'], users: [30_000, 500_000] },
  { system: 'app', team: 'messaging', service: 'Вход по SMS', host: 'auth-otp',
    title: 'Не приходят SMS-коды для входа в «Мой МТС»',
    description: 'Пользователи не могут войти в приложение: код подтверждения не приходит или приходит через несколько минут.',
    signals: ['Успешных входов −{pct}%', 'OTP доставлено за 60 с: {pct2}%'], prio: ['P1', 'P2'], users: [40_000, 800_000], source: 'support' },
  { system: 'app', team: 'platform_sre', service: 'Главный экран и баланс', host: 'api-gw-{n2}',
    title: '«Мой МТС»: баланс не загружается, 504 от API',
    description: 'Главный экран открывается без баланса и пакетов. В логах шлюза растёт доля ответов 504.',
    signals: ['504 на /v2/balance: {pct}%', 'latency p99: {s} с'], prio: ['P2', 'P1'], users: [60_000, 1_200_000] },
  { system: 'app', team: 'mobile_app', service: 'Push-уведомления', host: 'push-svc',
    title: 'Push-уведомления доставляются с задержкой до часа',
    description: 'Уведомления об остатке пакетов и платежах приходят с большой задержкой.',
    signals: ['Очередь push: {k} тыс.', 'Доставка p95: {n} мин'], prio: ['P4', 'P3'], users: [10_000, 200_000] },

  // ── Личный кабинет
  { system: 'lk', team: 'web_front', service: 'Авторизация', host: 'lk-front',
    title: 'Личный кабинет: белый экран после релиза фронтенда',
    description: 'После выкладки новой версии страница входа не отрисовывается в части браузеров (Safari, старые Chrome).',
    signals: ['JS error rate {pct}%', 'Ошибка: Unexpected token в main.{hash}.js'], prio: ['P2', 'P3'], users: [15_000, 250_000] },
  { system: 'lk', team: 'soc', service: 'Авторизация', host: 'waf-edge',
    title: 'ЛК: аномальный трафик на страницу входа',
    description: 'Резкий рост запросов к форме входа с большого числа адресов. Похоже на бот-активность или DDoS.',
    signals: ['RPS на /login ×{x} к норме', 'WAF: {k} тыс. блокировок за 10 мин'], prio: ['P2', 'P1'], users: [50_000, 600_000] },
  { system: 'lk', team: 'billing_l2', service: 'Детализация', host: 'lk-api',
    title: 'ЛК: не формируется детализация расходов',
    description: 'Заказ детализации завершается ошибкой «Попробуйте позже». Данные начислений не приходят из биллинга.',
    signals: ['Ошибки детализации: {pct}%', 'Таймаут ответа биллинга'], prio: ['P3', 'P4'], users: [3_000, 50_000], source: 'support' },
  { system: 'lk', team: 'web_front', service: 'Смена тарифа', host: 'lk-front',
    title: 'ЛК: кнопка «Сменить тариф» не реагирует в Safari',
    description: 'В Safari 17 модальное окно смены тарифа не открывается. В других браузерах работает.',
    signals: ['Конверсия смены тарифа −{pct}%'], prio: ['P4', 'P3'], users: [1_000, 20_000], source: 'user' },

  // ── Платежи
  { system: 'payments', team: 'payments', service: 'Эквайринг', host: 'pay-acq-{n2}',
    title: 'Падение конверсии оплаты картой до {pct}%',
    description: 'Оплата картой в приложении и ЛК проходит заметно хуже обычного. Ошибки на стороне эквайера.',
    signals: ['Успешных платежей: {pct}% (норма 94%)', 'Ответ эквайера: 91 Issuer unavailable'], prio: ['P1', 'P2'], users: [20_000, 300_000] },
  { system: 'payments', team: 'payments', service: 'СБП', host: 'sbp-gw',
    title: 'СБП: таймауты от банка-партнёра',
    description: 'Платежи через Систему быстрых платежей зависают в статусе «В обработке».',
    signals: ['Таймауты СБП: {pct}%', 'Время ответа банка p95: {s} с'], prio: ['P2', 'P3'], users: [5_000, 90_000] },
  { system: 'payments', team: 'payments', service: 'Автоплатёж', host: 'autopay-cron',
    title: 'Автоплатёж: задания не запустились по расписанию',
    description: 'Ночной запуск автоплатежей не отработал, часть абонентов может уйти в минус.',
    signals: ['Job autopay_daily: не стартовал', 'Ожидают списания: {k} тыс.'], prio: ['P3', 'P2'], users: [10_000, 200_000] },

  // ── ЦОД
  { system: 'dc', team: 'dc_infra', service: 'Электропитание и охлаждение', host: 'dc-msk-n hall {n}', region: 'Москва',
    title: 'ЦОД Москва-Север: перегрев в машзале, {t} °C',
    description: 'Отказал один из кондиционеров. Температура на входе стоек растёт, возможны аварийные отключения серверов.',
    signals: ['Температура холодного коридора {t} °C', 'CRAC-{n}: авария компрессора'], prio: ['P1', 'P2'], users: [0, 0] },
  { system: 'dc', team: 'dc_infra', service: 'СХД', host: 'stor-{n2}',
    title: 'Деградация СХД: латентность записи {ms} мс',
    description: 'Массив хранения отвечает медленно, это тормозит виртуальные машины нескольких систем.',
    signals: ['Write latency {ms} мс', 'Деградация RAID-группы'], prio: ['P2', 'P3'], users: [0, 0] },
  { system: 'dc', team: 'dc_infra', service: 'ЦОД Санкт-Петербург', host: 'esx-spb-{n2}', region: 'Санкт-Петербург',
    title: 'Гипервизор {host} недоступен, {n} ВМ перезапущены',
    description: 'Хост виртуализации перестал отвечать, виртуальные машины переехали на соседние хосты через HA.',
    signals: ['vCenter: host not responding', 'HA restart ×{n}'], prio: ['P3', 'P2'], users: [0, 0] },
  { system: 'dc', team: 'dc_infra', service: 'Электропитание и охлаждение', host: 'ups-ekb-{n}', region: 'Екатеринбург',
    title: 'Отказ ИБП в ЦОД Екатеринбург, работа от резерва',
    description: 'Один из источников бесперебойного питания вышел из строя, нагрузка перешла на резервный ИБП.',
    signals: ['UPS-{n}: fault', 'Нагрузка резервного ИБП {pct}%'], prio: ['P2', 'P1'], users: [0, 0] },

  // ── API и интеграции
  { system: 'api', team: 'platform_sre', service: 'API Gateway', host: 'api-gw-{n2}',
    title: 'API Gateway: доля ответов 5xx {pct}%',
    description: 'Шлюз отдаёт ошибки части запросов. Затронуты приложение, ЛК и партнёрские интеграции.',
    signals: ['5xx rate {pct}%', 'Pod restarts: {n} за 10 мин'], prio: ['P1', 'P2'], users: [100_000, 2_000_000] },
  { system: 'api', team: 'platform_sre', service: 'Kafka', host: 'kafka-{n2}',
    title: 'Kafka: лаг консьюмеров растёт ({k} тыс. сообщений)',
    description: 'Сервисы не успевают вычитывать события, обновления статусов приходят с задержкой.',
    signals: ['Consumer lag {k} тыс.', 'ISR shrink на брокере {n}'], prio: ['P2', 'P3'], users: [0, 100_000] },
  { system: 'api', team: 'platform_sre', service: 'Шина ESB', host: 'esb-partner',
    title: 'Истёк сертификат на шлюзе партнёрских интеграций',
    description: 'Партнёры получают ошибку TLS при обращении к API. Сертификат истёк ночью.',
    signals: ['TLS handshake failed ×{k}', 'Сертификат истёк {n} ч назад'], prio: ['P2', 'P3'], users: [0, 50_000], source: 'partner' },
  { system: 'api', team: 'platform_sre', service: 'SSO / OAuth', host: 'sso-{n2}',
    title: 'SSO: ошибки выдачи токенов {pct}%',
    description: 'Часть входов в сервисы завершается ошибкой авторизации.',
    signals: ['token endpoint 500: {pct}%', 'latency p95 {s} с'], prio: ['P2', 'P3'], users: [20_000, 400_000] },

  // ── KION
  { system: 'kion', team: 'media', service: 'VOD-стриминг', host: 'vod-edge-{n2}',
    title: 'KION: буферизация видео у {pct}% сессий',
    description: 'Фильмы и сериалы долго загружаются и останавливаются. Проблема сильнее в вечерний прайм-тайм.',
    signals: ['Rebuffering ratio {pct}%', 'Отдача CDN-узла {region}: −{pct2}%'], prio: ['P3', 'P2'], users: [10_000, 200_000] },
  { system: 'kion', team: 'media', service: 'Телеканалы (live)', host: 'live-enc-{n2}',
    title: 'Телеканал «{channel}» без сигнала',
    description: 'Канал показывает чёрный экран на всех платформах. Энкодер не получает входящий поток.',
    signals: ['Encoder input: no signal', 'Жалобы в чате: {n}'], prio: ['P3', 'P4'], users: [2_000, 60_000], source: 'user' },
  { system: 'kion', team: 'media', service: 'Подписки', host: 'drm-lic',
    title: 'Ошибки DRM-лицензий на Smart TV',
    description: 'Платный контент не воспроизводится на телевизорах части производителей.',
    signals: ['DRM license errors {pct}%'], prio: ['P3', 'P4'], users: [3_000, 40_000] },

  // ── Домашний интернет
  { system: 'home', team: 'fixed_net', service: 'GPON-доступ', host: 'olt-{reg}-{n3}',
    title: 'OLT {host}: {k} тыс. абонентов GPON без связи',
    description: 'Оптический терминал перестал отвечать, абоненты домашнего интернета и ТВ в нескольких домах без услуги.',
    signals: ['OLT unreachable', 'ONT offline ×{k} тыс.'], prio: ['P2', 'P3'], users: [1_000, 12_000] },
  { system: 'home', team: 'fixed_net', service: 'BRAS / PPPoE', host: 'bras-{reg}-{n2}',
    title: 'BRAS: ошибки авторизации PPPoE ({region})',
    description: 'Роутеры абонентов не могут поднять PPPoE-сессию, домашний интернет недоступен.',
    signals: ['PPPoE auth fail {pct}%', 'RADIUS timeout'], prio: ['P2', 'P3'], users: [3_000, 40_000] },
  { system: 'home', team: 'fixed_net', service: 'IPTV', host: 'mcast-{reg}',
    title: 'IPTV: рассыпается картинка на мультикасте',
    description: 'На части каналов артефакты и зависания картинки у абонентов домашнего ТВ.',
    signals: ['CC errors на мультикасте', 'Потери пакетов {pct2}%'], prio: ['P3', 'P4'], users: [2_000, 30_000], source: 'user' },

  // ── Контакт-центр
  { system: 'crm', team: 'crm_team', service: 'CRM оператора', host: 'crm-app-{n2}',
    title: 'CRM: операторы не открывают карточку абонента',
    description: 'Карточка клиента грузится больше минуты или падает с ошибкой. Растёт время обслуживания в контакт-центре.',
    signals: ['Время открытия карточки p95 {s} с', 'Очередь звонков на линии ×{x}'], prio: ['P2', 'P3'], users: [0, 20_000], source: 'support' },
  { system: 'crm', team: 'crm_team', service: 'IVR 0890', host: 'ivr-{n2}',
    title: 'IVR 0890: обрывы при переводе на оператора',
    description: 'Звонки на короткий номер обрываются на этапе перевода с голосового меню на оператора.',
    signals: ['Обрывов при переводе {pct}%'], prio: ['P2', 'P3'], users: [2_000, 30_000] },
  { system: 'crm', team: 'crm_team', service: 'Чат поддержки', host: 'chat-svc',
    title: 'Чат поддержки: сообщения клиентов не доходят до операторов',
    description: 'Сообщения в чате приложения висят в статусе «Отправлено».',
    signals: ['Недоставлено сообщений: {k} тыс.'], prio: ['P3', 'P4'], users: [1_000, 15_000] },

  // ── SMS
  { system: 'sms', team: 'messaging', service: 'OTP-коды', host: 'smpp-bank-{n2}',
    title: 'OTP-коды банков-партнёров приходят с задержкой',
    description: 'Коды подтверждения банковских операций доставляются за 2–5 минут вместо секунд.',
    signals: ['Доставка OTP p95: {n} мин', 'Очередь SMPP: {k} тыс.'], prio: ['P1', 'P2'], users: [30_000, 500_000], source: 'partner' },
  { system: 'sms', team: 'messaging', service: 'SMS-шлюз', host: 'smpp-{n2}',
    title: 'SMPP-подключение партнёра {partner} разорвано',
    description: 'Партнёр не может отправлять сообщения, сессия SMPP переподключается по кругу.',
    signals: ['SMPP bind failed ×{n}'], prio: ['P3', 'P4'], users: [0, 20_000], source: 'partner' },
  { system: 'sms', team: 'messaging', service: 'Рассылки B2B', host: 'bulk-sms',
    title: 'Массовая рассылка B2B зависла в очереди',
    description: 'Рассылка корпоративного клиента не отправляется больше часа.',
    signals: ['Кампания #{k}: 0% отправлено'], prio: ['P4', 'P3'], users: [0, 5_000], source: 'support' },
];

/** Центры городов, разброс точек вокруг них (в градусах широты) и вес города в потоке. */
export const CITY: Record<string, { lat: number; lon: number; spread: number; weight: number }> = {
  'Москва': { lat: 55.7558, lon: 37.6173, spread: 0.16, weight: 30 },
  'Санкт-Петербург': { lat: 59.9343, lon: 30.3351, spread: 0.1, weight: 13 },
  'Екатеринбург': { lat: 56.8389, lon: 60.6057, spread: 0.07, weight: 5 },
  'Новосибирск': { lat: 55.0084, lon: 82.9357, spread: 0.07, weight: 5 },
  'Казань': { lat: 55.7963, lon: 49.1088, spread: 0.06, weight: 5 },
  'Нижний Новгород': { lat: 56.2965, lon: 43.9361, spread: 0.06, weight: 5 },
  'Краснодар': { lat: 45.0355, lon: 38.9753, spread: 0.06, weight: 5 },
  'Ростов-на-Дону': { lat: 47.2357, lon: 39.7015, spread: 0.06, weight: 5 },
  'Самара': { lat: 53.1959, lon: 50.1002, spread: 0.06, weight: 4 },
  'Уфа': { lat: 54.7388, lon: 55.9721, spread: 0.06, weight: 4 },
  'Пермь': { lat: 58.0105, lon: 56.2502, spread: 0.05, weight: 3 },
  'Воронеж': { lat: 51.6608, lon: 39.2003, spread: 0.05, weight: 3 },
  'Красноярск': { lat: 56.0153, lon: 92.8932, spread: 0.06, weight: 3 },
  'Тюмень': { lat: 57.153, lon: 65.5343, spread: 0.05, weight: 3 },
  'Тольятти': { lat: 53.5303, lon: 49.3461, spread: 0.04, weight: 0 },
};

/** Площадки ЦОД: у инцидентов ЦОД точка стоит на площадке, а не в случайном месте города. */
export const DC_SITES: Record<string, { lat: number; lon: number }> = {
  'Москва': { lat: 55.8826, lon: 37.5432 },
  'Санкт-Петербург': { lat: 59.9861, lon: 30.2046 },
  'Екатеринбург': { lat: 56.8833, lon: 60.5172 },
};

export const CREW_TEAMS: Record<string, string> = {
  ran_ops: 'Бригада RAN',
  transport: 'Бригада ВОЛС',
  fixed_net: 'Монтажник ШПД',
  dc_infra: 'Инженер ЦОД',
};

export const PARTNERS = ['Telia', 'Turkcell', 'Beeline KZ', 'А1 Беларусь', 'Ucell', 'Банк «Северный»', 'Банк «Восток»', 'Сбор-Сервис'];
export const CHANNELS = ['Спорт Live HD', 'Кино Премиум', 'Детский мир', 'Наука 24', 'Мир путешествий'];

export const REG_CODES: Record<string, string> = {
  'Москва': 'msk', 'Санкт-Петербург': 'spb', 'Екатеринбург': 'ekb', 'Новосибирск': 'nsk', 'Казань': 'kzn',
  'Нижний Новгород': 'nnv', 'Краснодар': 'krd', 'Ростов-на-Дону': 'rnd', 'Самара': 'sam', 'Уфа': 'ufa',
  'Пермь': 'prm', 'Воронеж': 'vrn', 'Красноярск': 'krs', 'Тюмень': 'tmn',
};

export function systemById(id: string): SystemDef {
  const s = SYSTEMS.find((x) => x.id === id);
  if (!s) throw new Error(`Нет системы ${id}`);
  return s;
}

export function teamById(id: string | null | undefined): TeamDef | undefined {
  return TEAMS.find((t) => t.id === id);
}
