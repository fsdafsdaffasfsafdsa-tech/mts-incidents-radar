// Отчёт смены в PDF для руководства: итоги дежурного и пункта, графики, открытые и решённые инциденты,
// разборы по главным решённым (черновики ИИ). Собирается в браузере (pdfmake, шрифт Roboto с кириллицей),
// библиотека грузится только когда отчёт нужен — сайт от неё не тяжелеет.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Incident, Priority, Review } from '../../shared/types';
import { PRIORITY_TEXT } from '../../shared/types';
import { myShiftWork } from '../../shared/shift';
import { getState, serverNow, teamName } from '../store';

const H = 3_600_000;
const SHIFT = 12 * H;
const C = { ink: '#1d2433', muted: '#6b7689', line: '#e3e7ee', tile: '#f4f6f9', accent: '#ff3150', blue: '#5b8cff', green: '#22b573', amber: '#f0a020' };
const PC: Record<Priority, string> = { P1: '#e3142d', P2: '#f07a1a', P3: '#d9b300', P4: '#5b8cff' };
const W = 523; // ширина полосы A4 при полях 36
const RESOLVED_ROWS = 12;

const tz = { timeZone: 'Europe/Moscow' } as const;
const hm = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { ...tz, hour: '2-digit', minute: '2-digit' });
const day = (t: number) => new Date(t).toLocaleDateString('ru-RU', { ...tz, day: '2-digit', month: '2-digit', year: 'numeric' });
const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};
const where = (i: Incident) => (i.status === 'coordinators' ? `на пункте${i.coordinatorName ? `, ведёт ${i.coordinatorName}` : ', без дежурного'}` : `${teamName(i.teamId)}${i.assigneeName ? `, ${i.assigneeName}` : ''}`);

/** Столбики по часам: заведено (синий) и решено (зелёный), подписи часов — строкой под графиком. */
function hourlyChart(buckets: { label: string; a: number; b: number }[]): Content {
  const h = 96;
  const max = Math.max(1, ...buckets.flatMap((x) => [x.a, x.b]));
  const slot = W / buckets.length;
  const bw = Math.min(14, slot * 0.32);
  const shapes = [{ type: 'line' as const, x1: 0, y1: h, x2: W, y2: h, lineWidth: 0.6, lineColor: C.line }];
  buckets.forEach((x, k) => {
    const cx = slot * k + slot / 2;
    const ha = (x.a / max) * (h - 8);
    const hb = (x.b / max) * (h - 8);
    if (x.a) shapes.push({ type: 'rect', x: cx - bw - 1, y: h - ha, w: bw, h: ha, color: C.blue, r: 2 } as never);
    if (x.b) shapes.push({ type: 'rect', x: cx + 1, y: h - hb, w: bw, h: hb, color: C.green, r: 2 } as never);
  });
  return {
    stack: [
      { canvas: shapes, margin: [0, 4, 0, 2] },
      { columns: buckets.map((x) => ({ text: x.label, alignment: 'center', fontSize: 7, color: C.muted })), columnGap: 0 },
      { columns: buckets.map((x) => ({ text: x.a || x.b ? `${x.a}/${x.b}` : '', alignment: 'center', fontSize: 6.5, color: C.muted })), columnGap: 0, margin: [0, 1, 0, 0] },
    ],
  };
}

