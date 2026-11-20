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

export function App() {
  const theme = useStore((s) => s.theme);
  const me = useStore((s) => s.me);
  const authChecked = useStore((s) => s.authChecked);
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const loaded = useStore((s) => s.teams.length > 0);

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (!authChecked) return <div className="boot full"><span className="boot-ring" /></div>;
  if (!me) return <Login />;
  const atPoint = me.role === 'coordinator' || me.role === 'commander';

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
      <Toasts />
    </div>
  );
}
