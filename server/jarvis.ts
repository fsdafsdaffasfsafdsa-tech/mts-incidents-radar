// «Джарвис» — голосовой ИИ-помощник дежурного.
// Два режима (переключаются в настройках у дежурного):
//   chat    — отвечает на вопросы о ситуации, ничего не открывает и не меняет;
//   control — ведёт экран вместе с дежурным: открывает вкладки и инциденты, объясняет ситуацию,
//             подсказывает, кому передать, и по команде передаёт, назначает, поднимает уровень, пишет в переписку.
// Разговор помнит «фокус» — инцидент, о котором шла речь, поэтому «объясни», «кому дать?», «выдай» понимаются без номера.
// Мозг — Claude, голос — ElevenLabs, оба через OpenRouter (ключ только на сервере). Без ключа — команды по правилам.
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Incident, MailItem, Me, Priority } from '../shared/types.ts';
import { PRIORITY_TEXT } from '../shared/types.ts';
import type { Point } from './point.ts';
import type { Mailbox } from './mail.ts';
import { POINT_ID, POINT_STAFF, isOn, personById, teamById } from './directory.ts';
import { planPoint, routeTeams } from './ai-point.ts';
import { regionById } from './regions.ts';
import { RULES } from './complaints.ts';
import { FORECAST_TEXT, forecast } from '../shared/forecast.ts';
import { myShiftWork } from '../shared/shift.ts';
import type { DashOp } from '../shared/dash.ts';
import { dashSnapshot, fmtShort, isRecurring } from '../shared/dash.ts';
import { personaById } from '../shared/personas.ts';
import { BLOCK_TOOL, DASH_NOTE, DASH_TOOL, DESIGN_TOOL, briefByRules, briefContext, dashContextLine, dashRules, toDashOp, type DashCtx } from './jarvis-dash.ts';

const MIN = 60_000;
// Почта дежурного: сервер подключает ящик при запуске (index.ts), Джарвис читает письма и заводит по ним инциденты.
let mailbox: Mailbox | null = null;
export function attachMailbox(m: Mailbox) {
  mailbox = m;
}
const MAIL_KIND: Record<string, string> = { incident: 'сбой', update: 'новость по инциденту', request: 'просьба', complaint: 'жалоба клиента', noise: 'рассылка' };
const MAIL_URG = { high: 0, normal: 1, low: 2 } as const;
/** Непрочитанные важные письма: самое важное — первым. */
function importantMail(now: number) {
  return (mailbox?.items ?? [])
    .filter((m) => !m.read && m.analysis && m.analysis.kind !== 'noise' && now - m.at < 12 * 3_600_000)
    .sort((a, b) => MAIL_URG[a.analysis!.urgency] - MAIL_URG[b.analysis!.urgency] || b.at - a.at);
}
/** Письмо «по умолчанию»: самое важное разобранное, а если ИИ ещё не успел разобрать — самое свежее непрочитанное
 *  (письмо пришло секунду назад — «заведи инцидент по письму» не должно отвечать «писем нет»). */
function latestMail(now: number, needFree = false) {
  const free = (m: MailItem) => !needFree || (!m.analysis?.incidentId && !m.incidentCreated);
  return (
    importantMail(now).find(free) ??
    (mailbox?.items ?? []).filter((m) => free(m) && !m.read && m.analysis?.kind !== 'noise' && now - m.at < 12 * 3_600_000).sort((a, b) => b.at - a.at)[0]
  );
}
export const key = () => process.env.OPENROUTER_API_KEY || '';
export const JARVIS_MODEL = () => process.env.JARVIS_MODEL || 'anthropic/claude-sonnet-5.5';

// Голоса — разные «говорящие» модели OpenRouter. По умолчанию — живой русский голос MiniMax (родной русский, ~1,5 с).
const JARVIS_STYLE = 'Говори живо и естественно, как умный дружелюбный помощник Джарвис: уверенно, тепло, с лёгкой иронией, в хорошем темпе.';
export const VOICE_CATALOG: Record<string, { model: string; voice: string; format: 'mp3' | 'pcm'; instructions?: string; prefix?: string }> = {
  'mm-guy': { model: 'minimax/speech-2.8-hd', voice: 'Russian_AttractiveGuy', format: 'mp3' },
  'mm-reliable': { model: 'minimax/speech-2.8-hd', voice: 'Russian_ReliableMan', format: 'mp3' },
  'grok-rex': { model: 'x-ai/grok-voice-tts-1.0', voice: 'rex', format: 'mp3' },
  'gm-charon': { model: 'google/gemini-3.8-flash-tts', voice: 'Charon', format: 'pcm', instructions: JARVIS_STYLE },
  'gm-puck': { model: 'google/gemini-3.8-flash-tts', voice: 'Puck', format: 'pcm', instructions: JARVIS_STYLE },
  'el-brian': { model: 'elevenlabs/eleven-v4', voice: 'brian', format: 'mp3', prefix: '[warm, confident] ' },
  'el-adam': { model: 'elevenlabs/eleven-v4', voice: 'adam', format: 'mp3' },
  'el-matilda': { model: 'elevenlabs/eleven-v4', voice: 'matilda', format: 'mp3', prefix: '[warm] ' },
};
export const DEFAULT_VOICE = () => (VOICE_CATALOG[process.env.JARVIS_VOICE ?? ''] ? process.env.JARVIS_VOICE! : 'mm-guy');

export type Mode = 'control' | 'chat';
export type ClientAction =
  | { type: 'open'; id: string }
  | { type: 'tab'; tab: string }
  | { type: 'replay'; on: boolean }
  | { type: 'settings'; open: boolean }
  | { type: 'theme'; id: string }
  | { type: 'team'; name: string }
  | { type: 'show'; what: Show } // прокрутить карточку к разделу, который изменился, и подсветить
  | { type: 'mail'; id: string } // раскрыть письмо на стене (Джарвис его читает)
  | { type: 'report' } // собрать и скачать отчёт смены в PDF
  | { type: 'dash'; cmd: DashOp } // перестроить видеостену (дашборд)
  | { type: 'design'; prompt: string } // придумать оформление стены по описанию (ChatGPT, в браузере)
  | { type: 'block'; prompt: string; character: boolean }; // собрать свой блок или персонажа (ChatGPT) и поставить на поле
export type Show = 'top' | 'who' | 'route' | 'level' | 'p1' | 'signal' | 'chat' | 'decide';
export interface JarvisAsk {
  text: string;
  selectedId: string | null;
  focusId: string | null;
  tab: string | null;
  mode: Mode;
  short?: boolean; // сценарий для жюри: ещё короче
  dash?: DashCtx | null; // что сейчас на видеостене
  dashControl?: boolean; // в настройках дашборда разрешено перестраивать стену
  persona?: string | null; // персонаж ИИ: имя, характер и голос
  addressed?: boolean; // к нему точно обращаются (по имени, задачей, ответом на его вопрос) — «—» не отвечать
  history: { role: 'user' | 'assistant'; content: string }[];
}
/** Что Джарвис делает прямо сейчас — для окна «Работа Джарвиса» (поток событий во время ответа). */
export type JarvisEvent =
  | { type: 'step'; id: string; text: string; state: 'run' | 'done' | 'fail'; note?: string; tool?: string; target?: string | null }
  | { type: 'actions'; actions: ClientAction[] };
export type Emit = (e: JarvisEvent) => void;

export interface JarvisReply {
  reply: string;
  actions: ClientAction[];
  done: string[]; // что сделано — человеческим языком, для журнала в окне
  focus: string | null; // инцидент, о котором сейчас разговор
  llm: boolean;
}

export const jarvisStatus = () => ({ llm: !!key(), tts: !!key(), model: JARVIS_MODEL(), voices: Object.keys(VOICE_CATALOG), defaultVoice: DEFAULT_VOICE(), proxy: !!process.env.OPENROUTER_PROXY });

// ─── запрос к OpenRouter: напрямую или через SOCKS-прокси ──────────────────
// С серверов в РФ OpenRouter отвечает 403, поэтому на проде запросы идут через прокси из OPENROUTER_PROXY
// (socks5h://логин:пароль@хост:порт). Локально, если прокси не задан, — напрямую.
let agent: SocksProxyAgent | null | undefined;
function proxyAgent() {
  if (agent === undefined) agent = process.env.OPENROUTER_PROXY ? new SocksProxyAgent(process.env.OPENROUTER_PROXY) : null;
  return agent;
}
/** Сеть иногда рвётся на полуслове — один повтор через полсекунды. */
export async function openrouter(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; buf: Buffer }> {
  try {
    return await openrouterOnce(path, body, timeoutMs);
  } catch (err) {
    if (err instanceof Error && /aborted|timeout|не ответил/i.test(err.message)) throw err; // долгий ответ не повторяем
    await new Promise((r) => setTimeout(r, 500));
    return openrouterOnce(path, body, timeoutMs);
  }
}
async function openrouterOnce(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; buf: Buffer }> {
  const url = `https://openrouter.ai/api/v1${path}`;
  const payload = JSON.stringify(body);
  const headers = { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' };
  const a = proxyAgent();
  if (!a) {
    const r = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', agent: a, headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('прокси не ответил вовремя')));
    req.on('error', reject);
    req.end(payload);
  });
}

// ─── голос ─────────────────────────────────────────────────────────────────

