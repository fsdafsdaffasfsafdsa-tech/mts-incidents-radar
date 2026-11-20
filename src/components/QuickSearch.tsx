// Быстрый поиск (Ctrl+K или «/»): инцидент по номеру, тексту, сервису, региону или команде; команда — в справочнике.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookUser, Search } from 'lucide-react';
import { SCHEDULE_TEXT } from '../../shared/schedule';
import { openIncident, openTeamInDirectory, setPalette, teamName, useStore } from '../store';
import { PrioDot } from './ui';
import { STATUS_TEXT } from './kit';

export function QuickSearch() {
  const open = useStore((s) => s.palette);
  const incidents = useStore((s) => s.incidents);
  const teams = useStore((s) => s.teams);
  const [q, setQ] = useState('');
  const [k, setK] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
      void typing;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setK(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const incs = [...incidents.values()]
      .filter((i) => !s || `${i.id} ${i.title} ${i.service} ${i.regionName ?? ''} ${teamName(i.teamId)} ${i.coordinatorName ?? ''}`.toLowerCase().includes(s))
      .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || a.priority.localeCompare(b.priority) || b.createdAt - a.createdAt)
      .slice(0, 8)
      .map((i) => ({ kind: 'inc' as const, id: i.id, inc: i }));
    const ts =
      s.length >= 2
        ? teams
            .filter((t) => t.id !== 'kp' && t.name.toLowerCase().includes(s))
            .slice(0, 5)
            .map((t) => ({ kind: 'team' as const, id: t.id, team: t }))
        : [];
    return [...incs, ...ts];
  }, [q, incidents, teams]);

  if (!open) return null;
  const go = (n: number) => {
    const r = results[n];
    if (!r) return;
    setPalette(false);
    if (r.kind === 'inc') openIncident(r.id);
    else openTeamInDirectory(r.team.name);
  };
  return (
    <div className="modal-back" onClick={() => setPalette(false)}>
      <div className="palette" role="dialog" aria-label="Быстрый поиск" onClick={(e) => e.stopPropagation()}>
        <label className="pal-q">
          <Search size={17} />
          <input
            ref={input}
            value={q}
            placeholder="Номер инцидента, сервис, регион, команда, дежурный…"
            onChange={(e) => {
              setQ(e.target.value);
              setK(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setK((x) => Math.min(results.length - 1, x + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setK((x) => Math.max(0, x - 1)));
              else if (e.key === 'Enter') go(k);
              else if (e.key === 'Escape') setPalette(false);
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="pal-list">
          {!results.length && <div className="empty sm">Ничего не нашлось</div>}
          {results.map((r, n) =>
            r.kind === 'inc' ? (
              <button key={r.id} className={`pal-item ${n === k ? 'on' : ''}`} onMouseEnter={() => setK(n)} onClick={() => go(n)}>
                <PrioDot p={r.inc.priority} />
                <span className="pal-main">
                  <b>{r.inc.title}</b>
                  <span className="muted">
                    {r.inc.id} · {STATUS_TEXT[r.inc.status]}
                    {r.inc.teamId && r.inc.teamId !== 'kp' ? ` · ${teamName(r.inc.teamId)}` : ''}
                  </span>
                </span>
              </button>
            ) : (
              <button key={r.id} className={`pal-item ${n === k ? 'on' : ''}`} onMouseEnter={() => setK(n)} onClick={() => go(n)}>
                <BookUser size={15} />
                <span className="pal-main">
                  <b>{r.team.name}</b>
                  <span className="muted">команда · {SCHEDULE_TEXT[r.team.schedule]}</span>
                </span>
              </button>
            ),
          )}
        </div>
        <div className="pal-foot muted">
          <kbd>↑</kbd> <kbd>↓</kbd> выбрать · <kbd>Enter</kbd> открыть · <kbd>Ctrl</kbd>+<kbd>K</kbd> — открыть поиск (клавиши меняются в настройках)
        </div>
      </div>
    </div>
  );
}
