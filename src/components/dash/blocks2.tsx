// Новые блоки свободного поля и галерея «Добавить блок»: часы, счётчики, одна группа, персонаж, риск,
// кому передать, команды, заметка и свой блок, придуманный ChatGPT (в том числе новый персонаж с портретом).
import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeftRight, BarChart3, Bell, Bot, Check, Clock3, Columns3, Eye, Flame, Hash, List, Map as MapIcon, NotebookPen, Repeat, Send, Smile, Sparkles, Star, Table2, Users, X, Target, Timer, Mail, MessagesSquare } from 'lucide-react';
import type { Incident } from '../../../shared/types';
import { BLOCKS, BLOCK_CATS, DASH_GROUPS, GROUP_NAME, riskOf, waitingTake, NOT_TAKEN_MIN, type BlockId, type DashGroup } from '../../../shared/dash';
import { DEFAULT_SIZE } from '../../../shared/dashGrid';
import { applyFilter, type CustomSpec } from '../../../shared/dashCustom';
import { PERSONAS, personaById } from '../../../shared/personas';
import { markSeen, teamName } from '../../store';
import { openFav } from '../FavDialog';
import { fmtClock } from '../../lib/format';
import { applyDashOp, dashEvent } from '../../lib/dashLayout';
import { makeCustomBlock } from '../../lib/dashDesign';
import { BlockHead, GroupTags, PRIO, leftText, on, os, who, type BlockCtx, type Opts } from './Dashboard';
import { fmtShort } from '../../../shared/dash';

const MIN = 60_000;

export function ClockBlock({ now }: { now: number }) {
  return (
    <div className="db db-clock">
      <b className="num">{fmtClock(now)}</b>
      <span>{new Date(now).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })} · МСК</span>
    </div>
  );
}

export function CountersBlock({ ctx }: { ctx: BlockCtx }) {
  const c = ctx.snap.counts;
  return (
    <div className="db db-counters">
      {DASH_GROUPS.map((g) => (
        <div key={g.id} className={`dk g-${g.id} ${c[g.id] ? 'on' : ''}`} title={g.hint}>
          <b className="num">{c[g.id]}</b>
          <span>{g.label}</span>
        </div>
      ))}
    </div>
  );
}

function Row({ i, now, onClick, right }: { i: Incident; now: number; onClick: () => void; right?: React.ReactNode }) {
  return (
    <button className={`dg-row p-${i.priority}`} onClick={onClick} title={`${i.productName || i.service} · ${i.stateText}`}>
      <span className="dc-bar" />
      <span>
        <b>{i.title}</b>
        <small>{who(i)}</small>
      </span>
      {right ?? <span className={`num dg-left ${i.slaDeadline - now < 30 * MIN ? 'hot' : ''}`}>{leftText(i, now)}</span>}
    </button>
  );
}

export function GroupBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const g = (os(o, 'group', 'crit') as DashGroup) || 'crit';
  const list = ctx.snap.byGroup[g] ?? [];
  return (
    <div className={`db db-group g-${g}`}>
      <BlockHead title={GROUP_NAME[g]} count={list.length} />
      <div className="dg-list">
        {g === 'crit' &&
          ctx.snap.resolvedCrit.map((i) => (
            <div key={i.id} className="dg-row resolved">
              <span>
                <b>{i.title}</b>
                <small>решён</small>
              </span>
            </div>
          ))}
        {list.map((i) => (
          <Row key={i.id} i={i} now={ctx.now} onClick={() => ctx.open(i)} />
        ))}
        {!list.length && <div className="db-empty small">нет</div>}
      </div>
    </div>
  );
}

export function RiskBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const list = useMemo(
    () =>
      ctx.snap.action
        .map((x) => x.inc)
        .filter((i) => i.priority !== 'P1')
        .map((i) => ({ i, r: riskOf(i, ctx.now) }))
        .filter((x) => x.r.score >= 35)
        .sort((a, b) => b.r.score - a.r.score)
        .slice(0, on(o, 'count', 6)),
    [ctx.snap, ctx.now, o],
  );
  return (
    <div className="db db-risk">
      <BlockHead title="Риск стать критическим" count={list.length} icon={<Flame size={18} />} />
      {list.map(({ i, r }) => (
        <button key={i.id} className="da-row" onClick={() => ctx.open(i)} title={r.reasons.join(', ')}>
          <b className="num">{r.score}%</b>
          <span>
            {i.title}
            <small>{r.reasons[0] ?? PRIO[i.priority]}</small>
          </span>
        </button>
      ))}
      {!list.length && <div className="db-empty small">риска нет</div>}
    </div>
  );
}

