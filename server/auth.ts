// Вход для трёх ролей: дежурный пункта, сотрудник команды, руководитель команды.
// Пароли — scrypt с солью, сессия — случайный токен в HttpOnly-cookie, в базе только его хэш.
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Me, Role } from '../shared/types.ts';
import { getMeta, setMeta, type Db } from './db.ts';

const COOKIE = 'radar_sid';
const SESSION_DAYS = 14;
const ROLES: Role[] = ['coordinator', 'engineer', 'lead'];

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

/** Таблица учётных записей под четыре роли. Старая схема (онлайн/выездной) пересоздаётся. */
export function ensureUsersTable(db: Db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string } | undefined;
  if (row && !row.sql.includes('commander')) db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      login      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('coordinator', 'commander', 'engineer', 'lead')),
      person_id  TEXT,
      team_id    TEXT,
      pass_hash  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_team ON users(team_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      login      TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

export interface AccountSeed {
  login: string;
  name: string;
  role: Role;
  teamId: string;
}

/** Учётные записи из справочника: новые добавляются, смена DEMO_PASSWORD меняет пароль всем. */
export function seedUsers(db: Db, accounts: AccountSeed[], password: string) {
  ensureUsersTable(db);
  const stored = getMeta(db, 'demo_password');
  const same = !!stored && verifyPassword(password, stored);
  const hash = same ? stored! : hashPassword(password);
  const ins = db.prepare(
    `INSERT INTO users(login, name, role, person_id, team_id, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(login) DO UPDATE SET name = excluded.name, role = excluded.role, team_id = excluded.team_id`,
  );
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const a of accounts) ins.run(a.login, a.name, a.role, a.login, a.teamId, hash, now);
    // Учётные записи, которых больше нет в справочнике (например, командиры смены), удаляем вместе с сессиями.
    db.exec('CREATE TEMP TABLE IF NOT EXISTS keep_logins(login TEXT PRIMARY KEY); DELETE FROM keep_logins;');
    const keep = db.prepare('INSERT OR IGNORE INTO keep_logins(login) VALUES (?)');
    for (const a of accounts) keep.run(a.login);
    db.exec('DELETE FROM sessions WHERE login NOT IN (SELECT login FROM keep_logins); DELETE FROM users WHERE login NOT IN (SELECT login FROM keep_logins);');
    if (!same) db.prepare('UPDATE users SET pass_hash = ?').run(hash);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (!same) setMeta(db, 'demo_password', hash);
}

/** Поиск для экрана входа: только логины, имена и команды, без паролей. */
export function findAccounts(db: Db, role: Role, q: string, teamId: string | null, limit = 40): Me[] {
  if (!ROLES.includes(role)) return [];
  const like = `%${q.trim().toLowerCase()}%`;
  const rows = (
    teamId
      ? db.prepare('SELECT login, name, role, person_id, team_id FROM users WHERE role = ? AND team_id = ? ORDER BY name LIMIT ?').all(role, teamId, limit)
      : db.prepare('SELECT login, name, role, person_id, team_id FROM users WHERE role = ? AND (lower(name) LIKE ? OR login LIKE ?) ORDER BY name LIMIT ?').all(role, like, like, limit)
  ) as { login: string; name: string; role: Role; person_id: string | null; team_id: string | null }[];
  return rows.map((r) => ({ login: r.login, name: r.name, role: r.role, personId: r.person_id, teamId: r.team_id }));
}

// Не больше 8 неудачных попыток за 5 минут с одного адреса.
const fails = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (fails.get(ip) ?? []).filter((t) => now - t < 5 * 60_000);
  fails.set(ip, list);
  return list.length >= 8;
}

type UserRow = { login: string; name: string; role: Role; person_id: string | null; team_id: string | null };
const toMe = (r: UserRow): Me => ({ login: r.login, name: r.name, role: r.role, personId: r.person_id, teamId: r.team_id });

export function login(db: Db, req: http.IncomingMessage, loginName: string, password: string): { me: Me; cookie: string } {
  const ip = req.socket.remoteAddress ?? '?';
  if (tooMany(ip)) throw new Error('Слишком много попыток, подождите пару минут');
  const row = db.prepare('SELECT login, name, role, person_id, team_id, pass_hash FROM users WHERE login = ?').get(loginName.trim()) as (UserRow & { pass_hash: string }) | undefined;
  if (!row || !verifyPassword(password, row.pass_hash)) {
    fails.get(ip)!.push(Date.now());
    throw new Error('Неверный логин или пароль');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, login, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), row.login, now, now + SESSION_DAYS * 86_400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { me: toMe(row), cookie: `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}` };
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
    .prepare('SELECT u.login, u.name, u.role, u.person_id, u.team_id FROM sessions s JOIN users u ON u.login = s.login WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha(token), Date.now()) as UserRow | undefined;
  return row ? toMe(row) : null;
}

export function logout(db: Db, req: http.IncomingMessage): string {
  const token = tokenOf(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
