// Сборка контуров регионов РФ для своей карты (без внешней подложки — карта появляется мгновенно).
//   npx tsx scripts/build-regions.ts <russia.geojson>  →  public/rf-regions.json
// Источник: GeoJSON субъектов РФ (click_that_hood, данные CartoDB/OSM). Скрипт упрощает контуры, округляет координаты,
// выравнивает обход колец под d3-geo и привязывает каждый контур к нашему региону по координатам его столицы.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoArea, geoContains } from 'd3-geo';
import { REGIONS } from '../server/regions.ts';

type Pt = [number, number];
type Ring = Pt[];
type Poly = Ring[];
const TOL = Number(process.env.TOL ?? 0.035); // градусы: ~2–4 км, на карте страны не видно
const DIGITS = 3;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as { features: { properties: { name: string }; geometry: { type: string; coordinates: unknown } }[] };

/** Дуглас–Пекер; долгота сжата на cos(широты), чтобы на севере не оставалось лишних точек. */
function simplify(ring: Ring): Ring {
  if (ring.length < 5) return ring;
  const k = Math.cos((ring[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(ring.length);
  // Кольцо замкнуто (первая точка = последней) — делим его в самой дальней от начала точке.
  let mid = 1;
  for (let i = 1; i < ring.length - 1; i++) if (Math.hypot((ring[i][0] - ring[0][0]) * k, ring[i][1] - ring[0][1]) > Math.hypot((ring[mid][0] - ring[0][0]) * k, ring[mid][1] - ring[0][1])) mid = i;
  keep[0] = keep[mid] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [
    [0, mid],
    [mid, ring.length - 1],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = [ring[a][0] * k, ring[a][1]];
    const [bx, by] = [ring[b][0] * k, ring[b][1]];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let far = -1;
    let dmax = TOL;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (ring[i][0] * k - ax) - dx * (ring[i][1] - ay)) / len;
      if (d > dmax) {
        dmax = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const r = 10 ** DIGITS;
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push([Math.round(ring[i][0] * r) / r, Math.round(ring[i][1] * r) / r]);
  return out;
}
const planarArea = (ring: Ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(s / 2) * Math.cos((ring[0][1] * Math.PI) / 180);
};
/** d3-geo считает внешним кольцом то, что обходит по часовой; иначе рисует «весь шар минус регион». */
function fixWinding(poly: Poly): Poly {
  return geoArea({ type: 'Polygon', coordinates: poly }) > 2 * Math.PI ? poly.map((r) => [...r].reverse()) : poly;
}

const features = src.features.map((f) => {
  const parts = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as Poly[];
  const polys: Poly[] = [];
  for (const p of parts) {
    const outer = simplify(p[0]);
    if (outer.length < 4) continue;
    const holes = p.slice(1).map(simplify).filter((h) => h.length >= 4 && planarArea(h) > 0.05);
    polys.push(fixWinding([outer, ...holes]));
  }
  // Мелкие острова отбрасываем (кроме случая, когда регион — только острова).
  const biggest = Math.max(...polys.map((p) => planarArea(p[0])));
  const kept = polys.filter((p) => planarArea(p[0]) > Math.min(0.03, biggest * 0.5));
  return { name: f.properties.name, g: kept, area: geoArea({ type: 'MultiPolygon', coordinates: kept }) };
});

// Привязка: регион — тот контур, в котором стоит его столица (из нескольких — самый маленький: Москва внутри области).
const byFeature = new Map<number, string>();
const missing: string[] = [];
for (const r of REGIONS) {
  const hits = features.map((f, k) => ({ f, k })).filter(({ f }) => geoContains({ type: 'MultiPolygon', coordinates: f.g }, [r.lon, r.lat]));
  hits.sort((a, b) => a.f.area - b.f.area);
  const hit = hits.find(({ k }) => !byFeature.has(k));
  if (hit) byFeature.set(hit.k, r.id);
  else missing.push(`${r.id} ${r.name}`);
}

const out = {
  source: 'Контуры субъектов РФ: click_that_hood (CartoDB/OpenStreetMap), упрощены',
  features: features.map((f, k) => ({ id: byFeature.get(k) ?? null, name: f.name, g: f.g })),
};
const file = path.join(root, 'public', 'rf-regions.json');
fs.writeFileSync(file, JSON.stringify(out));
const points = out.features.reduce((n, f) => n + f.g.reduce((m, p) => m + p.reduce((q, r) => q + r.length, 0), 0), 0);
console.log(`контуров: ${out.features.length}, привязано к нашим регионам: ${byFeature.size}/${REGIONS.length}, точек: ${points}, размер: ${(fs.statSync(file).size / 1024).toFixed(0)} КБ`);
if (missing.length) console.log('без контура:', missing.join(', '));
