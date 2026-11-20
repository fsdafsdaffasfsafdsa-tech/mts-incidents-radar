// Центр инцидентов на наборе данных МТС: 44 записи из data/character_problems.json (время сдвинуто к «сейчас»)
// плюс живой поток новых инцидентов по их образцу. Сотрудники берут задачи, выездные едут на место.
import {
  AT_RISK_MIN,
  PRIORITY_SLA_MIN,
  PRIORITY_TEXT,
  type AiBrief,
  type FeedEvent,
  type FeedKind,
  type Incident,
  type Intensity,
  type Priority,
  type ScenarioKind,
  type ServerMessage,
  type Source,
  type Stats,
  type Status,
  type Worker,
  type WorkMode,
} from '../shared/types.ts';
import {
  COORDINATORS_GROUP,
  DESCRIPTION_TEMPLATES,
  EMPLOYEES,
  FIELD_DESCRIPTION,
  GROUPS,
  HEADER_TEMPLATES,
  OFFICES,
  PRODUCTS,
  RAW,
  SHORT_TEMPLATES,
  SOLUTION_TEMPLATES,
  employeeById,
  employeeLogin,
  groupById,
  groupByName,
  groupForService,
  isOfflineRecord,
  officeById,
  priorityFromId,
  productByName,
  serviceName,
  type ProductDef,
  type RawIncident,
} from './catalog.ts';
import { briefOf, buildContext, recommendWorkers } from './ai-heuristic.ts';

type Listener = (msg: ServerMessage) => void;

const rnd = Math.random;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const between = (a: number, b: number) => a + rnd() * (b - a);
const MIN = 60_000;

function weighted<T extends string>(w: Record<T, number>): T {
  const entries = Object.entries(w) as [T, number][];
  let x = rnd() * entries.reduce((a, [, v]) => a + v, 0);
  for (const [k, v] of entries) {
    x -= v;
    if (x <= 0) return k;
  }
  return entries[0][0];
}

/** Детерминированный «случай» по строке — чтобы точка инцидента из данных не прыгала между перезапусками. */
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

const INTENSITY: Record<Intensity, number> = { calm: 1 / 45, normal: 1 / 22, storm: 1 / 7 };
const STREAM_RESOLVED_TTL = 30 * MIN;
const ACTOR_DISPATCH = 'Дежурный координатор';

interface Hidden {
  warned: boolean;
  breached: boolean;
  finishAt: number | null;
}