/** PCM 16 бит моно (Gemini TTS) → WAV, чтобы браузер сыграл его как обычный звук. */
function wav(pcm: Buffer, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

type Spoken = { buf: Buffer; type: string; voice: string };
const cache = new Map<string, Spoken>();
// Говорящие модели на OpenRouter иногда пропадают («No endpoints found»). Тогда берём следующий живой голос,
// а упавший пропускаем 5 минут, чтобы не терять на нём время.
const FALLBACK = ['grok-rex', 'el-brian', 'mm-guy', 'gm-charon', 'el-adam'];
const down = new Map<string, number>();
async function speakWith(id: string, t: string): Promise<Spoken> {
  const v = VOICE_CATALOG[id];
  const body: Record<string, unknown> = { model: v.model, input: (v.prefix ?? '') + t, voice: v.voice, response_format: v.format };
  if (v.instructions) body.instructions = v.instructions;
  const r = await openrouter('/audio/speech', body, 25_000);
  if (r.status !== 200 || r.buf.length < 1000) throw new Error(`голос ${id}: ${r.status} ${r.buf.toString('utf8').slice(0, 160)}`);
  return v.format === 'pcm' ? { buf: wav(r.buf), type: 'audio/wav', voice: id } : { buf: r.buf, type: 'audio/mpeg', voice: id };
}
export async function speak(text: string, voiceId: string): Promise<Spoken | null> {
  if (!key()) return null;
  const want = VOICE_CATALOG[voiceId] ? voiceId : DEFAULT_VOICE();
  const t = text.slice(0, 700);
  const now = Date.now();
  const order = [want, ...FALLBACK.filter((x) => x !== want)].filter((x, k) => k === 0 || (down.get(x) ?? 0) < now);
  if ((down.get(want) ?? 0) > now) order.push(order.shift()!); // выбранный недавно падал — пробуем его последним
  let last: unknown;
  for (const id of order) {
    const hit = cache.get(`${id}|${t}`);
    if (hit) return hit;
    try {
      const out = await speakWith(id, t);
      down.delete(id);
      if (cache.size > 80) cache.delete(cache.keys().next().value!);
      cache.set(`${id}|${t}`, out);
      return out;
    } catch (err) {
      last = err;
      // Модель голоса недоступна у OpenRouter (404 «No endpoints») — откладываем все голоса этой модели на полчаса,
      // иначе каждая фраза сначала стучится в мёртвый голос и Джарвис отвечает с задержкой или молчит.
      const msg = err instanceof Error ? err.message : String(err);
      const wait = /: 404 |No endpoints/.test(msg) ? 30 * MIN : 5 * MIN;
      for (const [vid, v] of Object.entries(VOICE_CATALOG)) if (v.model === VOICE_CATALOG[id].model) down.set(vid, Date.now() + wait);
      console.error('Джарвис: голос недоступен, пробую следующий —', msg.slice(0, 160));
    }
  }
  throw last instanceof Error ? last : new Error('голоса недоступны');
}

// ─── данные пункта человеческим языком ─────────────────────────────────────

const TAB_NAMES: Record<string, string> = {
  desk: '«Мой стол»',
  map: '«Жалобы» (карта)',
  inbox: '«Входящие»',
  teams: '«У команд»',
  done: '«Решено»',
  reviews: '«Разборы» (разбор после решения)',
  requests: '«Запросы команд»',
  signals: '«Сигналы»',
  shift: '«Смена пункта»',
  ai: '«ИИ-помощник»',
  wall: '«Видеостена»',
  directory: '«Справочник»',
};
const THEMES: Record<string, string> = { light: 'светлая', dark: 'тёмная', night: 'ночная смена', ocean: 'океан', red: 'красная', contrast: 'высокий контраст' };

const openList = (point: Point) => [...point.incidents.values()].filter((i) => i.status !== 'resolved');
function hot(point: Point, now: number) {
  return openList(point)
    .sort((a, b) => {
      const w = (i: Incident) => (i.priority === 'P1' || i.p1Proposal ? 3 : 0) + (i.origin === 'complaints' ? 1 : 0) + (i.status === 'coordinators' ? 1 : 0) + (i.slaDeadline - now < 60 * MIN ? 1 : 0);
      return w(b) - w(a) || a.slaDeadline - b.slaDeadline;
    })
    .slice(0, 8);
}
const teamName = (id: string | null | undefined) => teamById(id)?.name ?? id ?? '—';
const where = (i: Incident) =>
  i.status === 'resolved' ? 'решён' : i.status === 'coordinators' ? `на пункте, команде не передан${i.coordinatorName ? `, ведёт ${i.coordinatorName}` : ', дежурного нет'}` : `у команды «${teamName(i.teamId)}»${i.assigneeName ? `, в работе у ${i.assigneeName}` : ', ещё не взяли'}`;
const left = (i: Incident, now: number) => {
  const m = Math.round((i.slaDeadline - now) / MIN);
  return m <= 0 ? 'срок уже прошёл' : m < 90 ? `${m} мин до дедлайна` : `${Math.round(m / 60)} ч до дедлайна`;
};
const regions = (i: Incident) => (i.regionIds ?? []).map((r) => regionById(r)?.name).filter(Boolean).join(', ');
const shortLine = (i: Incident, now: number, point?: Point) => {
  const f = point ? forecast(i, point.complaints, RULES, now) : null;
  return `id=${i.id}; «${i.title}»; ${PRIORITY_TEXT[i.priority]}${i.p1Proposal ? ' (ИИ предлагает «Наивысший»)' : ''}; ${where(i)}; ${left(i, now)}${i.origin === 'complaints' ? `; жалоб ${i.complaints}` : ''}${f?.next ? `; прогноз: ${FORECAST_TEXT[f.next.level]} через ~${f.next.inMin} мин` : ''}`;
};

/** Кому дать: команды по справочнику и кто из дежурных подходит вести. */
function suggestions(point: Point, inc: Incident) {
  const now = Date.now();
  const picks = routeTeams(inc, point.ctx(now), 3).filter((p) => p.teamId !== POINT_ID);
  const coord = inc.status === 'coordinators' && !inc.coordinatorId ? planPoint([inc], POINT_STAFF, point.owned(), now)[0] : undefined;
  return { picks, coord, coordName: coord ? personById(coord.personId)?.name ?? null : null };
}

function details(point: Point, inc: Incident) {
  const now = Date.now();
  const s = suggestions(point, inc);
  const sig = [...point.signals.values()].filter((x) => x.incidentId === inc.id && x.status !== 'closed');
  const lines = [
    `id=${inc.id}; «${inc.title}»`,
    `Что случилось: ${(inc.shortDescription || inc.description || '').replace(/\s+/g, ' ').slice(0, 320)}`,
    `Сервис: ${inc.service}; продукт: ${inc.productName}${regions(inc) ? `; регионы: ${regions(inc)}` : ''}`,
    `Уровень: ${PRIORITY_TEXT[inc.priority]}${inc.p1Proposal ? `; ИИ предлагает «Наивысший»: ${inc.p1Proposal}` : ''}`,
    `Где сейчас: ${where(inc)}; ${left(inc, now)}`,
    inc.origin === 'complaints' ? `Жалоб абонентов: ${inc.complaints}${inc.complaintsSeries ? `, за последние 15 мин: ${inc.complaintsSeries.slice(-3).reduce((a, b) => a + b, 0)}` : ''}` : `Источник: ITSM (${inc.channel})`,
    s.picks.length
      ? `ИИ советует команду: ${s.picks.map((p, k) => `${k + 1}) team_id=${p.teamId} «${teamName(p.teamId)}» — ${p.score}%, ${p.onDuty ? `на смене ${p.onDutyCount}` : 'сейчас не на смене'}; почему: ${p.reasons.slice(0, 2).join('; ')}`).join(' | ')}`
      : 'ИИ не нашёл команду в справочнике — выбрать вручную',
  ];
  const f = forecast(inc, point.complaints, RULES, now);
  if (f) lines.push(`Прогноз по темпу жалоб: ${f.rate}/мин, ${f.trend === 'up' ? 'растёт' : f.trend === 'down' ? 'спадает' : 'ровно'}; ${f.next ? `${FORECAST_TEXT[f.next.level]} примерно через ${f.next.inMin} мин` : 'порог в ближайший час не наберётся'}`);
  if (s.coordName) lines.push(`Вести на пункте лучше: ${s.coordName} — ${s.coord!.why}`);
  if (sig.length) lines.push(`Сигналы: ${sig.map((x) => x.text).join('; ')}`);
  const hist = inc.history.slice(-3).map((h) => h.text);
  if (hist.length) lines.push(`Последнее: ${hist.join(' → ')}`);
  const chat = (inc.comments ?? []).slice(-2).map((c) => `${c.author}: ${c.text}`);
  if (chat.length) lines.push(`Переписка: ${chat.join(' | ')}`);
  return lines.join('\n');
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
/** Что кейс просит не упустить: срочнее критического, забытые важные, избранное смены. */
function caseView(point: Point, now: number) {
  const snap = dashSnapshot(point.incidents.values(), now);
  const above = snap.topCrit > 0 ? snap.action.filter((x) => x.inc.priority !== 'P1' && x.att.score > snap.topCrit).slice(0, 3) : [];
  return { above, forgotten: snap.forgotten.slice(0, 4), pinned: snap.pinned.slice(0, 6) };
}
const pinLine = (i: Incident, now: number) =>
  `id=${i.id}; «${i.title}»; ${i.status === 'resolved' ? 'уже решён' : left(i, now)}; закрепил ${i.pin!.by}${i.pin!.note ? `; заметка: «${i.pin!.note}»` : ''}${i.pin!.remindAt ? `; напомнить в ${hhmm(i.pin!.remindAt)}` : ''}`;
function caseLines(point: Point, now: number): string[] {
  const v = caseView(point, now);
  const out: string[] = [];
  const recur = [...point.incidents.values()].filter((i) => isRecurring(i, now));
  if (recur.length)
    out.push(
      'РЕШИЛИ, А ЖАЛОБЫ СНОВА ИДУТ (проблема не устранена — предложить вернуть в работу):',
      ...recur.map((i) => `- id=${i.id}; «${i.title}»; решала ${i.recur?.team ?? 'команда'} ${fmtShort(now - (i.resolvedAt ?? now))} назад; после решения жалоб: ${i.recur?.count ?? 0}`),
    );
  if (v.above.length) out.push('Срочнее самого срочного критического (короткий срок важнее уровня):', ...v.above.map((x) => `- ${shortLine(x.inc, now)}; почему: ${x.att.reason}`));
  if (v.forgotten.length) out.push('«Не забыть» — важные некритические, на которые никто не смотрел 20+ минут:', ...v.forgotten.map((x) => `- ${shortLine(x.inc, now)}; без внимания ${fmtShort(x.idle)}`));
  out.push(v.pinned.length ? 'Избранное смены (закрепили дежурные, с заметками):' : 'Избранное смены пусто.', ...v.pinned.map((i) => `- ${pinLine(i, now)}`));
  return out;
}

function contextText(point: Point, me: Me, q: JarvisAsk) {
  const now = Date.now();
  const all = openList(point);
  const sig = [...point.signals.values()].filter((s) => s.status === 'open');
  const req = [...point.requests.values()].filter((r) => r.status === 'pending');
  const sel = q.selectedId ? point.incidents.get(q.selectedId) : undefined;
  const focus = q.focusId ? point.incidents.get(q.focusId) : undefined;
  const duty = POINT_STAFF.filter((p) => p.role === 'coordinator' && isOn(p, now));
  const owned = point.owned();
  const lines = [
    `Дежурный: ${me.name}. Время: ${new Date(now).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })} МСК.`,
    `На экране: вкладка ${TAB_NAMES[q.tab ?? ''] ?? '—'}${sel ? `, открыт инцидент id=${sel.id} «${sel.title}»` : ''}.`,
    dashContextLine(q.dash ?? null),
    `Жалоб в минуту: ${point.stats().flowPerMin}. Открыто инцидентов: ${all.length}: на пункте ${all.filter((i) => i.status === 'coordinators').length} (без дежурного ${all.filter((i) => i.status === 'coordinators' && !i.coordinatorId).length}), у команд ${all.filter((i) => i.status !== 'coordinators').length}. Открытых сигналов: ${sig.length}, запросов команд: ${req.length}.`,
    `Дежурные на смене: ${duty.map((p) => `${p.name} (${p.spec}, ведёт ${owned.get(p.id) ?? 0})`).join(', ') || 'никого'}.`,
    'Горящие инциденты:',
    ...hot(point, now).map((i) => `- ${shortLine(i, now, point)}`),
  ];
  lines.push(...caseLines(point, now));
  const mail = importantMail(now).slice(0, 5);
  if (mail.length)
    lines.push(
      'ПОЧТА — непрочитанные важные письма (самое важное первым; «прочитай письмо», «что в письме» — про первое):',
      ...mail.map((m) => {
        const a = m.analysis!;
        const inc = a.incidentId ? point.incidents.get(a.incidentId) : undefined;
        return `- mail=${m.id}; ${MAIL_KIND[a.kind] ?? a.kind}${a.urgency === 'high' ? ', срочно' : ''}; от ${m.fromName}; ${fmtShort(now - m.at)} назад; суть: ${a.summary}${inc ? `; про инцидент id=${inc.id} «${inc.title}»` : '; без инцидента'}`;
      }),
    );
  else if (mailbox) lines.push('Почта: важных непрочитанных писем нет.');
  if (point.clusters.length) lines.push('Подозрительные всплески жалоб (ещё не инциденты):', ...point.clusters.slice(0, 4).map((c) => `- key=${c.key}; ${c.service}, ${regionById(c.regionId)?.name}: ${c.count} за 10 мин при норме ${c.expected.toFixed(1)}`));
  if (sig.length) lines.push('Сигналы:', ...sig.slice(0, 5).map((s) => `- инцидент ${s.incidentId}: ${s.text}`));
  if (focus) lines.push('', 'ИНЦИДЕНТ В ФОКУСЕ РАЗГОВОРА («он», «его», «этот»):', details(point, focus));
  else if (sel) lines.push('', 'ОТКРЫТЫЙ НА ЭКРАНЕ ИНЦИДЕНТ («он», «его», «этот»):', details(point, sel));
  return lines.join('\n');
}

// ─── сводка смены ──────────────────────────────────────────────────────────

const SHIFT_MS = 12 * 3_600_000;
/** Итоги смены дежурного: что взял, передал, решено, что открыто и горит, что ждёт пункт. */
export function shiftSummary(point: Point, me: Me) {
  const now = Date.now();
  const from = now - SHIFT_MS;
  const all = [...point.incidents.values()];
  const { taken, routed, avgRouteMs } = myShiftWork(all, me.name, from);
  const mine = all.filter((i) => i.coordinatorId === me.personId);
  const solved = mine.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from).length;
  const open = mine.filter((i) => i.status !== 'resolved');
  const hot = open.filter((i) => i.priority === 'P1' || i.priority === 'P2' || i.slaDeadline - now < 3_600_000);
  const created = all.filter((i) => i.createdAt > from).length;
  const resolvedAll = all.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from).length;
  const ai = all.reduce((n, i) => n + i.history.filter((h) => h.kind === 'ai' && h.at > from).length, 0);
  const req = [...point.requests.values()].filter((r) => r.status === 'pending').length;
  const sig = [...point.signals.values()].filter((s) => s.status === 'open').length;
  const avg = avgRouteMs === null ? null : Math.round(avgRouteMs / MIN);
  const biggest = all.filter((i) => i.origin === 'complaints' && i.createdAt > from).sort((a, b) => (b.complaints ?? 0) - (a.complaints ?? 0))[0];
  return [
    `Смена ${me.name}, последние 12 часов.`,
    `Вы: взяли ${taken}, передали командам ${routed}${avg !== null ? ` (в среднем через ${avg} мин после того, как инцидент попал к вам)` : ''}, решено из ваших ${solved}.`,
    `Сейчас у вас открыто ${open.length}, из них горит ${hot.length}${hot.length ? `: ${hot.slice(0, 3).map((i) => `«${i.title}» (${where(i)})`).join('; ')}` : ''}.`,
    `По пункту: новых инцидентов ${created}, решено ${resolvedAll}, ИИ сделал ${ai} действий.`,
    biggest ? `Самый массовый: «${biggest.title}», ${biggest.complaints} жалоб, ${where(biggest)}.` : '',
    `Ждут пункт: запросов команд ${req}, открытых сигналов ${sig}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── действия: общий исполнитель для модели и для правил ───────────────────

class Exec {
  actions: ClientAction[] = [];
  done: string[] = [];
  focus: string | null;
  constructor(
    private point: Point,
    private me: Me,
    private mode: Mode,
    focus: string | null,
    private dash: { ctx: DashCtx | null; allowed: boolean } = { ctx: null, allowed: false },
    private emit: Emit = () => undefined,
  ) {
    this.focus = focus;
  }
  private steps = 0;
  /** Выполнить инструмент и рассказать окну «Работа Джарвиса», что делается: до, после и что поменялось на экране. */
  run(name: string, a: Record<string, unknown>): string {
    const id = `t${++this.steps}`;
    const before = { actions: this.actions.length, done: this.done.length };
    // с чем работает шаг — стена показывает курсор Джарвиса на этой строке («нажимает» и «печатает»)
    const target = typeof a.id === 'string' ? a.id : typeof a.mail === 'string' ? `mail:${a.mail}` : null;
    this.emit({ type: 'step', id, text: this.describe(name, a), state: 'run', tool: name, target });
    try {
      const out = this.exec(name, a);
      const done = this.done.slice(before.done);
      this.emit({ type: 'step', id, text: done.join('; ') || this.describe(name, a, true), state: 'done', tool: name, target: target ?? this.focus });
      const fresh = this.actions.slice(before.actions);
      if (fresh.length) this.emit({ type: 'actions', actions: fresh });
      return out;
    } catch (err) {
      this.emit({ type: 'step', id, text: this.describe(name, a), state: 'fail', note: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
  /** Человеческим языком: «Смотрю инцидент …», «Открываю вкладку …». */
  private describe(name: string, a: Record<string, unknown>, past = false): string {
    const t = (id: unknown) => (typeof id === 'string' ? this.point.incidents.get(id)?.title : undefined) ?? 'инцидент';
    const v = (now: string, was: string) => (past ? was : now);
    switch (name) {
      case 'get_incident':
        return `${v('Смотрю', 'Посмотрел')} «${t(a.id)}»`;
      case 'find_incidents':
        return `${v('Ищу', 'Нашёл')} инциденты: «${String(a.query ?? '')}»`;
      case 'who_is_on_duty':
        return v('Смотрю, кто на смене', 'Посмотрел, кто на смене');
      case 'shift_summary':
        return v('Собираю итоги смены', 'Собрал итоги смены');
      case 'suggest_assignee':
        return `${v('Подбираю команду для', 'Подобрал команду для')} «${t(a.id)}»`;
      case 'switch_tab':
        return `${v('Открываю', 'Открыл')} вкладку ${TAB_NAMES[String(a.tab)] ?? ''}`;
      case 'open_incident':
        return `${v('Открываю', 'Открыл')} «${t(a.id)}»`;
      case 'shift_report':
        return v('Собираю отчёт смены в PDF', 'Собрал отчёт смены');
      case 'open_settings':
        return v('Открываю настройки', 'Открыл настройки');
      case 'set_theme':
        return v('Меняю тему экрана', 'Сменил тему экрана');
      case 'replay':
        return v('Запускаю перемотку карты', 'Запустил перемотку');
      case 'open_team':
        return `${v('Ищу в справочнике', 'Нашёл в справочнике')} «${String(a.team ?? '')}»`;
      case 'take_incident':
        return `${v('Беру на вас', 'Взял на вас')} «${t(a.id)}»`;
      case 'assign_coordinator':
        return `${v('Поручаю', 'Поручил')} «${t(a.id)}» — ${String(a.person ?? '')}`;
      case 'route_incident':
        return `${v('Передаю команде', 'Передал команде')} «${t(a.id)}»`;
      case 'set_level':
        return `${v('Меняю уровень', 'Сменил уровень')} «${t(a.id)}»`;
      case 'answer_p1':
        return `${v('Отвечаю на предложение «Наивысшего»', 'Ответил на предложение «Наивысшего»')}: «${t(a.id)}»`;
      case 'notify_lead':
        return `${v('Указываю руководителю', 'Указал руководителю')} по «${t(a.id)}»`;
      case 'add_comment':
        return `${v('Пишу в переписку', 'Написал в переписку')} «${t(a.id)}»`;
      case 'message_lead':
        return `${v('Пишу руководителю команды', 'Написал руководителю команды')} по «${t(a.id)}»`;
      case 'create_from_cluster':
        return v('Создаю инцидент из всплеска жалоб', 'Создал инцидент из всплеска');
      case 'pin_incident':
        return `${v('Добавляю в избранное', 'Добавил в избранное')} «${t(a.id)}»`;
      case 'unpin_incident':
        return `${v('Убираю из избранного', 'Убрал из избранного')} «${t(a.id)}»`;
      case 'reopen_incident':
        return `${v('Возвращаю в работу', 'Вернул в работу')} «${t(a.id)}»`;
      case 'read_mail':
        return v('Читаю письмо', 'Прочитал письмо');
      case 'mail_to_incident':
        return v('Завожу инцидент по письму', 'Завёл инцидент по письму');
      case 'dashboard':
        return v('Перестраиваю видеостену', 'Перестроил видеостену');
      case 'design_dashboard':
        return v('Придумываю оформление стены', 'Придумал оформление стены');
      case 'create_block':
        return a.character === true ? v('Придумываю персонажа', 'Придумал персонажа') : v('Собираю новый блок', 'Собрал новый блок');
    }
    return v('Работаю', 'Сделал');
  }
  private inc(id: unknown) {
    const inc = typeof id === 'string' ? this.point.incidents.get(id) : undefined;
    if (!inc) throw new Error('нет такого инцидента');
    this.focus = inc.id;
    return inc;
  }
  private control() {
    if (this.mode !== 'control') throw new Error('управление экраном выключено в настройках — можно только отвечать');
  }

  private exec(name: string, a: Record<string, unknown>): string {
    const p = this.point;
    switch (name) {
      // ── узнать ──
      case 'get_incident':
        return details(p, this.inc(a.id));
      case 'find_incidents': {
        const found = findIncidents(p, String(a.query ?? ''), 6);
        if (found.length === 1) this.focus = found[0].id;
        return found.length ? found.map((i) => shortLine(i, Date.now())).join('\n') : 'ничего не нашлось';
      }
      case 'shift_summary':
        return shiftSummary(p, this.me);
      case 'who_is_on_duty': {
        const now = Date.now();
        const owned = p.owned();
        return POINT_STAFF.filter((x) => x.role === 'coordinator' && isOn(x, now)).map((x) => `${x.name} — ${x.spec}, ведёт ${owned.get(x.id) ?? 0}`).join('\n') || 'на смене никого';
      }
      case 'suggest_assignee': {
        const inc = this.inc(a.id);
        if (this.mode === 'control') this.actions.push({ type: 'show', what: 'route' });
        const s = suggestions(p, inc);
        return [s.picks.length ? s.picks.map((x, k) => `${k + 1}) team_id=${x.teamId} «${teamName(x.teamId)}» ${x.score}%: ${x.reasons.slice(0, 2).join('; ')}`).join('\n') : 'команд по справочнику нет', s.coordName ? `вести на пункте: ${s.coordName} — ${s.coord!.why}` : ''].filter(Boolean).join('\n');
      }
      // ── экран ──
      case 'switch_tab': {
        this.control();
        const tab = String(a.tab);
        if (!TAB_NAMES[tab]) throw new Error('нет такой вкладки');
        this.actions.push({ type: 'tab', tab });
        this.done.push(`Открыл вкладку ${TAB_NAMES[tab]}`);
        return 'ok';
      }
      case 'open_incident': {
        this.control();
        const inc = this.inc(a.id);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'top' });
        this.done.push(`Открыл «${inc.title}»`);
        return 'ok';
      }
      case 'dashboard': {
        if (!this.dash.allowed && this.mode !== 'control') throw new Error('перестраивать дашборд Джарвису не разрешено — включите это в настройках дашборда');
        const { cmd, done } = toDashOp(a, this.dash.ctx, this.point);
        if (cmd.op === 'focus' && cmd.id) this.focus = cmd.id;
        this.actions.push({ type: 'dash', cmd });
        this.done.push(done);
        return 'ok';
      }
      case 'design_dashboard': {
        if (!this.dash.allowed && this.mode !== 'control') throw new Error('перестраивать дашборд Джарвису не разрешено — включите это в настройках дашборда');
        if (this.dash.ctx?.locked) throw new Error('интерфейс закреплён за сотрудником — сначала открепите его в настройках дашборда');
        const prompt = String(a.prompt ?? '').trim();
        if (!prompt) throw new Error('опишите, каким сделать оформление');
        this.actions.push({ type: 'design', prompt });
        this.done.push(`Стена: ChatGPT придумывает оформление «${prompt.slice(0, 60)}»`);
        return 'оформление придумывается и появится на стене через несколько секунд';
      }
      case 'create_block': {
        if (!this.dash.allowed && this.mode !== 'control') throw new Error('перестраивать дашборд Джарвису не разрешено — включите это в настройках дашборда');
        if (this.dash.ctx?.locked) throw new Error('интерфейс закреплён за сотрудником — сначала открепите его в настройках дашборда');
        const prompt = String(a.prompt ?? '').trim();
        if (!prompt) throw new Error('опишите, какой блок нужен');
        const character = a.character === true;
        this.actions.push({ type: 'block', prompt, character });
        this.done.push(`Стена: ChatGPT собирает ${character ? 'персонажа' : 'блок'} «${prompt.slice(0, 50)}»`);
        return 'блок собирается и появится на стене через несколько секунд (персонаж с портретом — около минуты)';
      }
      case 'shift_report':
        this.control();
        this.actions.push({ type: 'report' });
        this.done.push('Собрал отчёт смены в PDF');
        return 'отчёт собирается и скачается в браузере дежурного';
      case 'open_settings':
        this.control();
        this.actions.push({ type: 'settings', open: a.open !== false });
        this.done.push(a.open !== false ? 'Открыл настройки' : 'Закрыл настройки');
        return 'ok';
      case 'set_theme': {
        this.control();
        const id = String(a.theme);
        if (!THEMES[id]) throw new Error('нет такой темы');
        this.actions.push({ type: 'theme', id });
        this.done.push(`Тема: ${THEMES[id]}`);
        return 'ok';
      }
      case 'replay':
        this.control();
        if (a.on !== false) this.actions.push({ type: 'tab', tab: 'map' });
        this.actions.push({ type: 'replay', on: a.on !== false });
        this.done.push(a.on !== false ? 'Запустил перемотку карты' : 'Остановил перемотку');
        return 'ok';
      case 'open_team': {
        this.control();
        const name = String(a.team ?? '');
        this.actions.push({ type: 'team', name });
        this.done.push(`Нашёл в справочнике «${name}»`);
        return 'ok';
      }
      // ── работа пункта ──
      case 'take_incident': {
        const inc = this.inc(a.id);
        if (!this.me.personId) throw new Error('нет учётки дежурного');
        p.assignCoordinator(inc.id, this.me.personId, this.me.name);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'who' });
        this.done.push(`Взял на вас «${inc.title}»`);
        return 'взято';
      }
      case 'assign_coordinator': {
        const inc = this.inc(a.id);
        const person = findCoordinator(String(a.person ?? ''));
        if (!person) throw new Error('такого дежурного нет на смене');
        p.assignCoordinator(inc.id, person.id, this.me.name);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'who' });
        this.done.push(`Вести «${inc.title}» — ${person.name}`);
        return `назначено: ${person.name}`;
      }
      case 'route_incident': {
        const inc = this.inc(a.id);
        const team = typeof a.team_id === 'string' && teamById(a.team_id) ? a.team_id : suggestions(p, inc).picks[0]?.teamId;
        if (!team || team === POINT_ID) throw new Error('справочник не нашёл команду — назовите её');
        if (inc.status !== 'coordinators' && inc.teamId === team) throw new Error(`он уже у команды «${teamName(team)}»${inc.assigneeName ? `, в работе у ${inc.assigneeName}` : ''}`);
        p.route(inc.id, team, this.me.name);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'route' });
        this.done.push(`Передал «${inc.title}» команде «${teamName(team)}»`);
        return `передано команде «${teamName(team)}»`;
      }
      case 'set_level': {
        const inc = this.inc(a.id);
        const lvl = String(a.level) as Priority;
        if (!['P1', 'P2', 'P3', 'P4'].includes(lvl)) throw new Error('уровень — P1…P4');
        p.setLevel(inc.id, lvl, this.me.name, String(a.reason ?? 'по команде дежурного через Джарвиса'));
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'level' });
        this.done.push(`Уровень «${inc.title}»: ${PRIORITY_TEXT[lvl]}`);
        return 'ok';
      }
      case 'answer_p1': {
        const inc = this.inc(a.id);
        if (a.confirm) p.setLevel(inc.id, 'P1', this.me.name, 'подтверждено дежурным по предложению ИИ');
        else p.dismissP1(inc.id, this.me.name);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'level' });
        this.done.push(a.confirm ? `Поднял до «Наивысшего»: «${inc.title}»` : `Отклонил «Наивысший» для «${inc.title}»`);
        return 'ok';
      }
      case 'notify_lead': {
        const inc = this.inc(a.id);
        const sig = [...p.signals.values()].find((s) => s.incidentId === inc.id && s.status === 'open');
        if (!sig) throw new Error('по этому инциденту нет открытого сигнала');
        p.notifyLead(sig.id, this.me.name);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'signal' });
        this.done.push(`Указал руководителю команды «${teamName(sig.teamId)}»`);
        return 'ok';
      }
      case 'message_lead': {
        const inc = this.inc(a.id);
        const left = inc.slaDeadline - Date.now();
        const text = String(a.text ?? '').trim() || `Прошу ускорить работу по «${inc.title}»: ${left > 0 ? `до срока ${fmtShort(left)}` : `срок прошёл ${fmtShort(-left)} назад`}. Дайте, пожалуйста, оценку.`;
        const r = p.messageLead(inc.id, this.me.name, text);
        this.focus = inc.id;
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'chat' });
        this.done.push(`Написал руководителю «${r.team}»${r.lead ? ` — ${r.lead}` : ''}`);
        return `отправлено руководителю ${r.lead ?? ''} («${r.team}»): ${text}`;
      }
      case 'add_comment': {
        const inc = this.inc(a.id);
        const text = String(a.text ?? '').trim();
        if (!text) throw new Error('пустое сообщение');
        p.comment(inc.id, { name: this.me.name, personId: this.me.personId, side: 'point', teamId: null }, text);
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'chat' });
        this.done.push(`Написал в переписку «${inc.title}»`);
        return 'ok';
      }
      case 'pin_incident': {
        const inc = this.inc(a.id);
        const m = typeof a.remind_min === 'number' && a.remind_min > 0 ? Math.min(720, Math.round(a.remind_min)) : null;
        const note = String(a.note ?? inc.pin?.note ?? '').trim().slice(0, 300);
        p.pin(inc.id, this.me.name, note, m);
        this.done.push(`Добавил в избранное «${inc.title}»${m ? `, напомню через ${m} мин` : ''}`);
        return 'ok';
      }
      case 'reopen_incident': {
        const inc = this.inc(a.id);
        p.reopen(inc.id, this.me.name);
        this.actions.push({ type: 'open', id: inc.id });
        this.done.push(`Вернул в работу «${inc.title}»${inc.teamId ? ` — команде «${teamName(inc.teamId)}»` : ''}`);
        return 'ok';
      }
      case 'read_mail': {
        if (!mailbox) throw new Error('почта не подключена');
        const m = typeof a.mail === 'string' && a.mail ? mailbox.get(a.mail.replace(/^mail=/, '')) : latestMail(Date.now());
        if (!m) throw new Error('такого письма нет — важных непрочитанных писем нет');
        mailbox.read(m.id);
        this.actions.push({ type: 'mail', id: m.id }); // на стене письмо раскрывается, пока он читает
        const an = m.analysis;
        if (an?.incidentId && p.incidents.has(an.incidentId)) this.focus = an.incidentId;
        this.done.push(`Прочитал письмо от ${m.fromName}`);
        return `письмо mail=${m.id} от ${m.fromName}, тема «${m.subject}».${an ? ` Суть: ${an.summary}. Что сделать: ${an.action}.` : ''}${an?.incidentId ? ` Про инцидент id=${an.incidentId}.` : ''} Текст: ${m.body.replace(/\s+/g, ' ').slice(0, 700)}`;
      }
      case 'mail_to_incident': {
        if (!mailbox) throw new Error('почта не подключена');
        const m = typeof a.mail === 'string' && a.mail ? mailbox.get(a.mail.replace(/^mail=/, '')) : latestMail(Date.now(), true);
        if (!m) throw new Error('нет письма без инцидента');
        const inc = mailbox.toIncident(m.id, this.me.name);
        this.focus = inc.id;
        this.actions.push({ type: 'open', id: inc.id });
        this.done.push(`Завёл инцидент «${inc.title}» по письму`);
        return `создан id=${inc.id} «${inc.title}»`;
      }
      case 'unpin_incident': {
        const inc = this.inc(a.id);
        p.unpin(inc.id, this.me.name);
        this.done.push(`Убрал из избранного «${inc.title}»`);
        return 'ok';
      }
      case 'create_from_cluster': {
        const before = p.incidents.size;
        const inc = p.createFromCluster(String(a.key), this.me.name);
        const existed = p.incidents.size === before;
        this.focus = inc.id;
        this.actions.push({ type: 'open', id: inc.id }, { type: 'show', what: 'top' });
        this.done.push(existed ? `Инцидент по этому всплеску уже есть — «${inc.title}»` : `Создал инцидент «${inc.title}»`);
        return existed ? `инцидент по этому всплеску ИИ уже завёл: id=${inc.id} (статус ${inc.status}) — продолжай с ним` : `создан id=${inc.id}`;
      }
    }
    throw new Error('неизвестный инструмент');
  }
}

const stem = (w: string) => w.slice(0, Math.max(4, w.length - 2));
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
function findCoordinator(q: string) {
  const words = norm(q).split(/[^а-яa-z]+/).filter((w) => w.length >= 3);
  const now = Date.now();
  return POINT_STAFF.filter((p) => p.role === 'coordinator' && isOn(p, now)).find((p) => {
    const tokens = norm(p.name).split(/\s+/);
    return words.some((w) => tokens.some((t) => t.startsWith(stem(w)) || w.startsWith(stem(t))));
  });
}
// Латиница в названиях сервисов так, как её произносят и как модель пишет по-русски: «КИОН» — это KION.
const LAT_RU: [RegExp, string][] = [
  [/kion/g, 'кион'],
  [/sms/g, 'смс'],
  [/ussd/g, 'юссд'],
  [/music/g, 'мьюзик музыка'],
  [/b2b/g, 'бтуби б2б'],
  [/pay/g, 'пэй пей'],
  [/crm/g, 'црм срм'],
  [/gpon/g, 'джипон'],
  [/l2/g, 'эл2'],
];
const withRu = (s: string) => `${s} ${LAT_RU.reduce((acc, [re, ru]) => (re.test(s) ? `${acc} ${ru}` : acc), '')}`;

/**
 * Инциденты по словам: открытые, а также решённые, по которым снова жалобы, и решённые за последние 2 часа
 * («верни в работу инцидент по KION» — он формально решён). Латиница сервисов понимается и по-русски.
 */
function findIncidents(point: Point, q: string, limit: number): Incident[] {
  const words = withRu(norm(q))
    .split(/[^а-яa-z0-9]+/)
    .filter((w) => w.length >= 3);
  const now = Date.now();
  const scored: [Incident, number][] = [];
  for (const i of point.incidents.values()) {
    const open = i.status !== 'resolved';
    const recent = !open && (isRecurring(i, now) || now - (i.resolvedAt ?? 0) < 2 * 3_600_000);
    if (!open && !recent) continue;
    const hay = withRu(norm(`${i.id} ${i.title} ${i.service} ${i.productName} ${i.regionName ?? ''} ${regions(i)} ${(i.regionIds ?? []).map((r) => regionById(r)?.city).join(' ')} ${teamName(i.teamId)}`));
    const s = words.filter((w) => hay.includes(stem(w))).length + (i.priority === 'P1' ? 0.2 : 0) + (open || isRecurring(i, now) ? 0.1 : 0);
    if (s >= 1) scored.push([i, s]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i]) => i);
}

// ─── инструменты для модели ────────────────────────────────────────────────

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const ID = { id: { type: 'string', description: 'id инцидента' } };
const MAIL_ARG = { mail: { type: 'string', description: 'mail=… из раздела «Почта»' } };
const INFO_TOOLS = [
  fn('get_incident', 'Подробно об инциденте: что случилось, где, уровень, кто ведёт, срок, совет ИИ, кому передать', ID, ['id']),
  fn('find_incidents', 'Найти открытые инциденты по словам: сервис, регион, город, команда', { query: { type: 'string' } }, ['query']),
  fn('who_is_on_duty', 'Кто из дежурных пункта сейчас на смене и сколько у каждого в работе'),
  fn('shift_summary', 'Итоги смены дежурного за 12 часов: что взял, передал, решено, что открыто и горит, что ждёт пункт — для пересменки'),
  fn('suggest_assignee', 'Кому дать инцидент: команды по справочнику и кто из дежурных подходит вести', ID, ['id']),
];
// Экран: вкладки, карточки, настройки — только когда Джарвис «управляет экраном».
const SCREEN_TOOLS = [
  fn('switch_tab', 'Открыть вкладку на экране дежурного', { tab: { type: 'string', enum: Object.keys(TAB_NAMES) } }, ['tab']),
  fn('open_incident', 'Открыть инцидент на экране (карточка по шагам)', ID, ['id']),
  fn('shift_report', 'Собрать отчёт смены в PDF для руководства (итоги, графики, инциденты, разборы) и скачать его'),
  fn('open_settings', 'Открыть или закрыть окно настроек', { open: { type: 'boolean' } }),
  fn('set_theme', 'Сменить тему экрана', { theme: { type: 'string', enum: Object.keys(THEMES) } }, ['theme']),
  fn('replay', 'Запустить (on=true) или остановить перемотку карты жалоб за последний час', { on: { type: 'boolean' } }),
  fn('open_team', 'Найти команду в справочнике и показать её', { team: { type: 'string' } }, ['team']),
];
// Действия с инцидентами — по прямой просьбе дежурного голосом или текстом, в любом режиме.
const ACTION_TOOLS = [
  fn('take_incident', 'Взять инцидент на себя (дежурный будет его вести)', ID, ['id']),
  fn('assign_coordinator', 'Поручить вести инцидент другому дежурному пункта (по фамилии)', { ...ID, person: { type: 'string', description: 'фамилия или имя дежурного' } }, ['id', 'person']),
  fn('route_incident', 'Передать инцидент команде. Без team_id — первой команде из совета ИИ', { ...ID, team_id: { type: 'string' } }, ['id']),
  fn('set_level', 'Изменить уровень инцидента', { ...ID, level: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] }, reason: { type: 'string' } }, ['id', 'level']),
  fn('answer_p1', 'Подтвердить (confirm=true) или отклонить предложение ИИ поднять до «Наивысшего»', { ...ID, confirm: { type: 'boolean' } }, ['id', 'confirm']),
  fn('notify_lead', 'Указать руководителю команды по открытому сигналу инцидента', ID, ['id']),
  fn('message_lead', 'Написать руководителю команды, у которой инцидент: сообщение придёт ему лично и будет видно в переписке. Текст — со слов дежурного; если дежурный не сказал что, напиши коротко сам: что случилось и что нужно (ускорить, взять в работу, дать срок)', { ...ID, text: { type: 'string', description: 'что написать руководителю' } }, ['id']),
  fn('add_comment', 'Написать сообщение команде в переписку инцидента', { ...ID, text: { type: 'string' } }, ['id', 'text']),
  fn('create_from_cluster', 'Создать инцидент из подозрительного всплеска жалоб', { key: { type: 'string' } }, ['key']),
  fn('pin_incident', 'Добавить инцидент в избранное смены (или изменить заметку): заметку и напоминание видит вся смена', { ...ID, note: { type: 'string', description: 'короткая заметка для смены' }, remind_min: { type: 'number', description: 'через сколько минут напомнить; 0 — без напоминания' } }, ['id']),
  fn('unpin_incident', 'Убрать инцидент из избранного смены', ID, ['id']),
  fn('reopen_incident', 'Вернуть в работу решённый инцидент, по которому снова идут жалобы (той же команде)', ID, ['id']),
  fn('read_mail', 'Прочитать письмо из почты: от кого, суть, что просят и текст; письмо станет прочитанным. Без mail — самое важное', MAIL_ARG),
  fn('mail_to_incident', 'Завести инцидент на пункте по письму о сбое. Без mail — самое важное письмо без инцидента', MAIL_ARG),
];

const SYSTEM = `Ты — Джарвис, голосовой ИИ-помощник дежурного координирующего пункта ИТ. Пункт получает жалобы абонентов, собирает инциденты и передаёт их в ~900 команд.
Твой ответ сразу звучит голосом, поэтому:
- говори по-русски, живо и коротко: одно-три предложения, строго не больше 40 слов, даже в обзоре; без списков, скобок, номеров INC и разметки;
- обращайся «сэр»;
- если горит много — назови одно-два главных и общее число, подробности — только по просьбе;
- исключение — «сводка смены»: вызови shift_summary и расскажи итоги связно, секунд на 30 (до 70 слов);
Пользуйся только данными пункта ниже и ответами инструментов — ничего не выдумывай.
Как вести разговор:
- «Объясни ситуацию» — что случилось, где и насколько массово, кто ведёт, сколько до срока, что советует ИИ.
- «Кому дать?», «кому передать?» — назови команду из совета ИИ и почему (и кто из дежурных подходит вести, если инцидент без дежурного). Пока не попросят — не передавай.
- «Выдай», «давай», «передавай», «да, отдай» после твоего предложения — выполни именно то, что предложил.
- Дежурный на смене один — это тот, кто с тобой говорит. «Назначь», «назначь инцидент», «распредели» без имени человека — это передать команде из совета ИИ (route_incident), а не назначить другого дежурного. Дежурного назначай, только если назвали его по имени.
- Предложил «завести инцидент?» по всплеску, а в ответ «да», «заведи», «да, назначь» — create_from_cluster; если в ответе есть «назначь», «передай», «распредели» — сразу и route_incident в команду из совета ИИ. Если инцидент по всплеску ИИ уже завёл сам — продолжай с ним, не говори, что всплеска нет.
- «Он», «его», «этот» — инцидент в фокусе разговора или открытый на экране.
- Главная мысль кейса: за критическими не потерять важные некритические. «Что я упускаю?», «что забыл?» — по разделу «Не забыть»; «что важнее критического?» — по разделу «Срочнее критического» (короткий срок у высокого может быть важнее критического). Спрашивают про общую обстановку — коротко упомяни и их, если есть.
- Строки-события в истории — то, что ты сам только что объявил (срочное на стене). Ответ дежурного относится к этому инциденту: «беру», «взял», «взял в задачу» — take_incident; «верни», «да, верни в работу» про «жалобы снова идут» — reopen_incident; «подтверждаю» про «Наивысший» — answer_p1 confirm=true; «принял» — коротко подтверди.
- «Решили, а жалобы снова идут» — проблема не устранена: предложи вернуть в работу той же команде (reopen_incident).
- «Что в избранном?» — по разделу «Избранное смены»: что закреплено и какие заметки. «Закрепи», «в избранное», «напомни через N минут» — pin_incident с заметкой со слов дежурного; «убери из избранного» — unpin_incident.
- «Напиши руководителю», «скажи руководителю команды», «пусть руководитель ускорит» — message_lead по инциденту в фокусе; текст — со слов дежурного, иначе коротко сам (что случилось, срок, что нужно). Если инцидент ещё не у команды — скажи, что сначала нужно передать.
- Почта: «прочитай письмо», «что пишут?» — read_mail (без mail — самое важное) и перескажи суть одной-двумя фразами, а не весь текст. «Заведи инцидент по письму» — mail_to_incident. «Передай в другую команду» про письмо-просьбу о переназначении — route_incident по инциденту из письма (команда — из письма или из совета ИИ).
- «Покажи четыре группы», «группы окном», «на весь экран», «закрой окно» — dashboard op=popup (block=groups; value=large — на весь экран; on=false — закрыть). Раскладку стены при этом не меняй.
- Вопрос команды (строка-событие «команда просит передать…»): «да», «передай» — route_incident в команду из совета ИИ; «команда просит помощи» — «да», «напиши» — message_lead с сутью просьбы.
- Реплика не тебе — люди говорят между собой, оценка вроде «лучше, чем было, но всё равно», оборванная фраза без просьбы: ответь ровно «—» и ничего не делай. Не переспрашивай и не объясняй.
- Пометка «[обращаются к тебе]» в начале реплики — она точно тебе: «—» не отвечай. Поняли не до конца — выполни самое вероятное или коротко переспроси одной фразой.
- Сначала сделай действие инструментом, потом коротко скажи, что сделал. Никогда не говори «открыл», «передал», «готово», не вызвав инструмент.
- Пометки «(Сделано: …)» в истории — действия, которые уже выполнены на самом деле. Не оспаривай их и не повторяй без просьбы.`;
/** Системная подсказка под выбранного персонажа: имя, обращение и характер. */
function systemFor(id: string | null | undefined) {
  const p = personaById(id);
  return SYSTEM.replace('Ты — Джарвис,', `Ты — ${p.name},`).replace('- обращайся «сэр»;', `${p.address ? `- обращайся «${p.address}»;` : '- обращайся на «вы», без «сэр»;'}\n- характер: говори ${p.style};`);
}
const CONTROL_NOTE = `Режим «Джарвис управляет экраном» включён: ты можешь открывать вкладки, инциденты, настройки, менять тему, запускать перемотку, брать, поручать, передавать, менять уровень и писать в переписку. Когда объясняешь инцидент — обязательно открой его на экране (open_incident). «Открой вкладку и объясни ситуацию» — открой вкладку и самый важный инцидент на ней, потом объясни.`;
const CHAT_NOTE = `Режим только ответов: ты ничего не открываешь и не меняешь. Если просят действие — скажи, что для этого нужно включить «Джарвис управляет экраном» в настройках.`;

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string };

async function llm(point: Point, me: Me, q: JarvisAsk, emit: Emit = () => undefined): Promise<JarvisReply> {
  const dashOk = q.mode === 'control' || !!q.dashControl;
  const ex = new Exec(point, me, q.mode, q.focusId ?? q.selectedId, { ctx: q.dash ?? null, allowed: !!q.dashControl }, emit);
  const msgs: Msg[] = [
    { role: 'system', content: `${systemFor(q.persona)}\n${q.mode === 'control' ? CONTROL_NOTE : CHAT_NOTE}${dashOk ? `\n${DASH_NOTE}` : ''}${q.short ? '\nСейчас показ для жюри: отвечай особенно коротко — одна-две фразы, до 25 слов, без поправок к прошлым ответам.' : ''}` },
    { role: 'system', content: `Данные пункта сейчас:\n${contextText(point, me, q)}` },
    ...q.history.slice(-8).map((h) => ({ role: h.role, content: h.content.slice(0, 600) }) as Msg),
    { role: 'user', content: `${q.addressed ? '[обращаются к тебе] ' : ''}${q.text.slice(0, 500)}` },
  ];
  const tools = [...INFO_TOOLS, ...ACTION_TOOLS, ...(q.mode === 'control' ? SCREEN_TOOLS : []), ...(dashOk ? [DASH_TOOL, DESIGN_TOOL, BLOCK_TOOL] : [])];
  let nudged = false;
  emit({ type: 'step', id: 'think', text: 'Думаю над ответом', state: 'run' });
  for (let round = 0; round < 6; round++) {
    // Размышления у модели на OpenRouter обязательны — держим их на минимуме (голосу важна скорость),
    // а лимит с запасом, чтобы на сам ответ всегда хватало (иначе текст выходил пустым).
    const r = await openrouter('/chat/completions', { model: JARVIS_MODEL(), messages: msgs, tools, tool_choice: 'auto', max_tokens: 1200, temperature: 0.3, reasoning: { effort: 'low' } }, 30_000);
    if (r.status !== 200) throw new Error(`модель: ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`);
    const data = JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const m = data.choices[0].message;
    if (process.env.JARVIS_DEBUG) console.log('Джарвис ←', JSON.stringify(m).slice(0, 600));
    if (!m.tool_calls?.length) {
      const reply = (m.content ?? '').trim();
      if (reply) {
        emit({ type: 'step', id: 'think', text: 'Ответ готов', state: 'done' });
        return { reply, actions: ex.actions, done: ex.done, focus: ex.focus, llm: true };
      }
      // Модель промолчала — просим сказать вслух; если снова молчит, отвечаем сами.
      if (!nudged) {
        nudged = true;
        msgs.push({ role: 'user', content: '(Скажи дежурному вслух одной-двумя фразами: что ты сделал или что предлагаешь.)' });
        continue;
      }
      if (ex.done.length) return { reply: `Сделано, сэр: ${ex.done.join(', ')}.`, actions: ex.actions, done: ex.done, focus: ex.focus, llm: true };
      const r2 = rules(point, me, { ...q, focusId: ex.focus }, emit);
      return { ...r2, actions: [...ex.actions, ...r2.actions], done: [...ex.done, ...r2.done] };
    }
    msgs.push({ role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls });
    for (const call of m.tool_calls) {
      let out: string;
      try {
        out = ex.run(call.function.name, JSON.parse(call.function.arguments || '{}') as Record<string, unknown>);
      } catch (err) {
        out = `не получилось: ${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(`Джарвис → ${call.function.name}(${call.function.arguments.slice(0, 120)}) — ${out.split('\n')[0].slice(0, 120)}`);
      msgs.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  return { reply: ex.done.length ? `Сделано, сэр: ${ex.done.join(', ')}.` : 'Готово, сэр.', actions: ex.actions, done: ex.done, focus: ex.focus, llm: true };
}

