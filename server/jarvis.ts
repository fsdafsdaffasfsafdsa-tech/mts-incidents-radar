// «Джарвис» — голосовой ИИ-помощник дежурного. Понимает вопросы о ситуации и команды («что горит», «открой Новосибирск»,
// «передай по совету», «кто на смене»), отвечает коротко — ответ озвучивается.
// С ключом OpenRouter: мозг — Claude, голос — ElevenLabs (как в сериалах). Без ключа — понятные команды по правилам
// и встроенный голос браузера. Ключ живёт только на сервере.
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Incident, Me } from '../shared/types.ts';
import { PRIORITY_TEXT } from '../shared/types.ts';
import type { Point } from './point.ts';
import { POINT_ID, POINT_STAFF, isOn, teamById } from './directory.ts';
import { routeTeams } from './ai-point.ts';
import { regionById } from './regions.ts';

const MIN = 60_000;
const key = () => process.env.OPENROUTER_API_KEY || '';
export const JARVIS_MODEL = () => process.env.JARVIS_MODEL || 'anthropic/claude-sonnet-5.5';
export const JARVIS_TTS = () => process.env.JARVIS_TTS_MODEL || 'elevenlabs/eleven-v4';
export const JARVIS_VOICES = ['adam', 'brian', 'bill', 'george', 'matilda'];

export type ClientAction = { type: 'open'; id: string } | { type: 'tab'; tab: string } | { type: 'replay' };
export interface JarvisReply {
  reply: string;
  actions: ClientAction[];
  llm: boolean;
}

export const jarvisStatus = () => ({ llm: !!key(), tts: !!key(), model: JARVIS_MODEL(), voices: JARVIS_VOICES, proxy: !!process.env.OPENROUTER_PROXY });

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

