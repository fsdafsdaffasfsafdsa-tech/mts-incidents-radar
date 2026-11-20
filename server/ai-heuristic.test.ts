import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.ts';
import { TEMPLATES } from './catalog.ts';
import { assessRisk, briefOf, buildContext, findCorrelation, heuristicInsight } from './ai-heuristic.ts';

test('подсказка команды совпадает с эталоном генератора в большинстве случаев', () => {
  const sim = new Sim();
  let hits = 0;
  let total = 0;
  const misses = new Map<string, number>();
  for (let round = 0; round < 6; round++) {
    for (const template of TEMPLATES) {
      const inc = sim.spawn({ template, quiet: true, seed: true, status: 'coordinators', createdAt: Date.now() - round * 3_600_000 });
      const ctx = buildContext(new Map([[inc.id, inc]]), Date.now());
      const b = briefOf(inc, ctx);
      total++;
      if (b.teamId === template.team) hits++;
      else misses.set(template.title, (misses.get(template.title) ?? 0) + 1);
    }
  }
  const acc = hits / total;
  assert.ok(acc >= 0.9, `точность ${Math.round(acc * 100)}%, промахи: ${[...misses.keys()].join(' | ')}`);
});

test('риск растёт по мере истечения SLA и при нарушении', () => {
  const sim = new Sim();
  const template = TEMPLATES[0];
  const now = Date.now();
  const fresh = sim.spawn({ template, quiet: true, seed: true, priority: 'P2', status: 'in_progress', trend: 'stable', users: 50_000, createdAt: now });
  const late = sim.spawn({ template, quiet: true, seed: true, priority: 'P2', status: 'in_progress', trend: 'stable', users: 50_000, createdAt: now - 230 * 60_000 });
  const broken = sim.spawn({ template, quiet: true, seed: true, priority: 'P2', status: 'in_progress', trend: 'stable', users: 50_000, createdAt: now - 260 * 60_000 });
  const ctx = (i: typeof fresh) => buildContext(new Map([[i.id, i]]), now);
  const r1 = assessRisk(fresh, ctx(fresh)).score;
  const r2 = assessRisk(late, ctx(late)).score;
  const r3 = assessRisk(broken, ctx(broken)).score;
  assert.ok(r1 < r2 && r2 < r3, `${r1} < ${r2} < ${r3}`);
  assert.ok(r1 < 50 && r3 >= 50);
});

test('каскад биллинга: последствие указывает на первопричину', () => {
  const sim = new Sim();
  const root = sim.spawn({ template: TEMPLATES[0], quiet: true, seed: true, priority: 'P1', status: 'coordinators', region: 'Москва' });
  const appTemplate = TEMPLATES.find((t) => t.system === 'app' && t.team === 'platform_sre')!;
  const child = sim.spawn({ template: appTemplate, quiet: true, seed: true, priority: 'P2', status: 'coordinators', region: 'Москва' });
  const ctx = buildContext(new Map([[root.id, root], [child.id, child]]), Date.now());
  const corr = findCorrelation(child, ctx);
  assert.equal(corr?.rootId, root.id);
  const insight = heuristicInsight(child, ctx);
  assert.match(insight.summary, /Мой МТС/);
  assert.ok(insight.nextSteps.some((s) => s.includes(root.id)));
});

test('причина не может появиться позже следствия и быть слабее его', () => {
  const sim = new Sim();
  const now = Date.now();
  const billing = sim.spawn({ template: TEMPLATES[0], quiet: true, seed: true, priority: 'P1', status: 'coordinators', createdAt: now - 60_000 });
  const dcTemplate = TEMPLATES.find((t) => t.system === 'dc')!;
  const laterDc = sim.spawn({ template: dcTemplate, quiet: true, seed: true, priority: 'P1', status: 'coordinators', createdAt: now });
  const weakerDc = sim.spawn({ template: dcTemplate, quiet: true, seed: true, priority: 'P2', status: 'coordinators', createdAt: now - 120_000 });
  const ctx = buildContext(new Map([[billing.id, billing], [laterDc.id, laterDc], [weakerDc.id, weakerDc]]), now);
  const corr = findCorrelation(billing, ctx);
  assert.notEqual(corr?.rootId, laterDc.id);
  assert.notEqual(corr?.rootId, weakerDc.id);
});

test('атака — сама себе первопричина, даже если выше по зависимости уже есть P1', () => {
  const sim = new Sim();
  const now = Date.now();
  const apiTemplate = TEMPLATES.find((t) => t.system === 'api' && t.title.includes('5xx'))!;
  const ddosTemplate = TEMPLATES.find((t) => t.team === 'soc')!;
  const api = sim.spawn({ template: apiTemplate, quiet: true, seed: true, priority: 'P1', status: 'in_progress', createdAt: now - 3 * 60_000 });
  const ddos = sim.spawn({ template: ddosTemplate, quiet: true, seed: true, priority: 'P1', status: 'coordinators', createdAt: now });
  const ctx = buildContext(new Map([[api.id, api], [ddos.id, ddos]]), now);
  assert.equal(findCorrelation(ddos, ctx)?.rootId, ddos.id);
  assert.equal(briefOf(ddos, ctx).teamId, 'soc');
});
