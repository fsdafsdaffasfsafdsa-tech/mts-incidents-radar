// Джарвис и дашборд координатора (видеостена): инструмент «dashboard» для модели, разбор команд без модели
// и выжимка «главное сейчас» по правилам. Сама стена применяет команду в браузере (src/lib/dashLayout.ts).
import { BLOCKS, BLOCK_NAME, DASH_GROUPS, GROUP_NAME, PRESETS, PRESET_NAME, dashSnapshot, fmtShort, riskOf, type BlockId, type DashGroup, type DashOp, type PresetId } from '../shared/dash.ts';
import { DASH_STYLES, dashStyleById, findDashStyle } from '../shared/dashStyles.ts';
import type { Point } from './point.ts';
import { teamById } from './directory.ts';

export interface DashCtx {
  preset: string;
  columns: BlockId[];
  style: string;
  filter: DashGroup | null;
  density: 'normal' | 'large';
  locked?: boolean;
}
const blockIds = BLOCKS.map((b) => b.id);
const presetIds = PRESETS.map((p) => p.id);
const groupIds = DASH_GROUPS.map((g) => g.id);

/** Разобрать присланное с клиента описание стены (что сейчас на ней). */
export function parseDashCtx(x: unknown): DashCtx | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const columns = Array.isArray(o.columns) ? (o.columns as unknown[]).filter((c): c is BlockId => typeof c === 'string' && (blockIds as string[]).includes(c)) : [];
  return {
    preset: typeof o.preset === 'string' ? o.preset : 'custom',
    columns,
    style: typeof o.style === 'string' ? o.style : '',
    filter: typeof o.filter === 'string' && (groupIds as string[]).includes(o.filter) ? (o.filter as DashGroup) : null,
    density: o.density === 'large' ? 'large' : 'normal',
    locked: o.locked === true,
  };
}

export const DASH_TOOL = {
  type: 'function',
  function: {
    name: 'dashboard',
    description: 'Перестроить видеостену (дашборд координатора): раскладка, блоки по колонкам, стиль оформления, фильтр по группе, размер, крупный показ инцидента, настройки дашборда.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['preset', 'show', 'hide', 'swap', 'replace', 'wider', 'narrower', 'filter', 'style', 'density', 'focus', 'toggle', 'settings', 'reset'] },
        preset: { type: 'string', enum: presetIds, description: `готовая раскладка: ${PRESETS.map((p) => `${p.id} — ${p.name}`).join('; ')}` },
        block: { type: 'string', enum: blockIds, description: `блок: ${BLOCKS.map((b) => `${b.id} — ${b.name}`).join('; ')}` },
        block2: { type: 'string', enum: blockIds, description: 'второй блок — для swap' },
        position: { type: 'string', description: 'колонка: left, center, right или номер 1–4 (для show, replace, swap)' },
        position2: { type: 'string', description: 'вторая колонка для swap' },
        style: { type: 'string', description: `стиль: ${DASH_STYLES.map((s) => `${s.id} — ${s.name}`).join('; ')}` },
        group: { type: 'string', enum: [...groupIds, 'all'], description: 'фильтр: crit — критические, coord — на координаторах, high — высокий, research — исследование, all — все' },
        id: { type: 'string', description: 'для focus: id инцидента или top — самый срочный; пусто — убрать крупный показ' },
        what: { type: 'string', enum: ['counters', 'ticker', 'onlyFile', 'sound'], description: 'для toggle: шапка со счётчиками, бегущая строка, только файл ITSM, звук тревоги' },
        on: { type: 'boolean' },
        value: { type: 'string', enum: ['large', 'normal'], description: 'для density' },
      },
      required: ['op'],
    },
  },
};

export const DESIGN_TOOL = {
  type: 'function',
  function: {
    name: 'design_dashboard',
    description: 'Придумать новое оформление видеостены по описанию словами (ChatGPT): «сделай в цветах моря», «строго и по-деловому», «новогоднее с золотом». Для готовых стилей из списка используй dashboard op=style.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'описание оформления словами человека' } }, required: ['prompt'] },
  },
};

