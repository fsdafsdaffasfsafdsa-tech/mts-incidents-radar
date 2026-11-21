// Вкладка «Разборы»: решённые за сутки и черновик разбора по каждому — ИИ пишет по истории инцидента
// (хронология, вероятная причина, что сделали, масштаб, что улучшить). Можно скопировать, написать заново, озвучить.
import { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCopy, FileSearch, Lightbulb, ListChecks, Megaphone, RefreshCw, Search, Users, Volume2 } from 'lucide-react';
import type { Priority, Review } from '../../shared/types';
import { select, useStore } from '../store';
import { fmtClock } from '../lib/format';
import { Empty, PrioDot } from './ui';
import { AiBadge } from './IncidentCard';
import { say, unlockJarvisAudio } from './Jarvis';

interface Item {
  id: string;
  title: string;
  priority: Priority;
  resolvedAt: number | null;
  durationMin: number;
  team: string;
  origin: string;
  ready: boolean;
  by: 'ai' | 'rules' | null;
}

const dur = (m: number) => (m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`);

function asText(r: Review) {
  const f = r.facts;
  return [
    `Разбор: ${r.title}`,
    `Уровень «${f.level}» · длительность ${dur(f.durationMin)}${f.toTeamMin !== null ? ` · до передачи команде ${f.toTeamMin} мин` : ''}${f.complaints !== null ? ` · жалоб ${f.complaints}` : ''} · команда «${f.team}»`,
    '',
    `Кратко: ${r.summary}`,
    '',
    'Хронология:',
    ...r.timeline.map((t) => `  ${fmtClock(t.at)} — ${t.text}`),
    '',
    `Вероятная причина: ${r.cause}`,
    `Что сделали: ${r.actions}`,
    `Масштаб: ${r.impact}`,
    '',
    'Что улучшить:',
    ...r.lessons.map((l) => `  • ${l}`),
    '',
    r.by === 'ai' ? 'Черновик подготовил ИИ — проверьте перед отправкой.' : 'Собрано по шаблону из истории инцидента.',
  ].join('\n');
}

export function ReviewsPage() {
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const [list, setList] = useState<Item[] | null>(null);
  const [rv, setRv] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const resolved = [...incidents.values()].filter((i) => i.status === 'resolved').length;

  useEffect(() => {
    void fetch('/api/reviews')
      .then((r) => r.json() as Promise<Item[]>)
      .then(setList)
      .catch(() => setList([]));
  }, [resolved, rv?.id]);

  const cur = list?.find((i) => i.id === selectedId) ?? list?.[0];
  async function load(id: string, fresh = false) {
    setBusy(true);
    setErr('');
    if (!fresh) setRv(null);
    try {
      const r = await fetch(`/api/reviews/${id}`, { method: fresh ? 'POST' : 'GET' });
      const data = (await r.json()) as Review & { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'не получилось');
      setRv(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (cur) void load(cur.id);
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page-split reviews">
      <section className="panel plist">
        <div className="rv-head">
          <FileSearch size={15} /> Решено за сутки <span className="num muted">{list?.length ?? '…'}</span>
        </div>
        <div className="pl-rows">
          {list && !list.length && <Empty icon={CheckCircle2} title="Пока нечего разбирать" hint="Как только команда решит инцидент, он появится здесь — ИИ напишет черновик разбора." />}
          {list?.map((i) => (
            <div key={i.id} className={`trow p-${i.priority} ${i.id === cur?.id ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => select(i.id)} onKeyDown={(e) => e.key === 'Enter' && select(i.id)}>
              <PrioDot p={i.priority} />
              <span className="tr-main">
                <span className="pr-title">{i.title}</span>
                <span className="pr-meta">
                  {i.team} · за {dur(i.durationMin)} · {i.resolvedAt ? fmtClock(i.resolvedAt) : ''}
                  {i.ready && <span className={`pr-tag ${i.by === 'ai' ? 'ai' : ''}`}>разбор ✓</span>}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel rv-doc">
        {!cur && <Empty icon={FileSearch} title="Здесь будет разбор" hint="Выберите решённый инцидент слева." />}
        {cur && busy && !rv && (
          <div className="rv-wait">
            <span className="boot-ring" /> ИИ пишет разбор по истории инцидента…
          </div>
        )}
        {err && <div className="jv-err">{err}</div>}
        {rv && (
          <>
            <header className="rv-top">
              <div className="rv-badges">
                {rv.by === 'ai' ? <AiBadge text="черновик ИИ — проверьте" /> : <span className="pr-tag">по шаблону</span>}
                <span className="muted">написан в {fmtClock(rv.at)}</span>
                <span className="pd-sp" />
                <button className="btn btn-sm btn-ghost" onClick={() => (unlockJarvisAudio(), void say(`${rv.summary} Вероятная причина: ${rv.cause}`))}>
                  <Volume2 size={14} /> Озвучить
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void navigator.clipboard?.writeText(asText(rv)).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                >
                  <ClipboardCopy size={14} /> {copied ? 'Скопировано' : 'Скопировать'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => void load(rv.id, true)} disabled={busy}>
                  <RefreshCw size={14} className={busy ? 'spin' : ''} /> Написать заново
                </button>
              </div>
              <h1 className="pd-title">{rv.title}</h1>
              <div className="rv-facts">
                <span>
                  уровень <b>{rv.facts.level}</b>
                </span>
                <span>
                  длительность <b>{dur(rv.facts.durationMin)}</b>
                </span>
                {rv.facts.toTeamMin !== null && (
                  <span>
                    до передачи команде <b>{rv.facts.toTeamMin} мин</b>
                  </span>
                )}
                {rv.facts.complaints !== null && (
                  <span>
                    жалоб <b>{rv.facts.complaints}</b>
                  </span>
                )}
                <span>
                  команда <b>{rv.facts.team}</b>
                </span>
              </div>
            </header>

            <p className="rv-summary">{rv.summary}</p>

            <div className="rv-grid">
              <div className="rv-sec">
                <h3>
                  <ListChecks size={15} /> Хронология
                </h3>
                <ol className="rv-time">
                  {rv.timeline.map((t, k) => (
                    <li key={k}>
                      <span className="num">{fmtClock(t.at)}</span>
                      <span>{t.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="rv-col">
                <div className="rv-sec">
                  <h3>
                    <Search size={15} /> Вероятная причина
                  </h3>
                  <p>{rv.cause}</p>
                </div>
                <div className="rv-sec">
                  <h3>
                    <Users size={15} /> Что сделали
                  </h3>
                  <p>{rv.actions}</p>
                </div>
                <div className="rv-sec">
                  <h3>
                    <Megaphone size={15} /> Масштаб
                  </h3>
                  <p>{rv.impact}</p>
                </div>
                <div className="rv-sec good">
                  <h3>
                    <Lightbulb size={15} /> Что улучшить
                  </h3>
                  <ul>
                    {rv.lessons.map((l, k) => (
                      <li key={k}>{l}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
