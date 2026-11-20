// «Джарвис» — голосовой ИИ-помощник дежурного.
// Два режима (переключаются в настройках у дежурного):
//   chat    — отвечает на вопросы о ситуации, ничего не открывает и не меняет;
//   control — ведёт экран вместе с дежурным: открывает вкладки и инциденты, объясняет ситуацию,
//             подсказывает, кому передать, и по команде передаёт, назначает, поднимает уровень, пишет в переписку.
// Разговор помнит «фокус» — инцидент, о котором шла речь, поэтому «объясни», «кому дать?», «выдай» понимаются без номера.
// Мозг — Claude, голос — ElevenLabs, оба через OpenRouter (ключ только на сервере). Без ключа — команды по правилам.
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Incident, Me, Priority } from '../shared/types.ts';
import { PRIORITY_TEXT } from '../shared/types.ts';
import type { Point } from './point.ts';
import { POINT_ID, POINT_STAFF, isOn, personById, teamById } from './directory.ts';
import { planPoint, routeTeams } from './ai-point.ts';
import { regionById } from './regions.ts';

const MIN = 60_000;
const key = () => process.env.OPENROUTER_API_KEY || '';
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
  | { type: 'team'; name: string };
export interface JarvisAsk {
  text: string;
  selectedId: string | null;
  focusId: string | null;
  tab: string | null;
  mode: Mode;
  history: { role: 'user' | 'assistant'; content: string }[];
}
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
async function openrouter(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; buf: Buffer }> {
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
const FALLBACK = ['mm-guy', 'grok-rex', 'el-brian', 'el-adam'];
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
      down.set(id, Date.now() + 5 * MIN);
      console.error('Джарвис: голос недоступен, пробую следующий —', err instanceof Error ? err.message : err);
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
const shortLine = (i: Incident, now: number) => `id=${i.id}; «${i.title}»; ${PRIORITY_TEXT[i.priority]}${i.p1Proposal ? ' (ИИ предлагает «Наивысший»)' : ''}; ${where(i)}; ${left(i, now)}${i.origin === 'complaints' ? `; жалоб ${i.complaints}` : ''}`;

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
  if (s.coordName) lines.push(`Вести на пункте лучше: ${s.coordName} — ${s.coord!.why}`);
  if (sig.length) lines.push(`Сигналы: ${sig.map((x) => x.text).join('; ')}`);
  const hist = inc.history.slice(-3).map((h) => h.text);
  if (hist.length) lines.push(`Последнее: ${hist.join(' → ')}`);
  const chat = (inc.comments ?? []).slice(-2).map((c) => `${c.author}: ${c.text}`);
  if (chat.length) lines.push(`Переписка: ${chat.join(' | ')}`);
  return lines.join('\n');
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
    `Жалоб в минуту: ${point.stats().flowPerMin}. Открыто инцидентов: ${all.length}: на пункте ${all.filter((i) => i.status === 'coordinators').length} (без дежурного ${all.filter((i) => i.status === 'coordinators' && !i.coordinatorId).length}), у команд ${all.filter((i) => i.status !== 'coordinators').length}. Открытых сигналов: ${sig.length}, запросов команд: ${req.length}.`,
    `Дежурные на смене: ${duty.map((p) => `${p.name} (${p.spec}, ведёт ${owned.get(p.id) ?? 0})`).join(', ') || 'никого'}.`,
    'Горящие инциденты:',
    ...hot(point, now).map((i) => `- ${shortLine(i, now)}`),
  ];
  if (point.clusters.length) lines.push('Подозрительные всплески жалоб (ещё не инциденты):', ...point.clusters.slice(0, 4).map((c) => `- key=${c.key}; ${c.service}, ${regionById(c.regionId)?.name}: ${c.count} за 10 мин при норме ${c.expected.toFixed(1)}`));
  if (sig.length) lines.push('Сигналы:', ...sig.slice(0, 5).map((s) => `- инцидент ${s.incidentId}: ${s.text}`));
  if (focus) lines.push('', 'ИНЦИДЕНТ В ФОКУСЕ РАЗГОВОРА («он», «его», «этот»):', details(point, focus));
  else if (sel) lines.push('', 'ОТКРЫТЫЙ НА ЭКРАНЕ ИНЦИДЕНТ («он», «его», «этот»):', details(point, sel));
  return lines.join('\n');
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
  ) {
    this.focus = focus;
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

  run(name: string, a: Record<string, unknown>): string {
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
      case 'who_is_on_duty': {
        const now = Date.now();
        const owned = p.owned();
        return POINT_STAFF.filter((x) => x.role === 'coordinator' && isOn(x, now)).map((x) => `${x.name} — ${x.spec}, ведёт ${owned.get(x.id) ?? 0}`).join('\n') || 'на смене никого';
      }
      case 'suggest_assignee': {
        const inc = this.inc(a.id);
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
        this.actions.push({ type: 'open', id: inc.id });
        this.done.push(`Открыл «${inc.title}»`);
        return 'ok';
      }
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
        this.control();
        const inc = this.inc(a.id);
        if (!this.me.personId) throw new Error('нет учётки дежурного');
        p.assignCoordinator(inc.id, this.me.personId, this.me.name);
        this.actions.push({ type: 'open', id: inc.id });
        this.done.push(`Взял на вас «${inc.title}»`);
        return 'взято';
      }
      case 'assign_coordinator': {
        this.control();
        const inc = this.inc(a.id);
        const person = findCoordinator(String(a.person ?? ''));
        if (!person) throw new Error('такого дежурного нет на смене');
        p.assignCoordinator(inc.id, person.id, this.me.name);
        this.done.push(`Вести «${inc.title}» — ${person.name}`);
        return `назначено: ${person.name}`;
      }
      case 'route_incident': {
        this.control();
        const inc = this.inc(a.id);
        const team = typeof a.team_id === 'string' && teamById(a.team_id) ? a.team_id : suggestions(p, inc).picks[0]?.teamId;
        if (!team || team === POINT_ID) throw new Error('справочник не нашёл команду — назовите её');
        if (inc.status !== 'coordinators' && inc.teamId === team) throw new Error(`он уже у команды «${teamName(team)}»${inc.assigneeName ? `, в работе у ${inc.assigneeName}` : ''}`);
        p.route(inc.id, team, this.me.name);
        this.actions.push({ type: 'open', id: inc.id });
        this.done.push(`Передал «${inc.title}» команде «${teamName(team)}»`);
        return `передано команде «${teamName(team)}»`;
      }
      case 'set_level': {
        this.control();
        const inc = this.inc(a.id);
        const lvl = String(a.level) as Priority;
        if (!['P1', 'P2', 'P3', 'P4'].includes(lvl)) throw new Error('уровень — P1…P4');
        p.setLevel(inc.id, lvl, this.me.name, String(a.reason ?? 'по команде дежурного через Джарвиса'));
        this.done.push(`Уровень «${inc.title}»: ${PRIORITY_TEXT[lvl]}`);
        return 'ok';
      }
      case 'answer_p1': {
        this.control();
        const inc = this.inc(a.id);
        if (a.confirm) p.setLevel(inc.id, 'P1', this.me.name, 'подтверждено дежурным по предложению ИИ');
        else p.dismissP1(inc.id, this.me.name);
        this.done.push(a.confirm ? `Поднял до «Наивысшего»: «${inc.title}»` : `Отклонил «Наивысший» для «${inc.title}»`);
        return 'ok';
      }
      case 'notify_lead': {
        this.control();
        const inc = this.inc(a.id);
        const sig = [...p.signals.values()].find((s) => s.incidentId === inc.id && s.status === 'open');
        if (!sig) throw new Error('по этому инциденту нет открытого сигнала');
        p.notifyLead(sig.id, this.me.name);
        this.done.push(`Указал руководителю команды «${teamName(sig.teamId)}»`);
        return 'ok';
      }
      case 'add_comment': {
        this.control();
        const inc = this.inc(a.id);
        const text = String(a.text ?? '').trim();
        if (!text) throw new Error('пустое сообщение');
        p.comment(inc.id, { name: this.me.name, personId: this.me.personId, side: 'point', teamId: null }, text);
        this.done.push(`Написал в переписку «${inc.title}»`);
        return 'ok';
      }
      case 'create_from_cluster': {
        this.control();
        const inc = p.createFromCluster(String(a.key), this.me.name);
        this.focus = inc.id;
        this.actions.push({ type: 'open', id: inc.id });
        this.done.push(`Создал инцидент «${inc.title}»`);
        return `создан id=${inc.id}`;
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
function findIncidents(point: Point, q: string, limit: number): Incident[] {
  const words = norm(q).split(/[^а-яa-z0-9]+/).filter((w) => w.length >= 4);
  const scored: [Incident, number][] = [];
  for (const i of openList(point)) {
    const hay = norm(`${i.id} ${i.title} ${i.service} ${i.productName} ${i.regionName ?? ''} ${regions(i)} ${(i.regionIds ?? []).map((r) => regionById(r)?.city).join(' ')} ${teamName(i.teamId)}`);
    const s = words.filter((w) => hay.includes(stem(w))).length + (i.priority === 'P1' ? 0.2 : 0);
    if (s >= 1) scored.push([i, s]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i]) => i);
}

// ─── инструменты для модели ────────────────────────────────────────────────

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const ID = { id: { type: 'string', description: 'id инцидента' } };
const INFO_TOOLS = [
  fn('get_incident', 'Подробно об инциденте: что случилось, где, уровень, кто ведёт, срок, совет ИИ, кому передать', ID, ['id']),
  fn('find_incidents', 'Найти открытые инциденты по словам: сервис, регион, город, команда', { query: { type: 'string' } }, ['query']),
  fn('who_is_on_duty', 'Кто из дежурных пункта сейчас на смене и сколько у каждого в работе'),
  fn('suggest_assignee', 'Кому дать инцидент: команды по справочнику и кто из дежурных подходит вести', ID, ['id']),
];
const CONTROL_TOOLS = [
  fn('switch_tab', 'Открыть вкладку на экране дежурного', { tab: { type: 'string', enum: Object.keys(TAB_NAMES) } }, ['tab']),
  fn('open_incident', 'Открыть инцидент на экране (карточка по шагам)', ID, ['id']),
  fn('open_settings', 'Открыть или закрыть окно настроек', { open: { type: 'boolean' } }),
  fn('set_theme', 'Сменить тему экрана', { theme: { type: 'string', enum: Object.keys(THEMES) } }, ['theme']),
  fn('replay', 'Запустить (on=true) или остановить перемотку карты жалоб за последний час', { on: { type: 'boolean' } }),
  fn('open_team', 'Найти команду в справочнике и показать её', { team: { type: 'string' } }, ['team']),
  fn('take_incident', 'Взять инцидент на себя (дежурный будет его вести)', ID, ['id']),
  fn('assign_coordinator', 'Поручить вести инцидент другому дежурному пункта (по фамилии)', { ...ID, person: { type: 'string', description: 'фамилия или имя дежурного' } }, ['id', 'person']),
  fn('route_incident', 'Передать инцидент команде. Без team_id — первой команде из совета ИИ', { ...ID, team_id: { type: 'string' } }, ['id']),
  fn('set_level', 'Изменить уровень инцидента', { ...ID, level: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] }, reason: { type: 'string' } }, ['id', 'level']),
  fn('answer_p1', 'Подтвердить (confirm=true) или отклонить предложение ИИ поднять до «Наивысшего»', { ...ID, confirm: { type: 'boolean' } }, ['id', 'confirm']),
  fn('notify_lead', 'Указать руководителю команды по открытому сигналу инцидента', ID, ['id']),
  fn('add_comment', 'Написать сообщение команде в переписку инцидента', { ...ID, text: { type: 'string' } }, ['id', 'text']),
  fn('create_from_cluster', 'Создать инцидент из подозрительного всплеска жалоб', { key: { type: 'string' } }, ['key']),
];