export const BLOCK_TOOL = {
  type: 'function',
  function: {
    name: 'create_block',
    description: 'Собрать новый блок для стены по описанию словами (ChatGPT): список, число, полосы, заметку — или нового персонажа (character=true), который будет комментировать обстановку; ему GPT нарисует портрет. Для готовых блоков используй dashboard op=show.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'что должно быть в блоке или какой персонаж — словами человека' }, character: { type: 'boolean' } }, required: ['prompt'] },
  },
};

export const DASH_NOTE = `Видеостену (дашборд координатора) перестраивай инструментом dashboard — это главный экран пункта. Примеры: «поменяй местами левый и правый блоки» → op=swap, position=left, position2=right; «покажи только критические» → op=filter, group=crit; «покажи все» → group=all; «добавь карту» → op=show, block=map; «убери ленту» → op=hide, block=events; «замени справа на историю передач» → op=replace, position=right, block=transfers; «сделай неон» → op=style; «крупнее» → op=density, value=large; «покажи крупно самый срочный» → op=focus, id=top; «раскладка четыре группы» → op=preset; «верни как было» → op=reset; «настройки дашборда» → op=settings. Если просят своё оформление словами, которого нет в списке стилей, — design_dashboard с описанием. Если просят новый блок, которого нет среди готовых, или нового персонажа — create_block. После действия скажи одной короткой фразой, что изменилось на стене.`;

export function dashContextLine(c: DashCtx | null): string {
  if (!c) return '';
  return `${c.locked ? 'Интерфейс закреплён (менять стену нельзя). ' : ''}Видеостена: раскладка «${PRESET_NAME[c.preset as PresetId] ?? 'своя'}», колонки слева направо: ${c.columns.map((b) => BLOCK_NAME[b]).join(', ') || '—'}; стиль «${dashStyleById(c.style).name}»${c.filter ? `; фильтр: только «${GROUP_NAME[c.filter]}»` : ''}${c.density === 'large' ? '; крупный шрифт' : ''}.`;
}

function pos(v: unknown, c: DashCtx | null, fallback: number): number {
  const n = c?.columns.length ?? 3;
  const s = String(v ?? '').toLowerCase();
  if (/^\d$/.test(s)) return Math.min(n - 1, Math.max(0, Number(s) - 1));
  if (/left|лев|перв/.test(s)) return 0;
  if (/right|прав|послед/.test(s)) return -1;
  if (/center|centre|центр|серед|middle/.test(s)) return Math.floor(n / 2);
  return fallback;
}

