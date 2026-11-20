// Демо для защиты: правит data/incidents.json, а дашборд реагирует на изменения файла.
// То же самое можно сделать руками в любом редакторе — скрипт просто экономит время.
//
//   npm run demo -- critical          новый критический инцидент (приоритет «Наивысший»)
//   npm run demo -- coord [INC…]      назначить на «КЦ ИТ Координаторы Массовых Инцидентов»
//   npm run demo -- raise [INC…]      повысить приоритет на ступень
//   npm run demo -- work [INC…]       взять в работу («Выполняется»)
//   npm run demo -- research [INC…]   сбой устранён, «Исследование ситуации»
//   npm run demo -- resolve [INC…]    «Завершен»
//   npm run demo -- reset             вернуть исходную выгрузку
//
// Без номера команда применяется к последнему инциденту, созданному демо (или к первому открытому).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Raw = Record<string, unknown>;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.resolve(root, process.env.INCIDENTS_FILE || 'data/incidents.json');
const SAMPLE = path.join(root, 'data/incidents.sample.json');
const COORD = 'КЦ ИТ Координаторы Массовых Инцидентов';
const DEMO_PREFIX = 'INC0009';

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PRIO: Record<number, [string, string]> = { 1: ['Низкий', 'Низкая'], 2: ['Средний', 'Средняя'], 3: ['Высокий', 'Высокая'], 4: ['Наивысший', 'Наивысшая'] };

function read(): Raw[] {
  if (!fs.existsSync(FILE)) fs.copyFileSync(SAMPLE, FILE);
  return JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '')) as Raw[];
}

function write(list: Raw[]) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n');
}

function target(list: Raw[], id?: string): Raw {
  if (id) {
    const r = list.find((x) => x.id === id);
    if (!r) throw new Error(`Инцидент ${id} не найден в ${path.basename(FILE)}`);
    return r;
  }
  const demo = list.filter((x) => String(x.id).startsWith(DEMO_PREFIX)).sort((a, b) => String(b.submitDate).localeCompare(String(a.submitDate)))[0];
  const open = list.find((x) => x.state === 'Назначен' && x.assignedGroupName !== COORD);
  const r = demo ?? open;
  if (!r) throw new Error('Нет подходящего инцидента');
  return r;
}

function setState(r: Raw, state: string, stateEnum: string, stateId: number) {
  Object.assign(r, { state, stateEnum, stateId });
}

const [cmd, id] = process.argv.slice(2);
const now = Date.now();
let list: Raw[];
let msg: string;

switch (cmd) {
  case 'critical': {
    list = read();
    const base = list[0];
    const newId = `${DEMO_PREFIX}${String(now).slice(-8)}`;
    list.push({
      ...base,
      sysId: String(now),
      id: newId,
      state: 'Назначен',
      stateEnum: 'Assigned',
      stateId: 0,
      stateReason: 'Нет',
      stateReasonId: '1',
      submitDate: iso(now),
      deadline: iso(now + 4 * 3_600_000),
      completionDate: null,
      lastAssignmentToTeamDateTime: iso(now),
      header: 'Полный отказ Магнитный двигатель',
      description: 'Мониторинг: Магнитный двигатель в продукте Летающий ковер не отвечает, ковры теряют высоту по всей стране. Массовые жалобы.',
      shortDescription: 'Ковры теряют высоту, массовые жалобы.',
      assignedGroupName: 'КЦ МТС Гильдия (SimpleOne)',
      assignedEmployee: null,
      assignedEmployeeLogin: null,
      isEffect: false,
      isReason: false,
      isDouble: false,
      isMaster: false,
      isRootIncident: true,
      serviceTypeId: 10,
      serviceType: 'Клиентский',
      priorityId: 4,
      priority: 'Наивысший',
      urgencyId: 4,
      urgency: 'Наивысшая',
      impactId: 4,
      impact: 'Наивысшее',
      productName: 'Летающий ковер',
      productMasterId: 'BI_DEMO',
      service: '[Летающий ковер] Магнитный двигатель',
      scenarioName: 'Катушка',
      receivingChannel: 'Мониторинг 9го королевства',
      solution: null,
      isNeedUp: null,
    });
    msg = `Добавлен критический ${newId}`;
    break;
  }
  case 'coord': {
    list = read();
    const r = target(list, id);
    Object.assign(r, { assignedGroupName: COORD, assignedEmployee: null, lastAssignmentToTeamDateTime: iso(now) });
    if (r.state !== 'Исследование ситуации') setState(r, 'Назначен', 'Assigned', 0);
    msg = `${r.id} назначен на координаторов`;
    break;
  }
  case 'raise': {
    list = read();
    const r = target(list, id);
    const p = Math.min(4, Number(r.priorityId ?? 1) + 1);
    Object.assign(r, { priorityId: p, priority: PRIO[p][0] });
    msg = `${r.id}: приоритет «${PRIO[p][0]}»`;
    break;
  }
  case 'work': {
    list = read();
    const r = target(list, id);
    setState(r, 'Выполняется', 'WorkInProgress', 2);
    if (!r.assignedEmployee) r.assignedEmployee = 'Винни Пух (winnie)';
    msg = `${r.id} взят в работу`;
    break;
  }
  case 'research': {
    list = read();
    const r = target(list, id);
    setState(r, 'Исследование ситуации', 'Research', 20);
    Object.assign(r, { completionDate: iso(now), stateReason: null, solution: r.solution ?? 'Сбой устранён, причины выясняются.' });
    msg = `${r.id}: исследование ситуации`;
    break;
  }
  case 'resolve': {
    list = read();
    const r = target(list, id);
    setState(r, 'Завершен', 'Resolved', 7);
    Object.assign(r, { completionDate: iso(now), stateReason: 'Постоянное решение' });
    msg = `${r.id} завершён`;
    break;
  }
  case 'reset':
    fs.copyFileSync(SAMPLE, FILE);
    console.log(`Выгрузка восстановлена из ${path.basename(SAMPLE)}`);
    process.exit(0);
  default:
    console.log('Команды: critical, coord, raise, work, research, resolve, reset. Например: npm run demo -- critical');
    process.exit(cmd ? 1 : 0);
}

write(list);
console.log(`${msg} → ${path.relative(root, FILE)}`);
