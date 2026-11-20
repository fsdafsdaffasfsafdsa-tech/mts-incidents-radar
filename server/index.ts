// Сервер: API, поток SSE и фронтенд на одном порту.
// Разработка: Vite в middleware-режиме с HMR. Прод (--prod): раздаём собранный dist/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Incident, Insight, Intensity, ScenarioKind, ServerMessage, Snapshot, WorkMode } from '../shared/types.ts';
import { COORDINATORS_GROUP, GROUPS, PRODUCTS, REGION_BOUNDS } from './catalog.ts';
import { Sim } from './sim.ts';
import { heuristicInsight } from './ai-heuristic.ts';
import { aiStatus, handleLlmError, llmEnabled, refineWithClaude } from './ai-llm.ts';
import { Persister, getMeta, loadState, openDb, resetState, setMeta } from './db.ts';
import { currentUser, listAccounts, login, logout, seedUsers } from './auth.ts';
import { ItsmFile } from './itsm-file.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* .env необязателен */
}

const PROD = process.argv.includes('--prod');
const PORT = Number(process.env.PORT || 5190);
// Пароль демо-учёток задаётся в .env (см. .env.example); значение по умолчанию — только для локального запуска.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'radar-demo';
const ITSM_URL = process.env.ITSM_URL || null; // шаблон ссылки, {id} заменяется номером инцидента

// ─── база и состояние ──────────────────────────────────────────────────────

const db = openDb(path.resolve(root, process.env.DB_FILE || 'data/radar.db'));
if (process.argv.includes('--reset')) resetState(db);
const saved = loadState(db);
const savedShift = getMeta(db, 'shift');
const sim = new Sim();
sim.start(saved, saved && savedShift ? Number(savedShift) : undefined);
const persister = new Persister(db);
if (!saved) {
  persister.saveAll(sim.incidents.values(), sim.workers, sim.feed);
  setMeta(db, 'shift', String(sim.shift));
}
sim.onMessage((msg) => persister.track(msg));
seedUsers(db, sim.workers, DEMO_PASSWORD);

// Выгрузка ITSM: рабочая копия data/incidents.json, при первом запуске — из набора данных ТЗ.
const itsm = new ItsmFile(
  path.resolve(root, process.env.INCIDENTS_FILE || 'data/incidents.json'),
  path.join(root, 'data', 'character_problems.json'),
  (records, initial) => sim.ingest(records, initial),
);
itsm.start();

// ─── SSE ───────────────────────────────────────────────────────────────────

const clients = new Set<http.ServerResponse>();

function send(res: http.ServerResponse, msg: ServerMessage) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

sim.onMessage((msg) => {
  for (const res of clients) send(res, msg);
});

function snapshot(): Snapshot {
  return {
    serverTime: Date.now(),
    incidents: [...sim.incidents.values()],
    feed: sim.feed.slice(0, 120),
    systems: PRODUCTS.map(({ id, name, short, icon }) => ({ id, name, short, icon, dependsOn: [] })),
    teams: GROUPS.map(({ id, name, short }) => ({ id, name, short, members: [], isCoordinators: id === COORDINATORS_GROUP })),
    workers: sim.workers,
    offices: sim.offices,
    stats: sim.stats(),
    intensity: sim.intensity,
    ai: aiStatus(),
    config: { itsmUrl: ITSM_URL, bounds: REGION_BOUNDS, source: itsm.status.error ? `ошибка в ${itsm.status.file}: ${itsm.status.error}` : itsm.status.file },
  };
}

// ─── ИИ-разбор: эвристика сразу, Claude — в фоне с кэшем ───────────────────

const llmCache = new Map<string, { key: string; insight: Insight }>();
const inFlight = new Set<string>();
const llmQueue: string[] = [];
const MAX_PARALLEL = 2;

function versionKey(inc: Incident) {
  return [inc.priority, inc.status, inc.teamId, inc.parentId, inc.relatedIds.length, inc.trend].join('|');
}

function insightFor(inc: Incident): Insight {
  const base = heuristicInsight(inc, sim.ctx());
  const cached = llmCache.get(inc.id);
  if (cached && cached.key === versionKey(inc)) {
    // Свежие цифры риска и SLA — из эвристики, тексты — от Claude.
    return { ...cached.insight, risk: { ...cached.insight.risk, minutesToBreach: base.risk.minutesToBreach, factors: base.risk.factors }, correlation: base.correlation };
  }
  if (llmEnabled() && inc.status !== 'resolved') {
    enqueueLlm(inc.id);
    return { ...base, pendingLlm: true };
  }
  return base;
}

function enqueueLlm(id: string) {
  if (inFlight.has(id) || llmQueue.includes(id)) return;
  llmQueue.push(id);
  pumpLlm();
}

function pumpLlm() {
  while (inFlight.size < MAX_PARALLEL && llmQueue.length) {
    const id = llmQueue.shift()!;
    const inc = sim.incidents.get(id);
    if (!inc) continue;
    inFlight.add(id);
    const key = versionKey(inc);
    const base = heuristicInsight(inc, sim.ctx());
    const related = (base.correlation?.ids ?? []).map((r) => sim.incidents.get(r)).filter(Boolean) as Incident[];
    refineWithClaude(inc, base, related)
      .then((insight) => {
        llmCache.set(id, { key, insight });
        for (const res of clients) send(res, { type: 'insight', data: insight });
      })
      .catch((err) => {
        handleLlmError(err);
        for (const res of clients) send(res, { type: 'insight', data: { ...base, pendingLlm: false } });
      })
      .finally(() => {
        inFlight.delete(id);
        pumpLlm();
      });
  }
}

