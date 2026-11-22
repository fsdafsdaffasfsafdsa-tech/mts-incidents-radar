// Блок «Вопросы»: вопросы команд пункту («не наше — передайте», «нужна помощь») и вопросы пункта командам и их
// руководителям («Джарвис, напиши руководителю…»). Ждём ответа — жёлтым, дольше 10 минут — красным, ответили —
// зелёным, с ответом. Кнопок нет: спросить или ответить — голосом Джарвису; щелчок по строке — инцидент.
import { useMemo, useRef } from 'react';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, MessagesSquare } from 'lucide-react';
import { questionsOf, type Question } from '../../../shared/attention';
import { useStore } from '../../store';
import { BlockHead, type BlockCtx } from './Dashboard';
import { useFlip } from './anim';
import { oneLine, serviceIcon } from './wall2';

const MIN = 60_000;
const LATE = 10 * MIN;
const waitText = (ms: number) => (ms < MIN ? 'только что' : ms < 60 * MIN ? `${Math.round(ms / MIN)} мин` : `${Math.round(ms / (60 * MIN))} ч`);

export function QuestionsBlock({ ctx }: { ctx: BlockCtx }) {
  const incidents = useStore((s) => s.incidents);
  const now = ctx.now;
  const list = useMemo(() => questionsOf(incidents.values(), now), [incidents, now]);
  const waiting = list.filter((q) => !q.answer).length;
  const shown = list.slice(0, 5);
  const rest = list.length - shown.length;
  const box = useRef<HTMLDivElement>(null);
  useFlip(box);
  return (
    <div className="db db-q">
      <BlockHead title="Вопросы" count={waiting || undefined} icon={<MessagesSquare size={18} />} />
      {shown.length ? (
        <div className="q-list" ref={box}>
          {shown.map((q) => (
            <Row key={q.id} q={q} now={now} onOpen={() => ctx.open(q.inc)} />
          ))}
          {rest > 0 && <div className="q-more">ещё {rest}</div>}
        </div>
      ) : (
        <div className="q-calm" title="Вопросов нет — спросить команду или руководителя: «Джарвис, напиши руководителю…»">
          <CheckCircle2 />
        </div>
      )}
    </div>
  );
}

function Row({ q, now, onOpen }: { q: Question; now: number; onOpen: () => void }) {
  const wait = now - q.at;
  const st = q.answer ? 'ok' : wait > LATE ? 'late' : 'wait';
  const Dir = q.dir === 'in' ? ArrowDownLeft : ArrowUpRight;
  const I = serviceIcon(q.inc);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`q-row q-${st} q-${q.dir} p-${q.inc.priority}`}
      data-flip={q.id}
      data-level={st === 'late' ? 2 : st === 'wait' ? 1 : 0}
      onClick={onOpen}
      title={`${q.dir === 'in' ? 'Команда спрашивает пункт' : 'Пункт спросил'} · ${q.inc.title}\n${q.who}: ${q.text}${q.answer ? `\nОтвет: ${q.answer}` : ''}`}
    >
      <span className="q-dir">
        <Dir />
      </span>
      <span className="q-main">
        <b>
          <I className="q-svc" /> {q.dir === 'in' ? q.who : `→ ${q.who}`} · {oneLine(q.inc)}
        </b>
        <small>{q.answer ? `✓ ${q.answer}` : q.text}</small>
      </span>
      <span className="q-st num">{q.answer ? <CheckCircle2 /> : waitText(wait)}</span>
    </div>
  );
}
