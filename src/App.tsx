import { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { connect, select, useStore } from './store';
import { unlockAudio } from './lib/sound';
import { TopBar } from './components/TopBar';
import { OfflineCenter, OnlineCenter } from './components/Center';
import { Cabinet } from './components/Cabinet';
import { CriticalBanner, Toasts } from './components/Alerts';

export function App() {
  const theme = useStore((s) => s.theme);
  const screen = useStore((s) => s.screen);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const loaded = useStore((s) => s.workers.length > 0);

  useEffect(() => {
    connect();
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

  return (
    <div className={`app screen-${screen}`}>
      <TopBar />
      <CriticalBanner />
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
        ) : screen === 'online' ? (
          <OnlineCenter />
        ) : screen === 'offline' ? (
          <OfflineCenter />
        ) : (
          <Cabinet />
        )}
      </div>
      <Toasts />
    </div>
  );
}
