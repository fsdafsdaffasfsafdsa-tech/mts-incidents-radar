// Карта РФ: каждая жалоба — точка, при отдалении — кластеры. Инциденты из жалоб — кольца по регионам.
import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getState, select, useStore } from '../store';

const STYLE = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
};
// Обжитая часть страны: от Калининграда до Камчатки, без пустого Заполярья (в Меркаторе оно съедает экран).
const RF: [[number, number], [number, number]] = [
  [20, 42],
  [160, 66],
];
const C = {
  dark: { P1: '#ff3150', P2: '#ff8a2b', P3: '#e6c247', P4: '#5b8cff', dot: '#ff8a2b', linked: '#ff3150', stroke: '#0b0f16', text: '#ffffff', label: '#e8ecf3' },
  light: { P1: '#e3142d', P2: '#e06a00', P3: '#c79600', P4: '#2f6bed', dot: '#e06a00', linked: '#e3142d', stroke: '#ffffff', text: '#ffffff', label: '#1d2433' },
};
const HALO_BASE = ['interpolate', ['linear'], ['get', 'n'], 5, 20, 50, 30, 200, 42];
// Подложка спокойнее: без POI, номеров домов и подписей улиц, дороги проявляются только вблизи, границы регионов — пунктиром.
const BASE = {
  dark: { bg: '#0c121c', water: '#05080d', state: '#2b3547', country: '#4a566c' },
  light: { bg: '#eef1f5', water: '#d3dce8', state: '#b4bfcf', country: '#8592a8' },
};
const HEAT = {
  dark: ['rgba(0,0,0,0)', 'rgba(255,138,43,0.22)', 'rgba(255,106,43,0.5)', 'rgba(255,49,80,0.78)', 'rgba(255,214,190,0.95)'],
  light: ['rgba(255,255,255,0)', 'rgba(255,138,43,0.25)', 'rgba(240,96,30,0.5)', 'rgba(227,20,45,0.72)', 'rgba(150,0,20,0.9)'],
};
const fallback = (theme: 'dark' | 'light'): StyleSpecification => ({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': theme === 'dark' ? '#0b0f16' : '#e9edf3' } }] });

export function RFMap({ forceTheme }: { forceTheme?: 'dark' | 'light' } = {}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const theme = useStore((s) => s.theme);
  const complaints = useStore((s) => s.complaints);
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const replayAt = useStore((s) => s.replayAt);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: STYLE[forceTheme ?? getState().theme],
      bounds: RF,
      fitBoundsOptions: { padding: 20 },
      maxBounds: [
        [5, 30],
        [180, 78],
      ],
      minZoom: 1.6,
      maxZoom: 15,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.current = m;
    (window as unknown as { __rfMap?: MlMap }).__rfMap = m;
    const fail = window.setTimeout(() => !m.isStyleLoaded() && m.setStyle(fallback(getState().theme), { diff: false }), 8000);
    let fitted = false;
    m.on('style.load', () => {
      clearTimeout(fail);
      install(m, forceTheme ?? getState().theme);
      ready.current = true;
      push(m);
      if (!fitted) {
        fitted = true;
        m.resize();
        m.fitBounds(RF, { padding: 10, duration: 0 });
      }
    });
    m.on('click', 'cl-circle', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      void (m.getSource('complaints') as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id).then((z) => m.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: z }));
    });
    m.on('click', 'inc-ring', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) select(String(id));
    });
    for (const l of ['cl-circle', 'inc-ring']) {
      m.on('mouseenter', l, () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', l, () => (m.getCanvas().style.cursor = ''));
    }
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  // Пульс колец инцидентов: радиус растёт, кольцо гаснет. При «уменьшить движение» — без анимации.
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => {
      const m = map.current;
      if (!m || !ready.current || !m.getLayer('inc-halo')) return;
      if (document.documentElement.dataset.motion === 'off') {
        m.setPaintProperty('inc-halo', 'circle-stroke-opacity', 0);
        return;
      }
      const k = (Date.now() % 1800) / 1800;
      m.setPaintProperty('inc-halo', 'circle-radius', ['+', HALO_BASE, 4 + k * 22] as any);
      m.setPaintProperty('inc-halo', 'circle-stroke-opacity', 0.6 * (1 - k));
    }, 60);
    return () => clearInterval(t);
  }, []);

  const applied = useRef(theme);
  useEffect(() => {
    const m = map.current;
    if (!m || forceTheme || applied.current === theme) return;
    applied.current = theme;
    ready.current = false;
    m.setStyle(STYLE[theme], { diff: false });
  }, [theme]);

  // Не чаще раза в секунду — кластеры успевают пересчитаться.
  const last = useRef(0);
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const run = () => {
      pending.current = null;
      last.current = Date.now();
      if (map.current && ready.current) push(map.current);
    };
    const wait = 1000 - (Date.now() - last.current);
    if (wait <= 0) run();
    else if (pending.current === null) pending.current = window.setTimeout(run, wait);
  }, [complaints, incidents, selectedId, replayAt]);

  useEffect(() => {
    const m = map.current;
    const inc = selectedId ? getState().incidents.get(selectedId) : undefined;
    if (!m || !inc || inc.origin !== 'complaints') return;
    const pts = getState().complaints.filter((c) => c.incidentId === inc.id);
    if (!pts.length) return;
    const lons = pts.map((c) => c.lon);
    const lats = pts.map((c) => c.lat);
    m.fitBounds(
      [
        [Math.min(...lons) - 0.3, Math.min(...lats) - 0.2],
        [Math.max(...lons) + 0.3, Math.max(...lats) + 0.2],
      ],
      { padding: 60, maxZoom: 9, duration: 900 },
    );
  }, [selectedId]);

  return (
    <div className="rfmap">
      <div ref={el} className="rfmap-canvas" />
      <div className="rf-legend">
        <span>
          <i className="lg-c" /> жалоба
        </span>
        <span>
          <i className="lg-l" /> в инциденте
        </span>
        <span>
          <i className="lg-r" /> инцидент
        </span>
        <button className="rf-reset" onClick={() => map.current?.fitBounds(RF, { padding: 20, duration: 700 })}>
          Вся страна
        </button>
      </div>
    </div>
  );
}

