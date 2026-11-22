// Координирующий пункт: жалобы → инциденты → дежурный пункта → команда → решение.
// Люди за экранами действуют сами; за тех, кто сейчас не в системе, работает автопилот (для демо).
import { PRIORITY_SLA_MIN, PRIORITY_TEXT, type Cluster, type Complaint, type FeedEvent, type FeedKind, type Incident, type MailItem, type Person, type PointMessage, type Priority, type Signal, type Stats, type Status, type TeamRequest } from '../shared/types.ts';
import { RAW, employeeLogin, groupByName, priorityFromId, productByName, serviceName, type RawIncident } from './catalog.ts';
import { ComplaintStream, RULES, findClusters, higher, isIncidentCluster, makeComplaint, nextAutoLevel, summarize, targetLevel, expected } from './complaints.ts';
import { POINT_ID, POINT_STAFF, isOn, itsmTeam, membersOf, onShift, personById, serviceDef, teamById, teamOnDuty } from './directory.ts';
import { TIMERS, checkTransfer, planPoint, routeTeams, stuckReason, type PointCtx, type PointPlanItem } from './ai-point.ts';
import { regionById } from './regions.ts';
import { RECUR_MIN } from '../shared/dash.ts';

type Listener = (m: PointMessage) => void;
const MIN = 60_000;
const rnd = Math.random;
const between = (a: number, b: number) => a + rnd() * (b - a);
const KEEP_COMPLAINTS = 2 * 60 * MIN;

interface Hidden {
  warned: boolean;
  breached: boolean;
  pointAt: number; // попал на пункт (для автораспределения ИИ)
  routeAt: number | null; // когда автопилот дежурного передаст команде
  acceptAt: number | null; // когда команда возьмёт
  finishAt: number | null;
  roll: 'ok' | 'stuck' | 'wrong' | 'help';
  rollDone: boolean;
  lastAutoLevel: number | null;
  leadAt: number | null;
  aiTop: string | null; // что советовал ИИ в момент передачи
}

export interface PointSaved {
  incidents: Incident[];
  complaints: Complaint[];
  requests: TeamRequest[];
  signals: Signal[];
  feed: FeedEvent[];
}

/** После решения ещё столько следим, не пошли ли жалобы снова. */
const RECUR_WINDOW = 40 * MIN;

export class Point {
  incidents = new Map<string, Incident>();
  complaints: Complaint[] = [];
  clusters: Cluster[] = [];
  requests = new Map<string, TeamRequest>();
  signals = new Map<string, Signal>();
  feed: FeedEvent[] = [];
  stream = new ComplaintStream();
  shift = 0;
  /** Режим показа: «коллеги» и команды сами ничего не делают — ситуации запускаются кнопками (server/show.ts). */
  show = false;
  private hidden = new Map<string, Hidden>();
  private online = new Map<string, number>();
  private listeners = new Set<Listener>();
  private buffer: Complaint[] = [];
  private dirty = new Set<string>();
  private baseline = new Map<string, string>();
  private seq = 31_000_000;
  private feedSeq = 1;
  private reqSeq = 1;
  private sigSeq = 1;
  private createdLog: number[] = [];
  private resolvedLog: { at: number; ttr: number }[] = [];
  private breachedLog: number[] = [];
  private series: Stats['series'] = [];
  private aiHits = { hit: 0, total: 0 };
  private ticks = 0;
  private timer: NodeJS.Timeout | null = null;

