// Сервер: API, поток SSE и фронтенд на одном порту.
// Данные — JSON-выгрузка инцидентов (data/incidents.json): сервер следит за файлом и рассылает изменения.
// Разработка: Vite в middleware-режиме с HMR. Прод (--prod): раздаём собранный dist/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Incident, Insight, ServerMessage, Snapshot } from '../shared/types.ts';
import { FileSource } from './source-file.ts';
import { buildContext, heuristicInsight, routableTeams } from './ai-heuristic.ts';
import { aiStatus, handleLlmError, llmEnabled, refineWithClaude } from './ai-llm.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* .env необязателен */
}

const PROD = process.argv.includes('--prod');
const PORT = Number(process.env.PORT || 5190);
const DATA_FILE = path.resolve(root, process.env.INCIDENTS_FILE || 'data/incidents.json');
const SAMPLE_FILE = path.join(root, 'data/incidents.sample.json');
const ITSM_URL = process.env.ITSM_URL?.trim() || null;

const source = new FileSource(DATA_FILE, SAMPLE_FILE);
source.start();

// ─── SSE ───────────────────────────────────────────────────────────────────

const clients = new Set<http.ServerResponse>();

function send(res: http.ServerResponse, msg: ServerMessage) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

source.onMessage((msg) => {
  for (const res of clients) send(res, msg);
});

function snapshot(): Snapshot {
  return {
    serverTime: Date.now(),
    incidents: [...source.incidents.values()],
    feed: source.feed.slice(0, 150),
    systems: source.systems,
    teams: source.teams,
    source: source.status,
    itsmUrl: ITSM_URL,
    ai: aiStatus(),
  };
}

// ─── ИИ-разбор: эвристика сразу, Claude — в фоне с кэшем ───────────────────

const llmCache = new Map<string, { key: string; insight: Insight }>();
const inFlight = new Set<string>();
const llmQueue: string[] = [];
const MAX_PARALLEL = 2;

function versionKey(inc: Incident) {
  return [inc.priority, inc.status, inc.teamId, inc.assignee, inc.slaDeadline, inc.isMaster, inc.isDouble, inc.isEffect, inc.isReason].join('|');
}

function insightFor(inc: Incident): Insight {
  const ctx = buildContext(source.incidents, Date.now());
  const base = heuristicInsight(inc, ctx);
  const cached = llmCache.get(inc.id);
  if (cached && cached.key === versionKey(inc)) {
    // Свежие цифры риска и сроков — из эвристики, тексты — от Claude.
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
    const inc = source.incidents.get(id);
    if (!inc) continue;
    inFlight.add(id);
    const key = versionKey(inc);
    const ctx = buildContext(source.incidents, Date.now());
    const base = heuristicInsight(inc, ctx);
    const related = (base.correlation?.ids ?? []).map((r) => source.incidents.get(r)).filter(Boolean) as Incident[];
    refineWithClaude(inc, base, related, routableTeams(ctx))
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

// Новые критические разбираем через Claude сразу, не дожидаясь клика.
source.onMessage((msg) => {
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

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const p = url.pathname;
  try {
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
    if (p === '/api/health') return json(res, 200, { ok: true, source: source.status, clients: clients.size, ai: aiStatus() });
    if (p === '/api/snapshot') return json(res, 200, snapshot());

    let m = p.match(/^\/api\/incidents\/([\w-]+)\/insight$/);
    if (m && req.method === 'GET') {
      const inc = source.incidents.get(m[1]);
      if (!inc) return json(res, 404, { error: 'Инцидент не найден' });
      return json(res, 200, insightFor(inc));
    }
    m = p.match(/^\/api\/incidents\/([\w-]+)\/ack$/);
    if (m && req.method === 'POST') {
      await readBody(req);
      return json(res, 200, source.ack(m[1]));
    }
    return json(res, 404, { error: 'Нет такого метода' });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
    // Рабочую копию выгрузки правят на демо — Vite не должен перезагружать из-за неё страницу.
    server: { middlewareMode: true, hmr: { server }, watch: { ignored: ['**/data/**'] } },
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
  console.log(`  Данные: ${path.relative(root, DATA_FILE)} — правки файла сразу попадают на дашборд`);
  console.log(`  ИИ: ${ai.mode === 'claude' ? `Claude (${ai.model})` : 'эвристика'} — ${ai.reason}\n`);
});

function shutdown() {
  source.stop();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
