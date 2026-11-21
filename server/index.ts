// Сервер координирующего пункта: вход, API для четырёх кабинетов, поток SSE, фронтенд на одном порту.
// Разработка: Vite в middleware-режиме с HMR. Прод (--prod): раздаём собранный dist/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Me, PointMessage, PointSnapshot, Priority } from '../shared/types.ts';
import { Point } from './point.ts';
import { RULES } from './complaints.ts';
import { POINT_ID, POINT_STAFF, PEOPLE, TEAMS, SERVICES, isOn, membersOf, teamById } from './directory.ts';
import { REGIONS } from './regions.ts';
import { planPoint, routeTeams } from './ai-point.ts';
import { assessRisk, buildContext } from './ai-heuristic.ts';
import { aiStatus } from './ai-llm.ts';
import { Persister, getMeta, loadPoint, openDb, resetState, setMeta } from './db.ts';
import { currentUser, findAccounts, login, logout, seedUsers } from './auth.ts';
import { ItsmFile } from './itsm-file.ts';
import { actorLine, ask as askJarvis, brief as jarvisBrief, jarvisStatus, speak } from './jarvis.ts';
import { reviewFor, reviewList } from './review.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* .env необязателен */
}

const PROD = process.argv.includes('--prod');
const PORT = Number(process.env.PORT || 5190);
// Пароль демо-учёток задаётся в .env (см. .env.example). Смена значения и перезапуск меняют пароль всем.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || '1234';
const ITSM_URL = process.env.ITSM_URL || null;
const MODEL = 'point-1'; // версия модели данных: при смене состояние пересобирается

// ─── база и состояние ──────────────────────────────────────────────────────

const db = openDb(path.resolve(root, process.env.DB_FILE || 'data/radar.db'));
if (process.argv.includes('--reset') || getMeta(db, 'model') !== MODEL) resetState(db);
const saved = loadPoint(db);
const savedShift = getMeta(db, 'shift');
const point = new Point();
point.start(saved, saved && savedShift ? Number(savedShift) : undefined);
const persister = new Persister(db);
if (!saved) {
  persister.saveAll(point.incidents.values(), [], point.feed, point.complaints);
  setMeta(db, 'shift', String(point.shift));
  setMeta(db, 'model', MODEL);
}
point.onMessage((m) => persister.track(m));
seedUsers(
  db,
  PEOPLE.map((p) => ({ login: p.id, name: p.name, role: p.role, teamId: p.teamId })),
  DEMO_PASSWORD,
);

const itsm = new ItsmFile(
  path.resolve(root, process.env.INCIDENTS_FILE || 'data/incidents.json'),
  path.join(root, 'data', 'character_problems.json'),
  (records, initial) => point.ingest(records, initial),
);
itsm.start();

// ─── SSE ───────────────────────────────────────────────────────────────────

const clients = new Map<http.ServerResponse, Me>();
function send(res: http.ServerResponse, msg: PointMessage) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
point.onMessage((m) => {
  for (const res of clients.keys()) send(res, m);
});

