import { useEffect, useRef, useState } from 'react';
import { Activity, Bell, BellOff, FlaskConical, Keyboard, LayoutGrid, ListOrdered, Map as MapIcon, Moon, Sparkles, Sun, Volume2, VolumeX } from 'lucide-react';
import type { Intensity, ScenarioKind } from '../../shared/types';
import { ME, runScenario, setIntensity, setView, toggleNotify, toggleSound, toggleTheme, useStore, type View } from '../store';

const NAV: { id: View; label: string; icon: typeof MapIcon }[] = [
  { id: 'map', label: 'Карта', icon: MapIcon },
  { id: 'queue', label: 'Очередь', icon: ListOrdered },
  { id: 'systems', label: 'Системы', icon: LayoutGrid },
  { id: 'feed', label: 'Лента', icon: Activity },
];
import { fmtClockSec } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Avatar } from './bits';

const INTENSITY: { id: Intensity; label: string }[] = [
  { id: 'calm', label: 'Спокойно' },
  { id: 'normal', label: 'Норма' },
  { id: 'storm', label: 'Шторм' },
];

const SCENARIOS: { id: ScenarioKind; title: string; text: string }[] = [
  { id: 'billing_outage', title: 'Сбой биллинга', text: 'P1 в биллинге и каскад: «Мой МТС», ЛК, платежи, контакт-центр' },
  { id: 'network_cut', title: 'Обрыв магистрали', text: 'P1 на транспорте в Самаре, следом БС, ядро и ШПД' },
  { id: 'ddos', title: 'DDoS на личный кабинет', text: 'Система — ЛК, а решать должен SOC: проверка подсказки ИИ' },
  { id: 'coord_flood', title: 'Наплыв на координаторов', text: '6 новых инцидентов без команды — разбор очереди с ИИ' },
];

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const connected = useStore((s) => s.connected);
  const stats = useStore((s) => s.stats);
  const ai = useStore((s) => s.ai);
  const sound = useStore((s) => s.sound);
  const notify = useStore((s) => s.notify);
  const theme = useStore((s) => s.theme);
  const intensity = useStore((s) => s.intensity);
  const view = useStore((s) => s.view);
  const attentionCount = useStore((s) => s.attention.length);
  const now = useNow(1000);
  const [demo, setDemo] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!demo) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setDemo(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [demo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'd' || e.key === 'в') setDemo((v) => !v);
      if (e.key === 'Escape') setDemo(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        <div>
          <div className="brand-name">Радар</div>
          <div className="brand-sub">координация IT-инцидентов</div>
        </div>
      </div>

      <nav className="nav" aria-label="Экраны">
        {NAV.map((n) => (
          <button key={n.id} className={view === n.id ? 'on' : ''} onClick={() => setView(n.id)} aria-current={view === n.id ? 'page' : undefined}>
            <n.icon size={16} />
            <span>{n.label}</span>
            {n.id === 'queue' && attentionCount > 0 && <span className="nav-badge num">{attentionCount}</span>}
          </button>
        ))}
      </nav>

      <div className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Поток подключён' : 'Нет связи с сервером, переподключаемся'}>
        <span className="live-dot" />
        <span className="live-text">{connected ? 'LIVE' : 'нет связи'}</span>
        {stats && connected && <span className="live-flow num">{stats.flowPerMin}/мин</span>}
      </div>

      {ai && (
        <div className={`ai-badge ai-${ai.mode}`} title={ai.reason}>
          <Sparkles size={14} />
          <span>{ai.mode === 'claude' ? `ИИ: Claude` : 'ИИ: эвристика'}</span>
          {stats?.aiAccuracy != null && <span className="ai-acc num">· точность {Math.round(stats.aiAccuracy * 100)}%</span>}
        </div>
      )}

      <div className="topbar-spacer" />

      <div className="demo-wrap" ref={ref}>
        <button className={`tb-btn demo-btn ${demo ? 'active' : ''}`} onClick={() => setDemo((v) => !v)} title="Демо-управление потоком (D)">
          <FlaskConical size={16} />
          <span>Демо</span>
          <span className={`intensity-dot i-${intensity}`} />
        </button>
        {demo && (
          <div className="popover demo-pop" role="dialog" aria-label="Демо-управление">
            <div className="pop-label">Интенсивность потока</div>
            <div className="seg">
              {INTENSITY.map((i) => (
                <button key={i.id} className={intensity === i.id ? 'on' : ''} onClick={() => void setIntensity(i.id)}>
                  {i.label}
                </button>
              ))}
            </div>
            <div className="pop-label">Сценарии</div>
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
                <span>{s.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button className={`tb-icon ${sound ? '' : 'muted'}`} onClick={toggleSound} title={sound ? 'Звук включён (M)' : 'Звук выключен (M)'} aria-label="Звук">
        {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
      </button>
      <button className={`tb-icon ${notify ? '' : 'muted'}`} onClick={() => void toggleNotify()} title="Уведомления браузера, когда вкладка свёрнута" aria-label="Уведомления">
        {notify ? <Bell size={17} /> : <BellOff size={17} />}
      </button>
      <button className="tb-icon" onClick={toggleTheme} title="Светлая / тёмная тема" aria-label="Тема">
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <button className="tb-icon" onClick={onHelp} title="Горячие клавиши (?)" aria-label="Горячие клавиши">
        <Keyboard size={17} />
      </button>

      <div className="clock num">{fmtClockSec(now)}</div>
      <div className="me">
        <Avatar name={ME} />
        <div>
          <div className="me-name">{ME}</div>
          <div className="me-role">координатор смены</div>
        </div>
      </div>
    </header>
  );
}