  onMessage(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(m: PointMessage) {
    for (const fn of this.listeners) fn(m);
  }

  // ─── кто сейчас в системе ────────────────────────────────────────────────

  setOnline(personId: string | null, delta: 1 | -1) {
    if (!personId) return;
    const n = (this.online.get(personId) ?? 0) + delta;
    if (n <= 0) this.online.delete(personId);
    else this.online.set(personId, n);
  }
  isOnline = (id: string | null | undefined) => !!id && this.online.has(id);

  load() {
    const m = new Map<string, number>();
    for (const i of this.incidents.values()) if (i.status !== 'resolved' && i.teamId && i.teamId !== POINT_ID) m.set(i.teamId, (m.get(i.teamId) ?? 0) + 1);
    return m;
  }
  ctx(now = Date.now()): PointCtx {
    return { now, load: this.load() };
  }
  /** Сколько инцидентов ведёт каждый дежурный пункта. */
  owned() {
    const m = new Map<string, number>();
    for (const i of this.incidents.values()) if (i.status !== 'resolved' && i.coordinatorId) m.set(i.coordinatorId, (m.get(i.coordinatorId) ?? 0) + 1);
    return m;
  }

  // ─── старт ───────────────────────────────────────────────────────────────

  start(saved?: PointSaved | null, shift?: number) {
    if (saved && shift !== undefined) this.restore(saved, shift);
    else this.seed();
    this.timer = setInterval(() => this.tick(), 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private seed() {
    const now = Date.now();
    const latest = Math.max(...RAW.map((r) => Date.parse(r.submitDate)));
    this.shift = now - latest - 5 * MIN;
    for (const r of RAW) {
      const inc = this.fromRaw(r, this.shift);
      // «Без движения» считаем с момента запуска, иначе все старые записи выгрузки сразу станут застрявшими.
      if (inc.status !== 'resolved') inc.updatedAt = now;
      this.incidents.set(inc.id, inc);
      this.hide(inc, now);
    }
    // Фон жалоб за последние 20 минут, чтобы карта не была пустой.
    for (let t = now - 20 * MIN; t < now; t += 1000) {
      for (const c of this.stream.tick(t)) this.complaints.push(c);
    }
    this.stream.outages = [];
    for (let i = 40; i > 0; i--) this.series.push({ at: now - i * 15_000, ...this.counts(now) });
  }

  private restore(saved: PointSaved, shift: number) {
    const now = Date.now();
    this.shift = shift;
    for (const inc of saved.incidents) {
      this.incidents.set(inc.id, inc);
      this.hide(inc, now);
    }
    this.complaints = saved.complaints.filter((c) => now - c.at < KEEP_COMPLAINTS).sort((a, b) => a.at - b.at);
    for (const r of saved.requests) this.requests.set(r.id, r);
    for (const s of saved.signals) this.signals.set(s.id, s);
    this.feed = saved.feed.sort((a, b) => b.at - a.at);
    const num = (s: string) => Number(s.replace(/\D/g, '')) || 0;
    this.feedSeq = Math.max(0, ...this.feed.map((f) => num(f.id))) + 1;
    this.reqSeq = Math.max(0, ...saved.requests.map((r) => num(r.id))) + 1;
    this.sigSeq = Math.max(0, ...saved.signals.map((s) => num(s.id))) + 1;
    const maxId = Math.max(0, ...[...this.incidents.values()].filter((i) => i.origin !== 'dataset').map((i) => num(i.id)));
    if (maxId >= this.seq) this.seq = maxId + 1;
    for (let i = 40; i > 0; i--) this.series.push({ at: now - i * 15_000, ...this.counts(now) });
  }

  private hide(inc: Incident, now: number) {
    const remaining = inc.slaDeadline - now;
    this.hidden.set(inc.id, {
      warned: remaining <= 30 * MIN,
      breached: remaining <= 0,
      pointAt: now,
      routeAt: null,
      acceptAt: inc.status === 'assigned' && !inc.assignee ? now + between(30, 120) * 1000 : null,
      finishAt: inc.status === 'in_progress' ? now + between(3, 10) * MIN : null,
      roll: 'ok',
      rollDone: true,
      lastAutoLevel: null,
      leadAt: null,
      aiTop: null,
    });
  }

  // ─── инцидент: конструктор ───────────────────────────────────────────────

  private blank(o: Partial<Incident> & Pick<Incident, 'id' | 'title' | 'priority' | 'status' | 'createdAt' | 'slaDeadline' | 'origin'>): Incident {
    const product = productByName(o.productName ?? '');
    return {
      description: '',
      shortDescription: '',
      solution: null,
      mode: 'online',
      priorityText: PRIORITY_TEXT[o.priority],
      impact: o.priority === 'P1' ? 'Наивысшее' : o.priority === 'P2' ? 'Высокое' : 'Среднее',
      urgency: 'Средняя',
      stateText: o.status === 'resolved' ? 'Завершен' : o.status === 'in_progress' ? 'Выполняется' : 'Назначен',
      stateReason: null,
      productName: '',
      serviceType: 'Клиентский',
      channel: 'Жалобы абонентов',
      groupName: 'Координирующий пункт',
      assigneeName: null,
      isMaster: false,
      isDouble: false,
      isEffect: false,
      isReason: false,
      takenAt: null,
      startedAt: null,
      systemId: product?.id ?? 'p1',
      service: '',
      component: '',
      region: '',
      geo: { lat: 0, lon: 0 },
      path: null,
      crew: null,
      teamId: POINT_ID,
      assignee: null,
      updatedAt: o.createdAt,
      slaMinutes: Math.round((o.slaDeadline - o.createdAt) / MIN),
      affectedUsers: 0,
      signals: [],
      source: 'user',
      trend: 'stable',
      reassignCount: 0,
      relatedIds: [],
      parentId: null,
      acknowledged: false,
      resolvedAt: null,
      history: [],
      ai: { risk: 0, level: 'low', teamId: null, confidence: 0, workerId: null, workerConfidence: 0 },
      coordinatorId: null,
      coordinatorName: null,
      regionId: null,
      regionIds: [],
      regionName: null,
      complaints: 0,
      complaintsSeries: [],
      levelLog: [],
      p1Proposal: null,
      leadNotifiedAt: null,
      ...o,
    };
  }

  /** Запись выгрузки ITSM → инцидент. Время сдвинуто к «сейчас», свежие записи — без сдвига. */
  private fromRaw(r: RawIncident, shift: number): Incident {
    const created = Date.parse(r.submitDate) + shift;
    const priority = priorityFromId(r.priorityId);
    let deadline = r.deadline ? Date.parse(r.deadline) + shift : NaN;
    if (!(deadline > created)) deadline = created + PRIORITY_SLA_MIN[priority] * MIN;
    const closed = r.stateId === 7 || r.stateId === 10 || /заверш|закрыт/i.test(r.state ?? '');
    const group = groupByName(r.assignedGroupName);
    const teamId = itsmTeam(group?.id) ?? POINT_ID;
    const login = employeeLogin(r.assignedEmployee);
    const person = personById(login);
    const working = r.stateId === 2 || r.stateId === 20;
    const status: Status = closed ? 'resolved' : teamId === POINT_ID ? 'coordinators' : working && person ? 'in_progress' : 'assigned';
    return this.blank({
      id: r.id,
      title: r.header,
      description: r.description,
      shortDescription: r.shortDescription,
      solution: r.solution,
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
      teamId,
      groupName: teamById(teamId)?.name ?? r.assignedGroupName ?? '—',
      assignee: status === 'in_progress' || status === 'assigned' ? (person ? login : null) : null,
      assigneeName: person?.name ?? null,
      createdAt: created,
      updatedAt: created,
      slaDeadline: deadline,
      status,
      startedAt: status === 'in_progress' ? created : null,
      resolvedAt: closed ? (r.completionDate ? Date.parse(r.completionDate) + shift : created + 60 * MIN) : null,
      isMaster: r.isMaster,
      isDouble: r.isDouble,
      isEffect: r.isEffect,
      isReason: r.isReason,
      acknowledged: true,
      origin: 'dataset',
      history: [{ at: created, kind: 'system', text: `Выгрузка ITSM: ${r.receivingChannel}` }],
    });
  }

  ingest(records: RawIncident[], initial: boolean) {
    const now = Date.now();
    for (const r of records) {
      const key = JSON.stringify(r);
      const was = this.baseline.get(r.id);
      this.baseline.set(r.id, key);
      if (initial || was === key) continue;
      const fresh = Math.abs(now - Date.parse(r.submitDate)) < 86_400_000;
      const next = this.fromRaw(r, fresh ? 0 : this.shift);
      const cur = this.incidents.get(r.id);
      if (!cur) {
        next.origin = 'stream';
        next.acknowledged = false;
        this.incidents.set(next.id, next);
        this.hide(next, now);
        this.createdLog.push(now);
        this.touch(next, now);
        this.pushFeed(next.priority === 'P1' ? 'p1' : next.status === 'coordinators' ? 'coordinators' : 'created', next, 'Из выгрузки ITSM');
        continue;
      }
      if (higher(next.priority, cur.priority)) this.pushFeed(next.priority === 'P1' ? 'p1' : 'priority_up', cur, `ITSM: приоритет «${next.priorityText}»`);
      cur.priority = next.priority;
      cur.priorityText = next.priorityText;
      cur.title = next.title;
      cur.slaDeadline = next.slaDeadline;
      cur.stateText = next.stateText;
      if (next.status === 'resolved' && cur.status !== 'resolved') this.finish(cur, 'ITSM');
      else if (next.status !== 'resolved') {
        // Переназначение в выгрузке: на координаторов или в другую команду — дашборд должен это увидеть сразу.
        if (next.teamId !== cur.teamId) {
          if (next.status === 'coordinators') {
            Object.assign(cur, { status: 'coordinators', teamId: POINT_ID, groupName: teamById(POINT_ID)!.name, assignee: null, assigneeName: null });
            cur.history.push({ at: now, kind: 'system', text: 'ITSM: назначен на координаторов' });
            this.pushFeed('coordinators', cur, 'ITSM: на координирующий пункт');
          } else {
            Object.assign(cur, { status: next.status, teamId: next.teamId, groupName: next.groupName, assignee: next.assignee, assigneeName: next.assigneeName, routedAt: now, startedAt: next.status === 'in_progress' ? now : null });
            cur.reassignCount = (cur.reassignCount ?? 0) + 1;
            cur.history.push({ at: now, kind: 'system', text: `ITSM: передано команде «${next.groupName}»` });
            this.pushFeed('routed', cur, `ITSM: передан команде «${next.groupName}»`);
          }
        } else if (next.status !== cur.status || next.assigneeName !== cur.assigneeName) {
          if (next.status === 'in_progress' && cur.status !== 'in_progress') cur.startedAt = now;
          Object.assign(cur, { status: next.status, assignee: next.assignee, assigneeName: next.assigneeName });
        }
      }
      cur.history.push({ at: now, kind: 'system', text: 'Изменения из выгрузки ITSM' });
      this.touch(cur, now);
    }
  }

  // ─── такт ────────────────────────────────────────────────────────────────

  private tick() {
    const now = Date.now();
    this.ticks++;
    for (const c of this.stream.tick(now)) this.addComplaint(c);
    if (this.buffer.length) {
      this.emit({ type: 'complaints', data: this.buffer });
      this.buffer = [];
    }
    if (this.ticks % 5 === 0) {
      this.clusters = findClusters(this.complaints, now);
      for (const c of this.clusters.filter(isIncidentCluster)) this.fromCluster(c, null);
      this.clusters = findClusters(this.complaints, now);
      this.emit({ type: 'clusters', data: this.clusters });
      this.escalate(now);
    }
    if (this.ticks % 10 === 0) {
      this.detectStuck(now);
      this.timers(now);
    }
    if (!this.show) this.autopilot(now);
    if (this.ticks % 3 === 0) this.autoRoute(now); // ИИ сам распределяет низкие и средние, пока горят критические
    this.sla(now);
    for (const id of this.dirty) {
      const inc = this.incidents.get(id);
      if (inc) this.emit({ type: 'incident', data: inc });
    }
    this.dirty.clear();
    if (this.ticks % 30 === 0) this.cleanup(now);
    if (this.ticks % 5 === 0) {
      this.emit({ type: 'load', data: Object.fromEntries(this.load()) });
      this.emit({ type: 'stats', data: this.stats() });
    }
    if (this.ticks % 15 === 0) {
      this.series.push({ at: now, ...this.counts(now) });
      if (this.series.length > 60) this.series.shift();
      this.emit({ type: 'tick', data: { serverTime: now } });
    }
  }

  private addComplaint(c: Complaint) {
    const inc = this.openFor(c.service, c.regionId);
    if (inc) {
      c.incidentId = inc.id;
      inc.complaints = (inc.complaints ?? 0) + 1;
      this.dirty.add(inc.id);
    } else {
      // Решённый недавно по тому же сервису и региону — жалобы после решения: проблема, похоже, не устранена.
      const done = this.resolvedFor(c.service, c.regionId, c.at);
      if (done) this.recurComplaint(done, c);
    }
    this.complaints.push(c);
    this.buffer.push(c);
  }

  private resolvedFor(service: string, regionId: string, at: number) {
    for (const i of this.incidents.values()) {
      if (i.origin === 'complaints' && i.status === 'resolved' && i.resolvedAt && at - i.resolvedAt < RECUR_WINDOW && i.service === service && (i.regionIds ?? []).includes(regionId)) return i;
    }
    return undefined;
  }

  /** Жалоба после решения. Сигнал — когда за 15 минут их набралось заметно больше фона (не меньше RECUR_MIN). */
  private recurComplaint(inc: Incident, c: Complaint) {
    c.incidentId = inc.id;
    inc.complaints = (inc.complaints ?? 0) + 1;
    const team = inc.teamId && inc.teamId !== POINT_ID ? teamById(inc.teamId)?.name ?? null : null;
    const resolvedBy = [...inc.history].reverse().find((h) => /: решено$/.test(h.text))?.actor ?? null;
    const r = inc.recur ?? { count: 0, since: c.at, lastAt: c.at, team, resolvedBy };
    const wasOn = r.count >= RECUR_MIN;
    const recent = this.complaints.filter((x) => x.incidentId === inc.id && x.at >= (inc.resolvedAt ?? 0) && c.at - x.at < 15 * MIN).length + 1;
    // фон — по всем регионам инцидента: у сбоя на восемь регионов и фоновых жалоб в восемь раз больше
    const bg = (inc.regionIds?.length ? inc.regionIds : [c.regionId]).reduce((a, r) => a + expected(inc.service, r, 15), 0);
    const need = Math.max(RECUR_MIN, Math.ceil(bg * 3));
    r.lastAt = c.at;
    r.count = wasOn ? r.count + 1 : recent >= need ? recent : Math.min(recent, RECUR_MIN - 1);
    inc.recur = r;
    if (!wasOn && r.count >= RECUR_MIN) {
      inc.history.push({ at: c.at, kind: 'ai', text: `ИИ: после решения снова жалобы — ${r.count} за ${Math.max(1, Math.round((c.at - r.since) / MIN))} мин. Похоже, проблема не устранена` });
      this.touch(inc, c.at);
      this.pushFeed('recur', inc, `Решён, но снова жалобы: ${r.count}`);
    } else this.dirty.add(inc.id);
  }

  /** Инцидент из письма — на пункт: уровень по срочности письма, описание — текст письма. */
  fromMail(mail: MailItem, actor: string) {
    const now = Date.now();
    const a = mail.analysis;
    const priority: Priority = a?.urgency === 'high' ? 'P2' : 'P3';
    const id = `INC0${this.seq++}`;
    const inc = this.blank({
      id,
      title: `Письмо: ${a?.summary || mail.subject}`.slice(0, 140),
      shortDescription: mail.subject.slice(0, 300),
      description: mail.body.slice(0, 1500),
      priority,
      status: 'coordinators',
      createdAt: now,
      slaDeadline: now + PRIORITY_SLA_MIN[priority] * MIN,
      origin: 'stream',
      channel: 'Почта',
      productName: a?.service ?? '',
      service: a?.service ?? 'Почта',
      history: [{ at: now, kind: 'coordinator', actor, text: `${actor}: создал инцидент из письма «${mail.subject.slice(0, 80)}» (${mail.fromName})` }],
    });
    this.incidents.set(id, inc);
    this.hide(inc, now);
    this.createdLog.push(now);
    this.touch(inc, now);
    this.pushFeed('coordinators', inc, `Из письма: ${mail.fromName}`, actor);
    return inc;
  }

  /** Вернуть решённый инцидент в работу: той же команде (или на пункт, если команды нет). */
  reopen(id: string, actor: string) {
    const inc = this.need(id);
    if (inc.status !== 'resolved') throw new Error('Инцидент ещё не решён');
    const now = Date.now();
    const n = inc.recur?.count ?? 0;
    const team = inc.teamId && inc.teamId !== POINT_ID ? teamById(inc.teamId) : undefined;
    const h = this.hidden.get(id);
    inc.resolvedAt = null;
    inc.stateReason = null;
    inc.recur = null;
    inc.slaDeadline = now + PRIORITY_SLA_MIN[inc.priority] * MIN;
    inc.assignee = null;
    inc.assigneeName = null;
    inc.startedAt = null;
    inc.escalation = 0;
    if (team) {
      inc.status = 'assigned';
      inc.stateText = 'Назначен';
      inc.routedAt = now;
      if (h) {
        h.acceptAt = teamOnDuty(team.id, now) ? now + between(30, 90) * 1000 : null;
        h.finishAt = null;
        h.roll = 'ok';
        h.rollDone = true;
      }
    } else {
      inc.status = 'coordinators';
      inc.stateText = 'Назначен';
      inc.teamId = POINT_ID;
      if (h) {
        h.pointAt = now;
        h.routeAt = null;
      }
    }
    if (h) {
      h.warned = false;
      h.breached = false;
    }
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: вернул в работу${team ? ` — команде «${team.name}»` : ' на пункт'}: после решения снова жалобы${n ? ` (${n})` : ''}` });
    this.touch(inc, now);
    this.pushFeed('reopened', inc, `Возвращён в работу: снова жалобы`, actor);
    return inc;
  }

  private openFor(service: string, regionId: string) {
    for (const i of this.incidents.values()) {
      if (i.origin === 'complaints' && i.status !== 'resolved' && i.service === service && (i.regionIds ?? []).includes(regionId)) return i;
    }
    return undefined;
  }

  /** Кластер жалоб → инцидент. Если по тому же сервису уже открыт инцидент (платформа или тот же округ) — расширяем его. */
  fromCluster(c: Cluster, actor: string | null) {
    const now = Date.now();
    const def = serviceDef(c.service);
    const region = regionById(c.regionId)!;
    const sibling = [...this.incidents.values()].find(
      (i) =>
        i.origin === 'complaints' &&
        i.status !== 'resolved' &&
        i.service === c.service &&
        now - i.createdAt < 60 * MIN &&
        (!def?.regional || (i.regionIds ?? []).some((r) => regionById(r)?.district === region.district)),
    );
    const linked = this.complaints.filter((x) => !x.incidentId && x.service === c.service && x.regionId === c.regionId && now - x.at < RULES.windowMin * MIN);
    if (sibling) {
      sibling.regionIds = [...new Set([...(sibling.regionIds ?? []), c.regionId])];
      sibling.regionName = sibling.regionIds.length > 1 ? `${sibling.regionIds.length} региона` : region.name;
      sibling.title = `Жалобы: ${c.service} · ${sibling.regionIds.map((r) => regionById(r)?.city).join(', ')}`;
      for (const x of linked) x.incidentId = sibling.id;
      sibling.complaints = (sibling.complaints ?? 0) + linked.length;
      sibling.history.push({ at: now, kind: 'ai', text: `ИИ: жалобы пошли и из региона «${region.name}» — объединено в этот инцидент` });
      this.touch(sibling, now);
      this.pushFeed('linked', sibling, `+ регион ${region.name}`);
      return sibling;
    }
    const t = targetLevel(linked.length, 1, !!def?.critical);
    const priority: Priority = t.level === 'P2' ? 'P3' : t.level; // стартуем не выше «Среднего», дальше — по правилам
    const s = summarize(linked);
    const id = `INC0${this.seq++}`;
    const inc = this.blank({
      id,
      title: `Жалобы: ${c.service} · ${region.name}`,
      shortDescription: `${linked.length} жалоб за ${RULES.windowMin} мин при норме ≈${c.expected}. ${s.top[0] ?? ''}`,
      description: `ИИ собрал жалобы абонентов в инцидент. Чаще всего: ${s.top.join('; ')}. Каналы: ${s.channels}.${s.b2b ? ` Корпоративных клиентов: ${s.b2b}.` : ''}`,
      priority,
      status: 'coordinators',
      createdAt: now,
      slaDeadline: now + PRIORITY_SLA_MIN[priority] * MIN,
      origin: 'complaints',
      productName: c.service,
      service: c.service,
      component: region.name,
      serviceType: s.b2b > linked.length / 3 ? 'Клиентский (B2B)' : 'Клиентский',
      urgency: def?.critical ? 'Высокая' : 'Средняя',
      regionId: c.regionId,
      regionIds: [c.regionId],
      regionName: region.name,
      region: region.city,
      geo: { lat: region.lat, lon: region.lon },
      complaints: linked.length,
      levelLog: [{ at: now, from: priority, to: priority, reason: `создан: ${linked.length} жалоб при норме ≈${c.expected}`, auto: true }],
      history: [{ at: now, kind: actor ? 'coordinator' : 'ai', actor: actor ?? undefined, text: actor ? `${actor}: создал инцидент из всплеска жалоб` : `ИИ: всплеск жалоб (${linked.length} при норме ≈${c.expected}) — создан инцидент` }],
    });
    for (const x of linked) x.incidentId = id;
    this.incidents.set(id, inc);
    this.hide(inc, now);
    this.createdLog.push(now);
    inc.complaintsSeries = this.seriesFor(inc, now);
    this.touch(inc, now);
    this.pushFeed(inc.priority === 'P1' ? 'p1' : 'coordinators', inc, `ИИ: ${linked.length} жалоб → инцидент`);
    return inc;
  }

  createFromCluster(key: string, actor: string) {
    const c = findClusters(this.complaints, Date.now()).find((x) => x.key === key);
    if (!c) throw new Error('Всплеск уже не актуален');
    return this.fromCluster(c, actor);
  }

  private seriesFor(inc: Incident, now: number) {
    const out = new Array(12).fill(0);
    for (const c of this.complaints) {
      if (c.incidentId !== inc.id) continue;
      const k = Math.floor((now - c.at) / (5 * MIN));
      if (k >= 0 && k < 12) out[11 - k]++;
    }
    return out;
  }

  /** Повышение уровня по жалобам — по правилам RULES. */
  private escalate(now: number) {
    for (const inc of this.incidents.values()) {
      if (inc.origin !== 'complaints' || inc.status === 'resolved') continue;
      inc.complaintsSeries = this.seriesFor(inc, now);
      const n30 = this.complaints.filter((c) => c.incidentId === inc.id && now - c.at < RULES.windowMin * MIN).length;
      const def = serviceDef(inc.service);
      const t = targetLevel(n30, inc.regionIds?.length ?? 1, !!def?.critical);
      const regions = inc.regionIds?.length ?? 1;
      inc.shortDescription = `За ${RULES.windowMin} мин: ${n30} жалоб${regions > 1 ? ` в ${regions} регионах` : ''}, всего ${inc.complaints ?? 0}.`;
      const h = this.hidden.get(inc.id)!;
      const next = nextAutoLevel(inc.priority, t.level, h.lastAutoLevel, now);
      if (next) {
        const from = inc.priority;
        this.setPriority(inc, next, now);
        h.lastAutoLevel = now;
        inc.levelLog = [...(inc.levelLog ?? []), { at: now, from, to: next, reason: t.reason, auto: true }];
        inc.history.push({ at: now, kind: 'ai', text: `ИИ: уровень ${PRIORITY_TEXT[from]} → ${PRIORITY_TEXT[next]} (${t.reason})` });
        this.pushFeed('priority_up', inc, `Уровень → ${PRIORITY_TEXT[next]}: ${t.reason}`);
      }
      if (t.p1 && inc.priority !== 'P1' && !inc.p1Proposal) {
        inc.p1Proposal = `ИИ предлагает «Наивысший»: ${t.reason}. Сервис критичный — нужно подтверждение дежурного.`;
        inc.history.push({ at: now, kind: 'ai', text: `ИИ предложил «Наивысший» (${t.reason}) — ждёт решения дежурного` });
        this.pushFeed('p1', inc, 'ИИ предлагает «Наивысший» — подтвердите');
      }
      this.dirty.add(inc.id);
    }
  }

  private setPriority(inc: Incident, p: Priority, now: number) {
    inc.priority = p;
    inc.priorityText = PRIORITY_TEXT[p];
    inc.impact = p === 'P1' ? 'Наивысшее' : p === 'P2' ? 'Высокое' : 'Среднее';
    // Срок сокращается до нормы нового уровня, но не продлевается.
    inc.slaDeadline = Math.min(inc.slaDeadline, inc.createdAt + PRIORITY_SLA_MIN[p] * MIN, Math.max(now + 20 * MIN, inc.slaDeadline - 1));
    inc.slaMinutes = Math.round((inc.slaDeadline - inc.createdAt) / MIN);
  }

  /** Автоэскалация по таймерам: команда на смене не взяла инцидент → напоминание → руководителю → дежурная смена. */
  private timers(now: number) {
    for (const inc of this.incidents.values()) {
      if (inc.status !== 'assigned' || inc.assignee || !inc.teamId || inc.teamId === POINT_ID) continue;
      const team = teamById(inc.teamId);
      if (!team) continue;
      // Пока команда не на смене, таймер не идёт: отсчёт начнётся с начала смены.
      if (!teamOnDuty(team.id, now)) {
        inc.routedAt = now;
        continue;
      }
      const waited = (now - (inc.routedAt ?? inc.updatedAt)) / MIN;
      const level = inc.escalation ?? 0;
      if (level >= TIMERS.length || waited < TIMERS[level]) continue;
      inc.escalation = level + 1;
      const sig = [...this.signals.values()].find((s) => s.incidentId === inc.id && s.kind === 'timer' && s.status !== 'closed');
      const lead = personById(team.leadId);
      const backup = team.backupId ? teamById(team.backupId) : undefined;
      if (level === 0) {
        inc.history.push({ at: now, kind: 'system', text: `Автоэскалация: «${team.name}» не взяла за ${TIMERS[0]} мин — команде отправлено напоминание` });
        this.addSignal({ kind: 'timer', incidentId: inc.id, personId: null, teamId: team.id, text: `«${team.name}» не взяла за ${TIMERS[0]} мин — напомнили команде` });
      } else if (level === 1) {
        inc.leadNotifiedAt = now;
        inc.history.push({ at: now, kind: 'system', text: `Автоэскалация: ${TIMERS[1]} мин без ответа — сообщено руководителю${lead ? ` (${lead.name})` : ''}` });
        if (sig) {
          sig.status = 'notified';
          sig.notifiedAt = now;
          sig.notifiedBy = 'Автоэскалация';
          sig.text = `«${team.name}» не взяла за ${TIMERS[1]} мин — сообщено руководителю`;
          this.emit({ type: 'signal', data: sig });
        }
        const h = this.hidden.get(inc.id);
        if (h && lead && !this.isOnline(lead.id)) h.acceptAt = now + between(40, 120) * 1000;
      } else {
        inc.history.push({ at: now, kind: 'system', text: `Автоэскалация: ${TIMERS[2]} мин без ответа${backup ? ` — пункту предложено передать в «${backup.name}»` : ' — нужна помощь пункта'}` });
        if (sig) {
          sig.status = 'open';
          sig.text = `«${team.name}» не взяла за ${TIMERS[2]} мин${backup ? ` — передать дежурной смене «${backup.name}»?` : ''}`;
          this.emit({ type: 'signal', data: sig });
        } else this.addSignal({ kind: 'timer', incidentId: inc.id, personId: null, teamId: team.id, text: `«${team.name}» не взяла за ${TIMERS[2]} мин` });
      }
      this.touch(inc, now);
      this.pushFeed('signal', inc, `Автоэскалация, ступень ${level + 1}`);
    }
  }

  private detectStuck(now: number) {
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved' || inc.status === 'coordinators') continue;
      const open = [...this.signals.values()].some((s) => s.incidentId === inc.id && s.status !== 'closed');
      if (open) continue;
      // Команда ещё не взяла — этим занимаются таймеры автоэскалации, а не «застрял».
      if (inc.status === 'assigned' && !inc.assignee) continue;
      const why = stuckReason(inc, now, inc.assigneeName);
      if (!why) continue;
      inc.history.push({ at: now, kind: 'ai', text: `ИИ заметил, что инцидент застрял: ${why.toLowerCase()} — сигнал пункту` });
      this.dirty.add(inc.id);
      this.addSignal({ kind: 'stuck', incidentId: inc.id, personId: inc.assignee, teamId: inc.teamId, text: `ИИ: ${why}` });
    }
  }

  private sla(now: number) {
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') continue;
      const h = this.hidden.get(inc.id);
      if (!h) continue;
      const left = inc.slaDeadline - now;
      if (!h.warned && left > 0 && left <= 30 * MIN) {
        h.warned = true;
        this.pushFeed('sla_warning', inc, `До дедлайна ${Math.round(left / MIN)} мин`);
      }
      if (!h.breached && left <= 0) {
        h.breached = true;
        this.breachedLog.push(now);
        this.pushFeed('sla_breach', inc, 'Дедлайн прошёл');
      }
    }
  }

  private cleanup(now: number) {
    this.complaints = this.complaints.filter((c) => now - c.at < KEEP_COMPLAINTS);
    for (const inc of [...this.incidents.values()]) {
      if (inc.origin !== 'dataset' && inc.status === 'resolved' && inc.resolvedAt && now - inc.resolvedAt > RECUR_WINDOW && !(inc.recur && now - inc.recur.lastAt < 20 * MIN)) {
        this.incidents.delete(inc.id);
        this.hidden.delete(inc.id);
        this.emit({ type: 'remove', data: { id: inc.id } });
      }
    }
    for (const s of [...this.signals.values()]) {
      if (s.status === 'closed' && now - s.at > 2 * 60 * MIN) this.signals.delete(s.id);
    }
  }

  // ─── автопилот за тех, кого нет в системе ────────────────────────────────

  private autopilot(now: number) {
    const staffOn = onShift(POINT_ID, now);
    // Распределяют люди. Для демо коллеги-дежурные, которых нет в системе, сами берут новые инциденты через 3–5 минут
    // (как сделал бы человек). Тот, кто вошёл в систему, успевает взять раньше.
    if (this.ticks % 5 === 0) {
      for (const inc of this.incidents.values()) {
        if (inc.status !== 'coordinators' || inc.coordinatorId) continue;
        const h = this.hidden.get(inc.id);
        if (!h) continue;
        if (h.routeAt === null) h.routeAt = h.pointAt + between(180, 300) * 1000;
        if (now < h.routeAt) continue;
        const colleagues = staffOn.filter((p) => p.role === 'coordinator' && !this.isOnline(p.id));
        const pick = planPoint([inc], colleagues, this.owned(), now)[0];
        if (pick) {
          const p = colleagues.find((x) => x.id === pick.personId)!;
          this.assignCoordinator(inc.id, p.id, p.name);
          h.routeAt = null;
        } else h.routeAt = now + 60_000;
      }
    }
    for (const inc of this.incidents.values()) {
      const h = this.hidden.get(inc.id);
      if (!h || inc.status === 'resolved') continue;
      // Дежурный пункта передаёт команде по подсказке ИИ.
      if (inc.status === 'coordinators' && inc.coordinatorId && !this.isOnline(inc.coordinatorId)) {
        if (h.routeAt === null) h.routeAt = now + between(40, 150) * 1000;
        else if (now >= h.routeAt) {
          const best = routeTeams(inc, this.ctx(now))[0];
          if (best) this.route(inc.id, best.teamId, `${inc.coordinatorName} (автопилот)`);
          else h.routeAt = now + 60_000;
        }
        continue;
      }
      if (!inc.teamId || inc.teamId === POINT_ID) continue;
      const teamOnline = membersOf(inc.teamId).some((p) => this.isOnline(p.id));
      if (teamOnline) continue;
      // Команда берёт, только когда кто-то на смене.
      if (inc.status === 'assigned' && !inc.assignee) {
        if (!teamOnDuty(inc.teamId, now)) continue;
        if (h.acceptAt === null) h.acceptAt = now + between(30, 120) * 1000;
        if (now >= h.acceptAt) {
          const eng = this.freeEngineer(inc.teamId, now);
          if (eng) this.take(inc.id, eng.id, true);
        }
        continue;
      }
      if (inc.status === 'assigned' && inc.assignee && now >= (h.acceptAt ?? 0)) {
        const p = personById(inc.assignee);
        if (p && isOn(p, now)) this.begin(inc.id, p.id);
        continue;
      }
      if (inc.status !== 'in_progress' || !inc.assignee) continue;
      // Руководитель после сигнала пункта передаёт другому сотруднику.
      if (h.leadAt && now >= h.leadAt) {
        h.leadAt = null;
        const other = this.freeEngineer(inc.teamId, now, inc.assignee);
        const lead = personById(teamById(inc.teamId)?.leadId);
        if (other) this.leadAssign(inc.id, other.id, lead?.name ?? 'Руководитель команды', true);
        h.roll = 'ok';
        h.finishAt = now + between(3, 8) * MIN;
        continue;
      }
      if (!h.rollDone && now - (inc.startedAt ?? now) > between(60, 150) * 1000) {
        h.rollDone = true;
        if (h.roll === 'wrong') {
          const alt = routeTeams(inc, this.ctx(now)).find((x) => x.teamId !== inc.teamId && x.onDuty);
          this.requestTransfer(inc.id, inc.assignee, alt?.teamId ?? null, 'По логам проблема не у нас — похоже, у смежной команды', true);
        } else if (h.roll === 'help') this.help(inc.id, inc.assignee, 'Не хватает доступа к системе, нужна помощь', true);
      }
      if (h.roll === 'ok' && h.finishAt && now >= h.finishAt) this.resolveByTeam(inc.id, inc.assignee, null, true);
    }
    // Запросы команд, у которых дежурный не в системе, — по проверке ИИ через пару минут.
    for (const r of this.requests.values()) {
      if (r.status !== 'pending' || now - r.at < 100_000) continue;
      const inc = r.incidentId ? this.incidents.get(r.incidentId) : undefined;
      if (inc?.coordinatorId && this.isOnline(inc.coordinatorId)) continue;
      if (staffOn.some((p) => p.role === 'coordinator' && this.isOnline(p.id)) && now - r.at < 5 * MIN) continue;
      this.resolveRequest(r.id, true, `${inc?.coordinatorName ?? 'Дежурный пункта'} (автопилот)`, r.aiTeamId ?? r.toTeamId ?? undefined, 'Согласовано по справочнику');
    }
  }

  private freeEngineer(teamId: string, now: number, except?: string) {
    const busy = new Map<string, number>();
    for (const i of this.incidents.values()) if (i.status === 'in_progress' && i.assignee) busy.set(i.assignee, (busy.get(i.assignee) ?? 0) + 1);
    return onShift(teamId, now)
      .filter((p) => p.role === 'engineer' && p.id !== except)
      .sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))[0];
  }

  // ─── действия пункта ─────────────────────────────────────────────────────

  private need(id: string) {
    const inc = this.incidents.get(id);
    if (!inc) throw new Error('Инцидент не найден');
    return inc;
  }

  assignCoordinator(id: string, personId: string, actor: string, aiWhy?: string) {
    const inc = this.need(id);
    const p = personById(personId);
    if (!p || p.teamId !== POINT_ID || p.role !== 'coordinator') throw new Error('Это не дежурный пункта');
    if (!isOn(p, Date.now())) throw new Error(`${p.name} сейчас не на смене`);
    const now = Date.now();
    inc.coordinatorId = p.id;
    inc.coordinatorName = p.name;
    inc.acknowledged = true;
    const h = this.hidden.get(id);
    if (h) h.routeAt = null;
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: ведёт ${p.name}` });
    if (aiWhy) inc.history.push({ at: now, kind: 'ai', text: `ИИ распределил на ${p.name}: ${aiWhy}` });
    this.touch(inc, now);
    this.pushFeed('assigned', inc, `Ведёт ${p.name}`, actor);
    return inc;
  }

  planPoint(): PointPlanItem[] {
    const waiting = [...this.incidents.values()].filter((i) => i.status === 'coordinators' && !i.coordinatorId);
    return planPoint(waiting, POINT_STAFF, this.owned(), Date.now());
  }

  applyPointPlan(items: PointPlanItem[], actor: string) {
    let n = 0;
    for (const it of items) {
      try {
        this.assignCoordinator(it.incidentId, it.personId, actor, it.why);
        n++;
      } catch {
        /* пропускаем устаревшие пункты плана */
      }
    }
    return n;
  }

  route(id: string, teamId: string, actor: string) {
    const inc = this.need(id);
    const team = teamById(teamId);
    if (!team || team.id === POINT_ID) throw new Error('Нет такой команды');
    const now = Date.now();
    inc.teamAsk = null; // передали — вопрос команды снят
    // и запрос команды «не наше — передайте» по этому инциденту выполнен
    for (const r of this.requests.values())
      if (r.incidentId === id && r.status === 'pending' && r.kind === 'transfer') {
        r.status = 'approved';
        r.doneAt = now;
        r.doneBy = actor;
        this.emit({ type: 'request', data: r });
      }
    const top = routeTeams(inc, this.ctx(now))[0];
    const h = this.hidden.get(id)!;
    h.aiTop = top?.teamId ?? null;
    if (top) {
      this.aiHits.total++;
      if (top.teamId === teamId) this.aiHits.hit++;
    }
    const was = inc.teamId;
    inc.teamId = team.id;
    inc.groupName = team.name;
    inc.status = 'assigned';
    inc.stateText = 'Назначен';
    inc.assignee = null;
    inc.assigneeName = null;
    inc.startedAt = null;
    if (was && was !== POINT_ID && was !== team.id) inc.reassignCount++;
    inc.routedAt = now;
    inc.escalation = 0;
    for (const s of this.signals.values()) if (s.incidentId === id && s.kind === 'timer' && s.status !== 'closed') (s.status = 'closed'), this.emit({ type: 'signal', data: s });
    const duty = teamOnDuty(team.id, now);
    h.acceptAt = duty ? now + between(30, 120) * 1000 : null;
    h.finishAt = null;
    const r = rnd();
    h.roll = r < 0.1 ? 'wrong' : r < 0.18 ? 'help' : r < 0.27 ? 'stuck' : 'ok';
    h.rollDone = h.roll === 'ok' || h.roll === 'stuck';
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: передано команде «${team.name}»${duty ? '' : ' — команда сейчас не на смене, возьмёт с началом смены'}` });
    if (top) inc.history.push({ at: now, kind: 'ai', text: top.teamId === teamId ? `Совпало с советом ИИ (балл ${top.score})` : `ИИ советовал «${teamById(top.teamId)?.name}» (балл ${top.score}), дежурный выбрал другую команду` });
    this.touch(inc, now);
    this.pushFeed('routed', inc, `→ ${team.name}`, actor);
    return inc;
  }

  setLevel(id: string, p: Priority, actor: string, reason: string) {
    const inc = this.need(id);
    const now = Date.now();
    const from = inc.priority;
    if (from === p) return inc;
    this.setPriority(inc, p, now);
    if (p === 'P1') inc.p1Proposal = null;
    inc.levelLog = [...(inc.levelLog ?? []), { at: now, from, to: p, reason: reason || 'решение дежурного', auto: false }];
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: уровень ${PRIORITY_TEXT[from]} → ${PRIORITY_TEXT[p]}${reason ? ` (${reason})` : ''}` });
    this.touch(inc, now);
    if (higher(p, from)) this.pushFeed(p === 'P1' ? 'p1' : 'priority_up', inc, `Уровень → ${PRIORITY_TEXT[p]}`, actor);
    return inc;
  }

  dismissP1(id: string, actor: string) {
    const inc = this.need(id);
    inc.p1Proposal = null;
    inc.history.push({ at: Date.now(), kind: 'coordinator', actor, text: `${actor}: «Наивысший» не нужен` });
    this.touch(inc, Date.now());
    return inc;
  }

  /** Избранное смены: закрепить инцидент с заметкой и напоминанием (своё поле Радара — видно всем дежурным). */
  pin(id: string, actor: string, note: string, remindMin: number | null) {
    const inc = this.need(id);
    const now = Date.now();
    const had = !!inc.pin;
    inc.pin = { by: actor, at: now, note: note.slice(0, 300), remindAt: remindMin && remindMin > 0 ? now + Math.min(24 * 60, remindMin) * MIN : null };
    inc.attentionAt = now;
    inc.attentionBy = actor;
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: ${had ? 'изменил избранное' : 'в избранное'}${note ? ` — «${note.slice(0, 80)}»` : ''}${inc.pin.remindAt ? `, напомнить через ${remindMin} мин` : ''}` });
    this.touch(inc, now);
    return inc;
  }
  unpin(id: string, actor: string) {
    const inc = this.need(id);
    if (!inc.pin) return inc;
    const now = Date.now();
    inc.pin = null;
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: убрал из избранного` });
    this.touch(inc, now);
    return inc;
  }
  /** Дежурный посмотрел инцидент — «Не забыть» перестаёт его подсовывать (не чаще раза в минуту). */
  seen(id: string, actor: string) {
    const inc = this.need(id);
    const now = Date.now();
    if (inc.attentionAt && now - inc.attentionAt < 60_000) return inc;
    inc.attentionAt = now;
    inc.attentionBy = actor;
    this.touch(inc, now);
    return inc;
  }

  resolveAtPoint(id: string, actor: string) {
    const inc = this.need(id);
    if (inc.status !== 'resolved') this.finish(inc, actor);
    return inc;
  }

  notifyLead(signalId: string, actor: string) {
    const s = this.signals.get(signalId);
    if (!s) throw new Error('Сигнал не найден');
    const inc = this.need(s.incidentId);
    const now = Date.now();
    const team = teamById(inc.teamId);
    const lead = personById(team?.leadId);
    s.status = 'notified';
    s.notifiedAt = now;
    s.notifiedBy = actor;
    inc.leadNotifiedAt = now;
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: указал руководителю команды${lead ? ` (${lead.name})` : ''} — ${s.text}` });
    const h = this.hidden.get(inc.id);
    if (h && lead && !this.isOnline(lead.id)) h.leadAt = now + between(90, 200) * 1000;
    this.emit({ type: 'signal', data: s });
    this.touch(inc, now);
    this.pushFeed('signal', inc, `Руководителю «${team?.name}»: ${s.text}`, actor);
    return s;
  }

  /**
   * Написать руководителю команды по инциденту (голосом через Джарвиса или с пункта): сообщение уходит ему лично
   * и видно в переписке инцидента; открытый сигнал по инциденту при этом считается переданным руководителю.
   */
  messageLead(id: string, actor: string, text: string) {
    const inc = this.need(id);
    const team = teamById(inc.teamId);
    if (!team || inc.teamId === POINT_ID) throw new Error('инцидент ещё не у команды — сначала передайте его');
    const lead = personById(team.leadId);
    const t = text.trim().slice(0, 600);
    if (!t) throw new Error('пустое сообщение');
    const now = Date.now();
    const c = { id: `M${now.toString(36)}${Math.floor(Math.random() * 1e4)}`, at: now, author: actor, personId: null, side: 'point' as const, teamId: null, text: `Руководителю${lead ? ` (${lead.name})` : ''}: ${t}` };
    inc.comments = [...(inc.comments ?? []), c].slice(-200);
    inc.leadNotifiedAt = now;
    inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: написал руководителю команды${lead ? ` ${lead.name}` : ''} — «${t.slice(0, 160)}»` });
    for (const s of this.signals.values())
      if (s.incidentId === inc.id && s.status === 'open') {
        s.status = 'notified';
        s.notifiedAt = now;
        s.notifiedBy = actor;
        this.emit({ type: 'signal', data: s });
      }
    const h = this.hidden.get(inc.id);
    if (h && lead && !this.isOnline(lead.id)) h.leadAt = now + between(90, 200) * 1000; // демо: руководитель отреагирует сам
    this.touch(inc, now);
    this.pushFeed('signal', inc, `Руководителю «${team.name}»: ${t.slice(0, 80)}`, actor);
    return { team: team.name, lead: lead?.name ?? null };
  }

  closeSignal(signalId: string, actor: string) {
    const s = this.signals.get(signalId);
    if (!s) throw new Error('Сигнал не найден');
    s.status = 'closed';
    this.emit({ type: 'signal', data: s });
    void actor;
    return s;
  }

  resolveRequest(reqId: string, approve: boolean, actor: string, teamId?: string, comment?: string) {
    const r = this.requests.get(reqId);
    if (!r || r.status !== 'pending') throw new Error('Запрос уже обработан');
    const now = Date.now();
    r.status = approve ? 'approved' : 'rejected';
    r.doneAt = now;
    r.doneBy = actor;
    r.comment = comment;
    const to = teamId ?? r.toTeamId;
    if (approve && to) {
      if (r.incidentId) this.route(r.incidentId, to, actor);
      else {
        // Команда сообщила о проблеме у другой команды — заводим инцидент и передаём.
        const id = `INC0${this.seq++}`;
        const from = teamById(r.fromTeamId);
        const inc = this.blank({
          id,
          title: `Сообщение от «${from?.name}»: ${r.reason.slice(0, 60)}`,
          description: r.reason,
          shortDescription: r.reason,
          priority: 'P3',
          status: 'coordinators',
          createdAt: now,
          slaDeadline: now + PRIORITY_SLA_MIN.P3 * MIN,
          origin: 'stream',
          channel: `Команда ${from?.name ?? r.fromTeamId}`,
          history: [{ at: now, kind: 'team', text: `Сообщила команда «${from?.name}»` }],
        });
        this.incidents.set(id, inc);
        this.hide(inc, now);
        this.createdLog.push(now);
        this.route(id, to, actor);
        r.incidentId = id;
      }
    } else if (!approve && r.incidentId) {
      const inc = this.incidents.get(r.incidentId);
      if (inc) {
        inc.teamAsk = null; // ответили команде — вопрос снят
        inc.history.push({ at: now, kind: 'coordinator', actor, text: `${actor}: передача отклонена${comment ? ` — ${comment}` : ''}` });
        const h = this.hidden.get(inc.id);
        if (h) {
          h.roll = 'ok';
          h.finishAt = now + between(3, 8) * MIN;
        }
        this.touch(inc, now);
      }
    }
    this.emit({ type: 'request', data: r });
    return r;
  }

  // ─── действия команды ────────────────────────────────────────────────────

  private member(teamId: string | null | undefined, personId: string) {
    const p = personById(personId);
    if (!p || !teamId || !(p.teamId === teamId || p.teams?.includes(teamId))) throw new Error('Вы не в этой команде');
    return p;
  }

  take(id: string, personId: string, auto = false) {
    const inc = this.need(id);
    const p = this.member(inc.teamId, personId);
    const now = Date.now();
    if (!isOn(p, now)) throw new Error('Вы сейчас не на смене');
    inc.assignee = p.id;
    inc.assigneeName = p.name;
    inc.status = 'in_progress';
    inc.stateText = 'Выполняется';
    inc.startedAt = now;
    const h = this.hidden.get(id)!;
    h.finishAt = now + between(4, 14) * MIN;
    inc.history.push({ at: now, kind: 'team', actor: p.name, text: `${p.name}: взял(а) в работу${auto ? '' : ''}` });
    for (const s of this.signals.values()) if (s.incidentId === id && s.kind === 'timer' && s.status !== 'closed') (s.status = 'closed'), this.emit({ type: 'signal', data: s });
    this.touch(inc, now);
    this.pushFeed('in_progress', inc, `${p.name} в работе`, p.name);
    return inc;
  }

  private begin(id: string, personId: string) {
    const inc = this.need(id);
    const p = personById(personId)!;
    const now = Date.now();
    inc.status = 'in_progress';
    inc.stateText = 'Выполняется';
    inc.startedAt = now;
    this.hidden.get(id)!.finishAt = now + between(4, 14) * MIN;
    inc.history.push({ at: now, kind: 'team', actor: p.name, text: `${p.name}: начал(а) работу` });
    this.touch(inc, now);
  }

  leadAssign(id: string, personId: string, actor: string, auto = false) {
    const inc = this.need(id);
    const p = this.member(inc.teamId, personId);
    const now = Date.now();
    if (!isOn(p, now)) throw new Error(`${p.name} сейчас не на смене`);
    inc.assignee = p.id;
    inc.assigneeName = p.name;
    inc.status = 'in_progress';
    inc.stateText = 'Выполняется';
    inc.startedAt = now;
    this.hidden.get(id)!.finishAt = now + between(3, 10) * MIN;
    for (const s of this.signals.values()) if (s.incidentId === id && s.status !== 'closed') (s.status = 'closed'), this.emit({ type: 'signal', data: s });
    inc.history.push({ at: now, kind: 'team', actor, text: `${actor}: передал(а) ${p.name}${auto ? '' : ''}` });
    this.touch(inc, now);
    this.pushFeed('assigned', inc, `Руководитель: → ${p.name}`, actor);
    return inc;
  }

  resolveByTeam(id: string, personId: string, solution: string | null, auto = false) {
    const inc = this.need(id);
    const p = this.member(inc.teamId, personId);
    if (solution) inc.solution = solution;
    else if (!inc.solution) inc.solution = auto ? 'Причина устранена, сервис восстановлен' : null;
    this.finish(inc, p.name);
    // Демо: иногда решение не помогает — через минуту-полторы жалобы по тому же сервису и региону идут снова.
    if (auto && inc.origin === 'complaints' && inc.regionIds?.length && rnd() < 0.25) {
      this.stream.start(inc.service, inc.regionIds, between(3, 5), between(0.3, 0.5), Date.now() + between(40, 90) * 1000);
    }
    return inc;
  }

  release(id: string, personId: string) {
    const inc = this.need(id);
    const p = this.member(inc.teamId, personId);
    const now = Date.now();
    inc.assignee = null;
    inc.assigneeName = null;
    inc.status = 'assigned';
    inc.stateText = 'Назначен';
    this.hidden.get(id)!.acceptAt = now + between(30, 90) * 1000;
    inc.history.push({ at: now, kind: 'team', actor: p.name, text: `${p.name}: вернул(а) в очередь команды` });
    this.touch(inc, now);
    return inc;
  }

  requestTransfer(id: string, personId: string, toTeamId: string | null, reason: string, auto = false) {
    const inc = this.need(id);
    const p = this.member(inc.teamId, personId);
    const check = checkTransfer(inc, toTeamId, this.ctx());
    const r: TeamRequest = {
      id: `R${this.reqSeq++}`,
      at: Date.now(),
      kind: 'transfer',
      incidentId: inc.id,
      fromTeamId: inc.teamId!,
      fromPersonId: p.id,
      toTeamId,
      reason: reason || 'Не наша зона',
      status: 'pending',
      aiNote: check.note,
      aiTeamId: check.teamId,
    };
    this.requests.set(r.id, r);
    inc.teamAsk = { kind: 'transfer', teamName: teamById(r.fromTeamId)?.name ?? 'команда', text: r.reason, at: r.at, aiTeamId: check.teamId ?? null };
    inc.history.push({ at: r.at, kind: 'team', actor: p.name, text: `${p.name}: просит передать${toTeamId ? ` в «${teamById(toTeamId)?.name}»` : ''} — ${r.reason}` });
    inc.history.push({ at: r.at, kind: 'ai', text: `ИИ проверил запрос по справочнику: ${check.note}` });
    this.touch(inc, r.at);
    this.emit({ type: 'request', data: r });
    this.pushFeed('request', inc, `Запрос на передачу от «${teamById(r.fromTeamId)?.name}»${auto ? '' : ''}`, p.name);
    return r;
  }

  report(personId: string, toTeamId: string, text: string) {
    const p = personById(personId);
    if (!p) throw new Error('Нет такого сотрудника');
    const check = checkTransfer(null, toTeamId, this.ctx());
    const r: TeamRequest = { id: `R${this.reqSeq++}`, at: Date.now(), kind: 'report', incidentId: null, fromTeamId: p.teamId, fromPersonId: p.id, toTeamId, reason: text, status: 'pending', aiNote: check.note, aiTeamId: check.teamId };
    this.requests.set(r.id, r);
    this.emit({ type: 'request', data: r });
    return r;
  }

  help(id: string, personId: string, text: string, auto = false) {
    const inc = this.need(id);
    const p = this.member(inc.teamId, personId);
    inc.teamAsk = { kind: 'help', teamName: teamById(inc.teamId)?.name ?? 'команда', text, at: Date.now() };
    inc.history.push({ at: Date.now(), kind: 'team', actor: p.name, text: `${p.name}: нужна помощь — ${text}` });
    this.touch(inc, Date.now());
    void auto;
    return this.addSignal({ kind: 'help', incidentId: inc.id, personId: p.id, teamId: inc.teamId, text: `${p.name}: ${text}` });
  }

  /** Переписка в карточке: пункт ↔ команда. */
  comment(id: string, author: { name: string; personId: string | null; side: 'point' | 'team'; teamId: string | null }, text: string) {
    const inc = this.need(id);
    const t = text.trim().slice(0, 1000);
    if (!t) throw new Error('Пустое сообщение');
    if (author.side === 'team' && author.teamId !== inc.teamId && !personById(author.personId)?.teams?.includes(inc.teamId ?? '')) throw new Error('Инцидент не у вашей команды');
    const now = Date.now();
    const c = { id: `M${now.toString(36)}${Math.floor(Math.random() * 1e4)}`, at: now, author: author.name, personId: author.personId, side: author.side, teamId: author.teamId, text: t };
    inc.comments = [...(inc.comments ?? []), c].slice(-200);
    this.touch(inc, now);
    this.pushFeed('comment', inc, `${author.name}: ${t.slice(0, 80)}`, author.name);
    return c;
  }

  setAway(personId: string, away: boolean) {
    const p = personById(personId);
    if (!p) throw new Error('Нет такого сотрудника');
    p.away = away;
    this.emit({ type: 'people', data: [p] });
    return p;
  }

  private addSignal(o: Omit<Signal, 'id' | 'at' | 'status'>) {
    const s: Signal = { ...o, id: `S${this.sigSeq++}`, at: Date.now(), status: 'open' };
    this.signals.set(s.id, s);
    this.emit({ type: 'signal', data: s });
    const inc = this.incidents.get(s.incidentId);
    if (inc) this.pushFeed('signal', inc, s.text);
    return s;
  }

  // ─── общее ───────────────────────────────────────────────────────────────

  private finish(inc: Incident, actor: string) {
    const now = Date.now();
    inc.teamAsk = null;
    inc.status = 'resolved';
    inc.stateText = 'Завершен';
    inc.stateReason = 'Постоянное решение';
    inc.resolvedAt = now;
    inc.p1Proposal = null;
    inc.history.push({ at: now, kind: 'team', actor, text: `${actor}: решено` });
    this.resolvedLog.push({ at: now, ttr: now - inc.createdAt });
    for (const s of this.signals.values()) if (s.incidentId === inc.id && s.status !== 'closed') (s.status = 'closed'), this.emit({ type: 'signal', data: s });
    this.touch(inc, now);
    this.pushFeed('resolved', inc, `Решено · ${actor}`, actor);
  }

  private touch(inc: Incident, now: number) {
    inc.updatedAt = now;
    this.dirty.delete(inc.id);
    this.emit({ type: 'incident', data: inc });
  }

  private pushFeed(kind: FeedKind, inc: Incident, text: string, actor?: string) {
    const ev: FeedEvent = { id: `E${this.feedSeq++}`, at: Date.now(), kind, incidentId: inc.id, priority: inc.priority, systemId: inc.systemId, text, actor };
    this.feed.unshift(ev);
    if (this.feed.length > 300) this.feed.length = 300;
    this.emit({ type: 'feed', data: ev });
  }

  private counts(now: number) {
    let open = 0;
    let critical = 0;
    let atRisk = 0;
    for (const i of this.incidents.values()) {
      if (i.status === 'resolved') continue;
      open++;
      if (i.priority <= 'P2') critical++;
      const r = i.slaDeadline - now;
      if (r > 0 && r <= 30 * MIN) atRisk++;
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
    const lastMin = this.complaints.filter((c) => now - c.at < 60_000).length;
    return {
      resolvedLastHour: this.resolvedLog.length,
      createdLastHour: this.createdLog.length,
      breachedLastHour: this.breachedLog.length,
      mttrMinutes: mttr === null ? null : Math.round(mttr),
      flowPerMin: lastMin,
      aiAccuracy: this.aiHits.total ? this.aiHits.hit / this.aiHits.total : null,
      series: this.series,
    };
  }

  /** Люди команд, где сейчас есть работа, — чтобы экраны показывали, кто на смене. */
  activePeople(extraTeam?: string | null): Person[] {
    const teams = new Set<string>();
    for (const i of this.incidents.values()) if (i.status !== 'resolved' && i.teamId && i.teamId !== POINT_ID) teams.add(i.teamId);
    if (extraTeam) teams.add(extraTeam);
    const out = new Map<string, Person>();
    for (const t of teams) for (const p of membersOf(t)) out.set(p.id, p);
    return [...out.values()];
  }

  /** Демо: сбой в регионе или на платформе. */
  outage(service: string, regionIds: string[], minutes = 6, perSec = 0.4) {
    return this.stream.start(service, regionIds, minutes, perSec);
  }

  // ─── показ по кнопкам (server/show.ts) ─────────────────────────────────────
  /** Инцидент из всплеска жалоб прямо сейчас: жалобы ставятся на карту, ИИ собирает инцидент, советует команду. */
  /**
   * ИИ распределяет сам, чтобы дежурный не отвлекался от главного. Только когда есть критический или сложный
   * (жалобы снова после решения, передают по кругу):
   *   низкий — сразу в команду из совета ИИ;
   *   средний — когда до срока осталось столько, сколько команде обычно нужно на работу (+15 минут запаса).
   * Взятые дежурным не трогаем. На инциденте — пометка autoRouted и запись в истории: почему ИИ решил сам.
   */
  autoRoute(now = Date.now()) {
    const open = [...this.incidents.values()].filter((i) => i.status !== 'resolved');
    const busy = open.some((i) => i.priority === 'P1' || (i.recur?.count ?? 0) >= RECUR_MIN || (i.reassignCount ?? 0) >= 2);
    if (!busy) return [];
    const done: Incident[] = [];
    for (const inc of open) {
      if (inc.status !== 'coordinators' || inc.coordinatorId || (inc.priority !== 'P4' && inc.priority !== 'P3')) continue;
      if (now - inc.createdAt < 8_000) continue; // сначала дежурный его видит, потом ИИ решает
      const top = routeTeams(inc, this.ctx(now)).find((p) => p.teamId !== POINT_ID);
      const team = top ? teamById(top.teamId) : undefined;
      if (!top || !team) continue;
      const left = inc.slaDeadline - now;
      const need = this.teamWorkMin(top.teamId, inc.priority) * MIN;
      let why: string;
      if (inc.priority === 'P4') why = 'низкий — дежурный занят критическими, ИИ передал сам';
      else if (left <= need + 15 * MIN) why = `средний — до срока ${Math.max(0, Math.round(left / MIN))} мин, а команде нужно около ${Math.round(need / MIN)}: ждать дальше нельзя, ИИ передал сам`;
      else continue;
      this.route(inc.id, top.teamId, 'ИИ (сам)');
      inc.autoRouted = { at: now, why, teamName: team.name };
      inc.history.push({ at: now, kind: 'ai', text: `ИИ: ${why} — в «${team.name}»` });
      this.touch(inc, now);
      done.push(inc);
    }
    return done;
  }
  /** Сколько команде обычно нужно на работу: по её решённым инцидентам (медиана), иначе — по уровню. */
  teamWorkMin(teamId: string, priority: Priority) {
    const took = [...this.incidents.values()]
      .filter((i) => i.teamId === teamId && i.status === 'resolved' && i.resolvedAt && i.routedAt)
      .map((i) => (i.resolvedAt! - i.routedAt!) / MIN)
      .filter((m) => m > 1)
      .sort((a, b) => a - b);
    if (took.length >= 3) return Math.round(took[Math.floor(took.length / 2)]);
    return priority === 'P3' ? 60 : priority === 'P4' ? 120 : 45;
  }
  scenarioIncident(o: { service: string; regionId: string; n: number; priority?: Priority; slaMin?: number; reason?: string }) {
    const now = Date.now();
    for (let k = 0; k < o.n; k++) this.addComplaint(makeComplaint(now - k * 3000, o.service, o.regionId));
    const inc = this.fromCluster({ key: `${o.service}|${o.regionId}`, service: o.service, regionId: o.regionId, count: o.n, expected: 0.4, pValue: 1e-9 }, null);
    if (o.priority && inc.priority !== o.priority) {
      (inc.levelLog ??= []).push({ at: now, from: inc.priority, to: o.priority, reason: o.reason ?? 'ИИ: по числу жалоб и критичности сервиса', auto: true });
      inc.priority = o.priority;
      inc.priorityText = PRIORITY_TEXT[o.priority];
      inc.slaDeadline = now + PRIORITY_SLA_MIN[o.priority] * MIN;
    }
    if (o.slaMin !== undefined) inc.slaDeadline = now + o.slaMin * MIN;
    const top = routeTeams(inc, this.ctx(now))[0];
    if (top) inc.ai = { ...inc.ai, teamId: top.teamId, confidence: Math.min(0.96, 0.6 + top.score / 250) };
    this.hide(inc, now);
    this.touch(inc, now);
    return inc;
  }
  /** Таймеры и «застрявшие» — сразу, не дожидаясь следующего такта. */
  runTimers() {
    const now = Date.now();
    this.timers(now);
    this.detectStuck(now);
  }
  /** Поменять поле инцидента для сценария и разослать изменения. */
  patch(id: string, f: (inc: Incident) => void) {
    const inc = this.need(id);
    f(inc);
    this.touch(inc, Date.now());
    return inc;
  }
  /** Очистить смену для показа: инциденты, жалобы, сигналы, лента. Клиенты получают пустой снимок. */
  reset() {
    for (const id of this.incidents.keys()) this.emit({ type: 'remove', data: { id } });
    this.incidents.clear();
    this.complaints = [];
    this.clusters = [];
    this.requests.clear();
    this.signals.clear();
    this.feed = [];
    this.hidden.clear();
    this.dirty.clear();
    this.buffer = [];
    this.stream.outages = [];
    this.createdLog = [];
    this.resolvedLog = [];
    this.breachedLog = [];
  }

  /** Демо: одна жалоба (для тестов и ручной проверки). */
  complain(service: string, regionId: string) {
    const c = makeComplaint(Date.now(), service, regionId);
    this.addComplaint(c);
    return c;
  }
}

