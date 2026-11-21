// Почта дежурного. Каждое письмо разбирает модель через OpenRouter (тот же ключ и прокси, что у Джарвиса):
// что это (новая проблема, новости по инциденту, просьба, жалоба клиента, рассылка), насколько срочно, суть одной строкой,
// что сделать и к какому инциденту относится. Без ключа или сверх лимита — по правилам.
// Откуда письма: для показа — поток правдоподобных писем по живой обстановке (руководители команд, руководство,
// B2B-клиенты, мониторинг, рассылки) — только пока дежурный в системе; и настоящие письма файлом .eml.
import type { Incident, MailAnalysis, MailItem, MailKind } from '../shared/types.ts';
import type { Point } from './point.ts';
import { key, openrouter } from './jarvis.ts';
import { DESIGN_MODEL } from './design.ts';
import { POINT_ID, SERVICES, personById, teamById } from './directory.ts';
import { REGIONS, regionById } from './regions.ts';

const MIN = 60_000;
const MAIL_MODEL = () => process.env.MAIL_MODEL || DESIGN_MODEL();
const LLM_PER_HOUR = () => Number(process.env.MAIL_LLM_PER_HOUR) || 60; // чтобы показ не съел ключ
const KEEP = 150;
const KINDS: MailKind[] = ['incident', 'update', 'request', 'complaint', 'noise'];
const rnd = Math.random;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const hhmm = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const teamName = (id: string | null | undefined) => teamById(id)?.name ?? '';

// ─── разбор по правилам (без модели) ──────────────────────────────────────
const RE = {
  noise: /дайджест|рассылк|обучени|опрос|вебинар|newsletter|корпоратив|отпуск|поздравля|акци[яи]/i,
  request: /просим|прошу|нужен статус|дайте статус|переназнач|не к нам|не наш|передайте|подскажите|что по ситуации/i,
  complaint: /не работает|недоступ|не можем|не грузится|пропал|жалоб|страдает работа/i,
  incident: /PROBLEM|alert|авари|сбой|недоступен узел|высокая загрузка|disaster/i,
  high: /срочно|критич|vip|руковод|немедленно|PROBLEM|disaster|страдает работа|договор/i,
};
function findIncident(text: string, point: Point): Incident | undefined {
  const id = /INC0*\d{5,}/i.exec(text)?.[0]?.toUpperCase();
  if (id) {
    const hit = point.incidents.get(id) ?? [...point.incidents.values()].find((i) => i.id.replace(/^INC0*/, '') === id.replace(/^INC0*/, ''));
    if (hit) return hit;
  }
  const t = text.toLowerCase();
  const service = SERVICES.find((s) => t.includes(s.name.toLowerCase()))?.name;
  if (!service) return undefined;
  const regions = REGIONS.filter((r) => t.includes(r.city.toLowerCase()) || t.includes(r.name.toLowerCase())).map((r) => r.id);
  const open = [...point.incidents.values()].filter((i) => i.service === service && (i.status !== 'resolved' || (i.resolvedAt && Date.now() - i.resolvedAt < 40 * MIN)));
  return open.find((i) => regions.some((r) => (i.regionIds ?? []).includes(r))) ?? (regions.length ? undefined : open[0]);
}
export function rulesAnalysis(m: Pick<MailItem, 'from' | 'fromName' | 'subject' | 'body'>, point: Point): MailAnalysis {
  const text = `${m.subject}\n${m.body}`;
  const inc = findIncident(text, point);
  const kind: MailKind = RE.noise.test(text) ? 'noise' : RE.request.test(text) ? 'request' : RE.incident.test(text) && !inc ? 'incident' : RE.complaint.test(text) ? 'complaint' : inc ? 'update' : 'request';
  const urgency = kind === 'noise' ? 'low' : RE.high.test(text) ? 'high' : 'normal';
  const action =
    kind === 'incident' ? 'Проверить и создать инцидент' : kind === 'complaint' ? (inc ? 'Связать с инцидентом и ответить клиенту' : 'Создать инцидент') : kind === 'request' ? 'Ответить на просьбу' : kind === 'update' ? 'Учесть в инциденте' : '';
  return { kind, urgency, summary: m.subject.replace(/^((re|fwd?|ответ|пересл)\s*:\s*)+/i, '').slice(0, 80), action, incidentId: inc?.id ?? null, service: inc?.service ?? null, llm: false, at: Date.now() };
}

