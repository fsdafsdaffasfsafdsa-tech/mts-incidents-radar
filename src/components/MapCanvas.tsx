// Карта инцидентов в духе такси-агрегатора: точки по приоритету, кластеры по городам,
// пульсирующие P1, едущие бригады с маршрутом и линии оборванных магистралей.
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Incident } from '../../shared/types';
import { getState, select, setState, useStore } from '../store';
import { matches } from '../lib/queue';
import { fmtSla } from '../lib/format';

const STYLE_URL = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};

// Запасной стиль без интернета: точки остаются, пропадает только подложка.
const offlineStyle = (theme: 'dark' | 'light'): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': theme === 'dark' ? '#0b0f16' : '#e9edf3' } }],
});

const PALETTE = {
  dark: { P1: '#ff3150', P2: '#ff8a2b', P3: '#e6c247', P4: '#5b8cff', ok: '#2fd27f', stroke: '#0b0f16', crew: '#ffffff', route: '#a78bff', text: '#ffffff', ai: '#a78bff' },
  light: { P1: '#e3142d', P2: '#e06a00', P3: '#c79600', P4: '#2f6bed', ok: '#0f9d57', stroke: '#ffffff', crew: '#121722', route: '#6b4cf0', text: '#ffffff', ai: '#6b4cf0' },
};

const RUSSIA: [[number, number], [number, number]] = [
  [28, 43.5],
  [95, 61.5],
];

export const SHEET_W = 460;
export const PANEL_W = 380;

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k;
}

function crewPos(inc: Incident, now: number) {
  const c = inc.crew!;
  const k = c.arrived ? 1 : Math.min(1, Math.max(0, (now - c.dispatchedAt) / c.etaMs));
  // Плавный разгон и торможение, как у машины на карте.
  const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  return { lon: lerp(c.from.lon, inc.geo.lon, e), lat: lerp(c.from.lat, inc.geo.lat, e), k };
}

function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const y = Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x =
    Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
    Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Значок бригады — стрелка-навигатор, как машина в такси-приложении. */
