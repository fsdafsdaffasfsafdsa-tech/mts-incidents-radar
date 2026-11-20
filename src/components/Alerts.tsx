import { useEffect, useMemo } from 'react';
import { CheckCircle2, Flame, Info, TriangleAlert, Users, X } from 'lucide-react';
import { ack, dismissToast, select, useStore, type ToastKind } from '../store';
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
                      select(t.incidentId!);
                      dismissToast(t.id);
                    }}
                  >
                    Открыть
                  </button>
                  {t.kind === 'p1' && (
                    <button
                      onClick={() => {
                        void ack(t.incidentId!);
                        dismissToast(t.id);
                      }}
                    >
                      Взять на контроль
                    </button>
                  )}
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

/** Полоса под шапкой: непросмотренные критические инциденты. Не мигает, но не даёт забыть. */
export function CriticalBanner() {
  const incidents = useStore((s) => s.incidents);
  const systems = useStore((s) => s.systems);
  const now = useNow(5000);
  const unack = useMemo(
    () =>
      [...incidents.values()]
        .filter((i) => i.priority === 'P1' && i.status !== 'resolved' && !i.acknowledged)
        .sort((a, b) => b.createdAt - a.createdAt),
    [incidents],
  );

  useEffect(() => {
    const base = 'Радар инцидентов';
    document.title = unack.length ? `(${unack.length}) критический без внимания · ${base}` : base;
  }, [unack.length]);

  if (!unack.length) return null;
  const first = unack[0];
  const sys = systems.find((s) => s.id === first.systemId)?.short ?? first.product;
  return (
    <div className="crit-banner" role="alert">
      <span className="crit-pulse" aria-hidden />
      <b>Критический без внимания</b>
      <span className="crit-sys">{sys}</span>
      <button className="crit-title" onClick={() => select(first.id)}>
        {first.title}
      </button>
      <span className="crit-age">{fmtAgo(now - first.createdAt)}</span>
      {unack.length > 1 && <span className="crit-more">+{unack.length - 1} ещё</span>}
      <span className="grow" />
      <button className="crit-btn" onClick={() => select(first.id)}>
        Открыть
      </button>
      <button className="crit-btn solid" onClick={() => void ack(first.id)}>
        Взять на контроль
      </button>
    </div>
  );
}