function soften(m: MlMap, theme: 'dark' | 'light') {
  const B = BASE[theme];
  for (const l of m.getStyle().layers) {
    const id = l.id;
    try {
      if (/^(poi_|housenumber|roadname_|waterway_label|watername_lake|aeroway|place_hamlet|place_suburbs|place_villages|place_continent|building)/.test(id)) m.setLayoutProperty(id, 'visibility', 'none');
      else if (l.type === 'line' && /^(road_|tunnel_|bridge_|rail)/.test(id)) m.setPaintProperty(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 5, 0, 8, 0.35, 11, 0.75]);
      else if (l.type === 'fill' && /^(landcover|park_|landuse)/.test(id)) m.setPaintProperty(id, 'fill-opacity', theme === 'dark' ? 0.2 : 0.3);
      else if (id === 'background') m.setPaintProperty(id, 'background-color', B.bg);
      else if (id === 'water') m.setPaintProperty(id, 'fill-color', B.water);
      else if (id === 'boundary_state') {
        m.setLayerZoomRange(id, 2, 24);
        m.setPaintProperty(id, 'line-color', B.state);
        m.setPaintProperty(id, 'line-opacity', 0.9);
        m.setPaintProperty(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 2, 0.5, 7, 1.2]);
        m.setPaintProperty(id, 'line-dasharray', [3, 2]);
      } else if (id === 'boundary_country_outline' || id === 'boundary_country_inner') m.setPaintProperty(id, 'line-color', B.country);
      else if (id === 'place_town') m.setLayerZoomRange(id, 7, 24);
      else if (l.type === 'symbol' && /^place_/.test(id)) m.setPaintProperty(id, 'text-opacity', 0.8);
    } catch {
      /* в запасной подложке таких слоёв нет */
    }
  }
}