/** Ответ модели → проверенный разбор. Чего нет у пункта — отбрасываем. */
export function cleanAnalysis(o: Record<string, unknown>, point: Point, fallback: MailAnalysis): MailAnalysis {
  const kind = KINDS.find((k) => k === o.kind) ?? fallback.kind;
  const urgency = (['high', 'normal', 'low'] as const).find((u) => u === o.urgency) ?? fallback.urgency;
  const incId = typeof o.incidentId === 'string' && point.incidents.has(o.incidentId) ? o.incidentId : fallback.incidentId;
  return { kind, urgency, summary: str(o.summary, 90) || fallback.summary, action: str(o.action, 70), incidentId: incId, service: str(o.service, 40) || (incId ? point.incidents.get(incId)!.service : null), llm: true, at: Date.now() };
}

const SYSTEM = `Ты разбираешь входящую почту дежурного координатора ИТ-инцидентов. Верни строго JSON без пояснений:
{"kind":"incident|update|request|complaint|noise","urgency":"high|normal|low","summary":"суть до 10 слов","action":"что сделать дежурному, до 8 слов, или пусто","incidentId":"id из списка или null","service":"сервис или null"}
kind: incident — новая проблема или алерт мониторинга; update — новости по известному инциденту; request — просят что-то сделать (статус, переназначить, помочь); complaint — жалоба клиента; noise — рассылки и не по делу.
urgency: high — страдают клиенты или руководство ждёт ответа; low — рассылки. Если письмо про инцидент из списка — укажи его id. Пиши по-русски.`;

