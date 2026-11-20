// Генератор потока инцидентов и их жизненный цикл.
// Состояние живёт на сервере, клиенты получают снимок и поток изменений.
import {
  AT_RISK_MIN,
  PRIORITY_SLA_MIN,
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
  type Trend,
} from '../shared/types.ts';
import {
  CHANNELS,
  CITY,
  COORDINATORS_ID,
  CREW_TEAMS,
  DC_SITES,
  PARTNERS,
  REGIONS,
  REG_CODES,
  SYSTEMS,
  TEAMS,
  TEMPLATES,
  systemById,
  teamById,
  type Template,
} from './catalog.ts';
import { briefOf, buildContext, higher, relationOf } from './ai-heuristic.ts';

type Listener = (msg: ServerMessage) => void;

const rnd = Math.random;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const between = (a: number, b: number) => a + rnd() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pad = (n: number, w: number) => String(n).padStart(w, '0');

const INTENSITY: Record<Intensity, { spawnPerSec: number; speed: number; label: string }> = {
  calm: { spawnPerSec: 1 / 14, speed: 0.7, label: 'спокойно' },
  normal: { spawnPerSec: 1 / 7, speed: 1, label: 'норма' },
  storm: { spawnPerSec: 1 / 2.4, speed: 1.6, label: 'шторм' },
};

const TARGET_OPEN = 190;
const RESOLVED_TTL_MS = 3 * 60_000;

interface Hidden {
  truthTeam: string;
  template: string;
  warned: boolean;
  breached: boolean;
}

interface SpawnOpts {
  template?: Template;
  priority?: Priority;
  status?: Status;
  region?: string;
  createdAt?: number;
  users?: number;
  trend?: Trend;
  acknowledged?: boolean;
  seed?: boolean;
  quiet?: boolean;
  crew?: boolean; // сразу отправить бригаду
}