/** Аргументы инструмента → команда для стены и что сделано человеческим языком. */
export function toDashOp(a: Record<string, unknown>, c: DashCtx | null, point: Point): { cmd: DashOp; done: string } {
  const op = String(a.op ?? '');
  if (c?.locked && op !== 'focus' && op !== 'settings') throw new Error('интерфейс закреплён за сотрудником — сначала открепите его в настройках дашборда');
  const block = (v: unknown) => {
    const b = String(v ?? '') as BlockId;
    if (!blockIds.includes(b)) throw new Error('нет такого блока');
    return b;
  };
  switch (op) {
    case 'preset': {
      const p = String(a.preset ?? '') as PresetId;
      if (!presetIds.includes(p)) throw new Error('нет такой раскладки');
      return { cmd: { op: 'preset', preset: p }, done: `Стена: раскладка «${PRESET_NAME[p]}»` };
    }
    case 'show': {
      const b = block(a.block);
      return { cmd: { op: 'show', block: b, at: a.position !== undefined ? Math.max(0, pos(a.position, c, c?.columns.length ?? 0)) : undefined }, done: `Стена: добавил «${BLOCK_NAME[b]}»` };
    }
    case 'hide': {
      const b = block(a.block);
      return { cmd: { op: 'hide', block: b }, done: `Стена: убрал «${BLOCK_NAME[b]}»` };
    }
    case 'swap': {
      let x = pos(a.position, c, 0);
      let y = pos(a.position2, c, -1);
      if (a.block && c) x = Math.max(0, c.columns.indexOf(block(a.block)));
      if (a.block2 && c) y = Math.max(0, c.columns.indexOf(block(a.block2)));
      return { cmd: { op: 'swap', a: x, b: y }, done: 'Стена: поменял блоки местами' };
    }
    case 'replace': {
      const b = block(a.block);
      return { cmd: { op: 'replace', at: pos(a.position, c, -1), block: b }, done: `Стена: поставил «${BLOCK_NAME[b]}»` };
    }
    case 'wider':
    case 'narrower': {
      const b = block(a.block);
      return { cmd: { op: 'wider', block: b, by: op === 'wider' ? 0.4 : -0.4 }, done: `Стена: «${BLOCK_NAME[b]}» ${op === 'wider' ? 'шире' : 'уже'}` };
    }
    case 'filter': {
      const g = String(a.group ?? 'all');
      const group = (groupIds as string[]).includes(g) ? (g as DashGroup) : null;
      return { cmd: { op: 'filter', group }, done: group ? `Стена: только «${GROUP_NAME[group]}»` : 'Стена: все группы' };
    }
    case 'style': {
      const raw = String(a.style ?? '');
      const s = DASH_STYLES.find((x) => x.id === raw) ?? findDashStyle(raw);
      if (!s) throw new Error('нет такого стиля');
      return { cmd: { op: 'style', style: s.id }, done: `Стена: стиль «${s.name}»` };
    }
    case 'density': {
      const v = a.value === 'normal' ? 'normal' : 'large';
      return { cmd: { op: 'density', value: v }, done: v === 'large' ? 'Стена: крупный шрифт' : 'Стена: обычный размер' };
    }
    case 'focus': {
      const raw = String(a.id ?? '');
      if (!raw) return { cmd: { op: 'focus', id: null }, done: 'Стена: убрал крупный показ' };
      const inc = raw === 'top' ? dashSnapshot(point.incidents.values(), Date.now(), { filter: c?.filter ?? null }).action[0]?.inc : point.incidents.get(raw);
      if (!inc) throw new Error(raw === 'top' ? 'сейчас ничего не требует действия' : 'нет такого инцидента');
      return { cmd: { op: 'focus', id: inc.id }, done: `Стена: крупно «${inc.title}»` };
    }
    case 'toggle': {
      const what = String(a.what ?? '');
      if (!['counters', 'ticker', 'onlyFile', 'sound'].includes(what)) throw new Error('не знаю, что переключить');
      const on = a.on !== false;
      const name = { counters: 'шапка со счётчиками', ticker: 'бегущая строка', onlyFile: 'только файл ITSM', sound: 'звук тревоги' }[what];
      return { cmd: { op: 'toggle', what: what as 'counters', on }, done: `Стена: ${name} — ${on ? 'вкл.' : 'выкл.'}` };
    }
    case 'settings':
      return { cmd: { op: 'settings', open: a.on !== false }, done: a.on !== false ? 'Открыл настройки дашборда' : 'Закрыл настройки дашборда' };
    case 'reset':
      return { cmd: { op: 'reset' }, done: 'Стена: раскладка по умолчанию' };
  }
  throw new Error('не понял, что сделать со стеной');
}

// ─── команды стене без модели ──────────────────────────────────────────────
const BLOCK_WORDS: [RegExp, BlockId][] = [
  [/час[ыа]|время/, 'clock'],
  [/счётчик|счетчик|цифры групп/, 'counters'],
  [/риск/, 'risk'],
  [/кому передать|подсказк.*передат/, 'route'],
  [/команд[ыа] /, 'teams'],
  [/заметк/, 'note'],
  [/карт/, 'map'],
  [/лент|событ/, 'events'],
  [/помощник|ассистент/, 'assistant'],
  [/передач|истори/, 'transfers'],
  [/цифр|статист/, 'stats'],
  [/четыре групп|групп/, 'groups'],
  [/в работе|у команд|таблиц/, 'work'],
  [/требует|действи|срочн/, 'action'],
  [/сменяем|карусел/, 'rotate'],
];
const findBlocks = (t: string) => BLOCK_WORDS.filter(([re]) => re.test(t)).map(([, b]) => b);