// Новые P1 разбираем через Claude сразу, не дожидаясь клика.
sim.onMessage((msg) => {
  if (msg.type === 'feed' && msg.data.kind === 'p1' && llmEnabled()) enqueueLlm(msg.data.incidentId);
});

// ─── HTTP ──────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
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

const INTENSITIES: Intensity[] = ['calm', 'normal', 'storm'];
const SCENARIOS: ScenarioKind[] = ['mass_outage', 'field_wave', 'coord_flood'];

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const p = url.pathname;
  try {
    // ─── вход ───
    if (p === '/api/health') return json(res, 200, { ok: true, incidents: sim.incidents.size, clients: clients.size, ai: aiStatus(), source: itsm.status });
    if (p === '/api/accounts' && req.method === 'GET') return json(res, 200, listAccounts(db));
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { me, cookie } = login(db, req, String(body.login ?? ''), String(body.password ?? ''));
        res.setHeader('Set-Cookie', cookie);
        return json(res, 200, me);
      } catch (err) {
        return json(res, 401, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', logout(db, req));
      return json(res, 200, { ok: true });
    }
    const me = currentUser(db, req);
    if (p === '/api/me') return me ? json(res, 200, me) : json(res, 401, { error: 'Нужно войти' });
    if (!me) return json(res, 401, { error: 'Нужно войти' });
    const coordinatorOnly = () => {
      if (me.role !== 'coordinator') throw new Forbidden('Только для координатора');
    };

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      send(res, { type: 'snapshot', data: snapshot() });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/snapshot') return json(res, 200, snapshot());

    let m = p.match(/^\/api\/incidents\/([\w-]+)\/insight$/);
    if (m && req.method === 'GET') {
      const inc = sim.incidents.get(m[1]);
      if (!inc) return json(res, 404, { error: 'Инцидент не найден' });
      return json(res, 200, insightFor(inc));
    }
    m = p.match(/^\/api\/incidents\/([\w-]+)\/action$/);
    if (m && req.method === 'POST') {
      coordinatorOnly();
      const body = await readBody(req);
      const inc = sim.act(m[1], String(body.type), { ...body, actor: me.name });
      return json(res, 200, inc);
    }
    m = p.match(/^\/api\/workers\/([\w.-]+)$/);
    if (m && req.method === 'POST') {
      // Сотрудник управляет только своим кабинетом.
      if (me.role !== 'coordinator' && me.workerId !== m[1]) throw new Forbidden('Это не ваш кабинет');
      const body = await readBody(req);
      return json(res, 200, sim.workerAct(m[1], body));
    }
    if (p === '/api/plan' && req.method === 'GET') {
      coordinatorOnly();
      const mode = url.searchParams.get('mode') === 'offline' ? 'offline' : ('online' satisfies WorkMode);
      return json(res, 200, sim.plan(mode));
    }
    if (p === '/api/bulk-assign' && req.method === 'POST') {
      coordinatorOnly();
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const n = sim.bulkAssign(items, me.name);
      return json(res, 200, { assigned: n });
    }
    if (p === '/api/events' && req.method === 'GET') {
      coordinatorOnly();
      const id = url.searchParams.get('incident');
      const rows = id
        ? db.prepare('SELECT at, kind, actor, text FROM events WHERE incident_id = ? ORDER BY at DESC LIMIT 100').all(id)
        : db.prepare('SELECT at, kind, incident_id, actor, text FROM events ORDER BY at DESC LIMIT 200').all();
      return json(res, 200, rows);
    }
    if (p.startsWith('/api/demo/')) coordinatorOnly();
    if (p === '/api/demo/intensity' && req.method === 'POST') {
      const body = await readBody(req);
      if (!INTENSITIES.includes(body.level)) return json(res, 400, { error: 'Неизвестный режим' });
      sim.setIntensity(body.level);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/demo/scenario' && req.method === 'POST') {
      const body = await readBody(req);
      if (!SCENARIOS.includes(body.kind)) return json(res, 400, { error: 'Неизвестный сценарий' });
      sim.scenario(body.kind);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Нет такого метода' });
  } catch (err) {
    return json(res, err instanceof Forbidden ? 403 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

class Forbidden extends Error {}

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

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
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
  void req;
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
  serveStatic(req, res, url);
});

if (!PROD) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  viteMiddlewares = vite.middlewares;
} else if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Нет собранного фронтенда: выполните npm run build');
  process.exit(1);
}

server.listen(PORT, () => {
  const ai = aiStatus();
  console.log(`\n  Радар инцидентов: http://localhost:${PORT}  (${PROD ? 'прод' : 'разработка'})`);
  console.log(`  ИИ: ${ai.mode === 'claude' ? `Claude (${ai.model})` : 'эвристика'} — ${ai.reason}\n`);
});

function shutdown() {
  sim.stop();
  itsm.stop();
  persister.close();
  db.close();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
