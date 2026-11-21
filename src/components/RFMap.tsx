// Карта России своя (SVG, контуры регионов в public/rf-regions.json) — появляется мгновенно, без внешней подложки.
// Регионы закрашены по числу жалоб за 30 минут, у столиц — пузыри «сколько жалоб за 10 минут», новые жалобы «пингуют»,
// инциденты — пульсирующие кольца. Колесо/кнопки — приблизить, перетаскивание — сдвинуть, выбранный инцидент — приближение.
//
// Плавность: во время перетаскивания и колеса карта двигается напрямую трансформацией слоёв (без перерисовки React),
// состояние фиксируется в конце жеста. Регионы и данные считаются один раз и не перерисовываются от движения.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { geoConicConformal, geoGraticule, geoPath, type GeoProjection } from 'd3-geo';
import type { Incident, Region } from '../../shared/types';
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
type Shape = { id: string | null; name: string; d: string; bounds: [[number, number], [number, number]] };

/** Слой регионов: перерисовывается только когда меняются заливка, выбор или регион под курсором — не от движения карты. */
const RegionLayer = memo(function RegionLayer({ shapes, fills, hot, sel, hoverId, onHover, onPick }: { shapes: Shape[]; fills: Map<string, string>; hot: Set<string>; sel: Set<string>; hoverId: string | null; onHover: (id: string | null, e?: React.PointerEvent) => void; onPick: (id: string) => void }) {
  return (
    <>
      {shapes.map((s, k) => (
        <path
          key={k}
          d={s.d}
          className={`rf-region ${s.id ? 'ours' : ''} ${s.id && hot.has(s.id) ? 'hot' : ''} ${s.id && sel.has(s.id) ? 'sel' : ''} ${s.id && hoverId === s.id ? 'hov' : ''}`}
          style={{ fill: s.id ? fills.get(s.id) ?? 'var(--rf-land)' : 'var(--rf-none)' }}
          onPointerMove={s.id ? (e) => onHover(s.id, e) : undefined}
          onPointerLeave={s.id ? () => onHover(null) : undefined}
          onClick={s.id ? () => onPick(s.id!) : undefined}
        />
      ))}
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
        [16, 16],
        [size.w - 16, size.h - 16],
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
    const per10 = new Map<string, { n: number; linked: number }>();
    for (const c of list) {
      if (now - c.at < 30 * MIN) per30.set(c.regionId, (per30.get(c.regionId) ?? 0) + 1);
      if (now - c.at < 10 * MIN) {
        const p = per10.get(c.regionId) ?? { n: 0, linked: 0 };
        p.n++;
        if (c.incidentId) p.linked++;
        per10.set(c.regionId, p);
      }
    }
    const max30 = Math.max(8, ...per30.values());
    const pings = list.filter((c) => now - c.at < 12_000).slice(-120);
    const openInc: Incident[] = [...incidents.values()].filter((i) => i.origin === 'complaints' && (replayAt === null ? i.status !== 'resolved' : i.createdAt <= replayAt && (i.resolvedAt === null || i.resolvedAt > replayAt)));
    const incByRegion = new Map<string, Incident[]>();
    for (const i of openInc) for (const r of i.regionIds ?? []) incByRegion.set(r, [...(incByRegion.get(r) ?? []), i]);
    const fills = new Map<string, string>();
    for (const r of regions) {
      const n = per30.get(r.id) ?? 0;
      const hot = incByRegion.get(r.id);
      const pct = n ? Math.round(12 + 70 * Math.sqrt(n / max30)) : 0;
      fills.set(r.id, hot ? `color-mix(in srgb, ${PRIO[hot[0].priority]} ${Math.max(28, pct)}%, var(--rf-land))` : pct ? `color-mix(in srgb, var(--rf-heat) ${pct}%, var(--rf-land))` : 'var(--rf-land)');
    }
    return { per30, per10, pings, openInc, incByRegion, fills, hot: new Set(incByRegion.keys()) };
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
              // Захват — только когда перетаскивание началось: иначе клики по регионам и кольцам не доходят до них.
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
          <g className={`rf-world ${anim ? 'anim' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <path d={base.grid} className="rf-grid" />
            <path d={base.country} className="rf-country" />
            <RegionLayer shapes={base.shapes} fills={data.fills} hot={data.hot} sel={selRegions} hoverId={hoverId} onHover={onHover} onPick={onPick} />
          </g>

          {/* Подписи и значки — поверх, размер не зависит от приближения */}
          <g className={`rf-marks ${anim ? 'hide' : ''}`}>
            {data.pings.map((c) => {
              const [x, y] = P(c.lon, c.lat);
              return <circle key={c.id} cx={x} cy={y} r={3} className={`rf-ping ${c.incidentId ? 'linked' : ''}`} />;
            })}
            {[...data.per10].map(([rid, p]) => {
              const r = regionById.get(rid);
              if (!r || p.n < 2) return null;
              const [x, y] = P(r.lon, r.lat);
              if (p.n < 6 && !data.incByRegion.has(rid)) return <circle key={rid} cx={x} cy={y} r={3.2} className="rf-dot" />;
              const rad = 5 + Math.sqrt(p.n) * 2.4;
              return (
                <g key={rid} className={`rf-bubble ${p.linked > p.n / 2 ? 'linked' : ''}`} transform={`translate(${x} ${y})`}>
                  <circle r={rad + 5} className="glow" />
                  <circle r={rad} className="core" />
                  {p.n >= 4 && (
                    <text dy="0.35em" className="num">
                      {p.n}
                    </text>
                  )}
                </g>
              );
            })}
            {data.openInc.flatMap((i) =>
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
                      if (!drag.current?.moved) select(i.id);
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