/** Если это команда стене — выполнить через run и вернуть ответ; иначе null. */
export function dashRules(t: string, c: DashCtx | null, run: (a: Record<string, unknown>) => string, onWall: boolean): string | null {
  const ok = (r: string, say: string) => (r.startsWith('!') ? `Не могу: ${r.slice(1)}.` : say);
  const aboutWall = /стен|дашборд|табло|блок|колонк|раскладк|стил|оформлен/.test(t);
  if (/настройк/.test(t) && /дашборд|стен/.test(t)) return ok(run({ op: 'settings', on: !/закрой/.test(t) }), 'Настройки дашборда, сэр.');
  if (/крупно|крупным планом|на весь экран/.test(t) && /срочн|главн|важн|критич|инцидент/.test(t)) return ok(run({ op: 'focus', id: 'top' }), 'Показываю крупно самый срочный, сэр.');
  if (/(сбрось|верни как было|по умолчанию)/.test(t) && (aboutWall || onWall || /как было/.test(t))) return ok(run({ op: 'reset' }), 'Вернул стену как было, сэр.');
  if (/прежн|стар(ую|ая) стен|как раньше/.test(t)) return ok(run({ op: 'preset', preset: 'legacy' }), 'Включил прежнюю стену, сэр.');
  const style = findDashStyle(t);
  if (style && (/стил|оформлен/.test(t) || ((aboutWall || onWall) && /сделай|включи|поставь/.test(t)))) return ok(run({ op: 'style', style: style.id }), `Стиль «${style.name}», сэр.`);
  if (/(создай|добавь|придумай|сделай|нарисуй).*(персонаж)/.test(t)) return ok(run({ op: '__block', prompt: t, character: true }), 'Придумываю персонажа через ChatGPT. Портрет нарисую примерно за минуту.');
  if (/(создай|придумай|собери|сделай)( мне)? (новый |свой )?блок/.test(t)) return ok(run({ op: '__block', prompt: t, character: false }), 'Собираю новый блок через ChatGPT, через несколько секунд он появится на стене.');
  if (/(придумай|нарисуй|сделай|создай|оформи).*(дизайн|оформлени|стил|в цветах|в духе)/.test(t) && !style) return ok(run({ op: '__design', prompt: t }), 'Придумываю оформление через ChatGPT, сэр. Через несколько секунд стена изменится.');
  if (/раскладк|режим|вид стены/.test(t)) {
    const p = /четыре групп|групп/.test(t) ? 'groups' : /ии.?центр|помощник/.test(t) ? 'ai' : /критичн/.test(t) ? 'critical' : /ноч/.test(t) ? 'night' : /карт/.test(t) ? 'map' : /кейс|три экрана|основн/.test(t) ? 'case' : null;
    if (p) return ok(run({ op: 'preset', preset: p }), `Раскладка «${PRESET_NAME[p as PresetId]}», сэр.`);
  }
  if (/(все группы|сними фильтр|убери фильтр|покажи вс[её]|все инциденты)/.test(t)) return ok(run({ op: 'filter', group: 'all' }), 'Показываю все группы, сэр.');
  const only = /только/.test(t) ? (/критич|наивысш/.test(t) ? 'crit' : /координатор|на пункте|на кц/.test(t) ? 'coord' : /высок/.test(t) ? 'high' : /исследован/.test(t) ? 'research' : null) : null;
  if (only) return ok(run({ op: 'filter', group: only }), `Только «${GROUP_NAME[only as DashGroup]}», сэр.`);
  if (/помен|переставь|местами/.test(t)) {
    const blocks = findBlocks(t);
    const args: Record<string, unknown> = { op: 'swap' };
    if (blocks.length >= 2) Object.assign(args, { block: blocks[0], block2: blocks[1] });
    else if (/лев.*центр|центр.*лев/.test(t)) Object.assign(args, { position: 'left', position2: 'center' });
    else if (/центр.*прав|прав.*центр/.test(t)) Object.assign(args, { position: 'center', position2: 'right' });
    else Object.assign(args, { position: 'left', position2: 'right' });
    return ok(run(args), 'Поменял местами, сэр.');
  }
  if (/бегущ/.test(t)) return ok(run({ op: 'toggle', what: 'ticker', on: !/убери|скрой|выключи/.test(t) }), 'Готово, сэр.');
  if (/шапк|счётчик|счетчик/.test(t) && (aboutWall || onWall)) return ok(run({ op: 'toggle', what: 'counters', on: !/убери|скрой|выключи/.test(t) }), 'Готово, сэр.');
  if (/крупнее|покрупнее|крупный шрифт/.test(t)) return ok(run({ op: 'density', value: 'large' }), 'Сделал крупнее, сэр.');
  if (/мельче|обычный размер/.test(t) && (aboutWall || onWall)) return ok(run({ op: 'density', value: 'normal' }), 'Обычный размер, сэр.');
  const blocks = findBlocks(t);
  if (blocks.length && (aboutWall || onWall || /карт|лент|помощник|передач/.test(t))) {
    const b = blocks[0];
    if (/убери|скрой|спрячь|удали/.test(t)) return ok(run({ op: 'hide', block: b }), `Убрал «${BLOCK_NAME[b]}», сэр.`);
    if (/шире|расширь|больше места/.test(t)) return ok(run({ op: 'wider', block: b }), `Сделал «${BLOCK_NAME[b]}» шире, сэр.`);
    if (/сузь|поуже|меньше места/.test(t)) return ok(run({ op: 'narrower', block: b }), `Сделал «${BLOCK_NAME[b]}» уже, сэр.`);
    const where = /слева|влево|лев/.test(t) ? 'left' : /справа|вправо|прав/.test(t) ? 'right' : /центр|середин/.test(t) ? 'center' : null;
    if (/замени|поставь/.test(t) && where) return ok(run({ op: 'replace', block: b, position: where }), `Поставил «${BLOCK_NAME[b]}», сэр.`);
    if (/добавь|покажи|верни|выведи|включи/.test(t)) {
      if (c?.columns.includes(b)) return `«${BLOCK_NAME[b]}» уже на стене, сэр.`;
      return ok(run({ op: 'show', block: b, ...(where ? { position: where } : {}) }), `Добавил «${BLOCK_NAME[b]}», сэр.`);
    }
  }
  return null;
}