// ─── письма для показа: по живой обстановке ───────────────────────────────
type Draft = { from: string; fromName: string; subject: string; body: string };
const CLIENTS = ['ООО «СеверЛес»', 'АО «ТрансЛогистик»', 'ООО «Медицинский центр Здоровье»', 'ПАО «УралСтройБанк»', 'ООО «Ритейл Плюс»'];
const NOISE: Draft[] = [
  { from: 'news@corp.local', fromName: 'ИТ-дайджест', subject: 'Дайджест ИТ-новостей за неделю', body: 'Коллеги, в этом выпуске: обновление ITSM, новые регламенты по заявкам, итоги квартала. Подробнее во вложении.' },
  { from: 'hr@corp.local', fromName: 'Отдел обучения', subject: 'Обучение по ITSM в пятницу', body: 'Приглашаем на обучение по новому интерфейсу ITSM в пятницу в 15:00. Запись по ссылке.' },
  { from: 'survey@corp.local', fromName: 'Опросы', subject: 'Опрос: удобство рабочего места', body: 'Пройдите, пожалуйста, короткий опрос — 3 минуты. Ваше мнение важно.' },
];
function draft(point: Point, now: number): Draft {
  const open = [...point.incidents.values()].filter((i) => i.status !== 'resolved');
  const atTeams = open.filter((i) => i.teamId && i.teamId !== POINT_ID);
  const hot = [...open].sort((a, b) => a.slaDeadline - b.slaDeadline).filter((i) => i.priority === 'P1' || i.priority === 'P2');
  const back = [...point.incidents.values()].filter((i) => i.status === 'resolved' && i.origin === 'complaints' && i.resolvedAt && now - i.resolvedAt < 30 * MIN);
  const lead = (i: Incident) => personById(teamById(i.teamId)?.leadId)?.name ?? 'Руководитель команды';
  const city = (i: Incident) => (i.regionIds?.length ? regionById(i.regionIds[0])?.city : i.region) || 'Москва';
  const r = rnd();
  if (r < 0.2 && atTeams.length) {
    const i = pick(atTeams);
    return { from: 'lead@corp.local', fromName: `${lead(i)} (${teamName(i.teamId)})`, subject: `Re: ${i.id} ${i.title}`, body: `Коллеги, добрый день. По ${i.id} работаем: причину нашли, сейчас ${pick(['перезапускаем узел', 'откатываем обновление', 'переключаем трафик на резерв'])}. Ориентировочно восстановим через ${pick([20, 30, 40, 60])} минут. Отпишусь по итогу.` };
  }
  if (r < 0.33 && atTeams.length) {
    const i = pick(atTeams);
    return { from: 'lead@corp.local', fromName: `${lead(i)} (${teamName(i.teamId)})`, subject: `${i.id}: просим переназначить`, body: `Добрый день. По ${i.id} «${i.title}» — по логам это не к нам: проблема на стороне ${pick(['сети', 'биллинга', 'платформы авторизации'])}. Просим передать в профильную команду, наши специалисты подключатся при необходимости.` };
  }
  if (r < 0.45 && hot.length) {
    const i = hot[0];
    return { from: 'director@corp.local', fromName: 'Руководитель направления эксплуатации', subject: `Статус по ${i.title.replace(/^Жалобы: /, '')}`, body: `Коллеги, что по ситуации с «${i.title}»? Нужен статус к ${hhmm(now + 30 * MIN)} для руководства: что случилось, кто работает, когда восстановим. Срочно.` };
  }
  if (r < 0.6 && (back.length || open.some((i) => i.origin === 'complaints'))) {
    const i = back[0] ?? pick(open.filter((x) => x.origin === 'complaints'));
    return { from: 'it@client.local', fromName: pick(CLIENTS), subject: `${back[0] ? 'Снова не работает' : 'Не работает'} ${i.service} в офисе (${city(i)})`, body: `Здравствуйте! ${back[0] ? 'Вчера починили, но сегодня опять' : 'С утра'} не работает ${i.service.toLowerCase()} в нашем офисе в городе ${city(i)}. Страдает работа ${pick([25, 40, 60, 120])} сотрудников. Просим срочно разобраться. Договор B2B-${Math.floor(10000 + rnd() * 89999)}.` };
  }
  if (r < 0.75) {
    const region = pick(REGIONS);
    return { from: 'monitoring@corp.local', fromName: 'Zabbix', subject: `PROBLEM: ${pick(['Высокая загрузка CPU', 'Недоступен узел', 'Рост ошибок 5xx', 'Потери пакетов'])} на ${pick(['PGW', 'BRAS', 'API-GW', 'DNS'])}-${region.id.toUpperCase()}-0${1 + Math.floor(rnd() * 4)}`, body: `Trigger: ${pick(['CPU > 90% 10 min', 'Host unreachable', 'HTTP 5xx > 5%', 'Packet loss > 3%'])}\nHost region: ${region.name}\nSeverity: ${pick(['High', 'Disaster', 'Average'])}\nStarted: ${hhmm(now - 3 * MIN)}` };
  }
  return pick(NOISE);
}