export function RouteBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const list = ctx.snap.byGroup.coord.slice(0, on(o, 'count', 6));
  return (
    <div className="db db-route">
      <BlockHead title="Кому передать" count={ctx.snap.byGroup.coord.length} icon={<Send size={18} />} />
      {list.map((i) => (
        <button key={i.id} className="da-row" onClick={() => ctx.open(i)}>
          <b className="num">{i.ai?.teamId ? `${Math.round((i.ai.confidence ?? 0) * 100)}%` : '—'}</b>
          <span>
            {i.title}
            <small>{i.ai?.teamId ? `→ «${teamName(i.ai.teamId)}»` : 'команду подберёт Джарвис'}</small>
          </span>
        </button>
      ))}
      {!list.length && <div className="db-empty small">на координаторах пусто</div>}
    </div>
  );
}

export function TeamsBlock({ ctx, o }: { ctx: BlockCtx; o?: Opts }) {
  const rows = useMemo(() => {
    const m = new Map<string, { n: number; late: number; wait: number }>();
    for (const i of ctx.snap.work) {
      const k = teamName(i.teamId);
      const x = m.get(k) ?? { n: 0, late: 0, wait: 0 };
      x.n++;
      if (i.slaDeadline < ctx.now) x.late++;
      if ((waitingTake(i, ctx.now) ?? 0) > NOT_TAKEN_MIN * MIN) x.wait++;
      m.set(k, x);
    }
    return [...m].sort((a, b) => b[1].n - a[1].n).slice(0, on(o, 'count', 8));
  }, [ctx.snap, ctx.now, o]);
  const max = Math.max(1, ...rows.map((r) => r[1].n));
  return (
    <div className="db db-teams">
      <BlockHead title="Команды" icon={<Users size={18} />} />
      {rows.map(([t, x]) => (
        <div key={t} className="dtm" title={`${x.n} в работе · ${x.late} просрочено · ${x.wait} не берут`}>
          <span>{t}</span>
          <i style={{ width: `${(x.n / max) * 100}%` }} className={x.late ? 'late' : ''} />
          <b className="num">{x.n}</b>
        </div>
      ))}
      {!rows.length && <div className="db-empty small">у команд пусто</div>}
    </div>
  );
}

export function NoteBlock({ o }: { o?: Opts }) {
  return (
    <div className="db db-note">
      <BlockHead title={os(o, 'title', 'Заметка')} icon={<NotebookPen size={18} />} />
      <p>{os(o, 'text', 'Нажмите «Изменить блоки», затем на эту заметку — и напишите свой текст: телефоны дежурных, напоминание смене.')}</p>
    </div>
  );
}