export class Sim {
  incidents = new Map<string, Incident>();
  workers: Worker[] = [];
  offices = OFFICES;
  feed: FeedEvent[] = [];
  intensity: Intensity = 'normal';
  private hidden = new Map<string, Hidden>();
  private manualUntil = new Map<string, number>();
  private breakUntil = new Map<string, number>();
  private listeners = new Set<Listener>();
  private seq = 21_942_000;
  private feedSeq = 1;
  private createdLog: number[] = [];
  private resolvedLog: { at: number; ttr: number }[] = [];
  private breachedLog: number[] = [];
  private series: Stats['series'] = [];
  private scheduled: { at: number; fn: () => void }[] = [];
  private lastBriefs = new Map<string, AiBrief>();
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMessage) {
    for (const fn of this.listeners) fn(msg);
  }

  start() {
    this.seed();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  ctx(now = Date.now()) {
    return buildContext(this.incidents, now, this.workers);
  }

  // ─── загрузка набора данных ──────────────────────────────────────────────

  private seed() {
    const now = Date.now();
    const parse = (s: string | null) => (s ? Date.parse(s) : NaN);
    const latest = Math.max(...RAW.map((r) => parse(r.submitDate)));
    // Сдвигаем время так, чтобы последняя запись была 5 минут назад: дедлайны тикают вживую.
    const shift = now - latest - 5 * MIN;
    this.workers = EMPLOYEES.map((e) => ({
      id: e.id,
      name: e.name,
      mode: e.mode,
      groups: e.groups,
      office: e.office,
      status: 'free',
      currentId: null,
      queue: [],
      focus: '',
      done: 0,
      manual: false,
    }));
    const maxId = Math.max(...RAW.map((r) => Number(r.id.replace(/\D/g, '')) || 0));
    if (maxId) this.seq = maxId + 1;

    for (const r of RAW) {
      const inc = this.fromRaw(r, shift);
      this.incidents.set(inc.id, inc);
      const remaining = inc.slaDeadline - now;
      this.hidden.set(inc.id, { warned: remaining <= AT_RISK_MIN * MIN, breached: remaining <= 0, finishAt: null });
    }
    // Связи мастер — дубль по одному сервису.
    for (const inc of this.incidents.values()) {
      if (!inc.isDouble && !inc.isReason) continue;
      const master = [...this.incidents.values()].find((m) => m.id !== inc.id && (m.isMaster || m.isEffect) && m.service === inc.service);
      if (master) {
        inc.parentId = master.id;
        master.relatedIds.push(inc.id);
        inc.relatedIds.push(master.id);
      }
    }
    // Состояние сотрудников из данных.
    for (const w of this.workers) {
      const mine = [...this.incidents.values()].filter((i) => i.assignee === w.id && i.status !== 'resolved');
      const current = mine.find((i) => i.status === 'in_progress');
      if (current) {
        w.currentId = current.id;
        w.status = w.mode === 'offline' ? 'onsite' : 'busy';
        this.hidden.get(current.id)!.finishAt = now + between(2, 8) * MIN;
      }
      w.queue = mine.filter((i) => i.id !== current?.id).sort((a, b) => a.slaDeadline - b.slaDeadline).map((i) => i.id);
      w.done = [...this.incidents.values()].filter((i) => i.assignee === w.id && i.status === 'resolved').length;
    }
    const recent = [...this.incidents.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).reverse();
    for (const inc of recent) this.pushFeed(inc.status === 'coordinators' ? 'coordinators' : 'created', inc, 'Зарегистрирован', undefined, inc.createdAt, true);
    this.feed.sort((a, b) => b.at - a.at);
    for (let i = 40; i > 0; i--) this.series.push({ at: now - i * 15_000, ...this.counts(now) });
    this.recomputeBriefs(true);
  }

  private fromRaw(r: RawIncident, shift: number): Incident {
    const created = Date.parse(r.submitDate) + shift;
    const priority = priorityFromId(r.priorityId);
    let deadline = r.deadline ? Date.parse(r.deadline) + shift : NaN;
    if (!(deadline > created)) deadline = created + PRIORITY_SLA_MIN[priority] * MIN; // в данных бывает дедлайн раньше регистрации
    const closed = r.stateId === 7 || r.stateId === 10;
    const group = groupByName(r.assignedGroupName);
    const login = employeeLogin(r.assignedEmployee);
    const emp = employeeById(login);
    const mode: WorkMode = isOfflineRecord(r) ? 'offline' : 'online';
    const status: Status = closed ? 'resolved' : r.stateId === 2 || r.stateId === 20 ? 'in_progress' : group?.id === COORDINATORS_GROUP ? 'coordinators' : 'assigned';
    const geo = this.placeFor(r.id, mode, emp?.office ?? (/Приморье/.test(r.assignedGroupName ?? '') ? 'vvo' : /Санкт-Петербург/.test(r.assignedGroupName ?? '') ? 'spb' : null));
    const resolvedAt = closed && r.completionDate ? Date.parse(r.completionDate) + shift : closed ? created + 60 * MIN : null;
    return this.make({
      id: r.id,
      title: r.header,
      description: r.description,
      shortDescription: r.shortDescription,
      solution: r.solution,
      mode,
      priority,
      priorityText: r.priority || PRIORITY_TEXT[priority],
      impact: r.impact,
      urgency: r.urgency,
      stateText: r.state,
      stateReason: r.stateReason,
      productName: r.productName,
      service: serviceName(r.service),
      component: r.scenarioName,
      serviceType: r.serviceType,
      channel: r.receivingChannel,
      groupId: group?.id ?? null,
      groupName: group?.name ?? '—',
      assignee: status === 'coordinators' ? null : login,
      createdAt: created,
      deadline,
      status,
      resolvedAt,
      geo,
      region: geo.city,
      flags: { isMaster: r.isMaster, isDouble: r.isDouble, isEffect: r.isEffect, isReason: r.isReason },
      origin: 'dataset',
    });
  }

  private placeFor(id: string, mode: WorkMode, officeId: string | null) {
    const office = officeById(officeId) ?? OFFICES[Math.floor(hash(id) * OFFICES.length)];
    if (mode === 'online') return { lat: office.lat, lon: office.lon, city: office.city };
    // Точное место в данных не указано: ставим точку в 5–45 км от офиса (условно, для демо).
    const km = 5 + hash(`${id}r`) * 40;
    const a = hash(`${id}a`) * Math.PI * 2;
    return {
      lat: office.lat + (km / 111) * Math.sin(a),
      lon: office.lon + (km / (111 * Math.cos((office.lat * Math.PI) / 180))) * Math.cos(a),
      city: office.city,
    };
  }

  private make(o: {
    id: string;
    title: string;
    description: string;
    shortDescription: string;
    solution: string | null;
    mode: WorkMode;
    priority: Priority;
    priorityText: string;
    impact: string;
    urgency: string;
    stateText: string;
    stateReason: string | null;
    productName: string;
    service: string;
    component: string;
    serviceType: string;
    channel: string;
    groupId: string | null;
    groupName: string;
    assignee: string | null;
    createdAt: number;
    deadline: number;
    status: Status;
    resolvedAt: number | null;
    geo: { lat: number; lon: number; city: string };
    region: string;
    flags: { isMaster: boolean; isDouble: boolean; isEffect: boolean; isReason: boolean };
    origin: 'dataset' | 'stream';
  }): Incident {
    const emp = employeeById(o.assignee);
    const product = productByName(o.productName);
    const source: Source = /монитор/i.test(o.channel) ? 'monitoring' : /жалоб/i.test(o.channel) ? 'user' : 'support';
    return {
      id: o.id,
      title: o.title,
      description: o.description,
      shortDescription: o.shortDescription,
      solution: o.solution,
      mode: o.mode,
      priority: o.priority,
      priorityText: o.priorityText,
      impact: o.impact,
      urgency: o.urgency,
      stateText: o.stateText,
      stateReason: o.stateReason,
      productName: o.productName,
      serviceType: o.serviceType,
      channel: o.channel,
      groupName: o.groupName,
      assigneeName: emp?.name ?? null,
      isMaster: o.flags.isMaster,
      isDouble: o.flags.isDouble,
      isEffect: o.flags.isEffect,
      isReason: o.flags.isReason,
      origin: o.origin,
      takenAt: null,
      startedAt: o.status === 'in_progress' ? o.createdAt : null,
      status: o.status,
      systemId: product?.id ?? 'p1',
      service: o.service,
      component: o.component,
      region: o.region,
      geo: { lat: o.geo.lat, lon: o.geo.lon },
      path: null,
      crew: null,
      teamId: o.groupId,
      assignee: o.assignee,
      createdAt: o.createdAt,
      updatedAt: o.createdAt,
      slaMinutes: Math.round((o.deadline - o.createdAt) / MIN),
      slaDeadline: o.deadline,
      affectedUsers: 0,
      signals: [o.shortDescription],
      source,
      trend: 'stable',
      reassignCount: 0,
      relatedIds: [],
      parentId: null,
      acknowledged: o.origin === 'dataset',
      resolvedAt: o.resolvedAt,
      history: [{ at: o.createdAt, kind: 'system', text: `Зарегистрирован: ${o.channel}` }],
      ai: { risk: 0, level: 'low', teamId: null, confidence: 0, workerId: null, workerConfidence: 0 },
    };
  }

  // ─── живой поток по образцу набора ───────────────────────────────────────

  spawn(opts: { mode?: WorkMode; product?: ProductDef; service?: string; priority?: Priority; master?: boolean; parentId?: string; quiet?: boolean } = {}): Incident {
    const now = Date.now();
    const p = opts.product ?? pick(PRODUCTS);
    const svc = p.services.find((s) => s.name === opts.service) ?? pick(p.services);
    const sc = pick(svc.scenarios);
    const mode: WorkMode = opts.mode ?? (rnd() < 0.3 ? 'offline' : 'online');
    const priority: Priority = opts.priority ?? weighted<Priority>({ P1: 0.03, P2: 0.12, P3: 0.5, P4: 0.35 });
    const fill = (t: string) => t.replace(/\{s\}/g, sc).replace(/\{svc\}/g, svc.name).replace(/\{p\}/g, p.name);
    const officeId = mode === 'offline' ? weighted({ msk: 3, spb: 2, kzn: 1, ekb: 1, nsk: 1, vvo: 1 }) : null;
    const id = `INC0000${this.seq++}`;
    const geo = this.placeFor(id, mode, officeId);
    const fieldGroup = officeId === 'vvo' ? GROUPS.find((g) => /Приморье/.test(g.name)) : officeId === 'spb' ? GROUPS.find((g) => /Санкт-Петербург/.test(g.name)) : undefined;
    const groupId = (mode === 'offline' ? fieldGroup?.id : undefined) ?? groupForService(p.name, svc.name) ?? COORDINATORS_GROUP;
    const inc = this.make({
      id,
      title: fill(pick(HEADER_TEMPLATES)),
      description: fill(mode === 'offline' ? FIELD_DESCRIPTION : pick(DESCRIPTION_TEMPLATES)),
      shortDescription: fill(pick(SHORT_TEMPLATES)),
      solution: null,
      mode,
      priority,
      priorityText: PRIORITY_TEXT[priority],
      impact: priority === 'P1' ? 'Наивысшее' : priority === 'P2' ? 'Высокое' : 'Среднее',
      urgency: weighted({ Наивысшая: 0.55, Низкая: 0.27, Средняя: 0.12, Высокая: 0.06 }),
      stateText: 'Назначен',
      stateReason: null,
      productName: p.name,
      service: svc.name,
      component: sc,
      serviceType: weighted({ Технологический: 0.6, Пользовательский: 0.2, Клиентский: 0.2 }),
      channel: weighted({ 'Мониторинг 9го королевства': 1, 'Жалоба от народа': 1, 'Анонимное письмо': 1 }),
      groupId,
      groupName: groupById(groupId)?.name ?? '—',
      assignee: null,
      createdAt: now,
      deadline: now + PRIORITY_SLA_MIN[priority] * MIN,
      status: 'coordinators',
      resolvedAt: null,
      geo,
      region: geo.city,
      flags: { isMaster: !!opts.master, isDouble: !!opts.parentId, isEffect: !!opts.master, isReason: !!opts.parentId },
      origin: 'stream',
    });
    if (opts.parentId) {
      const parent = this.incidents.get(opts.parentId);
      if (parent) {
        inc.parentId = parent.id;
        inc.relatedIds.push(parent.id);
        parent.relatedIds.push(inc.id);
        this.emit({ type: 'incident', data: parent });
      }
    }
    this.incidents.set(id, inc);
    this.hidden.set(id, { warned: false, breached: false, finishAt: null });
    this.createdLog.push(now);
    inc.ai = briefOf(inc, this.ctx(now));
    if (!opts.quiet) {
      this.emit({ type: 'incident', data: inc });
      this.pushFeed(priority === 'P1' ? 'p1' : 'coordinators', inc, mode === 'offline' ? 'Новый, нужен выезд' : 'Новый, ждёт назначения');
    }
    return inc;
  }

  // ─── такт ────────────────────────────────────────────────────────────────

  private tick() {
    const now = Date.now();
    this.ticks++;
    for (const s of this.scheduled.filter((x) => x.at <= now)) s.fn();
    this.scheduled = this.scheduled.filter((x) => x.at > now);
    if (rnd() < INTENSITY[this.intensity]) this.spawn();

    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') continue;
      const h = this.hidden.get(inc.id)!;
      const remaining = inc.slaDeadline - now;
      if (!h.warned && remaining > 0 && remaining <= AT_RISK_MIN * MIN) {
        h.warned = true;
        if (inc.priority <= 'P2') this.pushFeed('sla_warning', inc, `До дедлайна ${Math.round(remaining / MIN)} мин`);
      }
      if (!h.breached && remaining <= 0) {
        h.breached = true;
        this.breachedLog.push(now);
        this.pushFeed('sla_breach', inc, 'Дедлайн прошёл');
      }
      // Коллеги-координаторы разбирают то, что вы не взяли за 3 минуты.
      if (inc.status === 'coordinators' && !inc.takenAt && now - inc.createdAt > 3 * MIN && rnd() < 0.02) {
        const best = recommendWorkers(inc, this.ctx(now))[0];
        if (best) this.assign(inc, best.workerId, ACTOR_DISPATCH);
      }
      // Бригада доехала.
      if (inc.crew && !inc.crew.arrived && now >= inc.crew.dispatchedAt + inc.crew.etaMs) {
        inc.crew.arrived = true;
        const w = this.workers.find((x) => x.id === inc.assignee);
        if (w && w.status === 'enroute') {
          w.status = 'onsite';
          this.emit({ type: 'worker', data: w });
        }
        inc.history.push({ at: now, kind: 'team', text: `${inc.assigneeName ?? 'Специалист'} на месте` });
        this.touch(inc, now);
        this.pushFeed('crew', inc, `${inc.assigneeName ?? 'Специалист'} на месте`);
      }
    }

    for (const w of this.workers) this.workerStep(w, now);

    // Решённые из потока через 30 минут уходят; записи из набора остаются.
    for (const inc of this.incidents.values()) {
      if (inc.origin === 'stream' && inc.status === 'resolved' && inc.resolvedAt && now - inc.resolvedAt > STREAM_RESOLVED_TTL) {
        this.incidents.delete(inc.id);
        this.hidden.delete(inc.id);
        this.emit({ type: 'remove', data: { id: inc.id } });
      }
    }
    if (this.ticks % 10 === 0) this.recomputeBriefs(false);
    if (this.ticks % 15 === 0) {
      this.series.push({ at: now, ...this.counts(now) });
      if (this.series.length > 60) this.series.shift();
      this.emit({ type: 'tick', data: { serverTime: now } });
    }
    if (this.ticks % 5 === 0) this.emit({ type: 'stats', data: this.stats() });
  }

  /** Сотрудник без человека за кабинетом работает сам: берёт задачу по своему порядку, едет, закрывает. */
  private workerStep(w: Worker, now: number) {
    if (w.manual && (this.manualUntil.get(w.id) ?? 0) > now) return;
    if (w.manual) {
      w.manual = false;
      this.emit({ type: 'worker', data: w });
    }
    if (w.status === 'break') {
      if (now >= (this.breakUntil.get(w.id) ?? 0)) this.setWorker(w, { status: 'free' });
      return;
    }
    if (w.currentId) {
      const inc = this.incidents.get(w.currentId);
      if (!inc || inc.status === 'resolved') {
        this.setWorker(w, { currentId: null, status: 'free' });
        return;
      }
      const h = this.hidden.get(inc.id);
      const arrived = inc.mode === 'online' || !inc.crew || inc.crew.arrived;
      if (arrived && h?.finishAt && now >= h.finishAt) this.finish(inc, w);
      return;
    }
    const mine = this.ordered(w).filter((i) => i.status === 'assigned');
    if (mine.length && rnd() < 0.08) this.startWork(mine[0], w, now);
    else if (!mine.length && rnd() < 0.0004) {
      this.breakUntil.set(w.id, now + between(2, 4) * MIN);
      this.setWorker(w, { status: 'break' });
    }
  }

  /** Задачи сотрудника в его личном порядке (кабинет), остальные — по дедлайну. */
  ordered(w: Worker): Incident[] {
    const mine = [...this.incidents.values()].filter((i) => i.assignee === w.id && i.status !== 'resolved');
    const pos = (id: string) => {
      const k = w.queue.indexOf(id);
      return k < 0 ? 1e6 : k;
    };
    return mine.sort((a, b) => pos(a.id) - pos(b.id) || a.slaDeadline - b.slaDeadline);
  }

  private startWork(inc: Incident, w: Worker, now: number) {
    inc.status = 'in_progress';
    inc.stateText = 'Выполняется';
    inc.startedAt = now;
    const h = this.hidden.get(inc.id)!;
    if (inc.mode === 'offline') {
      const office = officeById(w.office) ?? OFFICES[0];
      const etaMs = Math.round(between(60, 180) * 1000);
      inc.crew = { name: w.name, from: { lat: office.lat, lon: office.lon }, dispatchedAt: now, etaMs, arrived: false };
      h.finishAt = now + etaMs + between(60, 150) * 1000;
      inc.history.push({ at: now, kind: 'team', text: `${w.name} выехал(а), в пути ≈ ${Math.max(1, Math.round(etaMs / MIN))} мин` });
      this.setWorker(w, { currentId: inc.id, status: 'enroute' });
      this.pushFeed('crew', inc, `${w.name} выехал(а)`, w.name);
    } else {
      h.finishAt = now + between(90, 300) * 1000;
      inc.history.push({ at: now, kind: 'team', text: `${w.name} начал(а) работу`, actor: w.name });
      this.setWorker(w, { currentId: inc.id, status: 'busy' });
      if (inc.priority <= 'P2') this.pushFeed('in_progress', inc, `${w.name} в работе`, w.name);
    }
    this.touch(inc, now);
  }

  private finish(inc: Incident, w: Worker | undefined, actor?: string) {
    const now = Date.now();
    inc.status = 'resolved';
    inc.stateText = 'Завершен';
    inc.stateReason = 'Постоянное решение';
    inc.resolvedAt = now;
    inc.solution = inc.solution ?? pick(SOLUTION_TEMPLATES).replace(/\{s\}/g, inc.component);
    inc.history.push({ at: now, kind: 'team', text: `${actor ?? w?.name ?? 'Координатор'}: решено`, actor: actor ?? w?.name });
    this.resolvedLog.push({ at: now, ttr: now - inc.createdAt });
    inc.updatedAt = now;
    this.emit({ type: 'incident', data: inc });
    this.pushFeed('resolved', inc, `Решено${w ? ` · ${w.name}` : ''}`, actor ?? w?.name);
    if (w) {
      w.done++;
      w.queue = w.queue.filter((x) => x !== inc.id);
      this.setWorker(w, { currentId: w.currentId === inc.id ? null : w.currentId, status: w.currentId === inc.id ? 'free' : w.status });
    }
  }

  private setWorker(w: Worker, patch: Partial<Worker>) {
    Object.assign(w, patch);
    this.emit({ type: 'worker', data: w });
  }

  private touch(inc: Incident, now = Date.now()) {
    inc.updatedAt = now;
    inc.ai = briefOf(inc, this.ctx(now));
    this.lastBriefs.set(inc.id, inc.ai);
    this.emit({ type: 'incident', data: inc });
  }

  private recomputeBriefs(initial: boolean) {
    const ctx = this.ctx();
    const changed: Record<string, AiBrief> = {};
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') continue;
      const b = briefOf(inc, ctx);
      const prev = this.lastBriefs.get(inc.id);
      inc.ai = b;
      if (!prev || Math.abs(prev.risk - b.risk) >= 2 || prev.workerId !== b.workerId || prev.level !== b.level) {
        changed[inc.id] = b;
        this.lastBriefs.set(inc.id, b);
      }
    }
    if (!initial && Object.keys(changed).length) this.emit({ type: 'brief', data: changed });
  }

  private pushFeed(kind: FeedKind, inc: Incident, text: string, actor?: string, at = Date.now(), silent = false) {
    const ev: FeedEvent = { id: `E${this.feedSeq++}`, at, kind, incidentId: inc.id, priority: inc.priority, systemId: inc.systemId, text, actor };
    this.feed.unshift(ev);
    if (this.feed.length > 300) this.feed.length = 300;
    if (!silent) this.emit({ type: 'feed', data: ev });
  }

  // ─── действия координатора ───────────────────────────────────────────────

  private assign(inc: Incident, workerId: string, actor: string) {
    const w = this.workers.find((x) => x.id === workerId);
    if (!w) throw new Error('Нет такого сотрудника');
    const now = Date.now();
    const prev = this.workers.find((x) => x.id === inc.assignee);
    if (prev && prev.id !== w.id) {
      prev.queue = prev.queue.filter((x) => x !== inc.id);
      if (prev.currentId === inc.id) prev.currentId = null;
      this.emit({ type: 'worker', data: prev });
    }
    inc.assignee = w.id;
    inc.assigneeName = w.name;
    inc.status = 'assigned';
    inc.stateText = 'Назначен';
    inc.acknowledged = true;
    inc.crew = null;
    if (!inc.teamId || inc.teamId === COORDINATORS_GROUP) {
      inc.teamId = w.groups[0] ?? inc.teamId;
      inc.groupName = groupById(inc.teamId)?.name ?? inc.groupName;
    }
    if (!w.queue.includes(inc.id)) w.queue.push(inc.id);
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: назначен ${w.name}` });
    this.emit({ type: 'worker', data: w });
    this.touch(inc, now);
    this.pushFeed('assigned', inc, `Назначен: ${w.name}`, actor);
  }

  act(id: string, type: string, body: { workerId?: string; teamId?: string; parentId?: string; actor?: string }) {
    const inc = this.incidents.get(id);
    if (!inc) throw new Error('Инцидент не найден');
    const actor = body.actor || 'Координатор';
    const now = Date.now();
    switch (type) {
      case 'take':
      case 'ack':
        inc.acknowledged = true;
        inc.takenAt = now;
        inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: взял(а) на контроль` });
        this.touch(inc, now);
        break;
      case 'assign': {
        const workerId = body.workerId ?? inc.ai.workerId;
        if (!workerId) throw new Error('Не указан сотрудник');
        this.assign(inc, workerId, actor);
        break;
      }
      case 'resolve':
        if (inc.status !== 'resolved') this.finish(inc, this.workers.find((w) => w.id === inc.assignee), actor);
        break;
      case 'escalate':
        inc.status = 'escalated';
        inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: эскалирован` });
        this.touch(inc, now);
        this.pushFeed('escalated', inc, 'Эскалирован', actor);
        break;
      case 'link': {
        const parent = body.parentId ? this.incidents.get(body.parentId) : undefined;
        if (!parent) throw new Error('Не найден главный инцидент');
        inc.parentId = parent.id;
        inc.isDouble = true;
        if (!inc.relatedIds.includes(parent.id)) inc.relatedIds.push(parent.id);
        if (!parent.relatedIds.includes(inc.id)) parent.relatedIds.push(inc.id);
        this.touch(parent, now);
        this.touch(inc, now);
        this.pushFeed('linked', inc, `Связан с ${parent.id}`, actor);
        break;
      }
      default:
        throw new Error(`Неизвестное действие ${type}`);
    }
    return inc;
  }

  bulkAssign(items: { id: string; teamId?: string; workerId?: string }[], actor: string) {
    let n = 0;
    for (const it of items) {
      const inc = this.incidents.get(it.id);
      const workerId = it.workerId ?? inc?.ai.workerId;
      if (!inc || inc.status === 'resolved' || !workerId) continue;
      this.assign(inc, workerId, actor);
      n++;
    }
    return n;
  }

  // ─── кабинет сотрудника ──────────────────────────────────────────────────

  workerAct(workerId: string, body: { action: string; incidentId?: string; status?: string; focus?: string; queue?: string[] }) {
    const w = this.workers.find((x) => x.id === workerId);
    if (!w) throw new Error('Нет такого сотрудника');
    const now = Date.now();
    // Кабинет открыл человек: автопилот этого сотрудника отключается на 20 минут после последнего действия.
    this.manualUntil.set(w.id, now + 20 * MIN);
    w.manual = true;
    const inc = body.incidentId ? this.incidents.get(body.incidentId) : undefined;
    switch (body.action) {
      case 'claim':
        break;
      case 'start':
        if (!inc || inc.assignee !== w.id) throw new Error('Это не ваша задача');
        if (w.currentId && w.currentId !== inc.id) {
          const cur = this.incidents.get(w.currentId);
          if (cur && cur.status === 'in_progress') {
            cur.status = 'assigned';
            this.touch(cur, now);
          }
        }
        this.startWork(inc, w, now);
        break;
      case 'onsite':
        if (!inc?.crew) throw new Error('Нет выезда');
        inc.crew.arrived = true;
        this.setWorker(w, { status: 'onsite' });
        this.touch(inc, now);
        break;
      case 'done':
        if (!inc || inc.assignee !== w.id) throw new Error('Это не ваша задача');
        this.finish(inc, w);
        break;
      case 'release':
        if (!inc || inc.assignee !== w.id) throw new Error('Это не ваша задача');
        inc.assignee = null;
        inc.assigneeName = null;
        inc.status = 'coordinators';
        inc.crew = null;
        w.queue = w.queue.filter((x) => x !== inc.id);
        if (w.currentId === inc.id) w.currentId = null;
        this.touch(inc, now);
        this.pushFeed('coordinators', inc, `${w.name} вернул(а) координатору`, w.name);
        break;
      case 'status':
        if (body.status !== 'free' && body.status !== 'break') throw new Error('Статус: free или break');
        if (body.status === 'break') this.breakUntil.set(w.id, now + 60 * MIN);
        w.status = body.status === 'break' ? 'break' : w.currentId ? (w.mode === 'offline' ? 'onsite' : 'busy') : 'free';
        break;
      case 'focus':
        w.focus = String(body.focus ?? '').slice(0, 80);
        break;
      case 'queue': {
        const mine = new Set(this.ordered(w).map((i) => i.id));
        w.queue = (body.queue ?? []).filter((id) => mine.has(id));
        break;
      }
      default:
        throw new Error(`Неизвестное действие ${body.action}`);
    }
    this.emit({ type: 'worker', data: w });
    return w;
  }

  setIntensity(level: Intensity) {
    this.intensity = level;
    this.emit({ type: 'intensity', data: level });
  }

  // ─── сценарии для показа ─────────────────────────────────────────────────

  scenario(kind: ScenarioKind) {
    const now = Date.now();
    const at = (sec: number, fn: () => void) => this.scheduled.push({ at: now + sec * 1000, fn });
    switch (kind) {
      case 'mass_outage': {
        const p = pick(PRODUCTS);
        const svc = pick(p.services).name;
        const master = this.spawn({ product: p, service: svc, priority: 'P2', master: true, mode: 'online' });
        for (let i = 1; i <= 3; i++) at(i * 4, () => this.spawn({ product: p, service: svc, priority: 'P3', parentId: master.id, mode: 'online' }));
        break;
      }
      case 'field_wave':
        for (let i = 0; i < 4; i++) at(i * 2, () => this.spawn({ mode: 'offline', priority: i === 0 ? 'P2' : 'P3' }));
        break;
      case 'coord_flood':
        for (let i = 0; i < 6; i++) at(i * 0.7, () => this.spawn({ mode: 'online' }));
        break;
    }
  }

  // ─── сводка ──────────────────────────────────────────────────────────────

  private counts(now: number) {
    let open = 0;
    let critical = 0;
    let atRisk = 0;
    for (const i of this.incidents.values()) {
      if (i.status === 'resolved') continue;
      open++;
      if (i.priority <= 'P2') critical++;
      const r = i.slaDeadline - now;
      if (r > 0 && r <= AT_RISK_MIN * MIN) atRisk++;
    }
    return { open, critical, atRisk };
  }

  stats(): Stats {
    const now = Date.now();
    const hour = now - 3_600_000;
    this.createdLog = this.createdLog.filter((t) => t > hour);
    this.resolvedLog = this.resolvedLog.filter((r) => r.at > hour);
    this.breachedLog = this.breachedLog.filter((t) => t > hour);
    const mttr = this.resolvedLog.length ? this.resolvedLog.reduce((a, r) => a + r.ttr, 0) / this.resolvedLog.length / MIN : null;
    return {
      resolvedLastHour: this.resolvedLog.length,
      createdLastHour: this.createdLog.length,
      breachedLastHour: this.breachedLog.length,
      mttrMinutes: mttr === null ? null : Math.round(mttr),
      flowPerMin: Math.round(INTENSITY[this.intensity] * 60 * 10) / 10,
      aiAccuracy: null,
      series: this.series,
    };
  }
}
