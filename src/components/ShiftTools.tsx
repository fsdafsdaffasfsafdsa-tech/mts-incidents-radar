// «Моя смена» (сколько взял, передал, решено) и сводка для пересменки — текст, который можно скопировать следующей смене.
import { useMemo, useState } from 'react';
import { ClipboardCopy, FileText, Mic, X } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { teamName, useStore } from '../store';
import { fmtClock, fmtDur } from '../lib/format';
import { useNow } from '../lib/hooks';
import { STATUS_TEXT } from './kit';
import { jarvisAsk } from './Jarvis';

const SHIFT_MS = 12 * 3_600_000;

function useMyShift() {
  const me = useStore((s) => s.me)!;
  const incidents = useStore((s) => s.incidents);
  const now = useNow(30_000);
  return useMemo(() => {
    const from = now - SHIFT_MS;
    let taken = 0;
    let routed = 0;
    const routeTimes: number[] = [];
    for (const i of incidents.values()) {
      const takeAt = i.history.find((h) => h.at > from && h.actor === me.name && /ведёт/.test(h.text))?.at;
      const routeAt = i.history.find((h) => h.at > from && h.actor === me.name && /передано команде/.test(h.text))?.at;
      if (takeAt) taken++;
      if (routeAt) {
        routed++;
        routeTimes.push(routeAt - i.createdAt);
      }
    }
    const mine = [...incidents.values()].filter((i) => i.coordinatorId === me.personId);
    const solved = mine.filter((i) => i.status === 'resolved' && (i.resolvedAt ?? 0) > from).length;
    const avg = routeTimes.length ? routeTimes.reduce((a, b) => a + b, 0) / routeTimes.length : null;
    return { taken, routed, solved, avg, mine, now };
  }, [incidents, me, now]);
}

export function MyShift() {
  const s = useMyShift();
  return (
    <section className="panel myshift" aria-label="Моя смена">
      <h3 className="cm-h">Моя смена</h3>
      <div className="ms-grid">
        <div>
          <span className="num">{s.taken}</span>взял
        </div>
        <div>
          <span className="num">{s.routed}</span>передал командам
        </div>
        <div>
          <span className="num">{s.solved}</span>решено
        </div>
        <div>
          <span className="num">{s.avg === null ? '—' : fmtDur(s.avg)}</span>в среднем до передачи
        </div>
      </div>
      <div className="ms-actions">
        <Handover />
        <button className="btn btn-sm btn-ai" onClick={() => void jarvisAsk('Сводка смены')} title="Джарвис расскажет итоги смены голосом">
          <Mic size={14} /> Сводка голосом
        </button>
      </div>
    </section>
  );
}

function line(i: Incident, now: number) {
  const left = i.slaDeadline - now;
  const where = i.status === 'coordinators' ? 'на пункте, команде не передан' : `${teamName(i.teamId)}${i.assigneeName ? `, у ${i.assigneeName}` : ''} — ${STATUS_TEXT[i.status]}`;
  return `• [${i.priorityText}] ${i.title} — ${where}; ${left > 0 ? `до дедлайна ${fmtDur(left)}` : 'дедлайн прошёл'}`;
}

/** Сводка для следующей смены: что открыто, что горит, что ждёт решения пункта. */
function Handover() {
  const me = useStore((s) => s.me)!;
  const incidents = useStore((s) => s.incidents);
  const requests = useStore((s) => s.requests);
  const signals = useStore((s) => s.signals);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => {
    const mine = [...incidents.values()].filter((i) => i.coordinatorId === me.personId && i.status !== 'resolved').sort((a, b) => a.priority.localeCompare(b.priority));
    const hot = mine.filter((i) => i.slaDeadline - now < 3_600_000 || i.priority <= 'P2');
    const p1 = mine.filter((i) => i.p1Proposal);
    const req = [...requests.values()].filter((r) => r.status === 'pending').length;
    const sig = [...signals.values()].filter((s) => s.status === 'open' && mine.some((i) => i.id === s.incidentId)).length;
    const out = [`Сводка смены · ${me.name} · ${new Date(now).toLocaleDateString('ru-RU')} ${fmtClock(now)} МСК`, ''];
    out.push(`Открыто у меня: ${mine.length}`);
    out.push(...mine.slice(0, 12).map((i) => line(i, now)));
    if (hot.length) out.push('', `Горит (высокий уровень или до дедлайна меньше часа): ${hot.length}`, ...hot.slice(0, 6).map((i) => line(i, now)));
    if (p1.length) out.push('', `ИИ предлагает «Наивысший» — решить: ${p1.map((i) => i.title).join('; ')}`);
    out.push('', `Ждут пункт: запросов команд ${req}, сигналов по моим инцидентам ${sig}.`);
    return out.join('\n');
  }, [incidents, requests, signals, me, now]);
  if (!open)
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        <FileText size={14} /> Сводка для пересменки
      </button>
    );
  return (
    <div className="form-box">
      <h3>
        Сводка для пересменки
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть">
          <X size={14} />
        </button>
      </h3>
      <textarea className="handover" readOnly value={text} rows={Math.min(16, text.split('\n').length + 1)} />
      <button
        className="btn btn-sm btn-primary"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <ClipboardCopy size={14} /> {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}

/** Текст для абонентов по массовому инциденту: контакт-центр, соцсети, автоответ в чате. */
export function CustomerText({ inc }: { inc: Incident }) {
  const [copied, setCopied] = useState(false);
  const regions = inc.regionName ?? '';
  const eta = new Date(Math.min(inc.slaDeadline, Date.now() + 3 * 3_600_000));
  const text = `Мы знаем о проблеме: «${inc.service}»${regions ? ` — ${regions}` : ''}. Специалисты уже восстанавливают работу, ориентировочно до ${fmtClock(eta.getTime())} МСК. Приносим извинения за неудобства — новые обращения не нужны, мы сообщим, когда всё заработает.`;
  return (
    <div className="form-box">
      <h3>Текст для абонентов</h3>
      <p className="cust-text">{text}</p>
      <button
        className="btn btn-sm"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <ClipboardCopy size={14} /> {copied ? 'Скопировано' : 'Скопировать для КЦ и соцсетей'}
      </button>
    </div>
  );
}