// ─── персонаж: портрет и реплики об обстановке в своём характере ───
const sayCache = new Map<string, { at: number; text: string }>();
function useSay(name: string, style: string, every: number) {
  const k = `${name}|${style}`;
  const [text, setText] = useState(sayCache.get(k)?.text ?? '');
  useEffect(() => {
    let dead = false;
    const load = async () => {
      const hit = sayCache.get(k);
      if (hit && Date.now() - hit.at < every * 1000 - 2000) return setText(hit.text);
      try {
        const r = await fetch('/api/dash/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, style }) });
        if (r.ok) {
          const x = (await r.json()) as { text: string };
          sayCache.set(k, { at: Date.now(), text: x.text });
          if (!dead) setText(x.text);
        }
      } catch {
        /* скажет в следующий раз */
      }
    };
    void load();
    const t = setInterval(load, every * 1000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [k, name, style, every]);
  return text;
}
function Avatar({ src, name, color }: { src?: string; name: string; color?: string }) {
  const persona = src && /^(jarvis|nika|captain|frost)$/.test(src) ? personaById(src) : null;
  const url = persona ? persona.avatar : src && src.startsWith('data:image/') ? src : null;
  return (
    <span className="dch-ava" style={{ ['--pc' as string]: color ?? persona?.color ?? 'var(--d-accent)' }}>
      {url ? <img src={url} alt={name} /> : <em>{src || name.slice(0, 1)}</em>}
    </span>
  );
}
export function CharacterBlock({ ctx, o, spec }: { ctx: BlockCtx; o?: Opts; spec?: CustomSpec }) {
  const p = personaById(os(o, 'persona', 'jarvis'));
  const ch = spec?.character;
  const name = ch?.name ?? p.name;
  const style = ch?.style ?? p.style;
  const color = ch?.color ?? p.color;
  const text = useSay(name, style, on(o, 'every', 60));
  const fallback = ctx.snap.action[0] ? `Главное — «${ctx.snap.action[0].inc.title}»: ${ctx.snap.action[0].att.reason.toLowerCase()}.` : 'Всё спокойно.';
  // Фигура на прозрачном фоне: у встроенных — готовая, у нарисованных ChatGPT — если фон удалось вырезать.
  const fig = ch ? (ch.cut && ch.avatar?.startsWith('data:image/') ? ch.avatar : null) : p.cutout;
  if (fig)
    return (
      <div className="db db-char cut" style={{ ['--pc' as string]: color }}>
        <p className="dch-bubble" key={text || fallback}>
          <small>{name}</small>
          <span>{text || fallback}</span>
        </p>
        <div className="dch-stage">
          <img className="dch-fig" src={fig} alt={name} draggable={false} />
        </div>
      </div>
    );
  return (
    <div className="db db-char">
      <Avatar src={ch?.avatar ?? p.id} name={name} color={color} />
      <b className="dch-name">{name}</b>
      <p className="dch-say">{text || fallback}</p>
    </div>
  );
}

// ─── свой блок по описанию от ChatGPT ───
export function CustomBlock({ ctx, spec }: { ctx: BlockCtx; spec: CustomSpec }) {
  const list = useMemo(() => {
    const all = [...ctx.snap.action.map((x) => x.inc), ...ctx.snap.work, ...ctx.snap.resolvedCrit];
    const uniq = [...new Map(all.map((i) => [i.id, i])).values()];
    const base = spec.filter?.status?.includes('resolved') ? uniq : uniq.filter((i) => i.status !== 'resolved');
    const f = applyFilter(base, spec.filter, ctx.now, (id) => teamName(id));
    const sortBy = spec.sort ?? 'deadline';
    const rank = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
    f.sort((a, b) => (sortBy === 'priority' ? rank[a.priority] - rank[b.priority] : sortBy === 'created' ? b.createdAt - a.createdAt : sortBy === 'complaints' ? (b.complaints ?? 0) - (a.complaints ?? 0) : a.slaDeadline - b.slaDeadline));
    return f;
  }, [ctx.snap, ctx.now, spec]);
  if (spec.kind === 'note')
    return (
      <div className="db db-note">
        <BlockHead title={spec.title} icon={<NotebookPen size={18} />} />
        <p>{spec.note}</p>
      </div>
    );
  if (spec.kind === 'counter')
    return (
      <div className="db db-bigcount" title={spec.hint}>
        <b className="num">{list.length}</b>
        <span>{spec.title}</span>
      </div>
    );
  if (spec.kind === 'bars') {
    const key = spec.groupBy ?? 'team';
    const m = new Map<string, number>();
    for (const i of list) {
      const k = key === 'team' ? teamName(i.teamId) : key === 'service' ? i.service : key === 'product' ? i.productName || i.service : key === 'priority' ? PRIO[i.priority] : i.stateText;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    const rows = [...m].sort((a, b) => b[1] - a[1]).slice(0, spec.limit ?? 8);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return (
      <div className="db db-teams" title={spec.hint}>
        <BlockHead title={spec.title} icon={<Sparkles size={16} />} />
        {rows.map(([t, n]) => (
          <div key={t} className="dtm">
            <span>{t}</span>
            <i style={{ width: `${(n / max) * 100}%` }} />
            <b className="num">{n}</b>
          </div>
        ))}
        {!rows.length && <div className="db-empty small">нет</div>}
      </div>
    );
  }
  return (
    <div className="db db-group" title={spec.hint}>
      <BlockHead title={spec.title} count={list.length} icon={<Sparkles size={16} />} />
      <div className="dg-list">
        {list.slice(0, spec.limit ?? 10).map((i) => (
          <Row key={i.id} i={i} now={ctx.now} onClick={() => ctx.open(i)} />
        ))}
        {!list.length && <div className="db-empty small">нет</div>}
      </div>
    </div>
  );
}

// ─── галерея «Добавить блок» ───
const ICONS: Record<string, React.ReactNode> = {
  bell: <Bell size={22} />,
  table: <Table2 size={22} />,
  columns: <Columns3 size={22} />,
  list: <List size={22} />,
  flame: <Flame size={22} />,
  send: <Send size={22} />,
  swap: <ArrowLeftRight size={22} />,
  hash: <Hash size={22} />,
  chart: <BarChart3 size={22} />,
  users: <Users size={22} />,
  clock: <Clock3 size={22} />,
  activity: <Activity size={22} />,
  map: <MapIcon size={22} />,
  bot: <Bot size={22} />,
  smile: <Smile size={22} />,
  repeat: <Repeat size={22} />,
  note: <NotebookPen size={22} />,
  sparkles: <Sparkles size={22} />,
  eye: <Eye size={22} />,
  star: <Star size={22} />,
  target: <Target size={22} />,
  mail: <Mail size={22} />,
  timer: <Timer size={22} />,
  chat: <MessagesSquare size={22} />,
};
/** Маленький набросок блока — чтобы было видно, как он выглядит. */
function Preview({ id }: { id: BlockId }) {
  const lines = (n: number) => Array.from({ length: n }, (_, k) => <i key={k} style={{ width: `${90 - ((k * 23) % 40)}%` }} />);
  switch (id) {
    case 'clock':
      return <div className="gp gp-clock">16:20</div>;
    case 'counters':
      return (
        <div className="gp gp-counters">
          {['crit', 'coord', 'high', 'research'].map((g) => (
            <b key={g} className={`g-${g}`}>{g === 'crit' ? 1 : g === 'coord' ? 2 : g === 'high' ? 4 : 0}</b>
          ))}
        </div>
      );
    case 'character':
      return (
        <div className="gp gp-char">
          <img src="/personas/nika-cut.webp" alt="" />
          <span>{lines(2)}</span>
        </div>
      );
    case 'groups':
      return (
        <div className="gp gp-cols">
          {[0, 1, 2, 3].map((k) => (
            <span key={k}>{lines(3)}</span>
          ))}
        </div>
      );
    case 'teams':
    case 'stats':
      return <div className="gp gp-bars">{[80, 60, 45, 30].map((w) => <i key={w} style={{ width: `${w}%` }} />)}</div>;
    case 'map':
      return <div className="gp gp-map" />;
    case 'note':
      return <div className="gp gp-note">{lines(3)}</div>;
    default:
      return <div className="gp gp-list">{[0, 1, 2].map((k) => <span key={k} className={k === 0 ? 'hot' : ''}>{lines(1)}</span>)}</div>;
  }
}

const BLOCK_IDEAS = ['Топ-5 просроченных у команд', 'Сколько инцидентов из жалоб абонентов', 'Инциденты по сервисам — полосами', 'Высокий приоритет, который команда не берёт', 'Заметка: телефоны дежурных инженеров'];
const CHAR_IDEAS = ['Строгий кот — начальник смены, говорит коротко', 'Весёлый робот-стажёр, подбадривает дежурных', 'Спокойная девушка-диспетчер из ЦУПа', 'Снеговик-аналитик, новогодний'];

export function BlockGallery({ at, onClose }: { at: { x: number; y: number } | null; onClose: () => void }) {
  const [pick, setPick] = useState<BlockId | null>(null);
  const [mode, setMode] = useState<'blocks' | 'gpt' | 'char'>('blocks');
  const [text, setText] = useState('');
  const [draw, setDraw] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const add = (block: BlockId, opts?: Record<string, string | number | boolean>, extra: { custom?: CustomSpec; w?: number; h?: number } = {}) => {
    const size = DEFAULT_SIZE[block] ?? { w: 4, h: 6 };
    const res = applyDashOp({ op: 'add', block, ...(at ? { x: at.x, y: at.y } : {}), w: extra.w ?? size.w, h: extra.h ?? size.h, opts, custom: extra.custom });
    if (/нет места|закреплён/.test(res)) setErr(res);
    else onClose();
  };
  const gpt = async (character: boolean) => {
    if (!text.trim() || busy) return;
    setErr('');
    try {
      await makeCustomBlock(text, { character, draw, at, onStep: setBusy });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy('');
  };
  return (
    <div className="gal-wrap" onClick={onClose}>
      <div className="gal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Добавить блок">
        <header className="gal-h">
          <b>Добавить блок{at ? ` · в клетку ${at.x + 1}:${at.y + 1}` : ''}</b>
          <nav>
            <button className={mode === 'blocks' ? 'on' : ''} onClick={() => setMode('blocks')}>
              Готовые блоки
            </button>
            <button className={mode === 'gpt' ? 'on' : ''} onClick={() => setMode('gpt')}>
              <Sparkles size={14} /> Свой блок
            </button>
            <button className={mode === 'char' ? 'on' : ''} onClick={() => setMode('char')}>
              <Smile size={14} /> Новый персонаж
            </button>
          </nav>
          <button className="gal-x" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        {mode === 'blocks' && (
          <div className="gal-body">
            {BLOCK_CATS.filter((c) => c.id !== 'own').map((cat) => (
              <section key={cat.id}>
                <h4>{cat.name}</h4>
                <div className="gal-grid">
                  {BLOCKS.filter((b) => b.cat === cat.id).map((b) => {
                    const choose = () => (b.id === 'group' || b.id === 'character' ? setPick(pick === b.id ? null : b.id) : add(b.id));
                    return (
                    <div key={b.id} role="button" tabIndex={0} className={`gal-card ${pick === b.id ? 'on' : ''}`} onClick={choose} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose())}>
                      <Preview id={b.id} />
                      <span className="gal-t">
                        {ICONS[b.icon]}
                        <b>{b.name}</b>
                      </span>
                      <small>{b.hint}</small>
                      {pick === 'group' && b.id === 'group' && (
                        <span className="gal-sub" onClick={(e) => e.stopPropagation()}>
                          {DASH_GROUPS.map((g) => (
                            <button key={g.id} className={`g-${g.id}`} onClick={() => add('group', { group: g.id })}>
                              {g.label}
                            </button>
                          ))}
                        </span>
                      )}
                      {pick === 'character' && b.id === 'character' && (
                        <span className="gal-sub" onClick={(e) => e.stopPropagation()}>
                          {PERSONAS.map((p) => (
                            <button key={p.id} className="gal-persona" onClick={() => add('character', { persona: p.id })} title={p.title}>
                              <img src={p.avatar} alt="" /> {p.name}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                    );
                  })}
                </div>
              </section>
            ))}
            <section>
              <h4>Своё</h4>
              <div className="gal-grid">
                <button className="gal-card" onClick={() => add('note')}>
                  <Preview id="note" />
                  <span className="gal-t">
                    {ICONS.note}
                    <b>Заметка</b>
                  </span>
                  <small>свой текст на стене</small>
                </button>
                <button className="gal-card gpt" onClick={() => setMode('gpt')}>
                  <div className="gp gp-gpt">
                    <Sparkles size={26} />
                  </div>
                  <span className="gal-t">
                    {ICONS.sparkles}
                    <b>Свой блок через ChatGPT</b>
                  </span>
                  <small>опишите словами — что показать</small>
                </button>
                <button className="gal-card gpt" onClick={() => setMode('char')}>
                  <div className="gp gp-gpt">
                    <Smile size={26} />
                  </div>
                  <span className="gal-t">
                    {ICONS.smile}
                    <b>Новый персонаж через ChatGPT</b>
                  </span>
                  <small>характер, реплики и нарисованный портрет</small>
                </button>
              </div>
            </section>
          </div>
        )}
        {mode !== 'blocks' && (
          <div className="gal-body gal-gpt">
            <p>{mode === 'gpt' ? 'Опишите, какой блок нужен — ChatGPT соберёт его из данных пункта: список, одно число, полосы или заметку.' : 'Опишите персонажа — ChatGPT придумает имя и характер, а GPT нарисует портрет. Персонаж будет комментировать обстановку на стене.'}</p>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'gpt' ? 'Например: топ-5 просроченных инцидентов с командами' : 'Например: строгий кот — начальник смены, говорит коротко'} disabled={!!busy} autoFocus />
            <div className="gal-ideas">
              {(mode === 'gpt' ? BLOCK_IDEAS : CHAR_IDEAS).map((x) => (
                <button key={x} onClick={() => setText(x)} disabled={!!busy}>
                  {x}
                </button>
              ))}
            </div>
            {mode === 'char' && (
              <label className="gal-check">
                <input type="checkbox" checked={draw} onChange={(e) => setDraw(e.target.checked)} disabled={!!busy} /> Нарисовать портрет (GPT, около 40 секунд)
              </label>
            )}
            <div className="gal-act">
              <button className="on" onClick={() => void gpt(mode === 'char')} disabled={!!busy || !text.trim()}>
                <Sparkles size={15} /> {busy || (mode === 'gpt' ? 'Собрать блок' : 'Создать персонажа')}
              </button>
              {busy && <span className="gal-spin" />}
            </div>
          </div>
        )}
        {err && <div className="gal-err">{err}</div>}
        <footer className="gal-f">
          <span>Блоки ставятся на свободное место поля. Двигать и менять размер — «Изменить блоки».</span>
          <button onClick={() => dashEvent({ type: 'edit', on: true })}>Изменить блоки</button>
        </footer>
      </div>
    </div>
  );
}

export { GroupTags, fmtShort };

// ─── «Не забыть»: подсовывает важные некритические, на которые давно никто не смотрел ───
export function ForgotBlock({ ctx }: { ctx: BlockCtx }) {
  // то, что и так вверху «Кому распределить», здесь не повторяем
  const top = new Set(ctx.snap.action.slice(0, 3).map((x) => x.inc.id));
  const list = ctx.snap.forgotten.filter((x) => !top.has(x.inc.id));
  const [k, setK] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setK((x) => x + 1), 12_000);
    return () => clearInterval(t);
  }, []);
  if (!list.length)
    return (
      <div className="db db-forgot">
        <BlockHead title="Не забыть" icon={<Eye size={18} />} />
        <div className="db-empty small">Ничего не забыто — всё важное под присмотром</div>
      </div>
    );
  const cur = list[k % Math.min(list.length, 5)];
  const i = cur.inc;
  const left = i.slaDeadline - ctx.now;
  return (
    <div className="db db-forgot">
      <BlockHead title="Не забыть" count={list.length} icon={<Eye size={18} />} />
      <button key={i.id} className={`dfg p-${i.priority}`} onClick={() => ctx.open(i)} title="Открыть — и он перестанет подсовываться">
        <span className="dfg-why">
          без внимания {fmtShort(cur.idle)}
          {ctx.snap.topCrit > 0 && cur.score > ctx.snap.topCrit ? ' · важнее критического' : ''}
        </span>
        <b>{i.title}</b>
        <small>{who(i)}</small>
        <span className={`dfg-sla num ${left < 30 * MIN ? 'hot' : ''}`}>{left > 0 ? `до срока ${fmtShort(left)}` : `просрочен ${fmtShort(-left)}`}</span>
      </button>
      <span className="dfg-act">
        <button onClick={() => markSeen(i.id)} title="Посмотрел — убрать из «Не забыть»">
          <Check size={14} /> Посмотрел
        </button>
        <button onClick={() => openFav(i.id)} title="В избранное смены с заметкой">
          <Star size={14} /> В избранное
        </button>
        {list.length > 1 && <span className="num">ещё {list.length - 1}</span>}
      </span>
    </div>
  );
}

// ─── Избранное смены: закреплённые инциденты с заметками и напоминаниями ───
export function FavsBlock({ ctx }: { ctx: BlockCtx }) {
  const list = ctx.snap.pinned;
  return (
    <div className="db db-favs">
      <BlockHead title="Избранное смены" count={list.length} icon={<Star size={18} />} />
      {!list.length && <div className="db-empty small">Закрепите важное звёздочкой на карточке — заметку и напоминание увидит вся смена</div>}
      {list.map((i) => {
        const p = i.pin!;
        const due = p.remindAt ? p.remindAt - ctx.now : null;
        return (
          <div key={i.id} className={`dfv p-${i.priority} ${i.status === 'resolved' ? 'done' : ''}`}>
            <button className="dfv-main" onClick={() => ctx.open(i)}>
              <b>{i.status === 'resolved' ? '✓ ' : ''}{i.title}</b>
              {p.note && <em>«{p.note}»</em>}
              <small>
                {p.by.split(' ')[0]} · {i.status === 'resolved' ? 'решён' : leftText(i, ctx.now)}
                {due !== null ? (due > 0 ? ` · напомнит через ${fmtShort(due)}` : ' · пора!') : ''}
              </small>
            </button>
            <button className="dfv-star" onClick={() => openFav(i.id)} aria-label="Изменить избранное">
              <Star size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