const SYSTEM = `Ты — Джарвис, голосовой ИИ-помощник дежурного координирующего пункта ИТ. Пункт получает жалобы абонентов, собирает инциденты и передаёт их в ~900 команд.
Твой ответ сразу звучит голосом, поэтому:
- говори по-русски, живо и коротко: одно-три предложения, строго не больше 40 слов, даже в обзоре; без списков, скобок, номеров INC и разметки;
- обращайся «сэр»;
- если горит много — назови одно-два главных и общее число, подробности — только по просьбе.
Пользуйся только данными пункта ниже и ответами инструментов — ничего не выдумывай.
Как вести разговор:
- «Объясни ситуацию» — что случилось, где и насколько массово, кто ведёт, сколько до срока, что советует ИИ.
- «Кому дать?», «кому передать?» — назови команду из совета ИИ и почему (и кто из дежурных подходит вести, если инцидент без дежурного). Пока не попросят — не передавай.
- «Выдай», «давай», «передавай», «да, отдай» после твоего предложения — выполни именно то, что предложил.
- «Он», «его», «этот» — инцидент в фокусе разговора или открытый на экране.
- Сначала сделай действие инструментом, потом коротко скажи, что сделал. Никогда не говори «открыл», «передал», «готово», не вызвав инструмент.`;
const CONTROL_NOTE = `Режим «Джарвис управляет экраном» включён: ты можешь открывать вкладки, инциденты, настройки, менять тему, запускать перемотку, брать, поручать, передавать, менять уровень и писать в переписку. Когда объясняешь инцидент — обязательно открой его на экране (open_incident). «Открой вкладку и объясни ситуацию» — открой вкладку и самый важный инцидент на ней, потом объясни.`;
const CHAT_NOTE = `Режим только ответов: ты ничего не открываешь и не меняешь. Если просят действие — скажи, что для этого нужно включить «Джарвис управляет экраном» в настройках.`;

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string };

