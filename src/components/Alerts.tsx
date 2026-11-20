import { useEffect, useMemo } from 'react';
import { CheckCircle2, Flame, Info, TriangleAlert, Users, X } from 'lucide-react';
import { dismissToast, openIncident, useStore, type ToastKind } from '../store';
import { fmtAgo } from '../lib/format';
import { useNow } from '../lib/hooks';

const ICON: Record<ToastKind, typeof Flame> = { p1: Flame, coord: Users, warn: TriangleAlert, resolved: CheckCircle2, info: Info };

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div key={t.id} className={`toast t-${t.kind}`} style={{ ['--ttl' as string]: `${t.ttl}ms` }}>
            <span className="toast-icon">
              <Icon size={17} />
            </span>
            <div className="toast-body">
              <b>{t.title}</b>
              <span>{t.body}</span>
              {t.incidentId && (
                <div className="toast-actions">
                  <button
                    onClick={() => {
                      openIncident(t.incidentId!);
                      dismissToast(t.id);
                    }}
                  >
                    Открыть
                  </button>
                </div>
              )}
            </div>
            <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Закрыть">
              <X size={14} />
            </button>
            <span className="toast-ttl" aria-hidden />
          </div>
        );
      })}
    </div>
  );
}

/** Полоса под шапкой: критические без дежурного и предложения ИИ поднять до «Наивысшего». */
export function CriticalBanner() {
  const incidents = useStore((s) => s.incidents);
  const now = useNow(5000);
  const urgent = useMemo(
    () =>
      [...incidents.values()]
        .filter((i) => i.status !== 'resolved' && ((i.priority === 'P1' && !i.coordinatorId && i.status === 'coordinators') || i.p1Proposal))
        .sort((a, b) => b.createdAt - a.createdAt),
    [incidents],
  );

  useEffect(() => {
    const base = 'Координирующий пункт';
    document.title = urgent.length ? `(${urgent.length}) требует решения · ${base}` : base;
  }, [urgent.length]);

  if (!urgent.length) return null;
  const first = urgent[0];
  return (
    <div className="crit-banner" role="alert">
      <span className="crit-pulse" aria-hidden />
      <b>{first.p1Proposal ? 'ИИ предлагает «Наивысший»' : 'Критический без дежурного'}</b>
      <button className="crit-title" onClick={() => openIncident(first.id)}>
        {first.title}
      </button>
      <span className="crit-age">{fmtAgo(now - first.createdAt)}</span>
      {urgent.length > 1 && <span className="crit-more">+{urgent.length - 1} ещё</span>}
      <span className="grow" />
      <button className="crit-btn solid" onClick={() => openIncident(first.id)}>
        Открыть
      </button>
    </div>
  );
}