function install(m: MlMap, theme: 'dark' | 'light') {
  const P = C[theme];
  soften(m, theme);
  const fonts = m
    .getStyle()
    .layers.map((l) => (l.layout as Record<string, unknown> | undefined)?.['text-font'])
    .filter((f): f is string[] => Array.isArray(f) && typeof f[0] === 'string');
  const font = fonts.find((f) => /bold|semibold|medium/i.test(f[0]) && !/italic/i.test(f[0])) ?? fonts[0] ?? ['Open Sans Regular'];
  for (const l of m.getStyle().layers) {
    try {
      if (l.type === 'symbol' && /place|countr|city|town|state/i.test(l.id)) m.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name_en']]);
    } catch {
      /* нет свойства */
    }
  }
  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  m.addSource('complaints', { type: 'geojson', data: empty, cluster: true, clusterRadius: 38, clusterMaxZoom: 8, clusterProperties: { linked: ['+', ['case', ['get', 'linked'], 1, 0]] } });
  m.addSource('incs', { type: 'geojson', data: empty });
  m.addSource('heat', { type: 'geojson', data: empty });
  // Тепловая карта жалоб: на всю страну видно, где «горит», без россыпи точек. Ближе — уступает кластерам.
  const H = HEAT[theme];
  m.addLayer({
    id: 'heat',
    type: 'heatmap',
    source: 'heat',
    maxzoom: 9,
    paint: {
      'heatmap-weight': ['*', ['interpolate', ['linear'], ['get', 'age'], 0, 1, 60, 0.25], ['case', ['get', 'linked'], 1.3, 0.7]],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 0.7, 8, 1.8],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 16, 5, 24, 8, 36],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, H[0], 0.15, H[1], 0.4, H[2], 0.7, H[3], 1, H[4]],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.95, 6, 0.6, 9, 0],
    },
  });
  m.addLayer({
    id: 'cl-glow',
    type: 'circle',
    source: 'complaints',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['case', ['>', ['/', ['get', 'linked'], ['get', 'point_count']], 0.5], P.linked, P.dot],
      'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 18, 20, 26, 100, 36, 400, 46],
      'circle-blur': 1,
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.15, 6, 0.35],
    },
  });
  m.addLayer({
    id: 'cl-circle',
    type: 'circle',
    source: 'complaints',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['case', ['>', ['/', ['get', 'linked'], ['get', 'point_count']], 0.5], P.linked, P.dot],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 5, 0.92],
      'circle-radius': ['interpolate', ['linear'], ['get', 'point_count'], 2, 9, 20, 14, 100, 21, 400, 28],
      'circle-stroke-color': theme === 'dark' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)',
      'circle-stroke-width': 1.5,
    },
  });
  // Без подложки (нет сети) нет и шрифтов: подписи пропускаем, точки и кольца остаются.
  const glyphs = !!m.getStyle().glyphs;
  if (glyphs) m.addLayer({
    id: 'cl-count',
    type: 'symbol',
    source: 'complaints',
    filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 12], 'text-allow-overlap': true },
    paint: { 'text-color': P.text },
  });
  m.addLayer({
    id: 'pt',
    type: 'circle',
    source: 'complaints',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['case', ['get', 'linked'], P.linked, P.dot],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 9, 5],
      'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 60, 0.35],
      'circle-stroke-color': P.stroke,
      'circle-stroke-width': 1,
    },
  });
  // Мягкая заливка под кольцом инцидента — «зона поражения».
  m.addLayer({
    id: 'inc-fill',
    type: 'circle',
    source: 'incs',
    paint: {
      'circle-color': ['match', ['get', 'p'], 'P1', P.P1, 'P2', P.P2, 'P3', P.P3, P.P4],
      'circle-radius': ['+', HALO_BASE, 6] as any,
      'circle-blur': 0.7,
      'circle-opacity': ['case', ['get', 'sel'], 0.32, 0.16],
    },
  });
  // Расходящееся кольцо вокруг инцидента — заметно, но не мешает (анимация в компоненте).
  m.addLayer({
    id: 'inc-halo',
    type: 'circle',
    source: 'incs',
    paint: {
      'circle-color': 'transparent',
      'circle-radius': HALO_BASE as any,
      'circle-stroke-width': 2,
      'circle-stroke-color': ['match', ['get', 'p'], 'P1', P.P1, 'P2', P.P2, 'P3', P.P3, P.P4],
      'circle-stroke-opacity': 0,
    },
  });
  m.addLayer({
    id: 'inc-ring',
    type: 'circle',
    source: 'incs',
    paint: {
      'circle-color': 'transparent',
      'circle-radius': ['interpolate', ['linear'], ['get', 'n'], 5, 20, 50, 30, 200, 42],
      'circle-stroke-color': ['match', ['get', 'p'], 'P1', P.P1, 'P2', P.P2, 'P3', P.P3, P.P4],
      'circle-stroke-width': ['case', ['get', 'sel'], 5, 3],
      'circle-stroke-opacity': 0.9,
    },
  });
  if (glyphs) m.addLayer({
    id: 'inc-label',
    type: 'symbol',
    source: 'incs',
    layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': ['case', ['get', 'sel'], 13, 11.5], 'text-offset': [0, 2.7], 'text-anchor': 'top', 'text-allow-overlap': false, 'text-optional': true, 'text-letter-spacing': 0.02 },
    paint: { 'text-color': ['case', ['get', 'sel'], ['match', ['get', 'p'], 'P1', P.P1, 'P2', P.P2, P.label], P.label], 'text-halo-color': P.stroke, 'text-halo-width': 2, 'text-halo-blur': 0.5 },
  });
}

function push(m: MlMap) {
  const s = getState();
  const at = s.replayAt;
  const now = at ?? Date.now() + s.offset;
  const list = at === null ? s.complaints : s.complaints.filter((c) => c.at <= at && at - c.at < 30 * 60_000);
  const pts: GeoJSON.Feature[] = list.map((c) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    properties: { linked: !!c.incidentId, age: Math.round((now - c.at) / 60_000) },
  }));
  (m.getSource('complaints') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pts });
  (m.getSource('heat') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pts });
  const incs: GeoJSON.Feature[] = [];
  for (const i of s.incidents.values()) {
    if (i.origin !== 'complaints') continue;
    if (at === null ? i.status === 'resolved' : i.createdAt > at || (i.resolvedAt !== null && i.resolvedAt <= at)) continue;
    const n = at === null ? i.complaints ?? 0 : list.filter((c) => c.incidentId === i.id).length;
    for (const r of i.regionIds ?? []) {
      const reg = s.regions.find((x) => x.id === r);
      if (!reg) continue;
      incs.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [reg.lon, reg.lat] },
        properties: { id: i.id, p: i.priority, n, sel: i.id === s.selectedId, label: `${i.service} · ${n}` },
      });
    }
  }
  (m.getSource('incs') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: incs });
}
