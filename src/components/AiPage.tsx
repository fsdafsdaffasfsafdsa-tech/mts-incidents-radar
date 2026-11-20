// «ИИ-помощник»: что ИИ делает для пункта, сколько раз сделал за последний час и журнал — каждое действие с причиной.
import { useMemo, useState } from 'react';
import { Activity, Bell, Check, GitMerge, ListChecks, Route, Sparkles, TrendingUp, Users } from 'lucide-react';
import { PRIORITY_TEXT } from '../../shared/types';
import { openIncident, useStore } from '../store';
import { fmtClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { AiBadge } from './IncidentCard';

type Kind = 'detect' | 'merge' | 'level' | 'p1' | 'route' | 'stuck' | 'check' | 'plan';

const KINDS: { id: Kind; title: string; what: string; icon: typeof Sparkles; test: RegExp }[] = [
  { id: 'detect', title: 'Находит всплески жалоб', what: 'Сравнивает жалобы за 10 минут с нормой для сервиса в регионе и сам создаёт инцидент', icon: Activity, test: /всплеск/i },
  { id: 'merge', title: 'Объединяет регионы', what: 'Если тот же сбой пошёл из другого региона — добавляет его в открытый инцидент, без дублей', icon: GitMerge, test: /объединено/i },
  { id: 'level', title: 'Поднимает уровень', what: 'По числу жалоб: по одной ступени, не чаще раза в 3 минуты, сам — не выше «Высокого»', icon: TrendingUp, test: /уровень/i },
  { id: 'p1', title: 'Предлагает «Наивысший»', what: 'Только предлагает. Поднимает дежурный, если согласен', icon: Sparkles, test: /предложил «Наивысший»/i },
  { id: 'route', title: 'Подсказывает команду', what: 'По справочнику ~900 команд, региону, графику смены и загрузке. Видно, совпало ли с решением дежурного', icon: Route, test: /советом ИИ|ИИ советовал/i },
  { id: 'plan', title: 'Подсказывает дежурного', what: 'В карточке нового инцидента: кому из дежурных на смене он подходит по специализации и загрузке. Распределяет человек', icon: Users, test: /распределил/i },
  { id: 'stuck', title: 'Замечает застрявшие', what: 'Нет движения 8 минут или прошло больше 60 % срока — сигнал пункту', icon: Bell, test: /застрял/i },
  { id: 'check', title: 'Проверяет запросы команд', what: 'Сверяет «это не наше — передайте» со справочником и подсказывает лучшую команду', icon: ListChecks, test: /проверил запрос/i },
];

interface Entry {
  at: number;
  text: string;
  kind: Kind | null;
  incidentId: string;
  title: string;
}

export function AiPage() {
  const incidents = useStore((s) => s.incidents);
  const stats = useStore((s) => s.stats);
  const rules = useStore((s) => s.config?.rules);
  const now = useNow(10_000);
  const [filter, setFilter] = useState<Kind | null>(null);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const i of incidents.values())
      for (const h of i.history)
        if (h.kind === 'ai') out.push({ at: h.at, text: h.text.replace(/^ИИ:\s*/, ''), kind: KINDS.find((k) => k.test.test(h.text))?.id ?? null, incidentId: i.id, title: i.title });
    return out.sort((a, b) => b.at - a.at);
  }, [incidents]);
  const hour = entries.filter((e) => now - e.at < 3_600_000);
  const count = (k: Kind) => hour.filter((e) => e.kind === k).length;
  const routed = hour.filter((e) => e.kind === 'route');
  const agreed = routed.filter((e) => /Совпало/.test(e.text)).length;
  const list = (filter ? entries.filter((e) => e.kind === filter) : entries).slice(0, 150);

  return (
    <div className="aipage">
      <section className="panel ai-what">
        <header className="ai-head">
          <Sparkles size={18} />
          <div>
            <h2>ИИ-помощник пункта</h2>
            <p className="muted">Подсказывает и берёт на себя рутину. Решения, которые влияют на людей и сроки, принимает дежурный. Всё работает внутри системы, без внешних сервисов.</p>
          </div>
        </header>
        <div className="ai-kpi">
          <div>
            <span className="num">{hour.length}</span>действий ИИ за час
          </div>
          <div>
            <span className="num">{routed.length ? `${Math.round((agreed / routed.length) * 100)}%` : stats?.aiAccuracy != null ? `${Math.round(stats.aiAccuracy * 100)}%` : '—'}</span>
            дежурные согласились с командой, которую советовал ИИ
          </div>
        </div>
        <div className="ai-grid">
          {KINDS.map((k) => (
            <button key={k.id} className={`ai-tile ${filter === k.id ? 'on' : ''}`} onClick={() => setFilter(filter === k.id ? null : k.id)}>
              <span className="ai-ico">
                <k.icon size={16} />
              </span>
              <span className="ai-t">
                <b>{k.title}</b>
                <span className="muted">{k.what}</span>
              </span>
              <span className="ai-n num" title="за последний час">
                {count(k.id)}
              </span>
            </button>
          ))}
        </div>
        {rules && (
          <details className="ai-rules">
            <summary>Правила уровня по жалобам</summary>
            <ul className="rules">
              <li>Инцидент создаётся сам при 6+ жалобах за 10 минут, если это почти невозможно случайно (p &lt; 0,001).</li>
              <li>
                «{PRIORITY_TEXT.P3}»: {rules.p3}+ жалоб за {rules.windowMin} мин. «{PRIORITY_TEXT.P2}»: {rules.p2}+ или {rules.p2multi}+ в двух регионах.
              </li>
              <li>Только вверх, не чаще раза в {rules.gapMin} мин, сам — не выше «{PRIORITY_TEXT[rules.ceiling]}».</li>
              <li>«{PRIORITY_TEXT.P1}» — только предложение при {rules.p1}+ жалобах или {rules.p1regions}+ регионах, решает дежурный.</li>
            </ul>
          </details>
        )}
      </section>

      <section className="panel ai-log">
        <header className="pl-head">
          <h2>Журнал ИИ</h2>
          {filter && (
            <button className="btn btn-sm btn-ghost" onClick={() => setFilter(null)}>
              Показать всё
            </button>
          )}
        </header>
        <div className="pl-rows">
          {!list.length && <div className="empty">ИИ пока ничего не делал</div>}
          {list.map((e, i) => (
            <button key={`${e.incidentId}${e.at}${i}`} className={`ai-entry ${now - e.at < 10_000 ? 'is-new' : ''}`} onClick={() => openIncident(e.incidentId)}>
              <span className="num">{fmtClock(e.at)}</span>
              <span className="ae-main">
                <span className="ae-text">
                  <AiBadge text={KINDS.find((k) => k.id === e.kind)?.title ?? 'ИИ'} /> {e.text}
                </span>
                <span className="muted">{e.title}</span>
              </span>
              {/Совпало/.test(e.text) && <Check size={15} className="ok-ico" />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
