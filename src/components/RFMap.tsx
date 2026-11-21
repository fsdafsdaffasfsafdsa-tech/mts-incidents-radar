// Карта России своя (SVG, контуры регионов в public/rf-regions.json) — появляется мгновенно, без внешней подложки.
// Оформление в одном стиле с объёмными миниатюрами городов: земля — плита с бортиком и мягкой тенью, регионы спокойные.
// Цвет только там, где есть смысл: регионы инцидента (цвет уровня) и настоящие всплески жалоб (жёлтый).
// На инцидент — один значок с числом жалоб; другие его регионы — точки, связанные с ним тонкими дугами.
// Фон жалоб — короткие «вспышки» без цифр. Миниатюры городов отходят в сторону от значков.
//
// Плавность: во время перетаскивания и колеса двигается HTML-слой с картой (видеокарта, без перерисовки),
// вид фиксируется в конце жеста. Регионы и данные считаются один раз и не перерисовываются от движения.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { geoConicConformal, geoGraticule, geoPath, type GeoProjection } from 'd3-geo';
import type { Incident, Region } from '../../shared/types';
import { readLocal, select, useStore, writeLocal } from '../store';
import { useNow } from '../lib/hooks';

interface GeoFeature {
  id: string | null;
  name: string;
  g: number[][][][];
}
let geoP: Promise<GeoFeature[]> | null = null;
const loadGeo = () =>
  (geoP ??= fetch('/rf-regions.json')
    .then((r) => r.json() as Promise<{ features: GeoFeature[] }>)
    .then((d) => d.features));

const MIN = 60_000;
const PRIO = { P1: 'var(--p1)', P2: 'var(--p2)', P3: 'var(--p3)', P4: 'var(--p4)' } as const;
type View = { k: number; x: number; y: number };
const ID: View = { k: 1, x: 0, y: 0 };
type Shape = { id: string | null; name: string; d: string; bounds: [[number, number], [number, number]] };
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

// Объёмные миниатюры достопримечательностей крупных городов (нарисованы в ChatGPT, public/landmarks/*.webp).
export const LANDMARKS: Record<string, string> = {
  msk: 'Кремль',
  spb: 'Исаакиевский собор',
  tat: 'Кул-Шариф',
  nsk: 'Оперный театр',
  svr: 'Храм на Крови',
  nnv: 'Нижегородский кремль',
  prim: 'Золотой мост',
  vgg: 'Родина-мать',
  sam: 'Монумент «Слава»',
  kry: 'Часовня Параскевы Пятницы',
  kgd: 'Кафедральный собор',
  mur: 'Ледокол «Ленин»',
};

/** Слой регионов: перерисовывается только когда меняется окраска, выбор или регион под курсором — не от движения. */
const RegionLayer = memo(function RegionLayer({ shapes, paint, sel, hoverId, onHover, onPick }: { shapes: Shape[]; paint: Map<string, { fill: string; stroke?: string }>; sel: Set<string>; hoverId: string | null; onHover: (id: string | null, e?: React.PointerEvent) => void; onPick: (id: string) => void }) {
  return (
    <>
      {shapes.map((s, k) => {
        const p = s.id ? paint.get(s.id) : undefined;
        return (
          <path
            key={k}
            d={s.d}
            className={`rf-region ${s.id ? 'ours' : ''} ${p?.stroke ? 'marked' : ''} ${s.id && sel.has(s.id) ? 'sel' : ''} ${s.id && hoverId === s.id ? 'hov' : ''}`}
            style={{ fill: p?.fill ?? (s.id ? 'var(--rf-land)' : 'var(--rf-none)'), stroke: p?.stroke }}
            onPointerMove={s.id ? (e) => onHover(s.id, e) : undefined}
            onPointerLeave={s.id ? () => onHover(null) : undefined}
            onClick={s.id ? () => onPick(s.id!) : undefined}
          />
        );
      })}
    </>
  );
});

