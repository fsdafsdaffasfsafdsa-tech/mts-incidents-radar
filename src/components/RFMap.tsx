// Карта России своя (SVG, контуры регионов в public/rf-regions.json) — появляется мгновенно, без внешней подложки.
// Регионы закрашены по числу жалоб за 30 минут, у столиц — пузыри «сколько жалоб за 10 минут», новые жалобы «пингуют»,
// инциденты — пульсирующие кольца. Колесо/кнопки — приблизить, перетаскивание — сдвинуть, выбранный инцидент — приближение.
import { useEffect, useMemo, useRef, useState } from 'react';
import { geoConicConformal, geoGraticule, geoPath, type GeoProjection } from 'd3-geo';
import type { Incident } from '../../shared/types';
import { select, useStore } from '../store';
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

export function RFMap({ forceTheme }: { forceTheme?: 'dark' | 'light' } = {}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [geo, setGeo] = useState<GeoFeature[] | null>(null);
  const [view, setView] = useState<View>(ID);
  const [anim, setAnim] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null);
  const complaints = useStore((s) => s.complaints);
  const incidents = useStore((s) => s.incidents);
  const regions = useStore((s) => s.regions);
  const selectedId = useStore((s) => s.selectedId);
  const replayAt = useStore((s) => s.replayAt);
  const tick = useNow(2000);
  const now = replayAt ?? tick;

  useEffect(() => void loadGeo().then(setGeo), []);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  // Проекция и пути регионов — пересчитываются только при смене размера.
  const base = useMemo(() => {
    if (!geo || size.w < 50 || size.h < 50) return null;
    const fc = { type: 'FeatureCollection' as const, features: geo.map((f) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'MultiPolygon' as const, coordinates: f.g } })) };
    const proj: GeoProjection = geoConicConformal().rotate([-100, 0]).parallels([52, 68]).fitExtent(
      [
        [16, 16],
        [size.w - 16, size.h - 16],
      ],
      fc,
    );
    const path = geoPath(proj);
    const shapes = geo.map((f, k) => ({ id: f.id, name: f.name, d: path(fc.features[k]) ?? '', bounds: path.bounds(fc.features[k]) }));
    const country = shapes.map((s) => s.d).join(' ');
    const grid = path(geoGraticule().step([10, 10])()) ?? '';
    const at = (lon: number, lat: number) => proj([lon, lat]) ?? [0, 0];
    return { shapes, country, grid, at };
  }, [geo, size.w, size.h]);

  // ─── данные слоёв ────────────────────────────────────────────────────────
  const live = replayAt === null ? complaints : complaints.filter((c) => c.at <= replayAt);
  const per30 = new Map<string, number>();
  const per10 = new Map<string, { n: number; linked: number }>();
  for (const c of live) {
    if (now - c.at < 30 * MIN) per30.set(c.regionId, (per30.get(c.regionId) ?? 0) + 1);
    if (now - c.at < 10 * MIN) {
      const p = per10.get(c.regionId) ?? { n: 0, linked: 0 };
      p.n++;
      if (c.incidentId) p.linked++;
      per10.set(c.regionId, p);
    }
  }
  const max30 = Math.max(8, ...per30.values());
  const pings = live.filter((c) => now - c.at < 12_000).slice(-120);
  const openInc: Incident[] = [...incidents.values()].filter((i) => i.origin === 'complaints' && (replayAt === null ? i.status !== 'resolved' : i.createdAt <= replayAt && (i.resolvedAt === null || i.resolvedAt > replayAt)));
  const incByRegion = new Map<string, Incident[]>();
  for (const i of openInc) for (const r of i.regionIds ?? []) incByRegion.set(r, [...(incByRegion.get(r) ?? []), i]);
  const sel = selectedId ? incidents.get(selectedId) : undefined;
  const selRegions = new Set(sel?.origin === 'complaints' ? sel.regionIds ?? [] : []);

  // ─── приближение ─────────────────────────────────────────────────────────
  function fitTo(ids: string[] | null, maxK = 6) {
    if (!base) return;
    if (!ids?.length) {
      setAnim(true);
      setView(ID);
      return;
    }
    const bs = base.shapes.filter((s) => s.id && ids.includes(s.id)).map((s) => s.bounds);
    if (!bs.length) return;
    const x0 = Math.min(...bs.map((b) => b[0][0]));
    const y0 = Math.min(...bs.map((b) => b[0][1]));
    const x1 = Math.max(...bs.map((b) => b[1][0]));
    const y1 = Math.max(...bs.map((b) => b[1][1]));
    const k = Math.max(1, Math.min(maxK, 0.75 / Math.max((x1 - x0) / size.w, (y1 - y0) / size.h)));
    setAnim(true);
    setView({ k, x: size.w / 2 - k * ((x0 + x1) / 2), y: size.h / 2 - k * ((y0 + y1) / 2) });
  }
  useEffect(() => {
    if (sel?.origin === 'complaints' && sel.regionIds?.length) fitTo(sel.regionIds);
  }, [selectedId, base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Колесо — приближение к курсору (свой обработчик: React вешает wheel пассивным).
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setAnim(false);
      setView((v) => {
        const k = Math.max(1, Math.min(14, v.k * (e.deltaY < 0 ? 1.25 : 0.8)));
        if (k === 1) return ID;
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [base]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const P = (lon: number, lat: number) => {
    const [x, y] = base!.at(lon, lat);
    return [view.x + view.k * x, view.y + view.k * y] as const;
  };
  const regionById = new Map(regions.map((r) => [r.id, r]));
  const hoverRegion = hover ? regionById.get(hover.id) : undefined;
  const zoomBy = (f: number) => {
    setAnim(true);
    setView((v) => {
      const k = Math.max(1, Math.min(14, v.k * f));
      if (k === 1) return ID;
      return { k, x: size.w / 2 - ((size.w / 2 - v.x) * k) / v.k, y: size.h / 2 - ((size.h / 2 - v.y) * k) / v.k };
    });
  };

  return (
    <div className={`rfmap rf-svg ${forceTheme === 'dark' ? 'rf-dark' : ''}`} ref={box}>
      {base && (
        <svg
          ref={svg}
          width={size.w}
          height={size.h}
          className={drag.current?.moved ? 'grabbing' : ''}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) < 4) return;
            d.moved = true;
            setAnim(false);
            setHover(null);
            setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
          }}
          onPointerUp={() => setTimeout(() => (drag.current = null), 0)}
        >
          <defs>
            <radialGradient id="rf-sea" cx="50%" cy="40%" r="75%">
              <stop offset="0%" stopColor="var(--rf-sea-1)" />
              <stop offset="100%" stopColor="var(--rf-sea-2)" />
            </radialGradient>
          </defs>
          <rect width={size.w} height={size.h} fill="url(#rf-sea)" />
          <g className={`rf-world ${anim ? 'anim' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <path d={base.grid} className="rf-grid" />
            <path d={base.country} className="rf-country" />
            {base.shapes.map((s, k) => {
              const n = s.id ? per30.get(s.id) ?? 0 : 0;
              const hot = s.id ? incByRegion.get(s.id) : undefined;
              const pct = n ? Math.round(12 + 70 * Math.sqrt(n / max30)) : 0;
              const fill = !s.id ? 'var(--rf-none)' : hot ? `color-mix(in srgb, ${PRIO[hot[0].priority]} ${Math.max(28, pct)}%, var(--rf-land))` : pct ? `color-mix(in srgb, var(--rf-heat) ${pct}%, var(--rf-land))` : 'var(--rf-land)';
              return (
                <path
                  key={k}
                  d={s.d}
                  className={`rf-region ${s.id ? 'ours' : ''} ${hot ? 'hot' : ''} ${s.id && selRegions.has(s.id) ? 'sel' : ''} ${hover?.id === s.id ? 'hov' : ''}`}
                  style={{ fill }}
                  onPointerMove={(e) => {
                    if (drag.current?.moved || !s.id) return;
                    const r = box.current!.getBoundingClientRect();
                    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, id: s.id });
                  }}
                  onPointerLeave={() => setHover((h) => (h?.id === s.id ? null : h))}
                  onClick={() => {
                    if (drag.current?.moved || !s.id) return;
                    const inc = incByRegion.get(s.id)?.[0];
                    if (inc) select(inc.id);
                    else fitTo([s.id], 5);
                  }}
                />
              );
            })}
          </g>

          {/* Подписи и значки — поверх, размер не зависит от приближения */}
          <g className="rf-marks">
            {pings.map((c) => {
              const [x, y] = P(c.lon, c.lat);
              return <circle key={c.id} cx={x} cy={y} r={3} className={`rf-ping ${c.incidentId ? 'linked' : ''}`} />;
            })}
            {[...per10].map(([rid, p]) => {
              const r = regionById.get(rid);
              if (!r || p.n < 2) return null;
              const [x, y] = P(r.lon, r.lat);
              // Фон (пара жалоб) — точка; всплеск — пузырь с числом.
              if (p.n < 6 && !incByRegion.has(rid)) return <circle key={rid} cx={x} cy={y} r={3.2} className="rf-dot" />;
              const rad = 5 + Math.sqrt(p.n) * 2.4;
              return (
                <g key={rid} className={`rf-bubble ${p.linked > p.n / 2 ? 'linked' : ''}`} transform={`translate(${x} ${y})`}>
                  <circle r={rad + 6} className="glow" />
                  <circle r={rad} className="core" />
                  {p.n >= 4 && (
                    <text dy="0.35em" className="num">
                      {p.n}
                    </text>
                  )}
                </g>
              );
            })}
            {openInc.flatMap((i) =>
              (i.regionIds ?? []).map((rid, k) => {
                const r = regionById.get(rid);
                if (!r) return null;
                const [x, y] = P(r.lon, r.lat);
                const n = i.complaints ?? 0;
                const rad = 14 + Math.min(22, Math.sqrt(n) * 1.6);
                const isSel = i.id === selectedId;
                return (
                  <g
                    key={`${i.id}-${rid}`}
                    className={`rf-inc ${isSel ? 'sel' : ''}`}
                    transform={`translate(${x} ${y})`}
                    style={{ ['--c' as string]: PRIO[i.priority] }}
                    onClick={(e) => {
                      e.stopPropagation();
                      select(i.id);
                    }}
                  >
                    <circle r={rad} className="halo" />
                    <circle r={rad} className="ring" />
                    {k === 0 && (
                      <text y={rad + 13} className="rf-label">
                        {i.service} · {n}
                      </text>
                    )}
                  </g>
                );
              }),
            )}
            {view.k >= 2.2 &&
              regions.map((r) => {
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
      )}
      {!base && <div className="rf-loading">Карта загружается…</div>}

      {hover && hoverRegion && (
        <div className="rf-tip" style={{ left: Math.min(hover.x + 14, size.w - 230), top: Math.max(8, hover.y - 10) }}>
          <b>{hoverRegion.name}</b>
          <span>
            жалоб за 30 мин: <b className="num">{per30.get(hover.id) ?? 0}</b>
          </span>
          {(incByRegion.get(hover.id) ?? []).slice(0, 3).map((i) => (
            <span key={i.id} className="rf-tip-inc" style={{ color: PRIO[i.priority] }}>
              ● {i.service}
            </span>
          ))}
        </div>
      )}

      <div className="rf-zoom">
        <button onClick={() => zoomBy(1.6)} aria-label="Приблизить">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.6)} aria-label="Отдалить">
          −
        </button>
      </div>
      <div className="rf-legend">
        <span className="rf-scale">
          <i className="rf-grad" /> жалобы за 30 мин
        </span>
        <span>
          <i className="lg-c" /> всплеск
        </span>
        <span>
          <i className="lg-r" /> инцидент
        </span>
        <button className="rf-reset" onClick={() => fitTo(null)}>
          Вся страна
        </button>
        <button className="rf-reset" onClick={() => fitTo(regions.filter((r) => r.district === 'cfo' || r.district === 'szfo' || r.district === 'pfo' || r.district === 'yufo').map((r) => r.id), 4)}>
          Европейская часть
        </button>
        {replayAt === null && <span className="rf-live">● в реальном времени</span>}
      </div>
    </div>
  );
}
