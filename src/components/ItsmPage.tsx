// ITSM-карточка инцидента (демо): так выглядит переход «по клику в ITSM». Исходная запись из файла выгрузки,
// подписи — из файла описания полей, отдельно — поля, которые добавил Радар (избранное, кто смотрел).
import { useEffect, useState } from 'react';
import { ExternalLink, Star } from 'lucide-react';
import './fav-itsm.css';
import { STATUS_TEXT } from './kit';
import { PRIORITY_TEXT, type Incident, type Priority } from '../../shared/types';

type Attr = { api_source: string; description: string; possible_values: string };
type Data = {
  record: Record<string, unknown> | null;
  attributes: Attr[];
  radar: { title: string; status: string; priority: string; team: string; assignee: string | null; slaDeadline: number; createdAt: number; origin: string; pin: { by: string; at: number; note: string; remindAt: number | null } | null; attentionAt: number | null; attentionBy: string | null; history: { at: number; text: string }[] } | null;
};
const SECTIONS: [string, string[]][] = [
  ['Основное', ['id', 'header', 'state', 'stateReason', 'priority', 'urgency', 'impact', 'incType', 'submitDate', 'deadline', 'completionDate']],
  ['Назначение', ['assignedGroupName', 'assignedEmployee', 'lastAssignmentToTeamDateTime', 'initiatorName']],
  ['Продукт и сервис', ['productName', 'productMasterId', 'service', 'serviceType', 'scenarioName', 'receivingChannel']],
  ['Описание', ['shortDescription', 'description', 'solution', 'eliminationType']],
  ['Связи', ['isMaster', 'isDouble', 'isEffect', 'isReason', 'isRootIncident', 'isNeedUp']],
];
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'да' : 'нет') : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toLocaleString('ru-RU') : String(v));
const dt = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—');

export function ItsmPage({ id }: { id: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    document.title = `ITSM · ${id}`;
    fetch(`/api/itsm/${encodeURIComponent(id)}`)
      .then(async (r) => (r.ok ? setD((await r.json()) as Data) : setErr(((await r.json()) as { error?: string }).error ?? 'не найдено')))
      .catch(() => setErr('нет связи'));
  }, [id]);
  const label = (k: string) => d?.attributes.find((a) => a.api_source === k)?.description ?? k;
  const rec = d?.record ?? {};
  const used = new Set(SECTIONS.flatMap(([, ks]) => ks));
  const rest = Object.keys(rec).filter((k) => !used.has(k));
  return (
    <div className="itsm">
      <header className="itsm-top">
        <b>ITSM</b>
        <span>Управление инцидентами · демо-карточка для перехода с дашборда</span>
      </header>
      {err && <div className="itsm-err">{err}</div>}
      {d && (
        <main>
          <div className="itsm-h">
            <span className="itsm-id">{id}</span>
            <h1>{String(rec.header ?? d.radar?.title ?? '')}</h1>
            <span className="itsm-badges">
              <em>{d.record ? fmt(rec.state) : STATUS_TEXT[d.radar?.status as Incident['status']] ?? '—'}</em>
              <em className={`pr-${d.record ? String(rec.priorityId ?? '') : ({ P1: '1', P2: '2', P3: '3', P4: '4' } as Record<string, string>)[d.radar?.priority ?? ''] ?? ''}`}>{d.record ? fmt(rec.priority) : PRIORITY_TEXT[d.radar?.priority as Priority] ?? '—'}</em>
            </span>
          </div>
          {!d.record && <p className="itsm-note">Инцидент создан Радаром из жалоб абонентов — в выгрузке ITSM его ещё нет.</p>}
          {d.record &&
            SECTIONS.map(([name, keys]) => (
              <section key={name}>
                <h2>{name}</h2>
                <dl>
                  {keys
                    .filter((k) => k in rec)
                    .map((k) => (
                      <div key={k} className={k === 'description' || k === 'solution' ? 'wide' : ''}>
                        <dt title={k}>{label(k)}</dt>
                        <dd>{fmt(rec[k])}</dd>
                      </div>
                    ))}
                </dl>
              </section>
            ))}
          {d.record && rest.length > 0 && (
            <details>
              <summary>Остальные поля выгрузки ({rest.length})</summary>
              <dl>
                {rest.map((k) => (
                  <div key={k}>
                    <dt title={k}>{label(k)}</dt>
                    <dd>{fmt(rec[k])}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {d.radar && (
            <section className="itsm-radar">
              <h2>Поля Радара (добавлены к формату выгрузки)</h2>
              <dl>
                <div>
                  <dt>pin — избранное смены</dt>
                  <dd>{d.radar.pin ? <><Star size={13} /> {d.radar.pin.by}: «{d.radar.pin.note || 'без заметки'}»{d.radar.pin.remindAt ? `, напомнить ${dt(d.radar.pin.remindAt)}` : ''}</> : '—'}</dd>
                </div>
                <div>
                  <dt>attentionAt — когда дежурный последний раз смотрел</dt>
                  <dd>{d.radar.attentionAt ? `${dt(d.radar.attentionAt)} · ${d.radar.attentionBy ?? ''}` : '—'}</dd>
                </div>
                <div>
                  <dt>Статус и команда в Радаре</dt>
                  <dd>
                    {STATUS_TEXT[d.radar.status as Incident['status']] ?? d.radar.status} · {d.radar.team}
                    {d.radar.assignee ? ` · ${d.radar.assignee}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Срок решения</dt>
                  <dd>{dt(d.radar.slaDeadline)}</dd>
                </div>
              </dl>
              <h3>История в Радаре</h3>
              <ul>
                {d.radar.history.map((h, k) => (
                  <li key={k}>
                    <b>{new Date(h.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</b> {h.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <a className="itsm-back" href="/">
            <ExternalLink size={14} /> Вернуться в Радар
          </a>
        </main>
      )}
    </div>
  );
}