export class Sim {
  incidents = new Map<string, Incident>();
  feed: FeedEvent[] = [];
  intensity: Intensity = 'normal';
  private hidden = new Map<string, Hidden>();
  private listeners = new Set<Listener>();
  private seq = 48_210 + int(0, 600);
  private feedSeq = 1;
  private createdLog: number[] = [];
  private resolvedLog: { at: number; ttr: number }[] = [];
  private breachedLog: number[] = [];
  private series: Stats['series'] = [];
  private scheduled: { at: number; fn: () => void }[] = [];
  private lastBriefs = new Map<string, AiBrief>();
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  aiAccuracy: number | null = null;

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMessage) {
    for (const fn of this.listeners) fn(msg);
  }

  // ─── Запуск ──────────────────────────────────────────────────────────────

  start() {
    this.seedInitial();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private seedInitial() {
    const now = Date.now();
    for (let i = 0; i < 175; i++) {
      const template = this.pickTemplate();
      let priority = this.pickPriority(template, 0.12);
      const sla = PRIORITY_SLA_MIN[priority] * 60_000;
      // Доля прошедшего SLA: большинство свежие, немного на грани, единицы уже нарушены.
      const r = rnd();
      const f = r < 0.035 ? between(1.0, 1.12) : r < 0.12 ? between(0.85, 0.99) : Math.pow(rnd(), 1.3) * 0.85;
      const createdAt = now - f * sla;
      const s = rnd();
      const status: Status = s < 0.08 ? 'coordinators' : s < 0.3 ? 'assigned' : s < 0.95 ? 'in_progress' : priority <= 'P2' ? 'escalated' : 'in_progress';
      this.spawn({ template, priority, status, createdAt, seed: true, quiet: true, acknowledged: s >= 0.04 });
    }
    // История ленты за последние минуты, чтобы экран не был пустым.
    const recent = [...this.incidents.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 14).reverse();
    for (const inc of recent) this.pushFeed(feedKindForNew(inc), inc, newIncidentText(inc), undefined, inc.createdAt, true);
    this.feed.sort((a, b) => b.at - a.at);
    for (let i = 40; i > 0; i--) this.series.push({ at: now - i * 15_000, ...this.counts(now - i * 15_000, true) });
    // Журналы последнего часа, чтобы счётчики «за час» не стартовали с нуля.
    const perHour = INTENSITY[this.intensity].spawnPerSec * 3600;
    for (let i = 0; i < perHour; i++) {
      const at = now - rnd() * 3_600_000;
      this.createdLog.push(at);
      this.resolvedLog.push({ at: now - rnd() * 3_600_000, ttr: between(12, 180) * 60_000 });
    }
    for (let i = 0; i < 6; i++) this.breachedLog.push(now - rnd() * 3_600_000);
    this.recomputeBriefs(true);
  }

  // ─── Генерация инцидента ─────────────────────────────────────────────────

  /** Шаблон, которого сейчас нет среди открытых, чтобы очередь не пестрела одинаковыми заголовками. */
  private pickTemplate(): Template {
    const busy = new Map<string, number>();
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') continue;
      const tpl = this.hidden.get(inc.id)?.template;
      if (tpl) busy.set(tpl, (busy.get(tpl) ?? 0) + 1);
    }
    let best = pick(TEMPLATES);
    for (let i = 0; i < 8; i++) {
      const cand = pick(TEMPLATES);
      if ((busy.get(cand.title) ?? 0) < (busy.get(best.title) ?? 0)) best = cand;
      if (!busy.get(best.title)) break;
    }
    return best;
  }

  private pickPriority(t: Template, p1Keep: number): Priority {
    let p = rnd() < 0.7 || t.prio.length === 1 ? t.prio[0] : t.prio[1];
    if (p === 'P1' && rnd() > p1Keep) p = 'P2';
    if (p === 'P2' && rnd() > 0.36) p = 'P3';
    if (p === 'P3' && rnd() < 0.3) p = 'P4';
    return p;
  }

  spawn(opts: SpawnOpts = {}): Incident {
    const now = Date.now();
    const t = opts.template ?? this.pickTemplate();
    const priority = opts.priority ?? this.pickPriority(t, this.intensity === 'storm' ? 0.45 : 0.2);
    const region = opts.region ?? t.region ?? pickRegion();
    const vars = makeVars(region);
    const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars(k));
    const component = t.host ? fill(t.host) : t.service ?? '';
    vars.set('host', component);
    const createdAt = opts.createdAt ?? now;
    const slaMinutes = PRIORITY_SLA_MIN[priority];
    const users = opts.users ?? roundUsers(logUniform(t.users[0], t.users[1]));

    let status: Status = opts.status ?? (rnd() < 0.45 ? 'coordinators' : 'assigned');
    let teamId: string = COORDINATORS_ID;
    let assignee: string | null = null;
    if (status !== 'coordinators') {
      // Автомаршрутизация мониторинга ошибается примерно в каждом пятом случае.
      teamId = rnd() < 0.82 ? t.team : pick(systemById(t.system).owners.concat(TEAMS[int(1, TEAMS.length - 1)].id));
      if (status === 'in_progress' || status === 'escalated') assignee = pick(teamById(teamId)!.members);
    }
    const id = `INC-${this.seq++}`;
    const source: Source = t.source ?? 'monitoring';
    const trend: Trend = opts.trend ?? (rnd() < 0.3 ? 'growing' : rnd() < 0.72 ? 'stable' : 'declining');
    const inc: Incident = {
      id,
      title: fill(t.title),
      description: fill(t.description),
      priority,
      status,
      systemId: t.system,
      service: t.service ?? systemById(t.system).services[0],
      component,
      region,
      geo: placeIncident(t, region),
      path: null,
      crew: null,
      teamId,
      assignee,
      createdAt,
      updatedAt: createdAt,
      slaMinutes,
      slaDeadline: createdAt + slaMinutes * 60_000,
      affectedUsers: users,
      signals: t.signals.map(fill),
      source,
      trend,
      reassignCount: 0,
      relatedIds: [],
      parentId: null,
      acknowledged: opts.acknowledged ?? false,
      resolvedAt: null,
      history: [],
      ai: { risk: 0, level: 'low', teamId: null, confidence: 0 },
    };
    const srcText: Record<Source, string> = {
      monitoring: 'мониторинг',
      support: 'обращения абонентов',
      partner: 'партнёр',
      user: 'жалоба абонента',
    };
    inc.history.push({ at: createdAt, kind: 'system', text: `Создан, источник: ${srcText[source]}. ${inc.signals[0] ?? ''}`.trim() });
    if (status === 'coordinators') inc.history.push({ at: createdAt + 1000, kind: 'system', text: 'Назначен на группу координаторов: автоматическая маршрутизация не уверена' });
    else inc.history.push({ at: createdAt + 1000, kind: 'system', text: `Автомаршрутизация: команда «${teamById(teamId)!.short}»` });
    if (assignee) inc.history.push({ at: createdAt + int(2, 15) * 60_000 * (opts.seed ? 1 : 0), kind: 'team', text: `${assignee} взял(а) в работу`, actor: assignee });

    // Магистраль между двумя городами рисуем линией.
    const second = t.pathTo ?? (t.title.includes('{region2}') ? vars('region2') : null);
    if (second && CITY[second] && CITY[region]) inc.path = [[CITY[region].lon, CITY[region].lat], [CITY[second].lon, CITY[second].lat]];

    const remaining = inc.slaDeadline - now;
    this.hidden.set(id, {
      truthTeam: t.team,
      template: t.title,
      warned: remaining <= AT_RISK_MIN * 60_000,
      breached: remaining <= 0,
    });
    this.incidents.set(id, inc);
    if (opts.crew || ((status === 'in_progress' || status === 'escalated') && opts.seed)) {
      this.dispatchCrew(inc, opts.seed ? now - rnd() * 600_000 : now, opts.crew ? 1 : 0.5, true);
    }
    if (!opts.seed) this.createdLog.push(now);
    const ctx = buildContext(this.incidents, now);
    inc.ai = briefOf(inc, ctx);
    if (!opts.quiet) {
      // ИИ сразу связывает новый инцидент с соседями, если видит общую причину.
      this.autoRelate(inc);
      this.emit({ type: 'incident', data: inc });
      this.pushFeed(feedKindForNew(inc), inc, newIncidentText(inc));
    }
    return inc;
  }

  private autoRelate(inc: Incident) {
    const ctx = buildContext(this.incidents, Date.now());
    for (const other of this.incidents.values()) {
      if (other.id === inc.id || other.status === 'resolved') continue;
      if (relationOf(inc, other)) {
        if (!inc.relatedIds.includes(other.id)) inc.relatedIds.push(other.id);
        if (!other.relatedIds.includes(inc.id)) {
          other.relatedIds.push(inc.id);
          other.ai = briefOf(other, ctx);
          this.emit({ type: 'incident', data: other });
        }
      }
    }
  }

  // ─── Такт симуляции ──────────────────────────────────────────────────────

  private tick() {
    const now = Date.now();
    this.ticks++;
    const cfg = INTENSITY[this.intensity];

    for (const s of this.scheduled.filter((x) => x.at <= now)) s.fn();
    this.scheduled = this.scheduled.filter((x) => x.at > now);

    if (rnd() < cfg.spawnPerSec) this.spawn();
    if (this.intensity === 'storm' && rnd() < cfg.spawnPerSec / 3) this.spawn();

    const open = [...this.incidents.values()].filter((i) => i.status !== 'resolved');
    const balance = Math.pow(Math.min(2, Math.max(0.5, open.length / TARGET_OPEN)), 2);

    for (const inc of open) {
      const h = this.hidden.get(inc.id)!;
      const remaining = inc.slaDeadline - now;
      if (!h.warned && remaining <= AT_RISK_MIN * 60_000 && remaining > 0) {
        h.warned = true;
        if (inc.priority <= 'P2') this.pushFeed('sla_warning', inc, `До нарушения SLA ${Math.round(remaining / 60_000)} мин`);
      }
      if (!h.breached && remaining <= 0) {
        h.breached = true;
        this.breachedLog.push(now);
        inc.history.push({ at: now, kind: 'system', text: 'SLA нарушен' });
        this.touch(inc, now);
        this.pushFeed('sla_breach', inc, 'SLA нарушен');
      }

      if (inc.crew && !inc.crew.arrived && now >= inc.crew.dispatchedAt + inc.crew.etaMs) {
        inc.crew.arrived = true;
        inc.history.push({ at: now, kind: 'team', text: `${inc.crew.name} на месте` });
        this.touch(inc, now);
        if (inc.priority <= 'P3') this.pushFeed('crew', inc, `${inc.crew.name} на месте`);
      }

      const sp = cfg.speed;
      if (inc.status === 'coordinators') {
        // Коллеги-координаторы тоже разбирают очередь, но новые и непросмотренные оставляют вам.
        if (inc.acknowledged || now - inc.createdAt > 6 * 60_000) {
          if (rnd() < 0.004 * sp) this.assign(inc, h.truthTeam, pick(TEAMS[0].members.slice(1)), false);
        }
      } else if (inc.status === 'assigned') {
        if (rnd() < 0.012 * sp) {
          inc.status = 'in_progress';
          inc.assignee = pick(teamById(inc.teamId)!.members);
          inc.history.push({ at: now, kind: 'team', text: `${inc.assignee} взял(а) в работу`, actor: inc.assignee });
          this.dispatchCrew(inc, now, 0.7, false);
          this.touch(inc, now);
          if (inc.priority <= 'P2') this.pushFeed('in_progress', inc, `${inc.assignee} взял(а) в работу`, inc.assignee);
        }
      } else if (inc.status === 'in_progress' || inc.status === 'escalated') {
        const wrongTeam = inc.teamId !== h.truthTeam;
        if (wrongTeam && rnd() < 0.006 * sp) {
          const team = teamById(inc.teamId)!;
          inc.status = 'coordinators';
          inc.history.push({ at: now, kind: 'team', text: `«${team.short}» вернули инцидент: не их профиль`, actor: inc.assignee ?? team.short });
          inc.teamId = COORDINATORS_ID;
          inc.assignee = null;
          inc.crew = null;
          inc.reassignCount++;
          inc.acknowledged = false;
          this.touch(inc, now);
          this.pushFeed('coordinators', inc, `«${team.short}» вернули на координаторов: не их профиль`);
          continue;
        }
        const base: Record<Priority, number> = { P1: 0.0016, P2: 0.0016, P3: 0.0013, P4: 0.0011 };
        const p = base[inc.priority] * balance * sp * (inc.trend === 'declining' ? 1.6 : 1);
        if (rnd() < p) {
          this.resolve(inc, inc.assignee ?? undefined);
          continue;
        }
      }

      // Эскалация приоритета при ухудшении.
      const raiseAt = inc.priority === 'P2' ? 75 : 60;
      if (inc.trend === 'growing' && (inc.priority === 'P2' || inc.priority === 'P3') && inc.ai.risk >= raiseAt && rnd() < 0.0004 * sp) {
        this.raise(inc, 'Мониторинг', 'метрики продолжают ухудшаться');
      }
      // Тренд медленно меняется.
      if (rnd() < 0.003) {
        const next: Trend = rnd() < 0.35 ? 'growing' : rnd() < 0.6 ? 'stable' : 'declining';
        if (next !== inc.trend) {
          inc.trend = next;
          inc.history.push({
            at: now,
            kind: 'system',
            text: next === 'growing' ? 'Мониторинг: метрики ухудшаются' : next === 'declining' ? 'Мониторинг: метрики восстанавливаются' : 'Мониторинг: метрики стабилизировались',
          });
          this.touch(inc, now);
        }
      }
    }

    // Решённые убираем через несколько минут.
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved' && inc.resolvedAt && now - inc.resolvedAt > RESOLVED_TTL_MS) {
        this.incidents.delete(inc.id);
        this.hidden.delete(inc.id);
        this.lastBriefs.delete(inc.id);
        this.emit({ type: 'remove', data: { id: inc.id } });
      }
    }

    if (this.ticks % 10 === 0) this.recomputeBriefs(false);
    if (this.ticks % 15 === 0) {
      this.series.push({ at: now, ...this.counts(now) });
      if (this.series.length > 60) this.series.shift();
    }
    if (this.ticks % 5 === 0) this.emit({ type: 'stats', data: this.stats() });
    if (this.ticks % 15 === 0) this.emit({ type: 'tick', data: { serverTime: now } });
  }

  /** Отправляет выездную бригаду, если у команды есть выезды. Время в пути сжато для демо: 1,5–5 минут. */
  private dispatchCrew(inc: Incident, at: number, chance: number, silent: boolean) {
    const team = inc.teamId && CREW_TEAMS[inc.teamId] ? inc.teamId : this.hidden.get(inc.id)?.truthTeam;
    const label = team ? CREW_TEAMS[team] : undefined;
    if (!label || inc.crew || rnd() > chance) return;
    const km = between(3, 9);
    const angle = rnd() * Math.PI * 2;
    const from = {
      lat: inc.geo.lat + (km / 111) * Math.sin(angle),
      lon: inc.geo.lon + (km / (111 * Math.cos((inc.geo.lat * Math.PI) / 180))) * Math.cos(angle),
    };
    const etaMs = Math.round(between(90, 300) * 1000);
    inc.crew = { name: `${label} №${int(11, 98)}`, from, dispatchedAt: at, etaMs, arrived: Date.now() >= at + etaMs };
    inc.history.push({ at, kind: 'team', text: `Выехала ${inc.crew.name}, в пути ≈ ${Math.max(1, Math.round(etaMs / 60_000))} мин` });
    if (!silent && inc.priority <= 'P2') this.pushFeed('crew', inc, `Выехала ${inc.crew.name}`);
  }

  private touch(inc: Incident, now = Date.now()) {
    inc.updatedAt = now;
    inc.ai = briefOf(inc, buildContext(this.incidents, now));
    this.lastBriefs.set(inc.id, inc.ai);
    this.emit({ type: 'incident', data: inc });
  }

  private recomputeBriefs(initial: boolean) {
    const now = Date.now();
    const ctx = buildContext(this.incidents, now);
    const changed: Record<string, AiBrief> = {};
    let hits = 0;
    let total = 0;
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') continue;
      const b = briefOf(inc, ctx);
      const prev = this.lastBriefs.get(inc.id);
      inc.ai = b;
      if (!prev || Math.abs(prev.risk - b.risk) >= 2 || prev.teamId !== b.teamId || prev.level !== b.level) {
        changed[inc.id] = b;
        this.lastBriefs.set(inc.id, b);
      }
      total++;
      if (b.teamId === this.hidden.get(inc.id)?.truthTeam) hits++;
    }
    this.aiAccuracy = total ? hits / total : null;
    if (!initial && Object.keys(changed).length) this.emit({ type: 'brief', data: changed });
  }

  // ─── Лента ───────────────────────────────────────────────────────────────

  private pushFeed(kind: FeedKind, inc: Incident, text: string, actor?: string, at = Date.now(), silent = false) {
    const ev: FeedEvent = { id: `E${this.feedSeq++}`, at, kind, incidentId: inc.id, priority: inc.priority, systemId: inc.systemId, text, actor };
    this.feed.unshift(ev);
    if (this.feed.length > 300) this.feed.length = 300;
    if (!silent) this.emit({ type: 'feed', data: ev });
  }

  // ─── Действия координатора ───────────────────────────────────────────────

  private assign(inc: Incident, teamId: string, actor: string, byAi: boolean) {
    const team = teamById(teamId);
    if (!team) throw new Error('Неизвестная команда');
    const now = Date.now();
    const wasCoord = inc.status === 'coordinators';
    if (inc.teamId && inc.teamId !== COORDINATORS_ID && inc.teamId !== teamId) inc.reassignCount++;
    inc.teamId = teamId;
    inc.assignee = null;
    inc.status = team.isCoordinators ? 'coordinators' : 'assigned';
    inc.acknowledged = true;
    inc.history.push({
      at: now,
      kind: 'coordinator',
      actor,
      text: `${actor}: передан команде «${team.short}»${byAi ? ' по рекомендации ИИ' : ''}`,
    });
    this.touch(inc, now);
    this.pushFeed('assigned', inc, `${wasCoord ? 'Назначен' : 'Переназначен'} на «${team.short}»${byAi ? ' · по подсказке ИИ' : ''}`, actor);
  }

  private resolve(inc: Incident, actor?: string) {
    const now = Date.now();
    inc.status = 'resolved';
    inc.resolvedAt = now;
    inc.acknowledged = true;
    inc.history.push({ at: now, kind: actor ? 'team' : 'coordinator', actor, text: `${actor ?? 'Координатор'}: инцидент решён` });
    this.resolvedLog.push({ at: now, ttr: now - inc.createdAt });
    inc.updatedAt = now;
    this.emit({ type: 'incident', data: inc });
    this.pushFeed('resolved', inc, `Решён${actor ? ` · ${actor}` : ''}`, actor);
  }

  private raise(inc: Incident, actor: string, why: string) {
    if (inc.priority === 'P1') return;
    const now = Date.now();
    const from = inc.priority;
    inc.priority = higher(inc.priority);
    // SLA пересчитывается от момента создания по новому приоритету, но не раньше чем через 15 минут.
    inc.slaMinutes = PRIORITY_SLA_MIN[inc.priority];
    inc.slaDeadline = Math.max(inc.createdAt + inc.slaMinutes * 60_000, now + 15 * 60_000);
    const h = this.hidden.get(inc.id);
    if (h) {
      h.warned = inc.slaDeadline - now <= AT_RISK_MIN * 60_000;
      h.breached = false;
    }
    inc.acknowledged = false;
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: приоритет ${from} → ${inc.priority} (${why})` });
    this.touch(inc, now);
    this.pushFeed(inc.priority === 'P1' ? 'p1' : 'priority_up', inc, `Приоритет повышен: ${from} → ${inc.priority}`, actor);
  }

  act(id: string, type: string, body: { teamId?: string; parentId?: string; actor?: string; byAi?: boolean }) {
    const inc = this.incidents.get(id);
    if (!inc) throw new Error('Инцидент не найден');
    const actor = body.actor || 'Координатор';
    const now = Date.now();
    switch (type) {
      case 'ack':
        if (!inc.acknowledged) {
          inc.acknowledged = true;
          inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: взят на контроль` });
          this.touch(inc, now);
        }
        break;
      case 'assign':
        if (!body.teamId) throw new Error('Не указана команда');
        this.assign(inc, body.teamId, actor, !!body.byAi);
        break;
      case 'raise':
        this.raise(inc, actor, 'решение координатора');
        break;
      case 'escalate':
        inc.status = 'escalated';
        inc.acknowledged = true;
        inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: эскалирован руководителю смены` });
        this.touch(inc, now);
        this.pushFeed('escalated', inc, 'Эскалирован руководителю смены', actor);
        break;
      case 'resolve':
        if (inc.status !== 'resolved') this.resolve(inc, actor);
        break;
      case 'link': {
        const parent = body.parentId ? this.incidents.get(body.parentId) : undefined;
        if (!parent) throw new Error('Не найден родительский инцидент');
        inc.parentId = parent.id;
        if (!inc.relatedIds.includes(parent.id)) inc.relatedIds.push(parent.id);
        if (!parent.relatedIds.includes(inc.id)) parent.relatedIds.push(inc.id);
        inc.acknowledged = true;
        inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: связан с ${parent.id} как дочерний` });
        parent.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: добавлен дочерний ${inc.id}` });
        if (parent.teamId && parent.teamId !== COORDINATORS_ID && inc.status === 'coordinators') {
          inc.teamId = parent.teamId;
          inc.status = 'assigned';
          inc.history.push({ at: now, kind: 'system', text: `Передан команде первопричины «${teamById(parent.teamId)!.short}»` });
        }
        this.touch(parent, now);
        this.touch(inc, now);
        this.pushFeed('linked', inc, `Связан с ${parent.id} (${systemById(parent.systemId).short})`, actor);
        break;
      }
      default:
        throw new Error(`Неизвестное действие ${type}`);
    }
    return inc;
  }

  bulkAssign(items: { id: string; teamId: string }[], actor: string) {
    let n = 0;
    for (const it of items) {
      const inc = this.incidents.get(it.id);
      if (!inc || inc.status === 'resolved') continue;
      this.assign(inc, it.teamId, actor, true);
      n++;
    }
    return n;
  }

  setIntensity(level: Intensity) {
    this.intensity = level;
    this.emit({ type: 'intensity', data: level });
  }

  // ─── Сценарии для демо ───────────────────────────────────────────────────

  scenario(kind: ScenarioKind) {
    const now = Date.now();
    const at = (sec: number, fn: () => void) => this.scheduled.push({ at: now + sec * 1000, fn });
    const custom = (t: Partial<Template> & Pick<Template, 'system' | 'team' | 'title' | 'description' | 'signals'>): Template => ({
      prio: ['P2'],
      users: [10_000, 100_000],
      ...t,
    });
    switch (kind) {
      case 'billing_outage': {
        const region = 'Москва';
        this.spawn({
          template: custom({
            system: 'billing', team: 'billing_l2', service: 'Тарификация CDR', host: 'bill-rt-03',
            title: 'Тарификация остановлена: очередь CDR {k} тыс. и растёт',
            description: 'Сервис тарификации перестал обрабатывать записи о звонках и трафике после обновления справочника тарифов. Балансы абонентов не обновляются.',
            signals: ['Лаг консьюмера cdr-rating: 34 мин и растёт', 'Ошибки rating-engine: TariffNotFound ×12 тыс.'],
          }),
          priority: 'P1', status: 'coordinators', region, users: 2_400_000, trend: 'growing',
        });
        at(7, () => this.spawn({
          template: custom({
            system: 'app', team: 'billing_l2', service: 'Главный экран и баланс', host: 'api-balance',
            title: '«Мой МТС»: у абонентов не обновляется баланс',
            description: 'Баланс на главном экране не меняется после звонков и пополнений. API приложения отвечает штатно, но данные начислений из биллинга устаревшие.',
            signals: ['Обращения «неверный баланс» ×6 к норме', 'Возраст данных баланса: 40 мин'],
          }),
          priority: 'P2', status: 'coordinators', region, users: 900_000, trend: 'growing',
        }));
        at(14, () => this.spawn({
          template: custom({
            system: 'lk', team: 'billing_l2', service: 'Детализация', host: 'lk-api',
            title: 'ЛК: устаревший баланс и пустая детализация',
            description: 'В личном кабинете не отображаются списания за последний час, детализация пустая. Начисления из биллинга не приходят.',
            signals: ['Ошибки детализации 38%', 'Таймаут ответа биллинга'],
          }),
          priority: 'P2', status: 'coordinators', region, users: 350_000, trend: 'growing',
        }));
        at(21, () => this.spawn({
          template: custom({
            system: 'payments', team: 'billing_l2', service: 'Эквайринг', host: 'pay-acq-02',
            title: 'Пополнение баланса задерживается больше чем на 15 минут',
            description: 'Оплата у абонентов проходит, но баланс пополняется с большой задержкой: биллинг не подтверждает начисление, очередь подтверждений растёт.',
            signals: ['Ожидают подтверждения: 48 тыс. операций', 'Подтверждение от биллинга p95: 17 мин'],
          }),
          priority: 'P2', status: 'coordinators', region, users: 120_000, trend: 'growing',
        }));
        at(29, () => this.spawn({
          template: custom({
            system: 'crm', team: 'crm_team', service: 'IVR 0890', host: 'ivr-01',
            title: 'Контакт-центр: всплеск звонков «неверный баланс»',
            description: 'Очередь на линии выросла в четыре раза, абоненты жалуются на неверный баланс и блокировки. Нужен готовый ответ для операторов.',
            signals: ['Очередь звонков на линии ×4', 'Среднее ожидание 11 мин'],
          }),
          priority: 'P3', status: 'coordinators', region, users: 40_000, trend: 'growing',
        }));
        break;
      }
      case 'network_cut': {
        const region = 'Самара';
        this.spawn({
          template: custom({
            system: 'ran', team: 'transport', service: 'Транспорт до БС', host: 'dwdm-sam-02', pathTo: 'Тольятти',
            title: 'Обрыв магистральной ВОЛС Самара — Тольятти',
            description: 'Пропал оптический канал на магистрали после земляных работ. Трафик ушёл на резервное кольцо, его ёмкости не хватает.',
            signals: ['DWDM: LOS на линии Самара–Тольятти', 'Резервный канал загружен на 97%'],
          }),
          priority: 'P1', status: 'coordinators', region, users: 1_100_000, trend: 'growing', crew: true,
        });
        at(6, () => this.spawn({
          template: custom({
            system: 'ran', team: 'ran_ops', service: 'Базовые станции LTE', host: 'enb-sam-cluster',
            title: 'Авария БС: 38 секторов LTE недоступны (Самара)',
            description: 'Базовые станции потеряли связь с ядром: транспортный канал до площадок недоступен.',
            signals: ['eNodeB alarm: S1 link down ×38', 'Падение трафика в кластере на 41%'],
          }),
          priority: 'P2', status: 'coordinators', region, users: 260_000, trend: 'growing',
        }));
        at(13, () => this.spawn({
          template: custom({
            system: 'core', team: 'core_net', service: 'EPC / MME', host: 'mme-sam-01',
            title: 'MME: всплеск Attach Reject в Самаре',
            description: 'Абоненты массово переподключаются к сети, ядро не справляется с потоком регистраций.',
            signals: ['Attach Reject ×84 тыс.', 'Нагрузка MME 93%'],
          }),
          priority: 'P2', status: 'coordinators', region, users: 400_000, trend: 'growing',
        }));
        at(20, () => this.spawn({
          template: custom({
            system: 'home', team: 'fixed_net', service: 'GPON-доступ', host: 'olt-sam-114',
            title: 'OLT olt-sam-114: 3 тыс. абонентов GPON без связи',
            description: 'Оптический терминал потерял аплинк, абоненты домашнего интернета в нескольких домах без услуги.',
            signals: ['OLT uplink down', 'ONT offline ×3 тыс.'],
          }),
          priority: 'P3', status: 'coordinators', region, users: 3_000,
        }));
        break;
      }
      case 'ddos': {
        const region = 'Москва';
        this.spawn({
          template: custom({
            system: 'lk', team: 'soc', service: 'Авторизация', host: 'waf-edge',
            title: 'ЛК и «Мой МТС»: аномальный трафик, признаки DDoS',
            description: 'Резкий рост запросов к форме входа с десятков тысяч адресов. WAF не успевает фильтровать, легитимные входы отваливаются.',
            signals: ['RPS на /login ×40 к норме', 'WAF: 2,1 млн блокировок за 10 мин'],
          }),
          priority: 'P1', status: 'coordinators', region, users: 1_500_000, trend: 'growing',
        });
        at(8, () => this.spawn({
          template: custom({
            system: 'lk', team: 'platform_sre', service: 'Авторизация', host: 'lk-auth-pods',
            title: 'Личный кабинет: ошибки 502 у 30% входов',
            description: 'Поды авторизации и шлюз API не справляются с потоком запросов, легитимные пользователи получают 502.',
            signals: ['5xx на /login: 30%', 'Pod restarts: 46 за 10 мин'],
          }),
          priority: 'P2', status: 'coordinators', region, users: 800_000, trend: 'growing',
        }));
        break;
      }
      case 'coord_flood': {
        const pool = TEMPLATES.filter((t) => t.prio[0] !== 'P1');
        for (let i = 0; i < 6; i++) {
          at(i * 0.7, () => this.spawn({ template: pick(pool), status: 'coordinators', priority: pick(['P2', 'P3', 'P3', 'P4'] as Priority[]) }));
        }
        break;
      }
    }
  }

  // ─── Сводка ──────────────────────────────────────────────────────────────

  private counts(now: number, synthetic = false) {
    let open = 0;
    let critical = 0;
    let atRisk = 0;
    for (const i of this.incidents.values()) {
      if (i.status === 'resolved') continue;
      open++;
      if (i.priority <= 'P2') critical++;
      const r = i.slaDeadline - now;
      if (r > 0 && r <= AT_RISK_MIN * 60_000) atRisk++;
    }
    if (synthetic) {
      const wobble = () => 0.92 + rnd() * 0.12;
      return { open: Math.round(open * wobble()), critical: Math.round(critical * wobble()), atRisk: Math.max(0, Math.round(atRisk * wobble())) };
    }
    return { open, critical, atRisk };
  }

  stats(): Stats {
    const now = Date.now();
    const hour = now - 3_600_000;
    this.createdLog = this.createdLog.filter((t) => t > hour);
    this.resolvedLog = this.resolvedLog.filter((r) => r.at > hour);
    this.breachedLog = this.breachedLog.filter((t) => t > hour);
    const mttr = this.resolvedLog.length ? this.resolvedLog.reduce((a, r) => a + r.ttr, 0) / this.resolvedLog.length / 60_000 : null;
    const lastMin = this.createdLog.filter((t) => t > now - 5 * 60_000).length / 5;
    return {
      resolvedLastHour: this.resolvedLog.length,
      createdLastHour: this.createdLog.length,
      breachedLastHour: this.breachedLog.length,
      mttrMinutes: mttr === null ? null : Math.round(mttr),
      flowPerMin: Math.round(lastMin) || Math.round(INTENSITY[this.intensity].spawnPerSec * 60),
      aiAccuracy: this.aiAccuracy,
      series: this.series,
    };
  }

  truthOf(id: string): string | undefined {
    return this.hidden.get(id)?.truthTeam;
  }
}

// ─── Вспомогательное ───────────────────────────────────────────────────────

function feedKindForNew(inc: Incident): FeedKind {
  if (inc.priority === 'P1') return 'p1';
  if (inc.status === 'coordinators') return 'coordinators';
  return 'created';
}

function newIncidentText(inc: Incident): string {
  if (inc.status === 'coordinators') return 'Автомаршрутизация не уверена — решение за координатором';
  return `Автомаршрутизация → «${teamById(inc.teamId)?.short ?? '—'}»`;
}

function makeVars(region: string) {
  const memo = new Map<string, string>();
  const region2 = nearestCities(region)[int(0, 2)] ?? pick(REGIONS.filter((r) => r !== region));
  const gen: Record<string, () => string> = {
    region: () => region,
    region2: () => region2,
    reg: () => REG_CODES[region] ?? 'msk',
    n: () => String(int(3, 40)),
    n2: () => pad(int(1, 24), 2),
    n3: () => pad(int(1, 480), 3),
    pct: () => String(int(8, 45)),
    pct2: () => String(int(50, 80)),
    ms: () => String(int(9, 45) * 100),
    k: () => String(int(3, 250)),
    x: () => String(int(3, 12)),
    s: () => String(int(4, 15)),
    t: () => String(int(29, 36)),
    ver: () => `8.${int(2, 9)}.${int(0, 4)}`,
    cf: () => String(int(91, 97)),
    hash: () => Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0'),
    partner: () => pick(PARTNERS),
    channel: () => pick(CHANNELS),
  };
  const fn = (k: string) => {
    if (!memo.has(k)) memo.set(k, gen[k] ? gen[k]() : `{${k}}`);
    return memo.get(k)!;
  };
  fn.set = (k: string, v: string) => memo.set(k, v);
  return fn;
}

function logUniform(a: number, b: number): number {
  if (a <= 0 && b <= 0) return 0;
  const lo = Math.max(1, a);
  return Math.exp(between(Math.log(lo), Math.log(Math.max(lo + 1, b))));
}

function roundUsers(n: number): number {
  if (n <= 0) return 0;
  if (n < 1000) return Math.round(n / 10) * 10;
  if (n < 100_000) return Math.round(n / 100) * 100;
  return Math.round(n / 1000) * 1000;
}

function pickRegion(): string {
  const entries = REGIONS.map((r) => [r, CITY[r]?.weight ?? 1] as const);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = rnd() * total;
  for (const [r, w] of entries) {
    x -= w;
    if (x <= 0) return r;
  }
  return REGIONS[0];
}

function nearestCities(region: string): string[] {
  const c = CITY[region];
  if (!c) return [];
  return REGIONS.filter((r) => r !== region && CITY[r])
    .map((r) => [r, Math.hypot(CITY[r].lat - c.lat, (CITY[r].lon - c.lon) * Math.cos((c.lat * Math.PI) / 180))] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([r]) => r);
}

/** Нормальное распределение (Бокс — Мюллер), чтобы точки гуще к центру города. */
function gauss(): number {
  const u = Math.max(1e-9, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

function placeIncident(t: Template, region: string): { lat: number; lon: number } {
  const c = CITY[region] ?? CITY['Москва'];
  const site = t.system === 'dc' ? DC_SITES[region] : undefined;
  if (site) return { lat: site.lat + gauss() * 0.002, lon: site.lon + gauss() * 0.003 };
  const k = 1 / Math.cos((c.lat * Math.PI) / 180);
  const s = c.spread * 0.55;
  const clamp = (x: number) => Math.max(-2.2, Math.min(2.2, x));
  return { lat: c.lat + clamp(gauss()) * s, lon: c.lon + clamp(gauss()) * s * k };
}

export { SYSTEMS, TEAMS };