export function RFMap({ forceTheme }: { forceTheme?: 'dark' | 'light' } = {}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pan = useRef<HTMLDivElement>(null); // слой, который двигается во время жеста
  const tip = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [geo, setGeo] = useState<GeoFeature[] | null>(null);
  const [view, setView] = useState<View>(ID);
  const [anim, setAnim] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [showLm, setShowLm] = useState(() => readLocal<boolean>('radar.map.landmarks', true));
  const complaints = useStore((s) => s.complaints);
  const incidents = useStore((s) => s.incidents);
  const regions = useStore((s) => s.regions);
  const selectedId = useStore((s) => s.selectedId);
  const replayAt = useStore((s) => s.replayAt);
  const tick = useNow(2000);
  const now = replayAt ?? tick;

  // Живое положение во время жеста (без React) и зафиксированное — в state.
  const live = useRef<View>(ID);
  const viewRef = useRef<View>(ID);
  viewRef.current = view;
  const gesture = useRef(false);

  useEffect(() => void loadGeo().then(setGeo), []);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  // Проекция и пути регионов — только при смене размера.
  const base = useMemo(() => {
    if (!geo || size.w < 50 || size.h < 50) return null;
    const fc = { type: 'FeatureCollection' as const, features: geo.map((f) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'MultiPolygon' as const, coordinates: f.g } })) };
    const proj: GeoProjection = geoConicConformal().rotate([-100, 0]).parallels([52, 68]).fitExtent(
      [
        [44, 22],
        [size.w - 22, size.h - 30],
      ],
      fc,
    );
    const path = geoPath(proj);
    const shapes: Shape[] = geo.map((f, k) => ({ id: f.id, name: f.name, d: path(fc.features[k]) ?? '', bounds: path.bounds(fc.features[k]) as Shape['bounds'] }));
    const country = shapes.map((s) => s.d).join(' ');
    const grid = path(geoGraticule().step([10, 10])()) ?? '';
    const at = (lon: number, lat: number) => (proj([lon, lat]) ?? [0, 0]) as [number, number];
    return { shapes, country, grid, at };
  }, [geo, size.w, size.h]);

  // ─── данные слоёв: считаются при новых жалобах/инцидентах, а не при каждом движении ─────────
  const data = useMemo(() => {
    const list = replayAt === null ? complaints : complaints.filter((c) => c.at <= replayAt);
    const per30 = new Map<string, number>();
    const per10 = new Map<string, number>();
    let bg30 = 0; // фон: жалобы вне инцидентов за 30 минут — от него считаем «норму» региона
    for (const c of list) {
      const age = now - c.at;
      if (age < 30 * MIN) {
        per30.set(c.regionId, (per30.get(c.regionId) ?? 0) + 1);
        if (!c.incidentId) bg30++;
      }
      if (age < 10 * MIN) per10.set(c.regionId, (per10.get(c.regionId) ?? 0) + 1);
    }
    const W = regions.reduce((a, r) => a + r.weight, 0) || 1;
    const norm10 = (r: Region) => ((bg30 / 3) * r.weight) / W;
    const pings = list.filter((c) => now - c.at < 9_000).slice(-80);
    const openInc: Incident[] = [...incidents.values()].filter((i) => i.origin === 'complaints' && (replayAt === null ? i.status !== 'resolved' : i.createdAt <= replayAt && (i.resolvedAt === null || i.resolvedAt > replayAt)));
    const incByRegion = new Map<string, Incident[]>();
    for (const i of openInc) for (const r of i.regionIds ?? []) incByRegion.set(r, [...(incByRegion.get(r) ?? []), i]);
    // Главный регион инцидента — где больше всего жалоб; там стоит его значок.
    const main = new Map<string, string>();
    for (const i of openInc) {
      const rs = i.regionIds ?? [];
      main.set(i.id, rs.reduce((best, r) => ((per30.get(r) ?? 0) > (per30.get(best) ?? -1) ? r : best), rs[0]));
    }
    // Всплеск — заметно выше нормы региона и без инцидента.
    const spikes = new Map<string, number>();
    for (const r of regions) {
      const n = per10.get(r.id) ?? 0;
      if (!incByRegion.has(r.id) && n >= 6 && n >= norm10(r) * 3) spikes.set(r.id, n);
    }
    // Окраска регионов: спокойно по умолчанию, цвет — только у инцидентов и всплесков.
    const paint = new Map<string, { fill: string; stroke?: string }>();
    const RANK = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
    for (const [rid, incs] of incByRegion) {
      const top = [...incs].sort((a, b) => RANK[a.priority] - RANK[b.priority])[0];
      // Тон по уровню: «Наивысший» — заметно, «Высокий» — мягко, ниже — едва (большие регионы Сибири иначе «заливают» карту).
      const pct = top.priority === 'P1' ? 34 : top.priority === 'P2' ? 22 : 12;
      paint.set(rid, { fill: `color-mix(in srgb, ${PRIO[top.priority]} ${pct}%, var(--rf-land))`, stroke: `color-mix(in srgb, ${PRIO[top.priority]} ${top.priority === 'P1' || top.priority === 'P2' ? 70 : 45}%, transparent)` });
    }
    for (const [rid, n] of spikes) paint.set(rid, { fill: `color-mix(in srgb, var(--warn) ${Math.min(30, 12 + n)}%, var(--rf-land))` });
    return { per30, per10, pings, openInc, incByRegion, main, spikes, paint };
  }, [complaints, incidents, regions, now, replayAt]);

  const sel = selectedId ? incidents.get(selectedId) : undefined;
  const selKey = sel?.origin === 'complaints' ? (sel.regionIds ?? []).join(',') : '';
  const selRegions = useMemo(() => new Set(selKey ? selKey.split(',') : []), [selKey]);
  const regionById = useMemo(() => new Map<string, Region>(regions.map((r) => [r.id, r])), [regions]);

  // ─── движение карты ──────────────────────────────────────────────────────
  /**
   * Во время жеста двигаем не SVG, а HTML-слой с ним: браузер сдвигает готовую картинку на видеокарте, без перерисовки.
   * Сдвиг/масштаб — относительно зафиксированного вида; в конце жеста вид фиксируется и слой возвращается на место.
   */
  const paint = (v: View) => {
    const c = viewRef.current;
    const r = v.k / c.k;
    if (pan.current) pan.current.style.transform = `translate(${v.x - c.x * r}px, ${v.y - c.y * r}px) scale(${r})`;
  };
  const commit = (v: View) => {
    gesture.current = false;
    setView(v);
  };
  // После фиксации вида значки уже стоят на новых местах — снимаем временный сдвиг.
  useLayoutEffect(() => {
    live.current = view;
    if (pan.current) pan.current.style.transform = '';
  }, [view, base]);

  function fitTo(ids: string[] | null, maxK = 6) {
    if (!base) return;
    let v = ID;
    if (ids?.length) {
      const bs = base.shapes.filter((s) => s.id && ids.includes(s.id)).map((s) => s.bounds);
      if (!bs.length) return;
      const x0 = Math.min(...bs.map((b) => b[0][0]));
      const y0 = Math.min(...bs.map((b) => b[0][1]));
      const x1 = Math.max(...bs.map((b) => b[1][0]));
      const y1 = Math.max(...bs.map((b) => b[1][1]));
      const k = Math.max(1, Math.min(maxK, 0.75 / Math.max((x1 - x0) / size.w, (y1 - y0) / size.h)));
      v = { k, x: size.w / 2 - k * ((x0 + x1) / 2), y: size.h / 2 - k * ((y0 + y1) / 2) };
    }
    setAnim(true);
    setView(v);
    window.setTimeout(() => setAnim(false), 780);
  }
  useEffect(() => {
    if (sel?.origin === 'complaints' && sel.regionIds?.length) fitTo(sel.regionIds);
  }, [selectedId, base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Колесо: двигаем напрямую, фиксируем через 160 мс после последнего щелчка колеса.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    let timer = 0;
    let raf = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const v = live.current;
      const k = Math.max(1, Math.min(14, v.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      live.current = k === 1 ? ID : { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      gesture.current = true;
      setAnim(false);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => paint(live.current));
      clearTimeout(timer);
      timer = window.setTimeout(() => commit(live.current), 160);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Перетаскивание: тоже без React до отпускания.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; raf: number } | null>(null);
  const zoomBy = (f: number) => {
    const v = live.current;
    const k = Math.max(1, Math.min(14, v.k * f));
    setAnim(true);
    setView(k === 1 ? ID : { k, x: size.w / 2 - ((size.w / 2 - v.x) * k) / v.k, y: size.h / 2 - ((size.h / 2 - v.y) * k) / v.k });
    window.setTimeout(() => setAnim(false), 780);
  };

  // ─── подсказка по региону: позиция — напрямую, состояние — только при смене региона ──────────
  const onHover = useMemo(
    () => (id: string | null, e?: React.PointerEvent) => {
      if (drag.current?.moved || gesture.current) return;
      if (id && e && tip.current && box.current) {
        const r = box.current.getBoundingClientRect();
        tip.current.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 230)}px`;
        tip.current.style.top = `${Math.max(8, e.clientY - r.top - 10)}px`;
      }
      setHoverId((h) => (h === id ? h : id));
    },
    [],
  );
  const onPick = useMemo(
    () => (id: string) => {
      if (drag.current?.moved) return;
      const inc = data.incByRegion.get(id)?.[0];
      if (inc) select(inc.id);
      else fitTo([id], 5);
    },
    [data, base, size.w, size.h], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const P = (lon: number, lat: number) => {
    const [x, y] = base!.at(lon, lat);
    return [view.x + view.k * x, view.y + view.k * y] as const;
  };
  const hoverRegion = hoverId ? regionById.get(hoverId) : undefined;
  const at = (rid: string) => {
    const r = regionById.get(rid);
    return r && base ? P(r.lon, r.lat) : null; // пока контуры не загрузились — значков нет
  };

  // ─── значки: считаются по зафиксированному виду ───────────────────────────
  const badgeR = (n: number) => 11 + Math.min(9, Math.sqrt(n) * 0.7);
  const badges = data.openInc.flatMap((i) => {
    const rid = data.main.get(i.id);
    const p = rid ? at(rid) : null;
    if (!rid || !p) return [];
    const n = i.complaints ?? 0;
    const others = (i.regionIds ?? []).filter((r) => r !== rid).map((r) => ({ rid: r, p: at(r) })).filter((o): o is { rid: string; p: readonly [number, number] } => !!o.p);
    return [{ i, rid, p, n, r: badgeR(n), others, sel: i.id === selectedId, d: [p[0], p[1]] as [number, number] }];
  });
  // Значки, что легли друг на друга (два инцидента в одном регионе), расходятся веером в стороны.
  for (let pass = 0; pass < 4; pass++)
    for (let a = 0; a < badges.length; a++)
      for (let b = a + 1; b < badges.length; b++) {
        const A = badges[a].d;
        const B = badges[b].d;
        const need = badges[a].r + badges[b].r + 6;
        const dist = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (dist >= need) continue;
        const ang = dist > 0.5 ? Math.atan2(B[1] - A[1], B[0] - A[0]) : -0.35 + b * 0.9;
        const push = (need - dist) / 2;
        A[0] -= Math.cos(ang) * push;
        A[1] -= Math.sin(ang) * push;
        B[0] += Math.cos(ang) * push;
        B[1] += Math.sin(ang) * push;
      }
  const occupied = new Map<string, number>(); // регион → радиус того, что стоит у его столицы
  for (const b of badges) {
    occupied.set(b.rid, Math.max(occupied.get(b.rid) ?? 0, b.r + 7));
    for (const o of b.others) occupied.set(o.rid, Math.max(occupied.get(o.rid) ?? 0, 6));
  }
  for (const [rid, n] of data.spikes) occupied.set(rid, Math.max(occupied.get(rid) ?? 0, 9 + Math.min(5, n / 4)));

  return (
    <div className={`rfmap rf-svg ${forceTheme === 'dark' ? 'rf-dark' : ''}`} ref={box}>
      <div className="rf-sea" />
      {base && (
        <div className="rf-pan" ref={pan}>
          <svg
            ref={svg}
            width={size.w}
            height={size.h}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, y: e.clientY, vx: live.current.x, vy: live.current.y, moved: false, raf: 0 };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (!d.moved) {
                if (Math.hypot(dx, dy) < 4) return;
                d.moved = true;
                gesture.current = true;
                // Захват — только когда перетаскивание началось: иначе клики по регионам и значкам не доходят до них.
                svg.current?.setPointerCapture?.(e.pointerId);
                setAnim(false);
                setHoverId(null);
                svg.current?.classList.add('grabbing');
              }
              live.current = { ...live.current, x: d.vx + dx, y: d.vy + dy };
              cancelAnimationFrame(d.raf);
              d.raf = requestAnimationFrame(() => paint(live.current));
            }}
            onPointerUp={() => {
              const d = drag.current;
              svg.current?.classList.remove('grabbing');
              if (d?.moved) {
                cancelAnimationFrame(d.raf);
                commit(live.current);
              }
              setTimeout(() => (drag.current = null), 0);
            }}
          >
            {/* Земля: тень, бортик (объём), регионы, береговая линия */}
            <g className={`rf-world ${anim ? 'anim' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
              <path d={base.grid} className="rf-grid" />
              <path d={base.country} className="rf-shadow" transform={`translate(0 ${12 / view.k})`} />
              <path d={base.country} className="rf-side" transform={`translate(0 ${5 / view.k})`} />
              <RegionLayer shapes={base.shapes} paint={data.paint} sel={selRegions} hoverId={hoverId} onHover={onHover} onPick={onPick} />
              <path d={base.country} className="rf-coast" />
            </g>

            {/* Значки — поверх, размер не зависит от приближения */}
            <g className={`rf-marks ${anim ? 'hide' : ''}`}>
              {/* фон жалоб: короткие вспышки без цифр */}
              {data.pings.map((c) => {
                const [x, y] = P(c.lon, c.lat);
                return <circle key={c.id} cx={x} cy={y} r={2.4} className={`rf-ping ${c.incidentId ? 'linked' : ''}`} />;
              })}
              {/* дуги от значка инцидента к другим его регионам */}
              {badges
                .filter((b) => b.sel || b.i.priority === 'P1' || b.i.priority === 'P2' || b.i.p1Proposal)
                .flatMap((b) =>
                b.others.map((o) => {
                  const [x1, y1] = b.d;
                  const [x2, y2] = o.p;
                  const lift = Math.min(60, Math.hypot(x2 - x1, y2 - y1) * 0.22);
                  return <path key={`ln-${b.i.id}-${o.rid}`} d={`M${x1},${y1} Q${(x1 + x2) / 2},${(y1 + y2) / 2 - lift} ${x2},${y2}`} className={`rf-link ${b.sel ? 'sel' : ''}`} style={{ stroke: PRIO[b.i.priority] }} />;
                }),
              )}
              {/* миниатюры городов — под значками, отходят от того, что стоит у столицы */}
              {showLm &&
                Object.keys(LANDMARKS).map((rid) => {
                  const p = at(rid);
                  const r = regionById.get(rid);
                  if (!p || !r) return null;
                  const s = Math.round(Math.min(124, 44 * Math.pow(view.k, 0.5)));
                  const busy = occupied.get(rid) ?? 0;
                  const x = p[0] - (busy ? busy + s * 0.34 : s * 0.12);
                  const y = p[1] - (busy ? busy * 0.3 : 2);
                  return (
                    <g key={`lm-${rid}`} className={`rf-lm ${busy ? 'aside' : ''}`}>
                      <ellipse cx={x} cy={y - 1} rx={s * 0.36} ry={s * 0.09} className="rf-lm-shadow" />
                      <image href={`/landmarks/${rid}.webp`} x={x - s / 2} y={y - s * 0.94} width={s} height={s} preserveAspectRatio="xMidYMax meet" />
                      {view.k >= 1.8 && (
                        <text x={x} y={y + 13} className="rf-lm-name">
                          {r.city}
                        </text>
                      )}
                    </g>
                  );
                })}
              {/* другие регионы инцидента — аккуратные точки */}
              {badges.flatMap((b) => b.others.map((o) => <circle key={`sec-${b.i.id}-${o.rid}`} cx={o.p[0]} cy={o.p[1]} r={4.5} className="rf-sec" style={{ fill: PRIO[b.i.priority] }} />))}
              {/* всплески без инцидента */}
              {[...data.spikes].map(([rid, n]) => {
                const p = at(rid);
                if (!p) return null;
                const rr = 9 + Math.min(5, n / 4);
                return (
                  <g key={`sp-${rid}`} className="rf-spike" transform={`translate(${p[0]} ${p[1]})`}>
                    <circle r={rr + 7} className="glow" />
                    <circle r={rr} className="core" />
                    <text dy="0.36em">{n}</text>
                  </g>
                );
              })}
              {/* инциденты: один значок с числом жалоб */}
              {/* значок отъехал от своего города — тонкая линия к нему */}
              {badges
                .filter((b) => Math.hypot(b.d[0] - b.p[0], b.d[1] - b.p[1]) > 3)
                .map((b) => (
                  <g key={`tie-${b.i.id}`} className="rf-tie" style={{ ['--c' as string]: PRIO[b.i.priority] }}>
                    <line x1={b.p[0]} y1={b.p[1]} x2={b.d[0]} y2={b.d[1]} />
                    <circle cx={b.p[0]} cy={b.p[1]} r={3} />
                  </g>
                ))}
              {badges.map((b) => (
                <g
                  key={`b-${b.i.id}`}
                  className={`rf-badge ${b.sel ? 'sel' : ''} ${b.i.priority === 'P1' || b.i.p1Proposal ? 'hot' : ''}`}
                  transform={`translate(${b.d[0]} ${b.d[1]})`}
                  style={{ ['--c' as string]: PRIO[b.i.priority] }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!drag.current?.moved) select(b.i.id);
                  }}
                >
                  <circle r={b.r * 2} className="glow" />
                  <circle r={b.r + (b.sel ? 3 : 0)} className="core" />
                  <text dy="0.36em">{short(b.n)}</text>
                </g>
              ))}
              {/* подписи — только у важных и выбранного, плашкой */}
              {badges
                .filter((b) => b.sel || b.i.priority === 'P1' || b.i.priority === 'P2' || b.i.p1Proposal)
                .map((b) => {
                  const label = b.i.service;
                  const w = Math.round(label.length * 6.6 + 18);
                  // Подпись под значком; если там другой значок — над ним.
                  const below = b.d[1] + b.r + 8;
                  const hits = badges.some((o) => o !== b && Math.abs(o.d[0] - b.d[0]) < w / 2 + o.r && o.d[1] + o.r > below && o.d[1] - o.r < below + 19);
                  const y = hits ? b.d[1] - b.r - 8 - 19 : below;
                  return (
                    <g key={`lb-${b.i.id}`} className={`rf-pill ${b.sel ? 'sel' : ''}`} transform={`translate(${b.d[0] - w / 2} ${y})`} style={{ ['--c' as string]: PRIO[b.i.priority] }}>
                      <rect width={w} height={19} rx={9.5} />
                      <text x={w / 2} y={13}>
                        {label}
                      </text>
                    </g>
                  );
                })}
              {view.k >= 2.4 &&
                regions.map((r) => {
                  if (LANDMARKS[r.id]) return null;
                  const [x, y] = P(r.lon, r.lat);
                  if (x < 0 || y < 0 || x > size.w || y > size.h) return null;
                  return (
                    <text key={r.id} x={x} y={y - 9} className="rf-city">
                      {r.city}
                    </text>
                  );
                })}
            </g>
          </svg>
        </div>
      )}
      {!base && <div className="rf-loading">Карта загружается…</div>}

      <div ref={tip} className={`rf-tip ${hoverRegion ? '' : 'off'}`}>
        {hoverRegion && hoverId && (
          <>
            <b>{hoverRegion.name}</b>
            <span>
              жалоб за 30 мин: <b className="num">{data.per30.get(hoverId) ?? 0}</b>
            </span>
            {data.spikes.has(hoverId) && <span className="rf-tip-spike">всплеск: {data.spikes.get(hoverId)} за 10 мин</span>}
            {(data.incByRegion.get(hoverId) ?? []).slice(0, 3).map((i) => (
              <span key={i.id} className="rf-tip-inc" style={{ color: PRIO[i.priority] }}>
                ● {i.service}
              </span>
            ))}
          </>
        )}
      </div>

      <div className="rf-zoom">
        <button onClick={() => zoomBy(1.6)} aria-label="Приблизить">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.6)} aria-label="Отдалить">
          −
        </button>
      </div>
      <div className="rf-legend">
        <span>
          <i className="lg-badge" /> инцидент
        </span>
        <span>
          <i className="lg-spike" /> всплеск жалоб
        </span>
        <span>
          <i className="lg-ping" /> жалоба
        </span>
        <label className="rf-lm-toggle" title="Объёмные миниатюры главных городов на карте">
          <input
            type="checkbox"
            checked={showLm}
            onChange={(e) => {
              setShowLm(e.target.checked);
              writeLocal('radar.map.landmarks', e.target.checked);
            }}
          />
          города
        </label>
        <button className="rf-reset" onClick={() => fitTo(null)}>
          Вся страна
        </button>
        <button className="rf-reset" onClick={() => fitTo(regions.filter((r) => r.district === 'cfo' || r.district === 'szfo' || r.district === 'pfo' || r.district === 'yufo').map((r) => r.id), 4)}>
          Европа
        </button>
        {replayAt === null && <span className="rf-live">● онлайн</span>}
      </div>
    </div>
  );
}
