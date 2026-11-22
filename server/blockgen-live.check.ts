// Живая проверка блоков от ChatGPT: на типичные просьбы — какой вид, группировка и период выбраны.
// Запуск: npx tsx --env-file=.env server/blockgen-live.check.ts
import { makeBlock } from './blockgen.ts';

const asks: [string, (s: { kind: string; groupBy?: string; filter?: { period?: string } }) => boolean][] = [
  ['диаграмму по сегодняшним задачам', (s) => s.kind === 'donut' && s.filter?.period === 'today'],
  ['как шла нагрузка по часам за смену', (s) => s.kind === 'hours' && !!s.filter?.period],
  ['сколько инцидентов у каждой команды', (s) => s.kind === 'bars' && s.groupBy === 'team'],
  ['распределение открытых инцидентов по статусам', (s) => s.kind === 'donut' && s.groupBy === 'status'],
  ['сколько критических сейчас', (s) => s.kind === 'counter'],
];
let ok = 0;
for (const [ask, good] of asks) {
  const t0 = Date.now();
  try {
    const r = await makeBlock(ask, false);
    const pass = good(r.spec as never);
    if (pass) ok++;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${String(Date.now() - t0).padStart(6)} мс  «${ask}» → ${r.spec.kind}${r.spec.groupBy ? ` / ${r.spec.groupBy}` : ''}${r.spec.filter?.period ? ` / ${r.spec.filter.period}` : ''} · «${r.spec.title}» · ${r.w}×${r.h} · ${r.model}`);
  } catch (e) {
    console.log(`FAIL «${ask}» → ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\nитог: ${ok}/${asks.length}`);
