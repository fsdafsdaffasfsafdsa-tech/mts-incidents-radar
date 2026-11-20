import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { act, connect, getState, select, setView, toggleSound, useStore } from './store';
import { useQueue } from './lib/queue';
import { unlockAudio } from './lib/sound';
import { TopBar } from './components/TopBar';
import { MapView } from './components/MapView';
import { FeedView, QueueView, SystemsView } from './components/Views';
import { CriticalBanner, Toasts } from './components/Alerts';
import { HelpOverlay, RoutingModal } from './components/RoutingModal';

export function App() {
  const theme = useStore((s) => s.theme);
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const loaded = useStore((s) => s.systems.length > 0);
  const queue = useQueue();
  const [routing, setRouting] = useState(false);
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const modalRef = useRef(false);
  modalRef.current = routing || help;

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
      const list = queueRef.current.filter((i) => i.status !== 'resolved');
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
        void act(sel.id, 'ack');
      } else if (k === '1' && sel && sel.ai.teamId && sel.status !== 'resolved' && sel.ai.teamId !== sel.teamId) {
        void act(sel.id, 'assign', { teamId: sel.ai.teamId, byAi: true });
      } else if ((k === 'e' || k === 'у') && sel && sel.status !== 'escalated' && sel.status !== 'resolved') {
        void act(sel.id, 'escalate');
      } else if ((e.key === 'R' || e.key === 'К') && e.shiftKey && sel && sel.status !== 'resolved') {
        void act(sel.id, 'resolve');
      } else if (e.key === '/') {
        e.preventDefault();
        if (s.view !== 'queue') setView('queue');
        setTimeout(() => searchRef.current?.focus(), 30);
      } else if (k === 'm' || k === 'ь') {
        toggleSound();
      } else if (e.key === '?' || e.key === ',') {
        setHelp((v) => !v);
      } else if (e.key === 'Escape') {
        if (modalRef.current) {
          setHelp(false);
          setRouting(false);
        } else if (s.selectedId) select(null);
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
            Подключаемся к потоку инцидентов…
          </div>
        ) : view === 'map' ? (
          <MapView onRouting={() => setRouting(true)} />
        ) : view === 'queue' ? (
          <QueueView onRouting={() => setRouting(true)} searchRef={searchRef} />
        ) : view === 'systems' ? (
          <SystemsView />
        ) : (
          <FeedView />
        )}
      </div>
      <Toasts />
      {routing && <RoutingModal onClose={() => setRouting(false)} />}
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}
