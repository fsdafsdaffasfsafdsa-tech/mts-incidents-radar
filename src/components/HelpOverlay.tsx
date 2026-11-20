import { X } from 'lucide-react';

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['↑ ↓  или  J K', 'перейти по очереди'],
    ['N', 'следующий, требующий внимания'],
    ['A', 'взять на контроль'],
    ['O', 'открыть выбранный инцидент в ITSM'],
    ['G', 'показать / скрыть карту'],
    ['/', 'поиск'],
    ['M', 'звук вкл/выкл'],
    ['Esc', 'закрыть окно'],
  ];
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm" role="dialog" aria-label="Горячие клавиши">
        <header className="modal-head">
          <div>
            <h2>Горячие клавиши</h2>
            <p>Координатору не нужно тянуться к мыши, пока горит критический.</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <dl className="keys">
          {keys.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
