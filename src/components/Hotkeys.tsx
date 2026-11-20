// Обработчик горячих клавиш (назначаются в настройках). Не срабатывает, пока вы печатаете в поле ввода.
import { useEffect } from 'react';
import type { HotAction } from '../lib/hotkeys';
import { hotNav } from '../lib/hotkeys';
import { getState, notifyLead, routeTo, select, setPalette, setSettings, setTab, takeAtPoint, teamTake } from '../store';

function run(action: HotAction) {
  const s = getState();
  const id = s.selectedId;
  const inc = id ? s.incidents.get(id) : undefined;
  const point = s.me?.role === 'coordinator';
  switch (action) {
    case 'next':
    case 'prev': {
      const list = hotNav.list;
      if (!list.length) return;
      const k = id ? list.indexOf(id) : -1;
      const n = action === 'next' ? Math.min(list.length - 1, k + 1) : Math.max(0, k <= 0 ? 0 : k - 1);
      select(list[n]);
      document.querySelector('.prow.sel, .trow.sel')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    case 'take':
      if (!inc) return;
      if (point) takeAtPoint(inc.id);
      else teamTake(inc.id);
      return;
    case 'route': {
      const best = inc && s.routes.get(inc.id)?.picks[0];
      if (point && inc && best && inc.teamId !== best.teamId && inc.status !== 'resolved') void routeTo(inc.id, best.teamId);
      return;
    }
    case 'lead': {
      const sig = inc && [...s.signals.values()].find((x) => x.incidentId === inc.id && x.status === 'open');
      if (point && sig) notifyLead(sig.id);
      return;
    }
    case 'chat':
      (document.getElementById('chat-input') as HTMLInputElement | null)?.focus();
      return;
    case 'search':
      setPalette(true);
      return;
    case 'settings':
      setSettings(true);
      return;
    default: {
      const n = Number(action.slice(3)) - 1;
      const tab = hotNav.tabs[n];
      if (tab) setTab(tab);
    }
  }
}

export function Hotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      if (!s.hotkeysOn || !s.me || s.palette || s.settings) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      const action = (Object.keys(s.hotkeys) as HotAction[]).find((a) => s.hotkeys[a] === e.code);
      if (!action) return;
      e.preventDefault();
      run(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
