// База данных SQLite (встроенный node:sqlite, без внешних зависимостей).
// Хранит учётные записи и сессии, состояние инцидентов и сотрудников (переживает перезапуск) и журнал действий.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FeedEvent, Incident, ServerMessage, Worker } from '../shared/types.ts';

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (
      login      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('coordinator', 'online', 'offline')),
      worker_id  TEXT,
      pass_hash  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      login      TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id         TEXT PRIMARY KEY,
      mode       TEXT NOT NULL,
      status     TEXT NOT NULL,
      priority   TEXT NOT NULL,
      assignee   TEXT,
      updated_at INTEGER NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status);
    CREATE TABLE IF NOT EXISTS workers (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      incident_id TEXT,
      actor       TEXT,
      text        TEXT NOT NULL,
      data        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_at ON events(at);
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export interface SavedState {
  incidents: Incident[];
  workers: Worker[];
  feed: FeedEvent[];
}

export function loadState(db: Db): SavedState | null {
  const incidents = (db.prepare('SELECT data FROM incidents').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Incident);
  if (!incidents.length) return null;
  const workers = (db.prepare('SELECT data FROM workers').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Worker);
  const feed = (db.prepare('SELECT data FROM events ORDER BY at DESC LIMIT 300').all() as { data: string }[]).map((r) => JSON.parse(r.data) as FeedEvent);
  return { incidents, workers, feed };
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Пишет изменения из потока событий пачками раз в 2 секунды, одной транзакцией. */
export class Persister {
  private incidents = new Map<string, Incident>();
  private removed = new Set<string>();
  private workers = new Map<string, Worker>();
  private events: FeedEvent[] = [];
  private timer: NodeJS.Timeout;

  constructor(private db: Db) {
    this.timer = setInterval(() => this.flush(), 2000);
  }

  track(msg: ServerMessage) {
    switch (msg.type) {
      case 'incident':
        this.removed.delete(msg.data.id);
        this.incidents.set(msg.data.id, msg.data);
        break;
      case 'remove':
        this.incidents.delete(msg.data.id);
        this.removed.add(msg.data.id);
        break;
      case 'worker':
        this.workers.set(msg.data.id, msg.data);
        break;
      case 'feed':
        this.events.push(msg.data);
        break;
    }
  }

  /** Полная запись состояния (первый запуск или сброс). */
  saveAll(incidents: Iterable<Incident>, workers: Worker[], feed: FeedEvent[]) {
    for (const i of incidents) this.incidents.set(i.id, i);
    for (const w of workers) this.workers.set(w.id, w);
    this.events.push(...[...feed].reverse());
    this.flush();
  }

  flush() {
    if (!this.incidents.size && !this.removed.size && !this.workers.size && !this.events.length) return;
    const putInc = this.db.prepare(
      `INSERT INTO incidents(id, mode, status, priority, assignee, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, status = excluded.status, priority = excluded.priority,
         assignee = excluded.assignee, updated_at = excluded.updated_at, data = excluded.data`,
    );
    const delInc = this.db.prepare('DELETE FROM incidents WHERE id = ?');
    const putWorker = this.db.prepare('INSERT INTO workers(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
    const putEvent = this.db.prepare('INSERT INTO events(at, kind, incident_id, actor, text, data) VALUES (?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const i of this.incidents.values()) putInc.run(i.id, i.mode, i.status, i.priority, i.assignee, i.updatedAt, JSON.stringify(i));
      for (const id of this.removed) delInc.run(id);
      for (const w of this.workers.values()) putWorker.run(w.id, JSON.stringify(w));
      for (const e of this.events) putEvent.run(e.at, e.kind, e.incidentId, e.actor ?? null, e.text, JSON.stringify(e));
      // Журнал храним 14 дней.
      this.db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - 14 * 86_400_000);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      console.error('Не удалось записать в базу:', err);
      return;
    }
    this.incidents.clear();
    this.removed.clear();
    this.workers.clear();
    this.events = [];
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}

/** Сброс игрового состояния (учётные записи остаются). */
export function resetState(db: Db) {
  db.exec('DELETE FROM incidents; DELETE FROM workers; DELETE FROM events; DELETE FROM meta;');
}
