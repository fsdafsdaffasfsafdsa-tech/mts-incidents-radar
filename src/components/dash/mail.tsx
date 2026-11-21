// Блок «Почта» на стене (вариант «полосы»): ИИ разбирает письма и привязывает к инцидентам.
// Строка — инцидент, о котором пишут; заливка — сколько писем, цвет — приоритет инцидента. Внизу — письма без инцидента.
// Кнопок нет: вопрос задаёт Джарвис, отвечают голосом. Срочное письмо Джарвис объявляет сам.
// Письмо целиком — по щелчку (для работы с мышью).
import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Inbox, Link2, Mail, Mic, Sparkles, Upload, X } from 'lucide-react';
import type { Incident, MailItem } from '../../../shared/types';
import { mailRead, mailToIncident, mailUpload, openIncident, setTab, useStore } from '../../store';
import { openWork } from '../../lib/dashLayout';
import { fmtClock } from '../../lib/format';
import { announceText } from '../Jarvis';
import { BlockHead, type BlockCtx } from './Dashboard';
import { oneLine, serviceIcon } from './wall2';
import { useFlip } from './anim';

const URG = { high: 0, normal: 1, low: 2 } as const;
const HOUR = 3_600_000;

/** Что спросит Джарвис про самое важное письмо. */
function mailAsk(top: MailItem | undefined): string | null {
  if (!top?.analysis) return null;
  const a = top.analysis;
  if (a.kind === 'incident' && !a.incidentId && !top.incidentCreated) return '«Завести инцидент по письму?»';
  if (a.kind === 'request' && a.incidentId) return '«Передать в другую команду?»';
  return '«Прочитать письмо?»';
}

/** Срочное письмо (не рассылка) — Джарвис объявляет голосом, один раз на письмо. */
function useMailAnnounce(mail: MailItem[]) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const done = mail.filter((m) => m.analysis);
    if (seen.current === null) {
      seen.current = new Set(done.map((m) => m.id)); // то, что было до открытия стены, не объявляем
      return;
    }
    for (const m of done) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      const a = m.analysis!;
      if (a.urgency !== 'high' || a.kind === 'noise' || m.read) continue;
      const ask = a.kind === 'incident' && !a.incidentId ? 'Завести инцидент?' : 'Прочитать?';
      announceText(`срочное письмо: ${a.summary.replace(/[.!]+$/, '')}. ${ask}`, a.incidentId ?? '', `mail:${m.id}`);
    }
  }, [mail]);
}

