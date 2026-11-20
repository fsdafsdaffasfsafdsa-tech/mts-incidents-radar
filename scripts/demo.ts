// Демо для защиты: правит data/incidents.json (выгрузку ITSM), а дашборд реагирует на изменения файла.
// То же самое можно сделать руками в любом редакторе — скрипт экономит время.
//
//   npm run demo -- critical          новый критический онлайн-инцидент
//   npm run demo -- field             новый выезд (бригада ОГЭ)
//   npm run demo -- coord [INC…]      назначить на «КЦ ИТ Координаторы Массовых Инцидентов»
//   npm run demo -- raise [INC…]      повысить приоритет на ступень
//   npm run demo -- research [INC…]   сбой устранён, «Исследование ситуации»
//   npm run demo -- resolve [INC…]    «Завершен»
//   npm run demo -- reset             вернуть исходную выгрузку
//
// Без номера команда применяется к последнему инциденту, созданному демо.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Raw = Record<string, unknown>;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.resolve(root, process.env.INCIDENTS_FILE || 'data/incidents.json');
const SAMPLE = path.join(root, 'data/character_problems.json');
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
  if (!demo) throw new Error('Сначала создайте инцидент: npm run demo -- critical');
  return demo;
}

function fresh(list: Raw[], patch: Raw): Raw {
  const now = Date.now();
  const r: Raw = {
    ...list[0],
    sysId: String(now),
    id: `${DEMO_PREFIX}${String(now).slice(-8)}`,
    state: 'Назначен',
    stateEnum: 'Assigned',
    stateId: 0,
    stateReason: null,
    submitDate: iso(now),
    deadline: iso(now + 2 * 3_600_000),
    completionDate: null,
    solution: null,
    assignedEmployee: null,
    assignedEmployeeLogin: null,
    isEffect: false,
    isReason: false,
    isDouble: false,
    isMaster: false,
    ...patch,
  };
  list.push(r);
  return r;
}

const [cmd, id] = process.argv.slice(2);
const now = Date.now();
let list: Raw[] = [];
let msg = '';

switch (cmd) {
  case 'critical': {
    list = read();
    const r = fresh(list, {
      header: 'Полный отказ Магнитный двигатель',
      description: 'Мониторинг: Магнитный двигатель в продукте Летающий ковер не отвечает, ковры теряют высоту по всей стране.',
      shortDescription: 'Ковры теряют высоту, массовые жалобы.',
      assignedGroupName: COORD,
      serviceType: 'Клиентский',
      priorityId: 4,
      priority: 'Наивысший',
      urgency: 'Наивысшая',
      impact: 'Наивысшее',
      productName: 'Летающий ковер',
      service: '[Летающий ковер] Магнитный двигатель',
      scenarioName: 'Катушка',
      receivingChannel: 'Мониторинг 9го королевства',
    });
    msg = `Добавлен критический ${r.id}`;
    break;
  }
  case 'field': {
    list = read();
    const field = list.find((x) => /ОГЭ/.test(String(x.assignedGroupName))) ?? list[0];
    const r = fresh(list, {
      header: 'Нет питания на площадке',
      description: 'Требуется выезд: на площадке пропало питание, оборудование на аккумуляторах.',
      shortDescription: 'Нужен выезд бригады.',
      assignedGroupName: field.assignedGroupName,
      priorityId: 3,
      priority: 'Высокий',
      urgency: 'Высокая',
      impact: 'Высокое',
      productName: field.productName,
      service: field.service,
      scenarioName: field.scenarioName,
    });
    msg = `Добавлен выезд ${r.id}`;
    break;
  }
  case 'coord': {
    list = read();
    const r = target(list, id);
    Object.assign(r, { assignedGroupName: COORD, assignedEmployee: null, lastAssignmentToTeamDateTime: iso(now) });
    if (r.state !== 'Исследование ситуации') Object.assign(r, { state: 'Назначен', stateEnum: 'Assigned', stateId: 0 });
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
  case 'research': {
    list = read();
    const r = target(list, id);
    Object.assign(r, { state: 'Исследование ситуации', stateEnum: 'Research', stateId: 20, solution: r.solution ?? 'Сбой устранён, причины выясняются.' });
    msg = `${r.id}: исследование ситуации`;
    break;
  }
  case 'resolve': {
    list = read();
    const r = target(list, id);
    Object.assign(r, { state: 'Завершен', stateEnum: 'Resolved', stateId: 7, completionDate: iso(now), stateReason: 'Постоянное решение' });
    msg = `${r.id} завершён`;
    break;
  }
  case 'reset':
    fs.copyFileSync(SAMPLE, FILE);
    console.log(`Выгрузка восстановлена из ${path.basename(SAMPLE)}`);
    process.exit(0);
  default:
    console.log('Команды: critical, field, coord, raise, research, resolve, reset. Например: npm run demo -- critical');
    process.exit(cmd ? 1 : 0);
}

write(list);
console.log(`${msg} → ${path.relative(root, FILE)}`);
