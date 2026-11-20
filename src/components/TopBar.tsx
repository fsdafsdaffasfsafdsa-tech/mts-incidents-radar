import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Monitor, Moon, Sun, Truck, UserRound, Volume2, VolumeX } from 'lucide-react';
import type { Intensity, ScenarioKind } from '../../shared/types';
import { runScenario, setIntensity, setScreen, toggleSound, toggleTheme, useStore, type Screen } from '../store';
import { fmtClockSec } from '../lib/format';
import { useNow } from '../lib/hooks';

const INTENSITY: { id: Intensity; label: string }[] = [
  { id: 'calm', label: 'Спокойно' },
  { id: 'normal', label: 'Норма' },
  { id: 'storm', label: 'Шторм' },
];

const SCENARIOS: { id: ScenarioKind; title: string }[] = [
  { id: 'mass_outage', title: 'Массовый сбой: главный + 3 дубля' },
  { id: 'field_wave', title: 'Волна выездов в 4 городах' },
  { id: 'coord_flood', title: '6 новых проблем без сотрудника' },
];

export function TopBar() {
  const connected = useStore((s) => s.connected);
  const sound = useStore((s) => s.sound);
  const theme = useStore((s) => s.theme);
  const intensity = useStore((s) => s.intensity);
  const screen = useStore((s) => s.screen);
  const incidents = useStore((s) => s.incidents);
  const now = useNow(1000);
  const [demo, setDemo] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const waiting = useMemo(() => {
    let online = 0;
    let offline = 0;
    for (const i of incidents.values()) {
      if (i.status !== 'coordinators') continue;
      if (i.mode === 'online') online++;
      else offline++;
    }
    return { online, offline };
  }, [incidents]);

  useEffect(() => {
    if (!demo) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setDemo(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [demo]);

  const tabs: { id: Screen; label: string; icon: typeof Monitor; badge?: number }[] = [
    { id: 'online', label: 'Онлайн-центр', icon: Monitor, badge: waiting.online },
    { id: 'offline', label: 'Офлайн-центр', icon: Truck, badge: waiting.offline },
    { id: 'cabinet', label: 'Кабинет', icon: UserRound },
  ];

  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="16" r="11" className="ring1" />
          <circle cx="16" cy="16" r="6" className="ring2" />
          <g className="sweep">
            <path d="M16 16 L16 4 A12 12 0 0 1 26.4 10 Z" />
          </g>
          <circle cx="16" cy="16" r="2.4" className="core" />
        </svg>
        <div className="brand-name">Радар</div>
      </div>

      <nav className="nav" aria-label="Экраны">
        {tabs.map((t) => (
          <button key={t.id} className={screen === t.id ? 'on' : ''} onClick={() => setScreen(t.id)} aria-current={screen === t.id ? 'page' : undefined}>
            <t.icon size={16} />
            <span>{t.label}</span>
            {!!t.badge && <span className="nav-badge num">{t.badge}</span>}
          </button>
        ))}
      </nav>

      <div className="topbar-spacer" />

      <div className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Поток подключён' : 'Нет связи'}>
        <span className="live-dot" />
        <span className="live-text">{connected ? 'LIVE' : 'нет связи'}</span>
      </div>

      <div className="demo-wrap" ref={ref}>
        <button className={`tb-btn ${demo ? 'active' : ''}`} onClick={() => setDemo((v) => !v)} title="Демо">
          <FlaskConical size={16} />
          <span>Демо</span>
        </button>
        {demo && (
          <div className="popover demo-pop">
            <div className="seg">
              {INTENSITY.map((i) => (
                <button key={i.id} className={intensity === i.id ? 'on' : ''} onClick={() => void setIntensity(i.id)}>
                  {i.label}
                </button>
              ))}
            </div>
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                className="scenario"
                onClick={() => {
                  void runScenario(s.id);
                  setDemo(false);
                }}
              >
                <b>{s.title}</b>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className={`tb-icon ${sound ? '' : 'muted'}`} onClick={toggleSound} aria-label="Звук">
        {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
      </button>
      <button className="tb-icon" onClick={toggleTheme} aria-label="Тема">
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <div className="clock num">{fmtClockSec(now)}</div>
    </header>
  );
}