export function MailBlock({ ctx }: { ctx: BlockCtx }) {
  const mail = useStore((s) => s.mail);
  const incidents = useStore((s) => s.incidents);
  const now = ctx.now;
  const [openId, setOpenId] = useState<string | null>(null);
  useMailAnnounce(mail);
  // Джарвис читает письмо голосом — на стене оно раскрывается и само закрывается, когда он дочитал
  useEffect(() => {
    let t = 0;
    const f = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      setOpenId(id);
      clearTimeout(t);
      t = window.setTimeout(() => setOpenId((cur) => (cur === id ? null : cur)), 20_000);
    };
    window.addEventListener('radar:mail-open', f);
    return () => {
      clearTimeout(t);
      window.removeEventListener('radar:mail-open', f);
    };
  }, []);
  const recent = mail.filter((m) => now - m.at < 12 * HOUR);
  const unread = recent.filter((m) => !m.read && m.analysis);
  const analyzing = recent.filter((m) => !m.analysis).length;
  const top = unread.filter((m) => m.analysis!.kind !== 'noise').sort((a, b) => URG[a.analysis!.urgency] - URG[b.analysis!.urgency] || b.at - a.at)[0];
  // письма — вокруг своих инцидентов; без инцидента — отдельно
  const by = new Map<string, MailItem[]>();
  const loose: MailItem[] = [];
  for (const m of unread) {
    const id = m.analysis!.incidentId;
    if (id && incidents.get(id)) by.set(id, [...(by.get(id) ?? []), m]);
    else loose.push(m);
  }
  const groups = [...by.entries()]
    .map(([id, list]) => ({ inc: incidents.get(id)!, list: [...list].sort((a, b) => b.at - a.at) }))
    .sort((a, b) => b.list.length - a.list.length || b.list[0].at - a.list[0].at)
    .slice(0, 4);
  const max = Math.max(1, ...groups.map((g) => g.list.length));
  const open = openId ? mail.find((m) => m.id === openId) : undefined;
  const feed = useRef<HTMLDivElement>(null);
  useFlip(feed); // строки переезжают, новая въезжает, писем стало больше — вспышка
  return (
    <div className="db db-mail">
      <BlockHead
        title="Почта"
        count={unread.length || undefined}
        icon={<Mail size={18} />}
        right={
          <span className="ml-head">
            {analyzing > 0 && (
              <span className="ml-ai" title="ИИ разбирает новые письма">
                <Sparkles size={14} />
              </span>
            )}
            {/* загрузка письма файлом — только для работы с мышью, на стене не видна */}
            <label className="ml-up" title="Загрузить письмо файлом .eml">
              <Upload size={15} />
              <input
                type="file"
                accept=".eml,.txt,message/rfc822"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) await mailUpload(await f.text()).catch(() => undefined);
                }}
              />
            </label>
          </span>
        }
      />
      {groups.length || loose.length ? (
        <div className="ml-feed" ref={feed}>
          {groups.map((g, k) => (
            <BarRow key={g.inc.id} inc={g.inc} n={g.list.length} frac={g.list.length / max} delay={k * 0.08} onClick={() => setOpenId(g.list[0].id)} />
          ))}
          {loose.length > 0 && (
            <div className="ml-row ml-bar loose" data-flip="loose" data-level={loose.length} title="Письма без инцидента">
              <span className="ml-bar-fill" style={{ width: `${Math.min(1, loose.length / max) * 100}%` }} />
              <Inbox className="ml-row-ic" />
              <b className="muted">без инцидента</b>
              <span className="ml-env num">
                <Mail /> {loose.length}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="ml-calm" title="Непрочитанных писем нет">
          <CheckCircle2 />
        </div>
      )}
      {(() => {
        const ask = mailAsk(top);
        return ask ? (
          <div className="dn4-jv ml-jv" title="Ответьте голосом — Джарвис сделает">
            <span className="dn4-mic">
              <Mic />
            </span>
            <b>{ask}</b>
          </div>
        ) : null;
      })()}
      {open && <MailDetail key={open.id} m={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Строка-полоса: инцидент, о котором пишут; заливка — сколько писем, цвет — приоритет. */
function BarRow({ inc, n, frac, delay, onClick }: { inc: Incident; n: number; frac: number; delay: number; onClick: () => void }) {
  const I = serviceIcon(inc);
  return (
    <div role="button" tabIndex={0} data-flip={inc.id} data-level={n} className={`ml-row ml-bar p-${inc.priority}`} style={{ animationDelay: `${delay}s` }} onClick={onClick} title={`${inc.title} · писем: ${n}`}>
      <span className="ml-bar-fill" style={{ width: `${frac * 100}%` }} />
      <I className="ml-row-ic" />
      <b>{oneLine(inc)}</b>
      <span className="ml-env num">
        <Mail /> {n}
      </span>
    </div>
  );
}

/** Письмо по щелчку: суть от ИИ, что сделать, действия. Подробности — только здесь, не на стене. */
function MailDetail({ m, onClose }: { m: MailItem; onClose: () => void }) {
  const incidents = useStore((s) => s.incidents);
  const a = m.analysis;
  const inc = a?.incidentId ? incidents.get(a.incidentId) : undefined;
  const [busy, setBusy] = useState(false);
  return (
    <div className="ml-detail" role="dialog" aria-label={m.subject}>
      {/* письмо открывается: клапан конверта откидывается, лист выезжает, конверт уходит — и проявляется текст */}
      <span className="ml-envelope" aria-hidden>
        <i className="ml-env-back" />
        <i className="ml-env-paper" />
        <i className="ml-env-front" />
        <i className="ml-env-flap" />
      </span>
      <header>
        <b>{a?.summary ?? m.subject}</b>
        <button onClick={onClose} aria-label="Закрыть">
          <X size={16} />
        </button>
      </header>
      <small>
        {m.fromName} · {fmtClock(m.at)}
        {a?.llm ? ' · разобрал ИИ' : ''}
      </small>
      <p className="ml-body">{m.body}</p>
      {a?.action && (
        <p className="ml-action">
          <Sparkles size={14} /> {a.action}
        </p>
      )}
      <footer>
        {inc ? (
          <button
            onClick={() => {
              openWork();
              setTab('inbox');
              openIncident(inc.id);
            }}
          >
            <Link2 size={14} /> {oneLine(inc)}
          </button>
        ) : (
          <button
            className="on"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await mailToIncident(m.id).catch(() => undefined);
              setBusy(false);
            }}
          >
            <Inbox size={14} /> Создать инцидент
          </button>
        )}
        <button
          onClick={() => {
            mailRead(m.id);
            onClose();
          }}
        >
          <Check size={14} /> Прочитано
        </button>
      </footer>
    </div>
  );
}
