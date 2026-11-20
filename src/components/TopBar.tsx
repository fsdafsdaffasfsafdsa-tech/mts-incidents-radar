import { Activity, Bell, BellOff, FileJson, FileWarning, Keyboard, LayoutDashboard, LayoutGrid, ListOrdered, Map as MapIcon, Moon, Sparkles, Sun, Volume2, VolumeX, X } from 'lucide-react';
import { ME, setView, toggleNotify, toggleSound, toggleTheme, useStore, type View } from '../store';
import { fmtAgo, fmtClockSec } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Avatar } from './bits';

const NAV: { id: View; label: string; icon: typeof MapIcon }[] = [
  { id: 'board', label: 'Обзор', icon: LayoutDashboard },
  { id: 'queue', label: 'Очередь', icon: ListOrdered },
  { id: 'systems', label: 'Продукты', icon: LayoutGrid },
  { id: 'feed', label: 'Лента', icon: Activity },
];

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const connected = useStore((s) => s.connected);
  const ai = useStore((s) => s.ai);
  const source = useStore((s) => s.source);
  const sound = useStore((s) => s.sound);
  const notify = useStore((s) => s.notify);
  const theme = useStore((s) => s.theme);
  const view = useStore((s) => s.view);
  const attentionCount = useStore((s) => s.attention.length);
  const now = useNow(1000);
  const onMap = view === 'map';

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

      <button className={`map-toggle ${onMap ? 'on' : ''}`} onClick={() => setView(onMap ? 'board' : 'map')} title="Карта инцидентов (G)">
        {onMap ? <X size={17} /> : <MapIcon size={17} />}
        <span>{onMap ? 'Закрыть карту' : 'Карта'}</span>
      </button>

      <div className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Поток подключён' : 'Нет связи с сервером, переподключаемся'}>
        <span className="live-dot" />
        <span className="live-text">{connected ? 'LIVE' : 'нет связи'}</span>
      </div>

      {source && (
        <div
          className={`src-badge ${source.error ? 'err' : ''}`}
          title={source.error ?? `Данные из ${source.file}: ${source.count} инцидентов${source.skipped ? `, пропущено записей: ${source.skipped}` : ''}. Правки файла попадают на дашборд сразу.`}
        >
          {source.error ? <FileWarning size={14} /> : <FileJson size={14} />}
          <span className="num">{source.file}</span>
          <span className="src-sub">{source.error ? 'ошибка в файле' : source.loadedAt ? `обновлён ${fmtAgo(now - source.loadedAt)}` : ''}</span>
        </div>
      )}

      {ai && (
        <div className={`ai-badge ai-${ai.mode}`} title={ai.reason}>
          <Sparkles size={14} />
          <span>{ai.mode === 'claude' ? `ИИ: Claude` : 'ИИ: эвристика'}</span>
        </div>
      )}

      <div className="topbar-spacer" />

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
