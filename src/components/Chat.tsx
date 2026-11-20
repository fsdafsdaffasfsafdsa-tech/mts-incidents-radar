// Переписка в карточке инцидента: пункт ↔ команда. @Фамилия подсвечивается, Enter — отправить.
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { sendComment, teamName, useStore } from '../store';
import { fmtClock } from '../lib/format';

function withMentions(text: string, me: string) {
  const surname = me.split(' ')[0];
  return text.split(/(@[А-ЯЁA-Z][\p{L}-]+)/u).map((part, i) =>
    part.startsWith('@') ? (
      <b key={i} className={`mention ${part.slice(1) === surname ? 'me' : ''}`}>
        {part}
      </b>
    ) : (
      part
    ),
  );
}

export function Chat({ inc }: { inc: Incident }) {
  const me = useStore((s) => s.me)!;
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = inc.comments ?? [];
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [list.length, inc.id]);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void sendComment(inc.id, t);
  };
  return (
    <div className="chat" data-jv="chat">
      <h3 className="step-h small">
        <MessageSquare size={14} /> Переписка {inc.teamId && inc.teamId !== 'kp' ? `с «${teamName(inc.teamId)}»` : 'по инциденту'}
        {list.length > 0 && <span className="tag">{list.length}</span>}
      </h3>
      <div className="chat-list" ref={box}>
        {!list.length && <div className="empty sm">Сообщений пока нет. Напишите команде или пункту — всё останется в истории инцидента.</div>}
        {list.map((c) => (
          <div key={c.id} className={`msg side-${c.side} ${c.personId === me.personId ? 'mine' : ''}`}>
            <span className="msg-head">
              <b>{c.author}</b> · {c.side === 'point' ? 'пункт' : teamName(c.teamId)} · {fmtClock(c.at)}
            </span>
            <span className="msg-text">{withMentions(c.text, me.name)}</span>
          </div>
        ))}
      </div>
      <div className="chat-in">
        <input
          id="chat-input"
          className="inp"
          placeholder="Сообщение… (@Фамилия — упомянуть)"
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
        />
        <button className="btn btn-sm btn-primary" onClick={send} disabled={!text.trim()} aria-label="Отправить">
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
