// Вход: координатор, онлайн-сотрудник, выездной сотрудник.
// Пароли — scrypt с солью, сессия — случайный токен в HttpOnly-cookie, в базе только его хэш.
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Me, Role, Worker } from '../shared/types.ts';
import type { Db } from './db.ts';

const COOKIE = 'radar_sid';
const SESSION_DAYS = 14;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Первый запуск: координатор и по учётной записи на каждого сотрудника. Пароль — DEMO_PASSWORD из .env. */
export function seedUsers(db: Db, workers: Worker[], password: string) {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const ins = db.prepare('INSERT OR IGNORE INTO users(login, name, role, worker_id, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  if (count === 0) {
    const hash = hashPassword(password);
    ins.run('coord', 'Координатор смены', 'coordinator', null, hash, now);
    ins.run('coord2', 'Старший координатор', 'coordinator', null, hash, now);
    for (const w of workers) ins.run(w.id, w.name, w.mode, w.id, hash, now);
    return;
  }
  // Новые сотрудники из выгрузки получают учётную запись с тем же паролем, что у координатора по умолчанию.
  const known = new Set((db.prepare('SELECT worker_id FROM users WHERE worker_id IS NOT NULL').all() as { worker_id: string }[]).map((r) => r.worker_id));
  const fresh = workers.filter((w) => !known.has(w.id));
  if (fresh.length) {
    const hash = hashPassword(password);
    for (const w of fresh) ins.run(w.id, w.name, w.mode, w.id, hash, now);
  }
}

export interface Account extends Me {}

/** Список для экрана входа: только логины и имена, без паролей. */
export function listAccounts(db: Db): Account[] {
  return (db.prepare('SELECT login, name, role, worker_id FROM users ORDER BY role, name').all() as { login: string; name: string; role: Role; worker_id: string | null }[]).map(
    (r) => ({ login: r.login, name: r.name, role: r.role, workerId: r.worker_id }),
  );
}

// Не больше 8 неудачных попыток за 5 минут с одного адреса.
const fails = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (fails.get(ip) ?? []).filter((t) => now - t < 5 * 60_000);
  fails.set(ip, list);
  return list.length >= 8;
}

export function login(db: Db, req: http.IncomingMessage, loginName: string, password: string): { me: Me; cookie: string } {
  const ip = req.socket.remoteAddress ?? '?';
  if (tooMany(ip)) throw new Error('Слишком много попыток, подождите пару минут');
  const row = db.prepare('SELECT login, name, role, worker_id, pass_hash FROM users WHERE login = ?').get(loginName.trim()) as
    | { login: string; name: string; role: Role; worker_id: string | null; pass_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.pass_hash)) {
    fails.get(ip)!.push(Date.now());
    throw new Error('Неверный логин или пароль');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, login, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), row.login, now, now + SESSION_DAYS * 86_400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return {
    me: { login: row.login, name: row.name, role: row.role, workerId: row.worker_id },
    cookie: `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}`,
  };
}

function tokenOf(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}

export function currentUser(db: Db, req: http.IncomingMessage): Me | null {
  const token = tokenOf(req);
  if (!token) return null;
  const row = db
    .prepare('SELECT u.login, u.name, u.role, u.worker_id FROM sessions s JOIN users u ON u.login = s.login WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha(token), Date.now()) as { login: string; name: string; role: Role; worker_id: string | null } | undefined;
  return row ? { login: row.login, name: row.name, role: row.role, workerId: row.worker_id } : null;
}

export function logout(db: Db, req: http.IncomingMessage): string {
  const token = tokenOf(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