function crewIcon(fill: string, accent: string): ImageData {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 8;
  g.beginPath();
  g.arc(0, 0, 17, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.shadowBlur = 0;
  g.beginPath();
  g.moveTo(0, -11);
  g.lineTo(8, 9);
  g.lineTo(0, 4);
  g.lineTo(-8, 9);
  g.closePath();
  g.fillStyle = accent;
  g.fill();
  return g.getImageData(0, 0, size, size);
}

export function MapCanvas() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const theme = useStore((s) => s.theme);
  const incidents = useStore((s) => s.incidents);
  const filter = useStore((s) => s.filter);
  const attention = useStore((s) => s.attention);
  const selectedId = useStore((s) => s.selectedId);
  const hoverId = useStore((s) => s.hoverId);
  const [offline, setOffline] = useState(false);

  // ── создание карты
  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: STYLE_URL[getState().theme],
      center: [56, 56],
      zoom: 3.4,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 15,
      minZoom: 2.5,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;
    (window as unknown as { __radarMap?: MlMap }).__radarMap = map; // для отладки и скриншотов

    let failTimer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) {
        setOffline(true);
        map.setStyle(offlineStyle(getState().theme), { diff: false });
      }
    }, 8000);
    map.on('error', (e) => {
      if (!readyRef.current && String(e.error?.message ?? '').match(/style|fetch|Failed/i)) {
        clearTimeout(failTimer);
        setOffline(true);
        map.setStyle(offlineStyle(getState().theme), { diff: false });
      }
    });
    let fitted = false;
    map.on('style.load', () => {
      clearTimeout(failTimer);
      installLayers(map, getState().theme);
      lastSig.delete(map);
      readyRef.current = true;
      pushData(map);
      if (!fitted) {
        fitted = true;
        fitRussia(map);
      }
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: 'map-pop' });
    map.on('mouseenter', 'points', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features?.[0];
      if (!f) return;
      const inc = getState().incidents.get(String(f.properties.id));
      if (!inc) return;
      popup
        .setLngLat([inc.geo.lon, inc.geo.lat])
        .setHTML(
          `<div class="mp-top"><span class="prio prio-${inc.priority}">${inc.priority}</span><span class="mp-city">${inc.region}</span><span class="mp-sla">${fmtSla(inc.slaDeadline - Date.now())}</span></div><div class="mp-title"></div>`,
        )
        .addTo(map);
      const t = popup.getElement()?.querySelector('.mp-title');
      if (t) t.textContent = inc.title; // без HTML из данных
      setState({ hoverId: inc.id });
    });
    map.on('mouseleave', 'points', () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
      setState({ hoverId: null });
    });
    map.on('click', 'points', (e) => {
      const id = e.features?.[0]?.properties.id;
      if (id) select(String(id));
    });
    map.on('mouseenter', 'clusters', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'clusters', () => (map.getCanvas().style.cursor = ''));
    map.on('click', 'clusters', async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const src = map.getSource('incidents') as GeoJSONSource;
      const zoom = await src.getClusterExpansionZoom(f.properties.cluster_id as number);
      map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: Math.min(zoom + 0.3, 13), duration: 700 });
    });
    map.on('click', 'crews', (e) => {
      const id = e.features?.[0]?.properties.id;
      if (id) select(String(id));
    });

    // Анимация: пульс P1, круги от новых точек, движение бригад.
    let raf = 0;
    let lastCrew = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!readyRef.current || !map.getLayer('halo')) return;
      const phase = (t % 1800) / 1800;
      map.setPaintProperty('halo', 'circle-radius', 9 + phase * 22);
      map.setPaintProperty('halo', 'circle-opacity', 0.55 * (1 - phase));
      map.setPaintProperty('cluster-halo', 'circle-stroke-opacity', 0.7 * (1 - phase));
      map.setPaintProperty('cluster-halo', 'circle-radius', ['+', ['step', ['get', 'point_count'], 18, 10, 22, 30, 27, 80, 33], phase * 14]);
      if (t - lastCrew > 250) {
        lastCrew = t;
        pushDynamic(map);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(failTimer);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // ── смена темы: меняем подложку, слои ставятся заново в style.load
  const appliedTheme = useRef(theme);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedTheme.current === theme) return;
    appliedTheme.current = theme;
    readyRef.current = false;
    // diff: false — полная перезагрузка стиля, иначе MapLibre молча удалит наши слои с точками.
    map.setStyle(offline ? offlineStyle(theme) : STYLE_URL[theme], { diff: false });
  }, [theme]);

  // ── данные: не чаще раза в секунду, иначе карта не успевает пересчитать кластеры и ничего не рисует
  const lastPush = useRef(0);
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const run = () => {
      pending.current = null;
      lastPush.current = Date.now();
      const map = mapRef.current;
      if (map && readyRef.current) pushData(map);
    };
    const wait = 1000 - (Date.now() - lastPush.current);
    if (wait <= 0) run();
    else if (pending.current === null) pending.current = window.setTimeout(run, wait);
  }, [incidents, filter, attention]);
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) pushFocus(map);
  }, [selectedId, hoverId]);
  useEffect(() => () => void (pending.current !== null && clearTimeout(pending.current)), []);

  // ── перелёт к выбранному инциденту
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const inc = getState().incidents.get(selectedId);
    if (!inc) return;
    const wide = map.getContainer().clientWidth > 1000;
    map.easeTo({
      center: [inc.geo.lon, inc.geo.lat],
      zoom: Math.max(map.getZoom(), inc.region === 'Москва' ? 10.2 : 10.8),
      padding: wide ? { left: PANEL_W + 30, right: SHEET_W + 30, top: 90, bottom: 30 } : { left: 0, right: 0, top: 0, bottom: 0 },
      duration: 900,
    });
  }, [selectedId]);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      {offline && <div className="map-offline">Нет доступа к подложке карты — точки показаны без неё</div>}
    </div>
  );
}

/** Вся страна в кадре; слева место под панель «Требуют решения», если экран широкий. */
export function fitRussia(map: MlMap, duration = 0) {
  const w = map.getContainer().clientWidth;
  const h = map.getContainer().clientHeight;
  const wide = w > 1000;
  const padding = {
    left: wide ? PANEL_W + 40 : 16,
    right: wide ? 40 : 16,
    top: Math.min(100, h * 0.15),
    bottom: Math.min(60, h * 0.1),
  };
  if (w - padding.left - padding.right < 200 || h - padding.top - padding.bottom < 150) return;
  map.fitBounds(RUSSIA, { padding, duration });
}

// ─── слои ──────────────────────────────────────────────────────────────────