// ─── «Главное сейчас» по правилам (если модель недоступна) ────────────────
export function briefByRules(point: Point): string {
  const now = Date.now();
  const s = dashSnapshot(point.incidents.values(), now);
  const top = s.action[0];
  const parts: string[] = [];
  if (top) parts.push(`Главное — «${top.inc.title}»: ${top.att.reason.toLowerCase()}.`);
  else parts.push('Срочного нет — всё под контролем.');
  parts.push(`Критических ${s.counts.crit}, на координаторах ${s.counts.coord}, срок под угрозой у ${s.counts.threat}.`);
  const route = s.byGroup.coord.find((i) => i.ai?.teamId);
  if (route) parts.push(`«${route.title}» лучше передать в «${teamById(route.ai.teamId)?.name ?? route.ai.teamId}».`);
  const risk = s.action
    .map((x) => x.inc)
    .filter((i) => i.priority !== 'P1')
    .map((i) => ({ i, r: riskOf(i, now) }))
    .sort((a, b) => b.r.score - a.r.score)[0];
  if (risk && risk.r.score >= 55) parts.push(`Может стать критическим: «${risk.i.title}» (${risk.r.score}%).`);
  return parts.join(' ');
}
/** Данные для выжимки моделью: числа и самые срочные с причинами. */
export function briefContext(point: Point): { key: string; text: string } {
  const now = Date.now();
  const s = dashSnapshot(point.incidents.values(), now);
  const top = s.action.slice(0, 7);
  const lines = [
    `Критических ${s.counts.crit}, на координаторах ${s.counts.coord}, высокий ${s.counts.high}, исследование ${s.counts.research}; срок под угрозой ${s.counts.threat}, не берут 10+ мин ${s.counts.notTaken}, повторные передачи ${s.counts.pingpong}; решено за час ${s.counts.doneHour}.`,
    ...top.map(({ inc, att }) => {
      const r = riskOf(inc, now);
      return `- «${inc.title}» (${inc.productName || inc.service}): ${att.reason}; ${inc.status === 'coordinators' ? 'на координаторах' : `у «${teamById(inc.teamId)?.name ?? '—'}»`}${inc.status === 'coordinators' && inc.ai?.teamId ? `; ИИ советует «${teamById(inc.ai.teamId)?.name}»` : ''}${r.score >= 50 ? `; риск стать критическим ${r.score}%` : ''}; до срока ${inc.slaDeadline > now ? fmtShort(inc.slaDeadline - now) : 'прошёл'}`;
    }),
  ];
  return { key: top.map((x) => `${x.inc.id}:${x.att.tone}:${x.inc.priority}:${x.inc.status}`).join('|') + `#${s.counts.crit}/${s.counts.coord}`, text: lines.join('\n') };
}