async function llm(point: Point, me: Me, q: JarvisAsk): Promise<JarvisReply> {
  const ex = new Exec(point, me, q.mode, q.focusId ?? q.selectedId);
  const msgs: Msg[] = [
    { role: 'system', content: `${SYSTEM}\n${q.mode === 'control' ? CONTROL_NOTE : CHAT_NOTE}` },
    { role: 'system', content: `Данные пункта сейчас:\n${contextText(point, me, q)}` },
    ...q.history.slice(-8).map((h) => ({ role: h.role, content: h.content.slice(0, 600) }) as Msg),
    { role: 'user', content: q.text.slice(0, 500) },
  ];
  const tools = q.mode === 'control' ? [...INFO_TOOLS, ...CONTROL_TOOLS] : INFO_TOOLS;
  let nudged = false;
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
      if (reply) return { reply, actions: ex.actions, done: ex.done, focus: ex.focus, llm: true };
      // Модель промолчала — просим сказать вслух; если снова молчит, отвечаем сами.
      if (!nudged) {
        nudged = true;
        msgs.push({ role: 'user', content: '(Скажи дежурному вслух одной-двумя фразами: что ты сделал или что предлагаешь.)' });
        continue;
      }
      if (ex.done.length) return { reply: `Сделано, сэр: ${ex.done.join(', ')}.`, actions: ex.actions, done: ex.done, focus: ex.focus, llm: true };
      const r2 = rules(point, me, { ...q, focusId: ex.focus });
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

function rules(point: Point, me: Me, q: JarvisAsk): JarvisReply {
  const text = norm(q.text);
  const now = Date.now();
  const ex = new Exec(point, me, q.mode, q.focusId ?? q.selectedId);
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
  if (/возьми|беру|забер/.test(text)) {
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
  const wantsExplain = /объясни|расскажи|что с ним|ситуац|подробн/.test(text);
  if (/открой|покажи|перейди|найди/.test(text)) {
    const tab = TAB_WORDS.find(([re]) => re.test(text));
    // «Открой входящие и объясни» — самый горящий на пункте; «у команд» — самый горящий у команд.
    const onTab = tab?.[1] === 'inbox' ? hot(point, now).find((i) => i.status === 'coordinators') : tab?.[1] === 'teams' ? hot(point, now).find((i) => i.status !== 'coordinators') : undefined;
    const inc = findIncidents(point, text, 1)[0] ?? (wantsExplain ? onTab ?? focus() ?? hot(point, now)[0] : undefined);
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

export async function ask(point: Point, me: Me, q: JarvisAsk): Promise<JarvisReply> {
  if (key()) {
    try {
      return await llm(point, me, q);
    } catch (err) {
      console.error('Джарвис: модель недоступна, отвечаю по правилам —', err instanceof Error ? err.message : err);
    }
  }
  return rules(point, me, q);
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