function installLayers(map: MlMap, theme: 'dark' | 'light') {
  const P = PALETTE[theme];
  // Шрифт для цифр в кластерах — прямой, не курсив: берём из стиля подложки, чтобы глифы точно были на сервере.
  const fonts = map
    .getStyle()
    .layers.map((l) => (l.layout as any)?.['text-font'])
    .filter((f): f is string[] => Array.isArray(f) && typeof f[0] === 'string');
  const font = fonts.find((f) => /bold|semibold|medium/i.test(f[0]) && !/italic/i.test(f[0])) ??
    fonts.find((f) => !/italic/i.test(f[0])) ?? ['Open Sans Regular'];

  for (const l of map.getStyle().layers) {
    try {
      // Подписи городов и стран — по-русски, где есть.
      if (l.type === 'symbol' && /place|countr|city|town|state/i.test(l.id) && (l.layout as any)?.['text-field']) {
        map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name_en']]);
      }
      // Тёмная подложка CARTO почти чёрная: суша чуть светлее, вода — синеватая, чтобы читалась география.
      if (theme === 'dark') {
        if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#141b26');
        else if (l.type === 'fill' && /^(earth|land$|landcover)/i.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#141b26');
        else if (l.type === 'fill' && /water|ocean|lake/i.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#0a1322');
        else if (l.type === 'line' && /boundar|admin/i.test(l.id)) map.setPaintProperty(l.id, 'line-color', '#3a4658');
      }
    } catch {
      /* у слоя нет такого свойства */
    }
  }

  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  map.addSource('incidents', {
    type: 'geojson',
    data: empty,
    cluster: true,
    clusterMaxZoom: 8,
    clusterRadius: 48,
    clusterProperties: {
      p1: ['+', ['case', ['==', ['get', 'priority'], 'P1'], 1, 0]],
      p2: ['+', ['case', ['==', ['get', 'priority'], 'P2'], 1, 0]],
      p3: ['+', ['case', ['==', ['get', 'priority'], 'P3'], 1, 0]],
    },
  });
  map.addSource('paths', { type: 'geojson', data: empty });
  map.addSource('crews', { type: 'geojson', data: empty });
  map.addSource('routes', { type: 'geojson', data: empty });
  map.addSource('focus', { type: 'geojson', data: empty });
  map.addSource('recent', { type: 'geojson', data: empty });
  if (!map.hasImage('crew')) map.addImage('crew', crewIcon(P.crew, P.ai), { pixelRatio: 2 });

  const worst = ['case', ['>', ['get', 'p1'], 0], P.P1, ['>', ['get', 'p2'], 0], P.P2, ['>', ['get', 'p3'], 0], P.P3, P.P4] as any;
  const prioColor = ['match', ['get', 'priority'], 'P1', P.P1, 'P2', P.P2, 'P3', P.P3, P.P4] as any;

  map.addLayer({
    id: 'paths',
    type: 'line',
    source: 'paths',
    paint: { 'line-color': P.P1, 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'routes',
    type: 'line',
    source: 'routes',
    minzoom: 6,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': P.route, 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [0.1, 2] },
  });

  map.addLayer({
    id: 'cluster-halo',
    type: 'circle',
    source: 'incidents',
    filter: ['all', ['has', 'point_count'], ['>', ['get', 'p1'], 0]],
    paint: { 'circle-color': 'transparent', 'circle-stroke-color': P.P1, 'circle-stroke-width': 2, 'circle-radius': 22 },
  });
  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'incidents',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': worst,
      'circle-opacity': 0.92,
      'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 30, 25, 80, 31],
      'circle-stroke-width': 4,
      'circle-stroke-color': worst,
      'circle-stroke-opacity': 0.28,
    },
  });
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'incidents',
    filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': font, 'text-size': 13, 'text-allow-overlap': true },
    paint: { 'text-color': P.text },
  });

  map.addLayer({
    id: 'halo',
    type: 'circle',
    source: 'incidents',
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'priority'], 'P1']],
    paint: { 'circle-color': P.P1, 'circle-opacity': 0.4, 'circle-radius': 14 },
  });
  map.addLayer({
    id: 'recent',
    type: 'circle',
    source: 'recent',
    paint: {
      'circle-color': ['get', 'color'],
      'circle-opacity': ['get', 'opacity'],
      'circle-radius': ['get', 'radius'],
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-opacity': ['get', 'opacity'],
    },
  });
  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'incidents',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': prioColor,
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        4,
        ['match', ['get', 'priority'], 'P1', 6.5, 'P2', 5, 'P3', 4, 3.5],
        11,
        ['match', ['get', 'priority'], 'P1', 10, 'P2', 8, 'P3', 6.5, 6],
      ],
      'circle-stroke-width': ['case', ['get', 'coord'], 2.5, 1.5],
      'circle-stroke-color': ['case', ['get', 'coord'], '#35c9db', P.stroke],
    },
  });
  map.addLayer({
    id: 'focus',
    type: 'circle',
    source: 'focus',
    paint: {
      'circle-color': 'transparent',
      'circle-radius': ['get', 'r'],
      'circle-stroke-width': 3,
      'circle-stroke-color': ['get', 'color'],
    },
  });
  map.addLayer({
    id: 'crews',
    type: 'symbol',
    source: 'crews',
    minzoom: 6, // на карте страны бригады налезали бы на кластеры
    layout: {
      'icon-image': 'crew',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 11, 1],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

// ─── данные ────────────────────────────────────────────────────────────────

const lastSig = new WeakMap<MlMap, { pts: string; paths: string }>();

function pushData(map: MlMap) {
  const s = getState();
  const now = Date.now() + s.offset;
  const att = new Set(s.attention);
  const features: GeoJSON.Feature[] = [];
  const paths: GeoJSON.Feature[] = [];
  for (const inc of s.incidents.values()) {
    if (inc.status === 'resolved') continue;
    if (!matches(inc, s.filter, att, now) && inc.id !== s.selectedId) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [inc.geo.lon, inc.geo.lat] },
      properties: { id: inc.id, priority: inc.priority, coord: inc.status === 'coordinators' },
    });
    if (inc.path) paths.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: inc.path }, properties: { id: inc.id } });
  }
  // Пересобираем кластеры, только если набор точек правда изменился.
  const sig = {
    pts: features.map((f) => `${f.properties!.id}${f.properties!.priority}${f.properties!.coord ? 'c' : ''}`).join('|'),
    paths: paths.map((f) => f.properties!.id).join('|'),
  };
  const prev = lastSig.get(map);
  if (!prev || prev.pts !== sig.pts) (map.getSource('incidents') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  if (!prev || prev.paths !== sig.paths) (map.getSource('paths') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: paths });
  lastSig.set(map, sig);
  pushFocus(map);
}

