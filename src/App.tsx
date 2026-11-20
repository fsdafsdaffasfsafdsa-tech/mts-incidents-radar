import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { ack, connect, getState, openItsm, select, setView, toggleSound, useStore } from './store';
import { useQueue } from './lib/queue';
import { unlockAudio } from './lib/sound';
import { TopBar } from './components/TopBar';
import { Board } from './components/Board';
import { MapView } from './components/MapView';
import { FeedView, QueueView, SystemsView } from './components/Views';
import { CriticalBanner, Toasts } from './components/Alerts';
import { HelpOverlay } from './components/HelpOverlay';

export function App() {
  const theme = useStore((s) => s.theme);
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const loaded = useStore((s) => s.source !== null);
  const queue = useQueue();
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const modalRef = useRef(false);
  modalRef.current = help;

  useEffect(() => {
    connect();
    // Браузер разрешает звук только после первого действия пользователя.
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea, select')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = getState();
      const list = queueRef.current;
      const idx = list.findIndex((i) => i.id === s.selectedId);
      const sel = s.selectedId ? s.incidents.get(s.selectedId) : undefined;
      const k = e.key.toLowerCase();
      if (k === 'arrowdown' || k === 'j' || k === 'о') {
        e.preventDefault();
        const next = list[Math.min(list.length - 1, idx + 1)];
        if (next) select(next.id);
      } else if (k === 'arrowup' || k === 'k' || k === 'л') {
        e.preventDefault();
        const prev = list[Math.max(0, idx - 1)];
        if (prev) select(prev.id);
      } else if (k === 'n' || k === 'т') {
        const next = s.attention.find((id) => s.incidents.get(id)?.status !== 'resolved');
        if (next) select(next);
      } else if ((k === 'a' || k === 'ф') && sel && !sel.acknowledged) {
        void ack(sel.id);
      } else if ((k === 'o' || k === 'щ') && sel) {
        openItsm(sel.id);
      } else if (k === 'g' || k === 'п') {
        setView(s.view === 'map' ? 'board' : 'map');
      } else if (e.key === '/') {
        e.preventDefault();
        if (s.view !== 'queue') setView('queue');
        setTimeout(() => searchRef.current?.focus(), 30);
      } else if (k === 'm' || k === 'ь') {
        toggleSound();
      } else if (e.key === '?' || e.key === ',') {
        setHelp((v) => !v);
      } else if (e.key === 'Escape') {
        if (modalRef.current) setHelp(false);
        else if (s.selectedId) select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app view-${view}`}>
      <TopBar onHelp={() => setHelp(true)} />
      <CriticalBanner />
      {!connected && everConnected && (
        <div className="offline">
          <WifiOff size={14} /> Связь с сервером потеряна — переподключаемся. Данные на экране могут быть неактуальны.
        </div>
      )}
      <div className="stage">
        {!loaded ? (
          <div className="boot">
            <span className="boot-ring" />
            Загружаем выгрузку инцидентов…
          </div>
        ) : view === 'board' ? (
          <Board />
        ) : view === 'map' ? (
          <MapView />
        ) : view === 'queue' ? (
          <QueueView searchRef={searchRef} />
        ) : view === 'systems' ? (
          <SystemsView />
        ) : (
          <FeedView />
        )}
      </div>
      <Toasts />
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}