const cache = new Map<string, Buffer>();
export async function speak(text: string, voice: string): Promise<Buffer | null> {
  if (!key()) return null;
  const v = JARVIS_VOICES.includes(voice) ? voice : 'adam';
  const t = text.slice(0, 600);
  const k = `${v}|${t}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const r = await openrouter('/audio/speech', { model: JARVIS_TTS(), input: t, voice: v, response_format: 'mp3' }, 30_000);
  if (r.status !== 200) throw new Error(`голос: ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`);
  const buf = r.buf;
  if (cache.size > 80) cache.delete(cache.keys().next().value!);
  cache.set(k, buf);
  return buf;
}

// ─── что сейчас происходит (контекст для ответа) ───────────────────────────

function open(point: Point) {
  return [...point.incidents.values()].filter((i) => i.status !== 'resolved');
}
function hot(point: Point, now: number) {
  return open(point)
    .sort((a, b) => {
      const w = (i: Incident) => (i.priority === 'P1' || i.p1Proposal ? 3 : 0) + (i.origin === 'complaints' ? 1 : 0) + (i.slaDeadline - now < 60 * MIN ? 1 : 0);
      return w(b) - w(a) || a.slaDeadline - b.slaDeadline;
    })
    .slice(0, 8);
}
const where = (i: Incident) => (i.status === 'coordinators' ? 'на пункте, команде не передан' : `у команды «${teamById(i.teamId)?.name ?? i.teamId}»${i.assigneeName ? `, в работе у ${i.assigneeName}` : ', ещё не взяли'}`);
const left = (i: Incident, now: number) => {
  const m = Math.round((i.slaDeadline - now) / MIN);
  return m <= 0 ? 'срок прошёл' : m < 90 ? `${m} мин до дедлайна` : `${Math.round(m / 60)} ч до дедлайна`;
};

function contextText(point: Point, me: Me, selectedId: string | null) {
  const now = Date.now();
  const all = open(point);
  const sig = [...point.signals.values()].filter((s) => s.status !== 'closed');
  const req = [...point.requests.values()].filter((r) => r.status === 'pending');
  const sel = selectedId ? point.incidents.get(selectedId) : undefined;
  const lines = [
    `Дежурный: ${me.name}. Время: ${new Date(now).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.`,
    `Жалоб за минуту: ${point.stats().flowPerMin}. Инцидентов открыто: ${all.length}, на пункте: ${all.filter((i) => i.status === 'coordinators').length}, у команд: ${all.filter((i) => i.status !== 'coordinators').length}. Сигналов: ${sig.length}, запросов команд: ${req.length}.`,
    `На смене дежурные: ${POINT_STAFF.filter((p) => p.role === 'coordinator' && isOn(p, now)).map((p) => `${p.name} (${p.spec})`).join(', ') || 'никого'}.`,
    'Горящие инциденты:',
    ...hot(point, now).map((i) => `- id=${i.id}; «${i.title}»; уровень ${PRIORITY_TEXT[i.priority]}${i.p1Proposal ? ' (ИИ предлагает «Наивысший»)' : ''}; ${where(i)}; ${left(i, now)}${i.origin === 'complaints' ? `; жалоб ${i.complaints}` : ''}${i.coordinatorName ? `; ведёт ${i.coordinatorName}` : ''}`),
  ];
  if (sel) lines.push(`Сейчас на экране открыт: id=${sel.id} «${sel.title}», ${where(sel)}.`);
  if (sig.length) lines.push('Сигналы:', ...sig.slice(0, 5).map((s) => `- ${s.text}`));
  return lines.join('\n');
}

// ─── по правилам (без ключа или если модель недоступна) ────────────────────

const TABS: [RegExp, string, string][] = [
  [/видеостен|стен/, 'wall', 'видеостену'],
  [/карт|жалоб[ауы]? на карте/, 'map', 'карту жалоб'],
  [/входящ/, 'inbox', 'входящие'],
  [/у команд|команд[аы]? .*работ/, 'teams', 'инциденты у команд'],
  [/сигнал/, 'signals', 'сигналы'],
  [/запрос/, 'requests', 'запросы команд'],
  [/реш[её]н/, 'done', 'решённые'],
  [/помощник|журнал/, 'ai', 'журнал ИИ'],
  [/справочник/, 'directory', 'справочник команд'],
  [/смен[аеу] пункта|график/, 'shift', 'смену пункта'],
];

function findIncident(point: Point, q: string): Incident | undefined {
  const words = q.toLowerCase().replace(/ё/g, 'е').split(/[^а-яa-z0-9]+/).filter((w) => w.length >= 4);
  let best: Incident | undefined;
  let score = 0;
  for (const i of open(point)) {
    const hay = `${i.title} ${i.service} ${i.regionName ?? ''} ${(i.regionIds ?? []).map((r) => `${regionById(r)?.name} ${regionById(r)?.city}`).join(' ')}`.toLowerCase().replace(/ё/g, 'е');
    const s = words.filter((w) => hay.includes(w.slice(0, Math.max(4, w.length - 2)))).length + (i.priority === 'P1' ? 0.2 : 0);
    if (s > score) {
      score = s;
      best = i;
    }
  }
  return score >= 1 ? best : undefined;
}

function rules(point: Point, me: Me, text: string, selectedId: string | null): JarvisReply {
  const q = text.toLowerCase();
  const now = Date.now();
  const actions: ClientAction[] = [];
  const sel = selectedId ? point.incidents.get(selectedId) : undefined;
  const say = (reply: string): JarvisReply => ({ reply, actions, llm: false });

  if (/передай|отправь/.test(q)) {
    const inc = findIncident(point, q) ?? sel;
    if (!inc) return say('Не понял, какой инцидент передать, сэр. Откройте его или назовите сервис и регион.');
    const best = routeTeams(inc, point.ctx(now))[0];
    if (!best) return say('Для этого инцидента справочник не нашёл команду, сэр. Выберите вручную.');
    point.route(inc.id, best.teamId, me.name);
    actions.push({ type: 'open', id: inc.id });
    return say(`Готово, сэр. «${inc.title}» передан команде «${teamById(best.teamId)?.name}».`);
  }
  if (/возьми|беру|забер/.test(q)) {
    const inc = findIncident(point, q) ?? sel;
    if (!inc || !me.personId) return say('Какой инцидент взять, сэр?');
    point.assignCoordinator(inc.id, me.personId, me.name);
    actions.push({ type: 'open', id: inc.id });
    return say(`Взял на вас, сэр: «${inc.title}».`);
  }
  if (/открой|покажи|найди/.test(q)) {
    const tab = TABS.find(([re]) => re.test(q));
    const inc = findIncident(point, q);
    if (inc) {
      actions.push({ type: 'open', id: inc.id });
      return say(`Открываю «${inc.title}». Он ${where(inc)}, ${left(inc, now)}.`);
    }
    if (tab) {
      actions.push({ type: 'tab', tab: tab[1] });
      return say(`Открываю ${tab[2]}.`);
    }
    return say('Не нашёл открытый инцидент по этим словам, сэр. Назовите сервис и регион.');
  }
  if (/перемот|прокрут|как развивал/.test(q)) {
    actions.push({ type: 'tab', tab: 'map' }, { type: 'replay' });
    return say('Запускаю перемотку за последний час, сэр.');
  }
  if (/кто.*смен|на смене/.test(q)) {
    const duty = POINT_STAFF.filter((p) => p.role === 'coordinator' && isOn(p, now));
    return say(duty.length ? `На смене: ${duty.map((p) => p.name.split(' ').reverse().join(' ')).join(', ')}.` : 'Сейчас на смене дежурных нет.');
  }
  if (/сколько.*жалоб|жалоб.*сколько/.test(q)) {
    const s = point.stats();
    const n = s.flowPerMin;
    const word = n % 10 === 1 && n % 100 !== 11 ? 'жалоба' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'жалобы' : 'жалоб';
    return say(`Сейчас ${n} ${word} в минуту. Собрано в инциденты за последний час: ${point.complaints.filter((c) => c.incidentId && now - c.at < 60 * MIN).length}.`);
  }
  if (/сигнал|застрял|помощ/.test(q)) {
    const sig = [...point.signals.values()].filter((s) => s.status === 'open');
    return say(sig.length ? `Открытых сигналов ${sig.length}. Первый: ${sig[0].text.replace(/^ИИ: /, '')}.` : 'Открытых сигналов нет, сэр.');
  }
  const tab = TABS.find(([re]) => re.test(q));
  if (tab && /(перейди|открой|покажи|вкладк)/.test(q)) {
    actions.push({ type: 'tab', tab: tab[1] });
    return say(`Открываю ${tab[2]}.`);
  }
  if (/что.*(горит|происход|случ)|ситуац|обстанов|сводк|статус|доклад/.test(q) || q.trim().length < 4) {
    const all = open(point);
    const top = hot(point, now)[0];
    const atPoint = all.filter((i) => i.status === 'coordinators').length;
    return say(
      `Открыто ${all.length} инцидентов: ${atPoint} на пункте, ${all.length - atPoint} у команд. ` +
        (top ? `Главное сейчас — «${top.title}», уровень ${PRIORITY_TEXT[top.priority].toLowerCase()}, ${where(top)}, ${left(top, now)}.` : 'Ничего не горит.'),
    );
  }
  if (/привет|здравств|джарвис/.test(q)) return say(`Здравствуйте, ${me.name.split(' ')[1] ?? 'сэр'}. Спросите, что горит, или скажите «открой» и сервис.`);
  return say('Я понял не всё, сэр. Спросите «что горит», «кто на смене» или скажите «открой мобильный интернет в Москве».');
}

// ─── Claude через OpenRouter, с инструментами ──────────────────────────────

const TOOLS = [
  { type: 'function', function: { name: 'open_incident', description: 'Открыть инцидент на экране дежурного', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'route_incident', description: 'Передать инцидент команде. Без team_id — команде, которую советует ИИ. Только если дежурный явно попросил.', parameters: { type: 'object', properties: { id: { type: 'string' }, team_id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'take_incident', description: 'Взять инцидент на себя (дежурный будет его вести). Только если явно попросили.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'switch_tab', description: 'Открыть вкладку: map, inbox, teams, done, requests, signals, shift, ai, wall, directory', parameters: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] } } },
  { type: 'function', function: { name: 'start_replay', description: 'Запустить перемотку карты жалоб за последний час', parameters: { type: 'object', properties: {} } } },
];

const SYSTEM = `Ты — Джарвис, голосовой ИИ-помощник дежурного координирующего пункта ИТ. Пункт получает жалобы абонентов, собирает инциденты и передаёт их в ~900 команд.
Ответ озвучивается голосом, поэтому:
- по-русски, очень коротко: одно-два предложения, не больше 30 слов; без списков, скобок и разметки;
- если горит много — назови самое важное и общее число, остальное — только по просьбе;
- номера инцидентов (INC…) вслух не называй — называй сервис и регион;
- обращайся «сэр».
Используй только данные пункта из сообщения — не выдумывай инциденты, команды и цифры. Если данных нет — так и скажи.
Любое действие на экране или в системе делай только через инструмент: показать инцидент — open_incident, вкладку — switch_tab, передать — route_incident, взять — take_incident, перемотка — start_replay. Никогда не говори «открываю», «передал», «готово», не вызвав инструмент в этом же ответе.
Передать и взять — только по явной просьбе дежурного. «Его», «этот» — инцидент, о котором шла речь, или открытый на экране.`;

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string };

async function llm(point: Point, me: Me, text: string, selectedId: string | null, history: { role: 'user' | 'assistant'; content: string }[]): Promise<JarvisReply> {
  const actions: ClientAction[] = [];
  const msgs: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `Данные пункта сейчас:\n${contextText(point, me, selectedId)}` },
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.content.slice(0, 500) }) as Msg),
    { role: 'user', content: text.slice(0, 500) },
  ];
  for (let round = 0; round < 3; round++) {
    const r = await openrouter('/chat/completions', { model: JARVIS_MODEL(), messages: msgs, tools: TOOLS, tool_choice: 'auto', max_tokens: 260, temperature: 0.3 }, 25_000);
    if (r.status !== 200) throw new Error(`модель: ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`);
    const data = JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const m = data.choices[0].message;
    if (process.env.JARVIS_DEBUG) console.log('Джарвис ←', JSON.stringify(m).slice(0, 600));
    if (!m.tool_calls?.length) return { reply: (m.content ?? '').trim() || 'Готово, сэр.', actions, llm: true };
    msgs.push({ role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls });
    for (const call of m.tool_calls) {
      let out = 'ok';
      try {
        const a = JSON.parse(call.function.arguments || '{}') as { id?: string; team_id?: string; tab?: string };
        const inc = a.id ? point.incidents.get(a.id) : undefined;
        switch (call.function.name) {
          case 'open_incident':
            if (!inc) throw new Error('нет такого инцидента');
            actions.push({ type: 'open', id: inc.id });
            break;
          case 'route_incident': {
            if (!inc) throw new Error('нет такого инцидента');
            const team = a.team_id ?? routeTeams(inc, point.ctx())[0]?.teamId;
            if (!team || team === POINT_ID) throw new Error('справочник не нашёл команду');
            point.route(inc.id, team, me.name);
            actions.push({ type: 'open', id: inc.id });
            out = `передано команде «${teamById(team)?.name}»`;
            break;
          }
          case 'take_incident':
            if (!inc || !me.personId) throw new Error('нет такого инцидента');
            point.assignCoordinator(inc.id, me.personId, me.name);
            actions.push({ type: 'open', id: inc.id });
            break;
          case 'switch_tab':
            actions.push({ type: 'tab', tab: String(a.tab) });
            break;
          case 'start_replay':
            actions.push({ type: 'tab', tab: 'map' }, { type: 'replay' });
            break;
        }
      } catch (err) {
        out = `ошибка: ${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(`Джарвис → ${call.function.name}(${call.function.arguments}) — ${out}`);
      msgs.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  return { reply: 'Готово, сэр.', actions, llm: true };
}

export async function ask(point: Point, me: Me, text: string, selectedId: string | null, history: { role: 'user' | 'assistant'; content: string }[]): Promise<JarvisReply> {
  if (key()) {
    try {
      return await llm(point, me, text, selectedId, history);
    } catch (err) {
      console.error('Джарвис: модель недоступна, отвечаю по правилам —', err instanceof Error ? err.message : err);
    }
  }
  return rules(point, me, text, selectedId);
}