function pushFocus(map: MlMap) {
  const s = getState();
  const P = PALETTE[s.theme];
  const focus: GeoJSON.Feature[] = [];
  for (const [id, color, r] of [
    [s.selectedId, P.ai, 18],
    [s.hoverId, P.text, 15],
  ] as const) {
    const inc = id ? s.incidents.get(id) : undefined;
    if (inc) focus.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [inc.geo.lon, inc.geo.lat] }, properties: { color, r } });
  }
  (map.getSource('focus') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: focus });
}

/** Часто меняющееся: бригады в пути, круги от новых и решённых точек. */
function pushDynamic(map: MlMap) {
  const s = getState();
  const now = Date.now() + s.offset;
  const P = PALETTE[s.theme];
  const crews: GeoJSON.Feature[] = [];
  const routes: GeoJSON.Feature[] = [];
  const recent: GeoJSON.Feature[] = [];
  for (const inc of s.incidents.values()) {
    if (inc.crew && inc.status !== 'resolved') {
      const p = crewPos(inc, now);
      crews.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: inc.id, bearing: bearing(inc.crew.from, inc.geo) },
      });
      if (p.k < 1) routes.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[p.lon, p.lat], [inc.geo.lon, inc.geo.lat]] }, properties: {} });
    }
    // Новый инцидент расходится кругом, решённый гаснет зелёным.
    const fresh = s.fresh.get(inc.id);
    const age = fresh ? Date.now() - fresh : Infinity;
    if (inc.status !== 'resolved' && age < 2600) {
      const k = age / 2600;
      recent.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [inc.geo.lon, inc.geo.lat] },
        properties: { color: P[inc.priority], radius: 8 + k * 40, opacity: 0.5 * (1 - k) },
      });
    }
    if (inc.status === 'resolved' && inc.resolvedAt && now - inc.resolvedAt < 4000) {
      const k = (now - inc.resolvedAt) / 4000;
      recent.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [inc.geo.lon, inc.geo.lat] },
        properties: { color: P.ok, radius: 7 + k * 10, opacity: 0.9 * (1 - k) },
      });
    }
  }
  (map.getSource('crews') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: crews });
  (map.getSource('routes') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: routes });
  (map.getSource('recent') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: recent });
}
