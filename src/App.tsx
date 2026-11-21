import { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { checkAuth, select, useStore } from './store';
import { unlockAudio } from './lib/sound';
import { TopBar } from './components/TopBar';
import { PointApp } from './components/PointApp';
import { TeamScreen } from './components/TeamScreen';
import { Directory } from './components/Directory';
import { CriticalBanner, Toasts } from './components/Alerts';
import { Login } from './components/Login';
import { QuickSearch } from './components/QuickSearch';
import { DashHome, StandaloneWall } from './components/dash/Dashboard';
import { setWorkOpen, useWorkOpen } from './lib/dashLayout';
import { startPrefsSync, stopPrefsSync } from './lib/userPrefs';
import { Hotkeys } from './components/Hotkeys';
import { Settings } from './components/Settings';
import { Alarm, ForecastWatch } from './components/Alarm';
import { Jarvis } from './components/Jarvis';
import { Scenario } from './components/Scenario';

export function App() {
  const theme = useStore((s) => s.theme);
  const me = useStore((s) => s.me);
  const authChecked = useStore((s) => s.authChecked);
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const loaded = useStore((s) => s.teams.length > 0);
  const workOpen = useWorkOpen();
  const tab = useStore((s) => s.tab);
  // Вошёл (или сменился) дежурный — начинаем с дашборда.
  useEffect(() => setWorkOpen(false), [me?.login]);
  // Настройки закреплены за сотрудником: подтягиваем при входе, сохраняем при изменении.
  useEffect(() => {
    if (me?.role === 'coordinator') void startPrefsSync(me.login);
    else stopPrefsSync();
  }, [me?.login, me?.role]);

  useEffect(() => {
    void checkAuth();
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, select, textarea')) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const skin = useStore((s) => s.skin);
  const motion = useStore((s) => s.motion);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.skin = skin;
    document.documentElement.dataset.motion = motion ? 'on' : 'off';
  }, [theme, skin, motion]);

  if (!authChecked) return <div className="boot full"><span className="boot-ring" /></div>;
  if (!me) return <Login />;
  const atPoint = me.role === 'coordinator';
  // Отдельное окно для экрана стены: адрес с ?wall — только видеостена, без шапки.
  if (atPoint && loaded && new URLSearchParams(location.search).has('wall')) return <StandaloneWall />;
  // После входа дежурный видит дашборд; всё рабочее место (вкладки, карточки, справочник) — по кнопке.
  if (atPoint && loaded && !workOpen)
    return (
      <>
        <DashHome />
        <Settings />
        <Jarvis />
      </>
    );

  return (
    <div className={`app role-${me.role} view-${view}`}>
      <TopBar />
      {atPoint && <CriticalBanner />}
      {!connected && everConnected && (
        <div className="offline">
          <WifiOff size={14} /> Нет связи с сервером — переподключаемся.
        </div>
      )}
      <div className="stage">
        {!loaded ? (
          <div className="boot">
            <span className="boot-ring" />
            Подключаемся…
          </div>
        ) : atPoint ? (
          <PointApp />
        ) : view === 'directory' ? (
          <Directory />
        ) : (
          <TeamScreen />
        )}
      </div>
      {!(atPoint && tab === 'wall') && <Toasts />}
      <QuickSearch />
      <Settings />
      <Hotkeys />
      {atPoint && loaded && <Alarm />}
      {atPoint && loaded && <ForecastWatch />}
      {atPoint && loaded && <Jarvis />}
      {atPoint && loaded && <Scenario />}
    </div>
  );
}