function snapshot(me: Me): PointSnapshot {
  const people = new Map(point.activePeople(me.teamId).map((p) => [p.id, p]));
  if (me.teamId) for (const p of membersOf(me.teamId)) people.set(p.id, p);
  return {
    serverTime: Date.now(),
    incidents: [...point.incidents.values()],
    complaints: point.complaints.filter((c) => Date.now() - c.at < 60 * 60_000),
    clusters: point.clusters,
    regions: REGIONS,
    teams: TEAMS,
    staff: POINT_STAFF,
    people: [...people.values()].filter((p) => p.teamId !== POINT_ID),
    load: Object.fromEntries(point.load()),
    requests: [...point.requests.values()].filter((r) => r.status === 'pending' || Date.now() - r.at < 3 * 3_600_000),
    signals: [...point.signals.values()],
    feed: point.feed.slice(0, 120),
    stats: point.stats(),
    ai: aiStatus(),
    config: { itsmUrl: ITSM_URL, source: itsm.status.error ? `ошибка в ${itsm.status.file}: ${itsm.status.error}` : itsm.status.file, rules: RULES },
  };
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

class Forbidden extends Error {}
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const PRIOS: Priority[] = ['P1', 'P2', 'P3', 'P4'];

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const p = url.pathname;
  const post = req.method === 'POST';
  try {
    // ─── без входа: вход и поиск себя на экране входа ───
    if (p === '/api/health') return json(res, 200, { ok: true, incidents: point.incidents.size, complaints: point.complaints.length, teams: TEAMS.length, people: PEOPLE.length, clients: clients.size, source: itsm.status });
    if (p === '/api/accounts') {
      const role = str(url.searchParams.get('role')) as Me['role'];
      return json(res, 200, findAccounts(db, role, str(url.searchParams.get('q')), url.searchParams.get('team')));
    }
    if (p === '/api/login-people') {
      // Для экрана входа: имя, команда и график (без паролей), чтобы сразу видеть, кто сейчас на смене.
      const role = str(url.searchParams.get('role'));
      const team = url.searchParams.get('team');
      const q = str(url.searchParams.get('q')).toLowerCase().trim();
      const list = PEOPLE.filter((x) => x.role === role && (!team || x.teamId === team || x.teams?.includes(team)) && (!q || x.name.toLowerCase().includes(q) || x.id.includes(q))).slice(0, 60);
      return json(res, 200, list.map((x) => ({ ...x, teamName: teamById(x.teamId)?.name ?? '' })));
    }
    if (p === '/api/login-teams') {
      const q = str(url.searchParams.get('q')).toLowerCase().trim();
      const list = TEAMS.filter((t) => t.id !== POINT_ID && (!q || t.name.toLowerCase().includes(q))).slice(0, 30);
      return json(res, 200, list.map((t) => ({ id: t.id, name: t.name, schedule: t.schedule })));
    }
    if (p === '/api/login' && post) {
      const body = await readBody(req);
      try {
        const { me, cookie } = login(db, req, str(body.login), str(body.password));
        res.setHeader('Set-Cookie', cookie);
        return json(res, 200, me);
      } catch (err) {
        return json(res, 401, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (p === '/api/logout' && post) {
      res.setHeader('Set-Cookie', logout(db, req));
      return json(res, 200, { ok: true });
    }
    const me = currentUser(db, req);
    if (p === '/api/me') return me ? json(res, 200, me) : json(res, 401, { error: 'Нужно войти' });
    if (!me) return json(res, 401, { error: 'Нужно войти' });
    const atPoint = me.role === 'coordinator';
    const pointOnly = () => {
      if (!atPoint) throw new Forbidden('Только для координирующего пункта');
    };
    const actor = me.name;
    const pid = me.personId ?? me.login;

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      send(res, { type: 'snapshot', data: snapshot(me) });
      clients.set(res, me);
      point.setOnline(me.personId, 1);
      req.on('close', () => {
        clients.delete(res);
        point.setOnline(me.personId, -1);
      });
      return;
    }

    let m = p.match(/^\/api\/incidents\/([\w-]+)\/(route|complaints|level|p1|resolve|comment)$/);
    if (m) {
      const [, id, what] = m;
      const inc = point.incidents.get(id);
      if (!inc) return json(res, 404, { error: 'Инцидент не найден' });
      if (what === 'route' && !post) {
        const ctx = point.ctx();
        // Подсказка, кому из дежурных на смене подходит инцидент (специализация и загрузка). Решает человек.
        const coordinator = inc.status === 'coordinators' ? planPoint([inc], POINT_STAFF, point.owned(), ctx.now)[0] ?? null : null;
        return json(res, 200, { picks: routeTeams(inc, ctx, 6), risk: assessRisk(inc, buildContext(point.incidents, ctx.now)), coordinator });
      }
      if (what === 'complaints') return json(res, 200, point.complaints.filter((c) => c.incidentId === id).slice(-150));
      if (what === 'comment' && post) {
        const body = await readBody(req);
        return json(res, 200, point.comment(id, { name: me.name, personId: me.personId, side: atPoint ? 'point' : 'team', teamId: atPoint ? null : me.teamId }, str(body.text)));
      }
      pointOnly();
      const body = await readBody(req);
      if (what === 'route') return json(res, 200, point.route(id, str(body.teamId), actor));
      if (what === 'level') {
        const pr = str(body.priority) as Priority;
        if (!PRIOS.includes(pr)) throw new Error('Неизвестный уровень');
        return json(res, 200, point.setLevel(id, pr, actor, str(body.reason)));
      }
      if (what === 'p1') return json(res, 200, body.confirm ? point.setLevel(id, 'P1', actor, 'подтверждено дежурным по предложению ИИ') : point.dismissP1(id, actor));
      if (what === 'resolve') return json(res, 200, point.resolveAtPoint(id, actor));
    }

    // ─── Джарвис: голосовой помощник дежурного ───
    if (p === '/api/jarvis/status') return json(res, 200, jarvisStatus());
    if (p === '/api/jarvis' && post) {
      pointOnly();
      const body = await readBody(req);
      const history = Array.isArray(body.history) ? (body.history as { role: string; content: string }[]).filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') : [];
      return json(
        res,
        200,
        await askJarvis(point, me, {
          text: str(body.text).slice(0, 500),
          selectedId: str(body.selectedId) || null,
          focusId: str(body.focusId) || null,
          tab: str(body.tab) || null,
          mode: body.mode === 'control' ? 'control' : 'chat',
          short: body.short === true,
          history: history as { role: 'user' | 'assistant'; content: string }[],
        }),
      );
    }
    // ─── Разборы после решения ───
    if (p === '/api/reviews') {
      pointOnly();
      return json(res, 200, reviewList(point));
    }
    m = p.match(/^\/api\/reviews\/([\w-]+)$/);
    if (m) {
      pointOnly();
      return json(res, 200, await reviewFor(point, m[1], post)); // POST — написать заново
    }
    m = p.match(/^\/api\/jarvis\/brief\/([\w-]+)$/);
    if (m) {
      pointOnly();
      const text = jarvisBrief(point, m[1]);
      return text ? json(res, 200, { text }) : json(res, 404, { error: 'Инцидент не найден' });
    }
    if (p === '/api/jarvis/speak' && post) {
      const body = await readBody(req);
      let audio: Awaited<ReturnType<typeof speak>>;
      try {
        audio = await speak(str(body.text), str(body.voice));
      } catch (err) {
        console.error('Джарвис: голос не получился —', err instanceof Error ? err.message : err);
        return json(res, 502, { error: 'Голос сейчас недоступен' });
      }
      if (!audio) return void res.writeHead(204).end();
      res.writeHead(200, { 'Content-Type': audio.type, 'Content-Length': audio.buf.length, 'Cache-Control': 'no-store', 'X-Jarvis-Voice': audio.voice });
      return void res.end(audio.buf);
    }

    if (p === '/api/point/assign' && post) {
      pointOnly();
      const body = await readBody(req);
      const target = str(body.personId) || pid;
      return json(res, 200, point.assignCoordinator(str(body.incidentId), target, actor));
    }
    if (p === '/api/point/plan') {
      pointOnly();
      if (!post) return json(res, 200, point.planPoint());
      const body = await readBody(req);
      return json(res, 200, { assigned: point.applyPointPlan(Array.isArray(body.items) ? body.items : [], actor) });
    }
    m = p.match(/^\/api\/clusters\/(.+)\/create$/);
    if (m && post) {
      pointOnly();
      return json(res, 200, point.createFromCluster(decodeURIComponent(m[1]), actor));
    }
    m = p.match(/^\/api\/signals\/([\w-]+)\/(notify|close)$/);
    if (m && post) {
      pointOnly();
      return json(res, 200, m[2] === 'notify' ? point.notifyLead(m[1], actor) : point.closeSignal(m[1], actor));
    }
    m = p.match(/^\/api\/requests\/([\w-]+)$/);
    if (m && post) {
      pointOnly();
      const body = await readBody(req);
      return json(res, 200, point.resolveRequest(m[1], !!body.approve, actor, str(body.teamId) || undefined, str(body.comment) || undefined));
    }

    // ─── команда ───
    m = p.match(/^\/api\/team\/(take|assign|resolve|release|transfer|help|report)$/);
    if (m && post) {
      if (atPoint) throw new Forbidden('Это действие команды');
      const body = await readBody(req);
      const id = str(body.incidentId);
      switch (m[1]) {
        case 'take':
          return json(res, 200, point.take(id, pid));
        case 'assign':
          if (me.role !== 'lead') throw new Forbidden('Назначает руководитель команды');
          return json(res, 200, point.leadAssign(id, str(body.personId), actor));
        case 'resolve':
          return json(res, 200, point.resolveByTeam(id, pid, str(body.solution) || null));
        case 'release':
          return json(res, 200, point.release(id, pid));
        case 'transfer':
          return json(res, 200, point.requestTransfer(id, pid, str(body.toTeamId) || null, str(body.reason)));
        case 'help':
          return json(res, 200, point.help(id, pid, str(body.text) || 'Нужна помощь'));
        case 'report':
          return json(res, 200, point.report(pid, str(body.toTeamId), str(body.text)));
      }
    }
    if (p === '/api/me/away' && post) {
      const body = await readBody(req);
      return json(res, 200, point.setAway(pid, !!body.away));
    }
    m = p.match(/^\/api\/teams\/([\w-]+)$/);
    if (m) {
      const team = teamById(m[1]);
      if (!team) return json(res, 404, { error: 'Нет такой команды' });
      return json(res, 200, { team, members: membersOf(team.id) });
    }

    // ─── демо ───
    if (p === '/api/demo/outage' && post) {
      pointOnly();
      const body = await readBody(req);
      const service = SERVICES.find((s) => s.name === str(body.service))?.name;
      const regions = (Array.isArray(body.regionIds) ? body.regionIds : []).map(str).filter((r) => REGIONS.some((x) => x.id === r));
      if (!service || !regions.length) throw new Error('Укажите сервис и регион');
      return json(res, 200, point.outage(service, regions, Number(body.minutes) || 6, Number(body.perSec) || 0.5));
    }
    // Сценарий для жюри: сбой → ИИ собирает инцидент → тревога → ИИ-дежурный говорит с Джарвисом → команда решает → разбор.
    if (p === '/api/demo/scenario' && post) {
      pointOnly();
      const body = await readBody(req);
      const step = str(body.step);
      if (step === 'start') {
        point.stream.outages = point.stream.outages.filter((o) => !o.id.startsWith('JURY'));
        // Остатки прошлого показа закрываем, чтобы ИИ собрал новый инцидент с нуля.
        for (const i of point.incidents.values())
          if (i.origin === 'complaints' && i.status !== 'resolved' && i.service === 'Мобильный интернет' && (i.regionIds ?? []).some((r) => ['nsk', 'oms', 'tom'].includes(r))) {
            try {
              if (i.status === 'coordinators') point.resolveAtPoint(i.id, 'Сценарий для жюри');
              else if (i.teamId) point.resolveByTeam(i.id, i.assignee ?? membersOf(i.teamId)[0]?.id ?? '', 'Закрыт перед новым показом');
            } catch {
              /* не мешаем запуску */
            }
          }
        const o = point.outage('Мобильный интернет', ['nsk', 'oms', 'tom'], 8, 3);
        o.id = `JURY${o.id}`;
        return json(res, 200, { startedAt: o.start, service: o.service, regionIds: o.regionIds });
      }
      if (step === 'actor') return json(res, 200, { text: await actorLine(str(body.goal), str(body.last), str(body.fallback)) });
      const inc = point.incidents.get(str(body.id));
      const team = inc ? teamById(inc.teamId) : undefined;
      if (!inc || !team) throw new Error('Инцидент ещё не передан команде');
      const people = membersOf(team.id).filter((x) => x.role === 'engineer');
      const eng = people.find((x) => isOn(x, Date.now())) ?? people[0];
      if (step === 'team') {
        try {
          return json(res, 200, point.take(inc.id, eng.id));
        } catch {
          return json(res, 200, inc); // никого на смене — команда возьмёт сама позже, сценарий идёт дальше
        }
      }
      if (step === 'resolve') {
        point.stream.outages = point.stream.outages.filter((o) => !o.id.startsWith('JURY'));
        return json(res, 200, point.resolveByTeam(inc.id, inc.assignee ?? eng.id, 'Перезапустили узел пакетного ядра в Новосибирске, трафик восстановлен, жалобы прекратились'));
      }
      throw new Error('Неизвестный шаг');
    }
    if (p === '/api/demo/auto' && post) {
      pointOnly();
      const body = await readBody(req);
      point.stream.auto = !!body.on;
      return json(res, 200, { auto: point.stream.auto });
    }
    return json(res, 404, { error: 'Нет такого метода' });
  } catch (err) {
    return json(res, err instanceof Forbidden ? 403 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
};

function serveStatic(res: http.ServerResponse, url: URL) {
  const dist = path.join(root, 'dist');
  let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

let viteMiddlewares: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) | null = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  if (viteMiddlewares) {
    return viteMiddlewares(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  }
  serveStatic(res, url);
});

if (!PROD) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  viteMiddlewares = vite.middlewares;
} else if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Нет собранного фронтенда: выполните npm run build');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`\n  Координирующий пункт: http://localhost:${PORT}  (${PROD ? 'прод' : 'разработка'})`);
  console.log(`  Команд: ${TEAMS.length}, сотрудников: ${PEOPLE.length}\n`);
});

function shutdown() {
  point.stop();
  itsm.stop();
  persister.close();
  db.close();
  for (const res of clients.keys()) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