// ─── письмо файлом .eml ───────────────────────────────────────────────────
function decodeWords(s: string) {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, txt: string) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return decode(bytes, cs);
  });
}
function decode(bytes: Buffer, charset = 'utf-8') {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^cp/, 'windows-')).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}
function headers(block: string) {
  const h = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const k = line.indexOf(':');
    if (k > 0) h.set(line.slice(0, k).trim().toLowerCase(), line.slice(k + 1).trim());
  }
  return h;
}
function partText(raw: string): { text: string; html: boolean } {
  const cut = raw.search(/\r?\n\r?\n/);
  const h = headers(cut >= 0 ? raw.slice(0, cut) : raw);
  const body = cut >= 0 ? raw.slice(cut).replace(/^\r?\n\r?\n/, '') : '';
  const type = h.get('content-type') ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/multipart\//i.test(type) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    const got = parts.map(partText);
    return got.find((p) => !p.html && p.text.trim()) ?? got.find((p) => p.text.trim()) ?? { text: '', html: false };
  }
  const cs = /charset="?([^";]+)"?/i.exec(type)?.[1] ?? 'utf-8';
  const te = (h.get('content-transfer-encoding') ?? '').toLowerCase();
  const bytes = te === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : te === 'quoted-printable' ? Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, x: string) => String.fromCharCode(parseInt(x, 16))), 'latin1') : Buffer.from(body, te === '8bit' || te === '' ? 'utf8' : 'latin1');
  const text = decode(bytes, cs);
  const html = /text\/html/i.test(type);
  return { text: html ? text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : text, html };
}
export function parseEml(raw: string): Draft & { at: number } {
  const cut = raw.search(/\r?\n\r?\n/);
  const h = headers(cut >= 0 ? raw.slice(0, cut) : raw);
  const fromRaw = decodeWords(h.get('from') ?? '');
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>/.exec(fromRaw);
  const date = Date.parse(h.get('date') ?? '');
  const body = partText(raw).text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { from: (m?.[2] ?? fromRaw).trim().slice(0, 120), fromName: (m?.[1] || m?.[2] || fromRaw || 'Отправитель').trim().slice(0, 120), subject: decodeWords(h.get('subject') ?? '(без темы)').slice(0, 200), body: body.slice(0, 8000), at: Number.isFinite(date) ? Math.min(date, Date.now()) : Date.now() };
}