/** Горизонтальные полосы: подпись, полоса, число. Ширина — полколонки (W − 40) / 2, без внутренних отступов таблицы. */
function barList(rows: { label: string; value: number; color: string }[], width = 240): Content {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const LABEL = 100;
  const NUM = 22;
  const GAP = 8;
  const bar = width - LABEL - NUM - GAP * 2 - 2;
  return {
    table: {
      widths: [LABEL, bar, NUM],
      body: rows.map((r) => [
        { text: r.label, fontSize: 8.5, margin: [0, 2, 0, 2] },
        r.value ? { canvas: [{ type: 'rect', x: 0, y: 5, w: Math.max(3, (bar * r.value) / max), h: 8, r: 2, color: r.color }] } : { text: '' },
        { text: String(r.value), alignment: 'right', bold: true, fontSize: 8.5, margin: [0, 2, 0, 2], color: r.value ? C.ink : C.muted },
      ]),
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: (k: number) => (k === 0 ? 0 : GAP), paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
  };
}

const tile = (value: string, label: string, color = C.ink): Content => ({
  stack: [
    { text: value, fontSize: 18, bold: true, color },
    { text: label, fontSize: 8, color: C.muted, margin: [0, 1, 0, 0] },
  ],
  fillColor: C.tile,
  margin: [8, 7, 8, 7],
});
// headlineLevel — чтобы заголовок не оставался один внизу страницы (см. pageBreakBefore ниже).
const section = (t: string): Content => ({ text: t, style: 'h2', headlineLevel: 1 }) as Content;

async function fetchReviews(ids: string[]): Promise<Review[]> {
  const one = (id: string) =>
    Promise.race([
      fetch(`/api/reviews/${id}`).then((r) => (r.ok ? (r.json() as Promise<Review>) : null)),
      new Promise<null>((ok) => setTimeout(() => ok(null), 30_000)),
    ]).catch(() => null);
  return (await Promise.all(ids.map(one))).filter((r): r is Review => !!r);
}

export async function buildShiftReport(): Promise<{ doc: TDocumentDefinitions; name: string }> {
  const s = getState();
  const me = s.me!;
  const now = serverNow();
  const from = now - SHIFT;
  const all = [...s.incidents.values()];

  // ── вы за смену ──
  const { taken, routed, avgRouteMs: avgRoute } = myShiftWork(all, me.name, from);
  const mine = all.filter((i) => i.coordinatorId === me.personId);
  const solvedMine = mine.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from).length;

  // ── пункт за смену ──
  const created = all.filter((i) => i.createdAt > from);
  const resolved = all.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const open = all.filter((i) => i.status !== 'resolved');
  const aiActs = all.reduce((n, i) => n + i.history.filter((h) => h.kind === 'ai' && h.at > from).length, 0);
  let advice = 0;
  let accepted = 0;
  for (const i of all)
    for (const h of i.history)
      if (h.at > from && h.kind === 'ai') {
        if (/^Совпало с советом ИИ/.test(h.text)) (advice++, accepted++);
        else if (/^ИИ советовал/.test(h.text)) advice++;
      }
  const fromComplaints = created.filter((i) => i.origin === 'complaints').length;
  const signals = [...s.signals.values()].filter((x) => x.status === 'open').length;
  const requests = [...s.requests.values()].filter((x) => x.status === 'pending').length;

  // ── графики ──
  const start = Math.floor(from / H) * H + H;
  const hourly = Array.from({ length: 12 }, (_, k) => {
    const a0 = start + k * H - H;
    const a1 = a0 + H;
    return { label: new Date(a1).toLocaleTimeString('ru-RU', { ...tz, hour: '2-digit' }), a: created.filter((i) => i.createdAt >= a0 && i.createdAt < a1).length, b: resolved.filter((i) => (i.resolvedAt ?? 0) >= a0 && (i.resolvedAt ?? 0) < a1).length };
  });
  const levels = (['P1', 'P2', 'P3', 'P4'] as Priority[]).map((p) => ({ label: PRIORITY_TEXT[p], value: created.filter((i) => i.priority === p).length, color: PC[p] }));
  const svc = new Map<string, number>();
  for (const i of created) {
    const k = i.origin === 'complaints' ? i.service : i.productName;
    svc.set(k, (svc.get(k) ?? 0) + 1);
  }
  const services = [...svc].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label: label.length > 22 ? `${label.slice(0, 21)}…` : label, value, color: C.blue }));
  const byTeam = new Map<string, { n: number; t: number }>();
  for (const i of resolved) {
    const k = teamName(i.teamId);
    const x = byTeam.get(k) ?? { n: 0, t: 0 };
    x.n++;
    x.t += (i.resolvedAt ?? now) - i.createdAt;
    byTeam.set(k, x);
  }
  const teams = [...byTeam].sort((a, b) => b[1].n - a[1].n).slice(0, 6);

  // ── таблицы ──
  const RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
  const openTop = [...open].sort((a, b) => Number(!!b.p1Proposal) - Number(!!a.p1Proposal) || RANK[a.priority] - RANK[b.priority] || a.slaDeadline - b.slaDeadline).slice(0, 12);
  const prio = (i: Incident): Content => ({ text: PRIORITY_TEXT[i.priority], color: PC[i.priority], bold: true, fontSize: 8 });
  const head = (cols: string[]) => cols.map((t) => ({ text: t, bold: true, fontSize: 8, color: C.muted }));
  const tableLayout = { hLineWidth: (k: number) => (k === 1 ? 0.8 : 0.4), vLineWidth: () => 0, hLineColor: () => C.line, paddingTop: () => 3, paddingBottom: () => 3 };

  // ── разборы по главным решённым ──
  const keyResolved = [...resolved].sort((a, b) => RANK[a.priority] - RANK[b.priority] || (b.complaints ?? 0) - (a.complaints ?? 0)).slice(0, 3);
  const reviews = await fetchReviews(keyResolved.map((i) => i.id));

  // ── что передать следующей смене ──
  const mineOpen = mine.filter((i) => i.status !== 'resolved');
  const p1wait = open.filter((i) => i.p1Proposal && i.priority !== 'P1');

  const content: Content[] = [
    {
      columns: [
        { canvas: [{ type: 'rect', x: 0, y: 2, w: 5, h: 40, r: 2, color: C.accent }], width: 14 },
        {
          stack: [
            { text: 'Отчёт смены', fontSize: 22, bold: true },
            { text: `Координирующий пункт ИТ · дежурный ${me.name}`, color: C.muted, margin: [0, 2, 0, 0] },
            { text: `${day(from)} ${hm(from)} — ${day(now)} ${hm(now)} МСК (12 часов) · сформирован ${hm(Date.now())}`, color: C.muted, fontSize: 8.5 },
          ],
        },
      ],
      margin: [0, 0, 0, 14],
    },
    section('Вы за смену'),
    {
      table: { widths: ['*', '*', '*', '*'], body: [[tile(String(taken), 'взяли на себя'), tile(String(routed), 'передали командам'), tile(String(solvedMine), 'решено из ваших', C.green), tile(avgRoute === null ? '—' : dur(avgRoute), 'в среднем до передачи')]] },
      layout: { hLineWidth: () => 3, vLineWidth: () => 3, hLineColor: () => '#ffffff', vLineColor: () => '#ffffff' },
    },
    section('Пункт за смену'),
    {
      table: {
        widths: ['*', '*', '*', '*'],
        body: [
          [tile(String(created.length), `новых инцидентов, из жалоб — ${fromComplaints}`), tile(String(resolved.length), 'решено', C.green), tile(String(open.length), 'открыто сейчас'), tile(String(open.filter((i) => i.priority === 'P1' || i.p1Proposal).length), 'критических сейчас', C.accent)],
          [tile(String(aiActs), 'действий ИИ'), tile(advice ? `${Math.round((accepted / advice) * 100)}%` : '—', `передач по совету ИИ (${accepted} из ${advice})`, C.blue), tile(String(s.stats?.flowPerMin ?? 0), 'жалоб в минуту сейчас'), tile(`${signals} / ${requests}`, 'сигналов / запросов команд', signals ? C.amber : C.ink)],
        ],
      },
      layout: { hLineWidth: () => 3, vLineWidth: () => 3, hLineColor: () => '#ffffff', vLineColor: () => '#ffffff' },
    },
    section('Инциденты по часам'),
    { text: [{ text: '■ ', color: C.blue }, 'заведено   ', { text: '■ ', color: C.green }, 'решено   (числа под графиком: заведено / решено)'], fontSize: 8, color: C.muted },
    hourlyChart(hourly),
    {
      columns: [
        { stack: [section('По уровням (новые за смену)'), barList(levels)] },
        { stack: [section('Чаще всего — сервисы'), services.length ? barList(services) : { text: 'нет новых инцидентов', color: C.muted }] },
      ],
      columnGap: 40,
    },
    { text: '', pageBreak: 'before' },
    section('Передать следующей смене'),
    {
      ul: [
        mineOpen.length ? `У вас открыто ${mineOpen.length}: ${mineOpen.slice(0, 5).map((i) => `«${i.title}» (${where(i)})`).join('; ')}${mineOpen.length > 5 ? '…' : ''}` : 'У вас открытых инцидентов нет.',
        p1wait.length ? `ИИ предлагает «Наивысший» — решить: ${p1wait.map((i) => `«${i.title}»`).join('; ')}` : 'Предложений поднять до «Наивысшего» нет.',
        `Ждут пункт: запросов команд ${requests}, открытых сигналов ${signals}.`,
      ],
    },
    section('Открыто сейчас — главное'),
    openTop.length
      ? {
          table: {
            headerRows: 1,
            widths: [52, '*', 150, 62],
            body: [head(['Уровень', 'Инцидент', 'Где сейчас', 'До срока']), ...openTop.map((i) => [prio(i), { text: `${i.title}${i.p1Proposal ? '  · ИИ предлагает «Наивысший»' : ''}`, fontSize: 8.5 }, { text: where(i), fontSize: 8 }, { text: i.slaDeadline - now > 0 ? dur(i.slaDeadline - now) : 'прошёл', fontSize: 8, color: i.slaDeadline - now > 0 ? C.ink : C.accent }])],
          },
          layout: tableLayout,
        }
      : { text: 'Открытых инцидентов нет.', color: C.muted },
    section('Решено за смену'),
    resolved.length
      ? {
          table: {
            headerRows: 1,
            widths: [34, '*', 130, 56, 44],
            body: [
              head(['Время', 'Инцидент', 'Команда', 'Длилось', 'Совет ИИ']),
              ...resolved.slice(0, RESOLVED_ROWS).map((i) => [
                { text: hm(i.resolvedAt ?? now), fontSize: 8 },
                { text: i.title, fontSize: 8.5 },
                { text: teamName(i.teamId), fontSize: 8 },
                { text: dur((i.resolvedAt ?? now) - i.createdAt), fontSize: 8 },
                { text: i.history.some((h) => /^Совпало с советом ИИ/.test(h.text)) ? 'да' : '—', fontSize: 8, color: C.blue },
              ]),
            ],
          },
          layout: tableLayout,
        }
      : { text: 'За смену решённых нет.', color: C.muted },
    ...(resolved.length > RESOLVED_ROWS ? [{ text: `…и ещё ${resolved.length - RESOLVED_ROWS}`, color: C.muted, fontSize: 8, margin: [0, 3, 0, 0] } as Content] : []),
    ...(teams.length
      ? [
          section('Кто решал'),
          {
            table: { headerRows: 1, dontBreakRows: true, widths: ['*', 70, 110], body: [head(['Команда', 'Решено', 'Длилось в среднем']), ...teams.map(([t, x]) => [{ text: t, fontSize: 8.5 }, { text: String(x.n), fontSize: 8.5 }, { text: dur(x.t / x.n), fontSize: 8.5 }])] },
            layout: tableLayout,
          } as Content,
        ]
      : []),
  ];

  // Разборы идут сразу за таблицами; каждый целиком на странице, заголовок раздела — вместе с первым разбором.
  reviews.forEach((r, k) => {
    const body: Content = {
      stack: [
        { text: r.title, bold: true, fontSize: 11 },
        { text: `уровень «${r.facts.level}» · длительность ${dur(r.facts.durationMin * 60_000)}${r.facts.toTeamMin !== null ? ` · до передачи команде ${r.facts.toTeamMin} мин` : ''}${r.facts.complaints !== null ? ` · жалоб ${r.facts.complaints}` : ''} · команда «${r.facts.team}»`, color: C.muted, fontSize: 8, margin: [0, 2, 0, 5] },
        { text: [{ text: 'Кратко. ', bold: true }, r.summary] },
        { text: [{ text: 'Вероятная причина. ', bold: true }, r.cause], margin: [0, 3, 0, 0] },
        { text: [{ text: 'Что сделали. ', bold: true }, r.actions], margin: [0, 3, 0, 0] },
        { text: 'Что улучшить:', bold: true, margin: [0, 3, 0, 1] },
        { ul: r.lessons, fontSize: 9 },
      ],
      margin: [0, 0, 0, 12],
    };
    content.push(
      k === 0
        ? { stack: [{ text: 'Разборы главных инцидентов', style: 'h2' }, { text: 'Черновики разборов подготовил ИИ по истории инцидентов — проверьте перед отправкой.', color: C.muted, fontSize: 8.5, margin: [0, 0, 0, 8] }, body], unbreakable: true }
        : { stack: [body], unbreakable: true },
    );
  });

  const surname = me.name.split(' ')[0] ?? 'дежурный';
  const name = `Отчёт смены — ${surname} — ${day(now)} ${hm(now).replace(':', '-')}.pdf`;
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [36, 40, 36, 44],
    info: { title: `Отчёт смены — ${me.name}`, author: 'Координирующий пункт ИТ' },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: C.ink, lineHeight: 1.2 },
    styles: { h2: { fontSize: 11.5, bold: true, margin: [0, 14, 0, 6] } },
    // Заголовок раздела не остаётся последней строкой страницы — переносится к своей таблице.
    pageBreakBefore: (node: { headlineLevel?: number }, followingOnPage: unknown[]) => node.headlineLevel === 1 && followingOnPage.length === 0,
    footer: (page: number, pages: number) => ({ text: `Координирующий пункт ИТ · отчёт смены · ${me.name} · стр. ${page} из ${pages}`, alignment: 'center', fontSize: 7.5, color: C.muted, margin: [0, 16, 0, 0] }),
    content,
  };
  return { doc, name };
}

/** Собрать и скачать PDF. */
export async function downloadShiftReport(): Promise<string> {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  const pm = pdfMake as unknown as { vfs?: unknown; addVirtualFileSystem?: (v: unknown) => void; createPdf: (d: TDocumentDefinitions) => { download: (name: string, cb?: () => void) => void } };
  if (pm.addVirtualFileSystem) pm.addVirtualFileSystem(vfs);
  else pm.vfs = vfs;
  const { doc, name } = await buildShiftReport();
  await new Promise<void>((ok) => pm.createPdf(doc).download(name, ok));
  return name;
}
