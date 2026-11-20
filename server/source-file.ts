// Источник данных — JSON-выгрузка инцидентов в формате ITSM (см. data/incidents_attributes.json).
// Читаем файл, следим за изменениями, сравниваем с прошлым состоянием и рассылаем события в поток.
import fs from 'node:fs';
import path from 'node:path';
import {
  AT_RISK_MIN,
  type FeedEvent,
  type FeedKind,
  type HistoryItem,
  type Incident,
  type Priority,
  type ServerMessage,
  type SourceStatus,
  type Status,
  type SystemInfo,
  type TeamInfo,
  slaRunning,
} from '../shared/types.ts';
import { briefOf, buildContext } from './ai-heuristic.ts';

type Raw = Record<string, unknown>;

// ─── Разбор полей ──────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'да') return true;
    if (s === 'false' || s === 'нет') return false;
  }
  return null;
};

/** Даты приходят как ISO с «Z» или как «YYYY-MM-DD HH:MM:SS» (по описанию полей). «0001-01-01» — пусто. */
export function parseDate(v: unknown): number | null {
  const s = str(v);
  if (!s || s.startsWith('0001-')) return null;
  const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? Date.parse(s.replace(' ', 'T')) : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** priorityId: 4 — Наивысший … 1 — Низкий. Если id нет, берём текст. */
export function parsePriority(r: Raw): Priority {
  const id = num(r.priorityId);
  const byId: Record<number, Priority> = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' };
  if (id !== null && byId[id]) return byId[id];
  const t = (str(r.priority) ?? '').toLowerCase();
  if (t.startsWith('наивысш') || t.startsWith('критич')) return 'P1';
  if (t.startsWith('высок')) return 'P2';
  if (t.startsWith('средн')) return 'P3';
  return 'P4';
}

/** Статус берём по stateEnum и тексту: в описании полей id «Закрыт» и «Завершен» перепутаны относительно выгрузки. */
export function parseStatus(r: Raw): Status {
  const e = (str(r.stateEnum) ?? '').toLowerCase();
  const t = (str(r.state) ?? '').toLowerCase();
  if (e === 'research' || t.startsWith('исследован')) return 'research';
  if (e === 'resolved' || e === 'closed' || t.startsWith('заверш') || t.startsWith('закрыт')) return 'resolved';
  if (e === 'workinprogress' || t.startsWith('выполня')) return 'in_progress';
  if (e === 'assigned' || t.startsWith('назнач')) return 'assigned';
  const id = num(r.stateId);
  if (id === 20) return 'research';
  if (id === 7 || id === 10) return 'resolved';
  if (id === 2) return 'in_progress';
  return 'assigned';
}

export const isCoordinatorsGroup = (name: string | null | undefined) => !!name && /координатор/i.test(name);

export function teamShort(name: string): string {
  if (isCoordinatorsGroup(name)) return 'Координаторы';
  return name.replace(/^КЦ\s+(ИТ\s+)?/i, '') || name;
}

export const PRIO_TEXT: Record<Priority, string> = { P1: 'Наивысший', P2: 'Высокий', P3: 'Средний', P4: 'Низкий' };

// ─── Условная точка на карте ───────────────────────────────────────────────
// В выгрузке нет координат. Чтобы карта оставалась полезной как обзор, ставим продукт в «свой» город,
// а инциденты продукта — с небольшим разбросом вокруг. Точка стабильна: зависит только от продукта и id.

const CITIES: { name: string; lat: number; lon: number }[] = [
  { name: 'Москва', lat: 55.7558, lon: 37.6173 },
  { name: 'Санкт-Петербург', lat: 59.9343, lon: 30.3351 },
  { name: 'Екатеринбург', lat: 56.8389, lon: 60.6057 },
  { name: 'Новосибирск', lat: 55.0084, lon: 82.9357 },
  { name: 'Казань', lat: 55.7963, lon: 49.1088 },
  { name: 'Нижний Новгород', lat: 56.2965, lon: 43.9361 },
  { name: 'Самара', lat: 53.1959, lon: 50.1002 },
  { name: 'Ростов-на-Дону', lat: 47.2357, lon: 39.7015 },
  { name: 'Краснодар', lat: 45.0355, lon: 38.9753 },
  { name: 'Уфа', lat: 54.7388, lon: 55.9721 },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Продукты раскладываем по городам по порядку появления, чтобы два продукта не попали в один город. */
const productCity = new Map<string, number>();
export function placeOf(product: string, id: string) {
  if (!productCity.has(product)) productCity.set(product, productCity.size % CITIES.length);
  const c = CITIES[productCity.get(product)!];
  const h = hash(id);
  const ang = ((h % 3600) / 3600) * Math.PI * 2;
  const r = 0.05 + ((h >>> 12) % 1000) / 1000 * 0.22;
  return { region: c.name, geo: { lat: c.lat + r * Math.sin(ang) * 0.55, lon: c.lon + r * Math.cos(ang) } };
}

/** Запись выгрузки → инцидент дашборда. Без id запись пропускаем. */
export function mapRecord(r: Raw, acked = false): Incident | null {
  const id = str(r.id);
  if (!id) return null;
  const createdAt = parseDate(r.submitDate) ?? Date.now();
  const team = str(r.assignedGroupName);
  const product = str(r.productName) ?? 'Без продукта';
  const status = parseStatus(r);
  const resolvedAt = parseDate(r.completionDate);
  const updatedAt = Math.max(createdAt, parseDate(r.lastAssignmentToTeamDateTime) ?? 0, resolvedAt ?? 0);
  return {
    id,
    ...placeOf(product, id),
    crew: null,
    path: null,
    title: str(r.header) ?? str(r.shortDescription) ?? id,
    description: str(r.description) ?? '',
    shortDescription: str(r.shortDescription) ?? '',
    priority: parsePriority(r),
    status,
    state: str(r.state) ?? status,
    stateReason: str(r.stateReason),
    // У одного продукта в выгрузке встречаются разные productMasterId, поэтому группируем по названию.
    systemId: product,
    product,
    service: (str(r.service) ?? '').replace(/^\[[^\]]*\]\s*/, '') || '—',
    scenario: str(r.scenarioName) ?? '',
    teamId: team,
    onCoordinators: isCoordinatorsGroup(team),
    assignee: str(r.assignedEmployee),
    initiator: str(r.initiatorName),
    channel: str(r.receivingChannel),
    serviceType: str(r.serviceType),
    urgency: str(r.urgency),
    impact: str(r.impact),
    urgencyId: num(r.urgencyId),
    impactId: num(r.impactId),
    createdAt,
    updatedAt,
    slaDeadline: parseDate(r.deadline),
    resolvedAt,
    isMaster: bool(r.isMaster) ?? false,
    isDouble: bool(r.isDouble) ?? false,
    isEffect: bool(r.isEffect) ?? false,
    isReason: bool(r.isReason) ?? false,
    isNeedUp: bool(r.isNeedUp),
    solution: str(r.solution),
    acknowledged: acked,
    history: initialHistory(r, createdAt, resolvedAt, status, team),
    ai: { risk: 0, level: 'low', teamId: null, confidence: 0 },
  };
}

function initialHistory(r: Raw, createdAt: number, resolvedAt: number | null, status: Status, team: string | null): HistoryItem[] {
  const h: HistoryItem[] = [];
  const channel = str(r.receivingChannel);
  h.push({ at: createdAt, text: `Зарегистрирован${channel ? ` · ${channel}` : ''}`, kind: 'system' });
  const assignedAt = parseDate(r.lastAssignmentToTeamDateTime);
  if (team) h.push({ at: assignedAt ?? createdAt, text: `Назначен на «${team}»`, kind: 'team' });
  if (resolvedAt) {
    const reason = str(r.stateReason);
    h.push({
      at: resolvedAt,
      text: status === 'research' ? 'Сбой устранён, начато исследование ситуации' : `Решён${reason && reason !== 'Нет' ? `: ${reason}` : ''}`,
      kind: 'team',
    });
  }
  return h.sort((a, b) => a.at - b.at);
}

// ─── Что изменилось ────────────────────────────────────────────────────────

const RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

export interface Change {
  kind: FeedKind;
  text: string;
}

/** События, которые координатор должен увидеть, когда запись в файле изменилась. */
export function diffIncident(prev: Incident | undefined, next: Incident): Change[] {
  const out: Change[] = [];
  if (!prev) {
    if (next.priority === 'P1' && next.status !== 'resolved') out.push({ kind: 'p1', text: `Новый критический: ${next.title}` });
    else out.push({ kind: 'created', text: `Новый · ${PRIO_TEXT[next.priority]} · ${next.product}` });
    if (next.onCoordinators && next.status !== 'resolved') out.push({ kind: 'coordinators', text: 'Назначен на координаторов' });
    return out;
  }
  if (RANK[next.priority] < RANK[prev.priority]) {
    out.push(
      next.priority === 'P1'
        ? { kind: 'p1', text: `Стал критическим: ${PRIO_TEXT[prev.priority]} → ${PRIO_TEXT[next.priority]}` }
        : { kind: 'priority_up', text: `Приоритет повышен: ${PRIO_TEXT[prev.priority]} → ${PRIO_TEXT[next.priority]}` },
    );
  }
  if (next.onCoordinators && !prev.onCoordinators && next.status !== 'resolved') out.push({ kind: 'coordinators', text: 'Назначен на координаторов' });
  else if (next.teamId !== prev.teamId && next.teamId) out.push({ kind: 'assigned', text: `Передан группе «${next.teamId}»` });
  if (next.status !== prev.status) {
    if (next.status === 'resolved') out.push({ kind: 'resolved', text: `${next.state}${next.stateReason && next.stateReason !== 'Нет' ? `: ${next.stateReason}` : ''}` });
    else if (next.status === 'research') out.push({ kind: 'research', text: 'Сбой устранён, идёт исследование ситуации' });
    else if (next.status === 'in_progress') out.push({ kind: 'in_progress', text: `В работе${next.assignee ? ` · ${next.assignee}` : ''}` });
    else out.push({ kind: 'assigned', text: `Статус: ${next.state}` });
  } else if (next.assignee !== prev.assignee && next.assignee) {
    out.push({ kind: 'in_progress', text: `Исполнитель: ${next.assignee}` });
  }
  return out;
}

/** События, после которых инцидент снова требует внимания координатора. */
const NEEDS_ATTENTION: FeedKind[] = ['p1', 'coordinators', 'priority_up'];

// ─── Источник ──────────────────────────────────────────────────────────────

export class FileSource {
  incidents = new Map<string, Incident>();
  feed: FeedEvent[] = [];
  systems: SystemInfo[] = [];
  teams: TeamInfo[] = [];
  status: SourceStatus;

  private rawText = new Map<string, string>();
  private lastText: string | null = null;
  private lastStat = '';
  private acked = new Set<string>();
  private slaNotified = new Map<string, 'warning' | 'breach'>();
  private listeners = new Set<(m: ServerMessage) => void>();
  private watcher: fs.FSWatcher | null = null;
  private timers: NodeJS.Timeout[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private seq = 1;

  constructor(
    readonly file: string,
    private readonly sample?: string,
  ) {
    this.status = { file: path.basename(file), loadedAt: null, count: 0, skipped: 0, error: null };
  }

  onMessage(cb: (m: ServerMessage) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(m: ServerMessage) {
    for (const l of this.listeners) l(m);
  }

  start() {
    if (!fs.existsSync(this.file) && this.sample && fs.existsSync(this.sample)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.copyFileSync(this.sample, this.file);
    }
    this.reload(true);
    try {
      // Следим за папкой: редакторы часто сохраняют файл через замену, и наблюдатель за самим файлом теряется.
      const base = path.basename(this.file);
      this.watcher = fs.watch(path.dirname(this.file), (_ev, name) => {
        if (!name || name.toString() === base) this.schedule();
      });
    } catch {
      /* останется опрос */
    }
    this.timers.push(setInterval(() => this.poll(), 1500));
    this.timers.push(setInterval(() => this.checkSla(), 15_000));
    this.timers.push(setInterval(() => this.refreshBriefs(), 60_000));
    this.timers.push(setInterval(() => this.emit({ type: 'tick', data: { serverTime: Date.now() } }), 30_000));
  }

  stop() {
    this.watcher?.close();
    for (const t of this.timers) clearInterval(t);
    if (this.debounce) clearTimeout(this.debounce);
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.reload(false), 250);
  }

  private poll() {
    try {
      const st = fs.statSync(this.file);
      const sig = `${st.mtimeMs}:${st.size}`;
      if (sig !== this.lastStat) this.schedule();
    } catch {
      if (!this.status.error) this.fail(`Файл ${this.status.file} не найден`);
    }
  }

  private fail(error: string) {
    this.status = { ...this.status, error };
    this.emit({ type: 'source', data: this.status });
    console.warn(`[data] ${error}`);
  }

  /** Перечитывает файл. При ошибке разбора держим последнее рабочее состояние. */
  reload(initial = false) {
    let text: string;
    try {
      const st = fs.statSync(this.file);
      this.lastStat = `${st.mtimeMs}:${st.size}`;
      text = fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '');
    } catch {
      return this.fail(`Файл ${this.status.file} не найден`);
    }
    if (!initial && text === this.lastText && !this.status.error) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return this.fail(`Ошибка в JSON: ${(err as Error).message}. Показаны данные последней удачной загрузки.`);
    }
    const list = Array.isArray(data) ? data : Array.isArray((data as Raw)?.incidents) ? ((data as Raw).incidents as unknown[]) : null;
    if (!list) return this.fail('В файле нет массива инцидентов. Показаны данные последней удачной загрузки.');
    this.lastText = text;
    this.apply(list.filter((x): x is Raw => !!x && typeof x === 'object'), initial, list.length);
  }

  /** Применяет новую выгрузку: считает разницу и рассылает изменения. */
  apply(records: Raw[], initial: boolean, total = records.length) {
    const now = Date.now();
    const seen = new Set<string>();
    const changed: Incident[] = [];
    const events: { inc: Incident; change: Change }[] = [];

    for (const r of records) {
      const id = str(r.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const json = JSON.stringify(r);
      const prev = this.incidents.get(id);
      if (prev && this.rawText.get(id) === json) continue;
      this.rawText.set(id, json);
      const next = mapRecord(r, this.acked.has(id));
      if (!next) continue;
      if (prev) next.history = prev.history;
      if (!initial) {
        for (const change of diffIncident(prev, next)) {
          events.push({ inc: next, change });
          next.history = [...next.history, { at: now, text: change.text, kind: change.kind === 'coordinators' ? 'coordinator' : 'team' }];
          if (NEEDS_ATTENTION.includes(change.kind)) {
            this.acked.delete(id);
            next.acknowledged = false;
          }
        }
        if (prev && next.slaDeadline !== prev.slaDeadline) this.slaNotified.delete(id);
      }
      this.incidents.set(id, next);
      changed.push(next);
    }

    const removed = [...this.incidents.keys()].filter((id) => !seen.has(id));
    for (const id of removed) {
      const inc = this.incidents.get(id)!;
      this.incidents.delete(id);
      this.rawText.delete(id);
      this.acked.delete(id);
      if (!initial) {
        this.emit({ type: 'remove', data: { id } });
        this.pushFeed({ inc, change: { kind: 'removed', text: 'Удалён из выгрузки' } }, now);
      }
    }

    // ИИ-оценки зависят от соседей, поэтому пересчитываем все.
    const briefs = this.recomputeBriefs(now);
    const catalogChanged = this.rebuildCatalog();
    this.status = { file: this.status.file, loadedAt: now, count: this.incidents.size, skipped: total - this.incidents.size, error: null };

    if (initial) {
      this.feed = this.historyFeed();
      for (const inc of this.incidents.values()) {
        // Уже нарушенные сроки не превращаем в поток уведомлений при старте.
        const st = this.slaState(inc, now);
        if (st) this.slaNotified.set(inc.id, st);
      }
      console.log(`[data] ${this.status.file}: ${this.incidents.size} инцидентов${this.status.skipped ? `, пропущено ${this.status.skipped}` : ''}`);
      return;
    }

    if (catalogChanged) this.emit({ type: 'catalog', data: { systems: this.systems, teams: this.teams } });
    const changedIds = new Set(changed.map((i) => i.id));
    for (const inc of changed) this.emit({ type: 'incident', data: this.incidents.get(inc.id)! });
    const otherBriefs = Object.fromEntries(Object.entries(briefs).filter(([id]) => !changedIds.has(id)));
    if (Object.keys(otherBriefs).length) this.emit({ type: 'brief', data: otherBriefs });
    for (const e of events) this.pushFeed(e, now);
    this.emit({ type: 'source', data: this.status });
    console.log(`[data] обновлено: изменено ${changed.length}, удалено ${removed.length}, событий ${events.length}`);
  }

  private pushFeed({ inc, change }: { inc: Incident; change: Change }, at: number) {
    const ev: FeedEvent = { id: `F${this.seq++}`, at, kind: change.kind, incidentId: inc.id, priority: inc.priority, systemId: inc.systemId, text: change.text };
    this.feed.unshift(ev);
    if (this.feed.length > 300) this.feed.length = 300;
    this.emit({ type: 'feed', data: ev });
  }

  /** Лента при старте — из дат выгрузки, чтобы экран не был пустым. */
  private historyFeed(): FeedEvent[] {
    const out: FeedEvent[] = [];
    for (const inc of this.incidents.values()) {
      const base = { incidentId: inc.id, priority: inc.priority, systemId: inc.systemId };
      out.push({ ...base, id: `F${this.seq++}`, at: inc.createdAt, kind: inc.priority === 'P1' ? 'p1' : inc.onCoordinators ? 'coordinators' : 'created', text: `Зарегистрирован · ${inc.teamId ?? 'без группы'}` });
      if (inc.resolvedAt)
        out.push({ ...base, id: `F${this.seq++}`, at: inc.resolvedAt, kind: inc.status === 'research' ? 'research' : 'resolved', text: inc.status === 'research' ? 'Сбой устранён, идёт исследование ситуации' : inc.state });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 200);
  }

  private recomputeBriefs(now: number): Record<string, Incident['ai']> {
    const ctx = buildContext(this.incidents, now);
    const changed: Record<string, Incident['ai']> = {};
    for (const inc of this.incidents.values()) {
      const b = briefOf(inc, ctx);
      if (b.risk !== inc.ai.risk || b.teamId !== inc.ai.teamId || Math.abs(b.confidence - inc.ai.confidence) > 0.01) {
        inc.ai = b;
        changed[inc.id] = b;
      }
    }
    return changed;
  }

  private refreshBriefs() {
    const changed = this.recomputeBriefs(Date.now());
    if (Object.keys(changed).length) this.emit({ type: 'brief', data: changed });
  }

  private rebuildCatalog(): boolean {
    const products = new Map<string, SystemInfo>();
    const groups = new Map<string, TeamInfo>();
    for (const inc of this.incidents.values()) {
      if (!products.has(inc.systemId)) products.set(inc.systemId, { id: inc.systemId, name: inc.product, short: inc.product });
      if (inc.teamId && !groups.has(inc.teamId))
        groups.set(inc.teamId, { id: inc.teamId, name: inc.teamId, short: teamShort(inc.teamId), isCoordinators: inc.onCoordinators || undefined });
    }
    const systems = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const teams = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const changed = JSON.stringify(systems) !== JSON.stringify(this.systems) || JSON.stringify(teams) !== JSON.stringify(this.teams);
    this.systems = systems;
    this.teams = teams;
    return changed;
  }

  private slaState(inc: Incident, now: number): 'warning' | 'breach' | null {
    if (!slaRunning(inc) || inc.slaDeadline === null) return null;
    const left = inc.slaDeadline - now;
    if (left <= 0) return 'breach';
    if (left <= AT_RISK_MIN * 60_000) return 'warning';
    return null;
  }

  /** Срок решения истекает или истёк прямо сейчас — это событие, хотя файл не менялся. */
  private checkSla() {
    const now = Date.now();
    for (const inc of this.incidents.values()) {
      const st = this.slaState(inc, now);
      const was = this.slaNotified.get(inc.id);
      if (!st || st === was || (was === 'breach' && st === 'warning')) continue;
      this.slaNotified.set(inc.id, st);
      this.pushFeed(
        { inc, change: st === 'breach' ? { kind: 'sla_breach', text: 'Срок решения истёк' } : { kind: 'sla_warning', text: `До дедлайна меньше ${AT_RISK_MIN} мин` } },
        now,
      );
    }
  }

  /** «Взять на контроль» — локальная отметка дашборда, в файл не пишется. */
  ack(id: string): Incident {
    const inc = this.incidents.get(id);
    if (!inc) throw new Error('Инцидент не найден');
    this.acked.add(id);
    const next = { ...inc, acknowledged: true, history: [...inc.history, { at: Date.now(), text: 'Взят на контроль координатором', kind: 'coordinator' as const }] };
    this.incidents.set(id, next);
    this.emit({ type: 'incident', data: next });
    return next;
  }
}