// ─── по правилам (без ключа или если модель недоступна) ────────────────────

const TAB_WORDS: [RegExp, string][] = [
  [/видеостен|стен[уы]/, 'wall'],
  [/мой стол|стол/, 'desk'],
  [/карт|перемот/, 'map'],
  [/входящ/, 'inbox'],
  [/у команд/, 'teams'],
  [/сигнал/, 'signals'],
  [/запрос/, 'requests'],
  [/реш[её]н/, 'done'],
  [/журнал|помощник/, 'ai'],
  [/справочник/, 'directory'],
  [/смен[ауы] пункта|график/, 'shift'],
];

function rules(point: Point, me: Me, q: JarvisAsk, emit: Emit = () => undefined): JarvisReply {
  const text = norm(q.text);
  const now = Date.now();
  const ex = new Exec(point, me, q.mode, q.focusId ?? q.selectedId, { ctx: q.dash ?? null, allowed: !!q.dashControl }, emit);
  const say = (reply: string): JarvisReply => ({ reply, actions: ex.actions, done: ex.done, focus: ex.focus, llm: false });
  const focus = () => (ex.focus ? point.incidents.get(ex.focus) : undefined) ?? findIncidents(point, text, 1)[0];
  const tryRun = (name: string, a: Record<string, unknown>) => {
    try {
      return ex.run(name, a);
    } catch (err) {
      return `!${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const explain = (i: Incident) => {
    const s = suggestions(point, i);
    return `${i.title}. ${i.origin === 'complaints' ? `${i.complaints} жалоб. ` : ''}Сейчас ${where(i)}, ${left(i, now)}.${s.picks[0] ? ` ИИ советует команду «${teamName(s.picks[0].teamId)}».` : ''}`;
  };

  // Команды видеостене: «покажи только критические», «поменяй местами блоки», «сделай неон»…
  const dashReply = dashRules(text, q.dash ?? null, (a) => (a.op === '__design' ? tryRun('design_dashboard', { prompt: a.prompt }) : a.op === '__block' ? tryRun('create_block', { prompt: a.prompt, character: a.character }) : tryRun('dashboard', a)), q.tab === 'wall');
  if (dashReply) return say(dashReply);
  // Почта: «прочитай письмо», «заведи инцидент по письму»; «да» в ответ на «срочное письмо… Прочитать?»
  const lastSaid = norm(q.history.at(-1)?.role === 'assistant' ? q.history.at(-1)!.content : '');
  const yes = /^(да|давай|ага|конечно|читай)([\s,.!]|$)/.test(text);
  if (/письм|почт/.test(text) || (yes && /письм/.test(lastSaid))) {
    if (/завед|созда|инцидент/.test(text) || (yes && /завести инцидент/.test(lastSaid))) {
      const r = tryRun('mail_to_incident', {});
      return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Готово, сэр. ${ex.done.at(-1)}.`);
    }
    const m = importantMail(now)[0];
    const r = tryRun('read_mail', {});
    if (r.startsWith('!') || !m) return say('Важных непрочитанных писем нет, сэр.');
    const an = m.analysis!;
    return say(`Письмо от ${m.fromName}: ${an.summary.replace(/[.!]+$/, '')}.${an.action ? ` ${an.action.replace(/[.!]+$/, '')}.` : ''}`);
  }
  if (/руководител/.test(text) && /напиши|написать|скажи|сообщи|передай|пусть|попроси|напомни/.test(text)) {
    const i = focus();
    if (!i) return say('По какому инциденту написать руководителю, сэр?');
    const said = /(?:что|чтобы|:)\s+(.{4,})$/.exec(q.text)?.[1]?.trim();
    const r = tryRun('message_lead', { id: i.id, text: said ?? '' });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Готово, сэр. ${ex.done.at(-1)}.`);
  }
  if (/кому .*(дать|переда|отда|поруч)|кто .*(возьм|подойд)/.test(text)) {
    const i = focus();
    if (!i) return say('О каком инциденте речь, сэр? Откройте его или назовите сервис и регион.');
    ex.focus = i.id;
    const s = suggestions(point, i);
    return say(s.picks[0] ? `Команде «${teamName(s.picks[0].teamId)}»: ${s.picks[0].reasons[0] ?? 'подходит по справочнику'}.${s.coordName ? ` Вести на пункте лучше ${s.coordName}.` : ''} Передать?` : 'Справочник не нашёл команду, сэр. Назовите её.');
  }
  const person = /(дай|поручи|назначь|отдай)\s+([а-я]+)/.exec(text);
  if (person && findCoordinator(person[2])) {
    const i = focus();
    if (!i) return say('Какой инцидент поручить, сэр?');
    const r = tryRun('assign_coordinator', { id: i.id, person: person[2] });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Готово, сэр. ${ex.done.at(-1)}.`);
  }
  if (/выдай|передай|передавай|отдай|давай|отправь|да,? (переда|отда)/.test(text)) {
    const i = focus();
    if (!i) return say('Что передать, сэр? Откройте инцидент или назовите его.');
    const r = tryRun('route_incident', { id: i.id });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Готово, сэр. ${ex.done.at(-1)}.`);
  }
  const fi = ex.focus ? point.incidents.get(ex.focus) : undefined;
  if (/верни|вернуть|переоткр|снова в работу|возобнов/.test(text) || (/^(да|давай|ага|конечно)([\s,.!]|$)/.test(text) && fi && isRecurring(fi, now))) {
    const i = (fi && fi.status === 'resolved' ? fi : undefined) ?? [...point.incidents.values()].find((x) => isRecurring(x, now));
    if (!i) return say('Нет решённого инцидента, по которому снова идут жалобы, сэр.');
    const r = tryRun('reopen_incident', { id: i.id });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Вернул в работу, сэр: «${i.title}»${i.teamId ? ` — команде «${teamName(i.teamId)}»` : ''}.`);
  }
  if (/возьми|беру|берем|забер|взял|на себя|в задачу/.test(text)) {
    const i = focus();
    if (!i) return say('Какой инцидент взять, сэр?');
    const r = tryRun('take_incident', { id: i.id });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Взял на вас, сэр: «${i.title}».`);
  }
  if (/настройк/.test(text)) {
    const r = tryRun('open_settings', { open: !/закрой/.test(text) });
    return say(r.startsWith('!') ? `Не могу: ${r.slice(1)}.` : 'Готово, сэр.');
  }
  const theme = Object.entries({ dark: /т[её]мн/, light: /светл/, night: /ночн/, ocean: /океан/, red: /красн/, contrast: /контраст/ }).find(([, re]) => re.test(text) && /тем|экран|сделай|включи/.test(text));
  if (theme) {
    const r = tryRun('set_theme', { theme: theme[0] });
    return say(r.startsWith('!') ? `Не могу: ${r.slice(1)}.` : `Тема «${THEMES[theme[0]]}», сэр.`);
  }
  if (/перемот|прокрут|как развивал/.test(text)) {
    const r = tryRun('replay', { on: !/стоп|останов/.test(text) });
    return say(r.startsWith('!') ? `Не могу: ${r.slice(1)}.` : 'Перемотка за последний час, сэр.');
  }
  const cv = caseView(point, now);
  if (/(убери|удали|сними).*(избранн|закреп)/.test(text)) {
    const i = focus();
    if (!i) return say('Что убрать из избранного, сэр?');
    const r = tryRun('unpin_incident', { id: i.id });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `Убрал из избранного, сэр: «${i.title}».`);
  }
  if (/(добав|закрепи|запомни|в избранн).*(избранн|закреп|его|этот|напомн)|^закрепи|напомни через/.test(text)) {
    const i = focus();
    if (!i) return say('Какой инцидент закрепить, сэр? Откройте его или назовите.');
    const m = /через (\d+)\s*(мин|час|ч)/.exec(text);
    const min = m ? Number(m[1]) * (m[2].startsWith('ч') ? 60 : 1) : 0;
    const r = tryRun('pin_incident', { id: i.id, remind_min: min });
    return say(r.startsWith('!') ? `Не вышло: ${r.slice(1)}.` : `В избранном смены, сэр: «${i.title}»${min ? `. Напомню через ${min} мин` : ''}.`);
  }
  if (/избранн|закреплен/.test(text)) {
    if (!cv.pinned.length) return say('В избранном пусто, сэр. Закрепите важное звёздочкой на карточке или скажите «закрепи».');
    const top = cv.pinned[0];
    ex.focus = top.id;
    return say(`В избранном ${cv.pinned.length}. ${top.title}${top.pin!.note ? ` — «${top.pin!.note}»` : ''}${cv.pinned[1] ? `, и ещё «${cv.pinned[1].title}»` : ''}.`);
  }
  if (/забыл|забыт|не забыть|упуска|без внимания|пропуска/.test(text)) {
    if (!cv.forgotten.length) return say('Ничего важного не забыто, сэр: на всё смотрели за последние 20 минут.');
    const x = cv.forgotten[0];
    ex.focus = x.inc.id;
    return say(`Без внимания ${fmtShort(x.idle)}: «${x.inc.title}», ${left(x.inc, now)}.${cv.forgotten.length > 1 ? ` Всего таких ${cv.forgotten.length}.` : ''}`);
  }
  if (/важнее критич|срочнее критич|опаснее критич/.test(text)) {
    if (!cv.above.length) return say('Сейчас критические — самое срочное, сэр. Ничего важнее них нет.');
    const x = cv.above[0];
    ex.focus = x.inc.id;
    return say(`Да, сэр: «${x.inc.title}» — ${x.att.reason.toLowerCase()}, ${left(x.inc, now)}. Это срочнее любого критического сейчас.`);
  }
  const wantsExplain = /объясни|расскажи|что с ним|ситуац|подробн/.test(text);
  if (/открой|покажи|перейди|найди/.test(text)) {
    const tab = TAB_WORDS.find(([re]) => re.test(text));
    // «Открой входящие и объясни» — самый горящий на пункте; «у команд» — самый горящий у команд.
    const onTab = tab?.[1] === 'inbox' ? hot(point, now).find((i) => i.status === 'coordinators') : tab?.[1] === 'teams' ? hot(point, now).find((i) => i.status !== 'coordinators') : undefined;
    const wantsTop = /срочн|горящ|главн|важн/.test(text);
    const inc = findIncidents(point, text, 1)[0] ?? (wantsExplain || wantsTop ? onTab ?? (wantsTop ? hot(point, now)[0] : focus() ?? hot(point, now)[0]) : undefined);
    const parts: string[] = [];
    if (tab) parts.push(tryRun('switch_tab', { tab: tab[1] }));
    if (inc) parts.push(tryRun('open_incident', { id: inc.id }));
    const err = parts.find((x) => x.startsWith('!'));
    if (err) return say(`Не могу: ${err.slice(1)}.`);
    if (inc) return say(`${wantsExplain || !tab ? explain(inc) : `Открыл, сэр. ${inc.title}.`}`);
    if (tab) return say(`Открыл ${TAB_NAMES[tab[1]]}, сэр.`);
    return say('Не нашёл открытый инцидент по этим словам, сэр. Назовите сервис и регион.');
  }
  if (wantsExplain) {
    const i = focus() ?? hot(point, now)[0];
    if (!i) return say('Сейчас ничего не горит, сэр.');
    ex.focus = i.id;
    return say(explain(i));
  }
  if (/отч[её]т/.test(text)) {
    const r = tryRun('shift_report', {});
    return say(r.startsWith('!') ? `Не могу: ${r.slice(1)}.` : 'Собираю отчёт смены в PDF, сэр. Через пару секунд он скачается.');
  }
  if (/сводк|итог.*смен|пересменк/.test(text)) {
    const s = shiftSummary(point, me).split('\n');
    return say(`Сэр, итоги смены. ${s.slice(1, 4).join(' ')}`);
  }
  if (/кто.*смен|на смене/.test(text)) {
    const duty = POINT_STAFF.filter((p) => p.role === 'coordinator' && isOn(p, now));
    return say(duty.length ? `На смене: ${duty.map((p) => p.name.split(' ').reverse().join(' ')).join(', ')}.` : 'Сейчас на смене дежурных нет.');
  }
  if (/сколько.*жалоб|жалоб.*сколько/.test(text)) {
    const n = point.stats().flowPerMin;
    const word = n % 10 === 1 && n % 100 !== 11 ? 'жалоба' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'жалобы' : 'жалоб';
    return say(`Сейчас ${n} ${word} в минуту, сэр.`);
  }
  if (/что.*(горит|происход|случ)|обстанов|сводк|статус|доклад/.test(text) || text.trim().length < 4) {
    const all = openList(point);
    const top = hot(point, now)[0];
    if (top) ex.focus = top.id;
    const atPoint = all.filter((i) => i.status === 'coordinators').length;
    return say(`Открыто ${all.length} инцидентов: ${atPoint} на пункте, ${all.length - atPoint} у команд.${top ? ` Главное — ${explain(top)}` : ' Ничего не горит.'}`);
  }
  if (/привет|здравств|джарвис/.test(text)) return say(`Здравствуйте, сэр. Спросите, что горит, или скажите «открой входящие и объясни ситуацию».`);
  return say('Я понял не всё, сэр. Спросите «что горит», «кому дать?» или скажите «открой входящие».');
}

// Короткие команды окну на стене — сразу по правилам, без модели: модель путает «покажи четыре группы» с раскладкой
// стены, а «закрой окно» — с окном настроек; по правилам это верно и мгновенно.
const QUICK_WALL_RE = /((закрой|убери|сверни) (окно|групп)|(четыре|4) групп|групп[ыа]? (на весь экран|окном|крупно)|(покажи|открой|разверни) групп)/;
export const quickWall = (text: string) => {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  return QUICK_WALL_RE.test(t) && !/раскладк|режим|вид стены|настройк/.test(t);
};

export async function ask(point: Point, me: Me, q: JarvisAsk, emit: Emit = () => undefined): Promise<JarvisReply> {
  if (quickWall(q.text)) return rules(point, me, q, emit);
  if (key()) {
    try {
      return await llm(point, me, q, emit);
    } catch (err) {
      console.error('Джарвис: модель недоступна, отвечаю по правилам —', err instanceof Error ? err.message : err);
      emit({ type: 'step', id: 'think', text: 'Модель не ответила — делаю по правилам', state: 'fail' });
    }
  }
  return rules(point, me, q, emit);
}

/**
 * Сценарий для жюри: реплика дежурного — её говорит другой ИИ (своя модель, свой голос).
 * Цель шага задана сценарием, формулировку и реакцию на ответ Джарвиса ИИ-дежурный выбирает сам.
 */
// ─── «Главное сейчас» для ИИ-помощника на видеостене ───────────────────────
let briefMemo: { key: string; at: number; text: string; llm: boolean } | null = null;
let briefPending: Promise<{ text: string; llm: boolean }> | null = null;
export async function dashBrief(point: Point): Promise<{ text: string; llm: boolean }> {
  const { key: k, text: ctx } = briefContext(point);
  const now = Date.now();
  if (briefMemo && ((briefMemo.key === k && now - briefMemo.at < 120_000) || now - briefMemo.at < 25_000)) return briefMemo;
  if (briefPending) return briefPending;
  briefPending = (async () => {
    let out = { text: briefByRules(point), llm: false };
    if (key()) {
      try {
        const r = await openrouter(
          '/chat/completions',
          {
            model: JARVIS_MODEL(),
            messages: [
              { role: 'system', content: 'Ты — ИИ-помощник на видеостене координаторов массовых инцидентов. По данным напиши два коротких предложения, всего до 40 слов: что сейчас главное и что сделать координатору (кому передать, что под угрозой, что может стать критическим). Без вступлений, без обращений, без разметки, без номеров INC. Пользуйся только данными.' },
              { role: 'user', content: ctx },
            ],
            max_tokens: 700,
            temperature: 0.3,
            reasoning: { effort: 'low' },
          },
          25_000,
        );
        if (r.status === 200) {
          const t = ((JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] }).choices[0]?.message.content ?? '').trim();
          if (t) out = { text: t, llm: true };
        }
      } catch (err) {
        console.error('Выжимка для стены: модель недоступна —', err instanceof Error ? err.message : err);
      }
    }
    briefMemo = { key: k, at: Date.now(), ...out };
    return out;
  })().finally(() => {
    briefPending = null;
  });
  return briefPending;
}

export async function actorLine(goal: string, last: string, fallback: string): Promise<string> {
  if (!key() || !goal) return fallback;
  try {
    const r = await openrouter(
      '/chat/completions',
      {
        model: process.env.JARVIS_ACTOR_MODEL || 'anthropic/claude-haiku-5.5',
        max_tokens: 80,
        temperature: 0.8,
        reasoning: { enabled: false },
        messages: [
          {
            role: 'system',
            content:
              'Ты — дежурный координирующего пункта ИТ, говоришь голосом с ИИ-помощником Джарвисом. Скажи одну короткую живую разговорную реплику по-русски, до 10 слов, строго про то, что нужно сказать сейчас: не добавляй других вопросов и не проси данных вроде имён инженеров или узлов сети. Обращайся к нему «Джарвис» только если это первая реплика. Без кавычек, без пояснений — только то, что произносишь.',
          },
          { role: 'user', content: `Что нужно сказать сейчас: ${goal}.\nПоследнее, что сказал Джарвис: ${last.slice(0, 400) || '—'}` },
        ],
      },
      9_000,
    );
    if (r.status !== 200) throw new Error(String(r.status));
    const text = ((JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] }).choices[0].message.content ?? '').trim().replace(/^["«]|["»]$/g, '');
    return text && text.length < 160 ? text : fallback;
  } catch (err) {
    console.error('Сценарий: ИИ-дежурный недоступен, реплика по сценарию —', err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** Объявление голосом о критическом: что случилось и что советует ИИ. Без модели — быстро, по шаблону. */
export function brief(point: Point, id: string): string | null {
  const i = point.incidents.get(id);
  if (!i) return null;
  const s = suggestions(point, i);
  const head = i.p1Proposal && i.priority !== 'P1' ? `Сэр, ИИ предлагает поднять до наивысшего: ${i.title}.` : `Сэр, критический инцидент: ${i.title}.`;
  const scale = i.origin === 'complaints' ? ` ${i.complaints} жалоб${regions(i) ? `, ${regions(i)}` : ''}.` : '';
  const now = ` Сейчас ${where(i)}.`;
  const tip = s.picks[0] && i.status === 'coordinators' ? ` ИИ советует команду «${teamName(s.picks[0].teamId)}».` : '';
  return `${head}${scale}${now}${tip}`;
}