// ─── ящик ─────────────────────────────────────────────────────────────────
export class Mailbox {
  items: MailItem[] = [];
  /** Демо-письма приходят сами; в режиме показа — выключено, письма только по кнопке. */
  demo = true;
  private seq = 1;
  private nextDemo = Date.now() + 25_000;
  private llmLog: number[] = [];
  private busy = false;
  private dirty = false;
  private savedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private point: Point,
    private emit: (m: MailItem) => void,
    private online: () => boolean,
    private save: (items: MailItem[]) => void = () => undefined,
  ) {}

  restore(items: unknown) {
    if (!Array.isArray(items)) return;
    this.items = items.filter((m): m is MailItem => !!m && typeof m === 'object' && typeof (m as MailItem).id === 'string').slice(0, KEEP);
  }
  start() {
    if (!this.items.length) {
      // первые письма — чтобы ящик не был пустым
      const now = Date.now();
      for (let k = 0; k < 5; k++) this.add({ ...draft(this.point, now), at: now - (5 - k) * 7 * MIN, source: 'demo' });
    }
    this.timer = setInterval(() => void this.tick(), 3000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  get(id: string) {
    return this.items.find((m) => m.id === id);
  }
  private add(m: Omit<MailItem, 'id' | 'analysis' | 'read' | 'incidentCreated'>): MailItem {
    const item: MailItem = { ...m, id: `M${Date.now().toString(36)}${(this.seq++).toString(36)}`, read: false, analysis: null, incidentCreated: null };
    this.items.unshift(item);
    if (this.items.length > KEEP) this.items.length = KEEP;
    this.dirty = true;
    this.emit(item);
    return item;
  }
  /** Письмо для показа по кнопке: приходит сразу и разбирается как настоящее. */
  inject(d: { from: string; fromName: string; subject: string; body: string }) {
    return this.add({ ...d, at: Date.now(), source: 'demo' });
  }
  /** Очистить ящик (кнопка «Очистить» в режиме показа). */
  clear() {
    for (const m of this.items) if (!m.read) m.read = true;
    this.items = [];
    this.dirty = true;
  }
  /** Настоящее письмо файлом .eml (или просто текстом). */
  upload(raw: string) {
    const isEml = /^[\w-]+:\s/m.test(raw.slice(0, 2000)) && /\r?\n\r?\n/.test(raw);
    const d = isEml ? parseEml(raw) : { from: 'manual', fromName: 'Вставлено вручную', subject: raw.split('\n')[0].slice(0, 120) || '(без темы)', body: raw.slice(0, 8000), at: Date.now() };
    return this.add({ ...d, source: 'upload' });
  }
  read(id: string) {
    const m = this.get(id);
    if (!m) throw new Error('Письмо не найдено');
    if (!m.read) {
      m.read = true;
      this.dirty = true;
      this.emit(m);
    }
    return m;
  }
  /** Письмо → инцидент на пункте. */
  toIncident(id: string, actor: string) {
    const m = this.get(id);
    if (!m) throw new Error('Письмо не найдено');
    if (m.incidentCreated && this.point.incidents.has(m.incidentCreated)) return this.point.incidents.get(m.incidentCreated)!;
    const inc = this.point.fromMail(m, actor);
    m.incidentCreated = inc.id;
    m.read = true;
    if (m.analysis) m.analysis.incidentId = inc.id;
    this.dirty = true;
    this.emit(m);
    return inc;
  }
  private budget() {
    const now = Date.now();
    this.llmLog = this.llmLog.filter((t) => now - t < 3_600_000);
    return LLM_PER_HOUR() - this.llmLog.length;
  }
  private async tick() {
    const now = Date.now();
    if (this.demo && this.online() && now >= this.nextDemo) {
      this.add({ ...draft(this.point, now), at: now, source: 'demo' });
      this.nextDemo = now + (100 + rnd() * 140) * 1000;
    }
    if (!this.busy) {
      const todo = this.items.filter((m) => !m.analysis).slice(-2).reverse();
      if (todo.length) {
        this.busy = true;
        try {
          for (const m of todo) {
            m.analysis = await this.analyze(m);
            this.dirty = true;
            this.emit(m);
          }
        } finally {
          this.busy = false;
        }
      }
    }
    if (this.dirty && now - this.savedAt > 15_000) {
      this.dirty = false;
      this.savedAt = now;
      this.save(this.items);
    }
  }
  private async analyze(m: MailItem): Promise<MailAnalysis> {
    const rules = rulesAnalysis(m, this.point);
    if (!key() || !this.online() || this.budget() <= 0) return rules;
    try {
      const open = [...this.point.incidents.values()].filter((i) => i.status !== 'resolved' || (i.recur && i.recur.count > 0)).sort((a, b) => a.slaDeadline - b.slaDeadline).slice(0, 30);
      const list = open.map((i) => `${i.id}; ${i.title}; ${i.service}; ${teamName(i.teamId) || 'пункт'}`).join('\n');
      const r = await openrouter(
        '/chat/completions',
        { model: MAIL_MODEL(), messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Письмо:\nОт: ${m.fromName} <${m.from}>\nТема: ${m.subject}\n\n${m.body.slice(0, 1500)}\n\nОткрытые инциденты (id; название; сервис; команда):\n${list || '—'}` }], max_tokens: 220, temperature: 0.1 },
        25_000,
      );
      this.llmLog.push(Date.now());
      if (r.status !== 200) throw new Error(`${r.status} ${r.buf.toString('utf8').slice(0, 120)}`);
      const j = JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] };
      const txt = j.choices[0]?.message.content ?? '';
      const o = JSON.parse(/\{[\s\S]*\}/.exec(txt)?.[0] ?? '{}') as Record<string, unknown>;
      return cleanAnalysis(o, this.point, rules);
    } catch (err) {
      console.error('Почта: разбор моделью не удался —', err instanceof Error ? err.message.slice(0, 160) : err);
      return rules;
    }
  }
  /** Для Джарвиса: непрочитанные важные письма. */
  digest() {
    return this.items.filter((m) => !m.read && m.analysis && m.analysis.kind !== 'noise').slice(0, 6);
  }
}
