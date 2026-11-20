import { useEffect, useState } from 'react';
import { AlertTriangle, CircleCheck, GitMerge, Lightbulb, Sparkles } from 'lucide-react';
import type { Incident, Insight } from '../../shared/types';
import { loadInsight, select, teamName, useStore } from '../store';
import { RISK_LABEL } from '../lib/format';

type Tab = 'summary' | 'team' | 'risk';

export function AiPanel({ inc }: { inc: Incident }) {
  const insight = useStore((s) => s.insights.get(inc.id));
  const ai = useStore((s) => s.ai);
  const [tab, setTab] = useState<Tab>('summary');

  // Перезапрашиваем разбор, когда инцидент заметно меняется.
  const key = `${inc.priority}|${inc.status}|${inc.teamId}|${inc.assignee}|${inc.slaDeadline}`;
  useEffect(() => {
    void loadInsight(inc.id);
  }, [inc.id, key]);

  return (
    <div className={`ai-panel ${insight?.pendingLlm ? 'pending' : ''}`}>
      <div className="ai-head">
        <Sparkles size={15} />
        <span>ИИ-разбор</span>
        {insight && (
          <span className={`ai-src ${insight.source}`}>{insight.source === 'claude' ? `Claude` : ai?.mode === 'claude' ? 'эвристика' : 'эвристика, без ключа'}</span>
        )}
        {insight?.pendingLlm && <span className="ai-refining">уточняется…</span>}
      </div>

      {insight && <AiVerdict inc={inc} insight={insight} onTab={setTab} />}

      <div className="ai-tabs" role="tablist">
        {(
          [
            ['summary', 'Что случилось'],
            ['team', 'Какой группе'],
            ['risk', 'Риск'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {!insight ? (
        <>
          <div className="skeleton" />
          <div className="skeleton short" />
        </>
      ) : tab === 'summary' ? (
        <SummaryTab inc={inc} insight={insight} />
      ) : tab === 'team' ? (
        <TeamTab insight={insight} />
      ) : (
        <RiskTab insight={insight} />
      )}
    </div>
  );
}

/** Две строки вывода, которые читаются без кликов: кому отдать и насколько опасно. */
function AiVerdict({ inc, insight, onTab }: { inc: Incident; insight: Insight; onTab: (t: Tab) => void }) {
  const top = insight.teams[0];
  const r = insight.risk;
  const already = top && inc.teamId === top.teamId;
  return (
    <div className="ai-verdict">
      <button className="v-row" onClick={() => onTab('team')}>
        <span className="v-label">{inc.onCoordinators && (inc.status === 'assigned' || inc.status === 'in_progress') ? 'Передать' : 'Группа'}</span>
        <span className="v-value">
          {teamName(top?.teamId, false)} <span className="num v-conf">{top ? Math.round(top.confidence * 100) : 0}%</span>
        </span>
        {already && <CircleCheck size={15} className="ok" />}
      </button>
      <button className={`v-row lvl-${r.level}`} onClick={() => onTab('risk')}>
        <span className="v-label">Риск</span>
        <span className="v-value">
          <span className="v-risk num">{r.score}</span> {RISK_LABEL[r.level]}
        </span>
        <span className="v-bar">
          <span style={{ width: `${r.score}%` }} />
        </span>
      </button>
    </div>
  );
}

function SummaryTab({ inc, insight }: { inc: Incident; insight: Insight }) {
  const corr = insight.correlation;
  return (
    <div className="ai-tab-body">
      <p className="ai-summary">{insight.summary}</p>
      {insight.cause && (
        <p className="ai-cause">
          <Lightbulb size={14} /> {insight.cause}
        </p>
      )}
      {corr && (
        <div className="ai-corr">
          <GitMerge size={16} />
          <div>
            <p>{corr.text}</p>
            <div className="corr-ids">
              {corr.rootId && corr.rootId !== inc.id && (
                <button className="corr-chip root num" onClick={() => select(corr.rootId!)}>
                  {corr.rootId} · {inc.isDouble ? 'мастер' : 'первопричина'}
                </button>
              )}
              {corr.ids
                .filter((x) => x !== corr.rootId)
                .slice(0, 5)
                .map((x) => (
                  <button key={x} className="corr-chip num" onClick={() => select(x)}>
                    {x}
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
      {insight.nextSteps.length > 0 && (
        <ol className="ai-steps">
          {insight.nextSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TeamTab({ insight }: { insight: Insight }) {
  return (
    <div className="ai-tab-body">
      {insight.teams.length === 0 && <p className="muted">В выгрузке нет истории, по которой можно подсказать группу.</p>}
      {insight.teams.map((t, i) => (
        <div key={t.teamId} className={`team-opt ${i === 0 ? 'top' : ''}`}>
          <div className="team-line">
            <span className="team-name">{teamName(t.teamId, false)}</span>
            <span className="team-conf num">{Math.round(t.confidence * 100)}%</span>
          </div>
          <span className="conf-bar">
            <span style={{ width: `${Math.round(t.confidence * 100)}%` }} />
          </span>
          <ul className="reasons">
            {t.reasons.slice(0, 3).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RiskTab({ insight }: { insight: Insight }) {
  const r = insight.risk;
  const arc = Math.PI * 52;
  return (
    <div className={`ai-tab-body ai-risk lvl-${r.level}`}>
      <div className="risk-top">
        <div className="gauge">
          <svg viewBox="0 0 120 70" aria-hidden>
            <path d="M8 62 A52 52 0 0 1 112 62" className="g-track" />
            <path d="M8 62 A52 52 0 0 1 112 62" className="g-arc" strokeDasharray={`${(r.score / 100) * arc} ${arc}`} />
          </svg>
          <div className="gauge-val">
            <span className="num">{r.score}</span>
            <small>{RISK_LABEL[r.level]}</small>
          </div>
        </div>
        <p className="risk-note">
          {(r.level === 'high' || r.level === 'critical') && <AlertTriangle size={13} />} {r.note}
        </p>
      </div>
      <ul className="factors">
        {r.factors.map((f) => (
          <li key={f.label} className={f.weight > 0 ? 'up' : 'down'}>
            <span className="f-label">{f.label}</span>
            <span className="f-bar">
              <span style={{ width: `${Math.min(100, Math.abs(f.weight) * 38)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
