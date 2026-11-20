// «Мой стол» — дежурный сам собирает рабочее место из блоков: входящие, карточка, карта, детектор, сигналы…
// Блоки можно добавлять и убирать, перетаскивать местами и растягивать за угол. Раскладка своя у каждого
// дежурного и хранится в браузере. Есть готовые раскладки — с них удобно начать.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BellRing, CheckCheck, GripVertical, Inbox, LayoutDashboard, Map as MapIcon, MessageSquareShare, Plus, Sparkles, SquareStack, Target, Users, Workflow, X } from 'lucide-react';
import type { Incident } from '../../shared/types';
import { readLocal, select, teamName, useStore, writeLocal } from '../store';
import { urgency } from '../lib/format';
import { useNow } from '../lib/hooks';
import { hotNav } from '../lib/hotkeys';
import { Deadline, PrioDot } from './ui';
import { RFMap } from './RFMap';
import { IncidentCard } from './IncidentCard';
import { Detector, IncidentRow, RequestCard, Signals } from './PointScreen';
import { Roster } from './CommanderScreen';
import { MyShift } from './ShiftTools';
import { heatClass, heatOf, heatStyle, isOn } from './kit';

type BlockType = 'kpi' | 'inbox' | 'card' | 'map' | 'detector' | 'teams' | 'signals' | 'requests' | 'myshift' | 'roster' | 'ai';
interface Block {
  id: string;
  type: BlockType;
  w: number; // ширина в колонках из 12
  h: number; // высота в рядах
}

const BLOCKS: Record<BlockType, { name: string; icon: typeof Inbox; hint: string; w: number; h: number; minW?: number; minH?: number }> = {
  kpi: { name: 'Показатели', icon: Target, hint: 'жалобы в минуту, на пункте, у команд, сигналы', w: 12, h: 1, minH: 1 },
  inbox: { name: 'Входящие', icon: Inbox, hint: 'новые на пункте: мои и без дежурного', w: 4, h: 5 },
  card: { name: 'Карточка инцидента', icon: SquareStack, hint: 'выбранный инцидент по шагам', w: 5, h: 5, minW: 4 },
  map: { name: 'Карта жалоб', icon: MapIcon, hint: 'жалобы и инциденты по России', w: 6, h: 4 },
  detector: { name: 'Детектор всплесков', icon: Activity, hint: 'что ИИ сейчас собирает в инциденты', w: 3, h: 4 },
  teams: { name: 'У команд', icon: Workflow, hint: 'переданные: кто взял, сколько до срока', w: 4, h: 4 },
  signals: { name: 'Сигналы', icon: BellRing, hint: 'застрявшие и просьбы о помощи', w: 4, h: 3 },
  requests: { name: 'Запросы команд', icon: MessageSquareShare, hint: '«не наше — передайте»', w: 4, h: 3 },
  myshift: { name: 'Моя смена', icon: CheckCheck, hint: 'сколько взял, передал, решено', w: 3, h: 2 },
  roster: { name: 'Смена пункта', icon: Users, hint: 'кто из дежурных на смене', w: 3, h: 4 },
  ai: { name: 'Журнал ИИ', icon: Sparkles, hint: 'последние действия ИИ', w: 4, h: 3 },
};

let seq = 0;
const mk = (type: BlockType, w?: number, h?: number): Block => ({ id: `${type}-${Date.now().toString(36)}-${seq++}`, type, w: w ?? BLOCKS[type].w, h: h ?? BLOCKS[type].h });

const PRESETS: { id: string; name: string; hint: string; make: () => Block[] }[] = [
  { id: 'triage', name: 'Разбор входящих', hint: 'список, карточка, сигналы', make: () => [mk('kpi'), mk('inbox', 4, 5), mk('card', 5, 5), mk('signals', 3, 3), mk('myshift', 3, 2)] },
  { id: 'watch', name: 'Наблюдение', hint: 'карта, детектор, у команд', make: () => [mk('kpi'), mk('map', 6, 5), mk('detector', 3, 5), mk('teams', 3, 5)] },
  { id: 'all', name: 'Всё сразу', hint: 'для большого монитора', make: () => [mk('kpi'), mk('inbox', 3, 5), mk('card', 5, 5), mk('map', 4, 3), mk('signals', 4, 2), mk('teams', 4, 3), mk('requests', 4, 3), mk('ai', 4, 3)] },
];

function useDesk(login: string) {
  const key = `radar.desk.${login}`;
  const [blocks, setBlocks] = useState<Block[]>(() => {
    const saved = readLocal<Block[] | null>(key, null);
    return saved?.length ? saved.filter((b) => BLOCKS[b.type]) : PRESETS[0].make();
  });
  useEffect(() => writeLocal(key, blocks), [key, blocks]);
  return [blocks, setBlocks] as const;
}

export function Desk() {
  const me = useStore((s) => s.me)!;
  const [blocks, setBlocks] = useDesk(me.login);
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);

  const used = new Set(blocks.map((b) => b.type));
  const patch = (id: string, p: Partial<Block>) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const remove = (id: string) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  // Новый блок — в конец стола; панель закрываем и показываем блок.
  const add = (t: BlockType) => {
    const b = mk(t);
    setBlocks((bs) => [...bs, b]);
    setAdding(false);
    setTimeout(() => document.querySelector(`[data-block="${b.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  };
  const move = (from: string, to: string) =>
    setBlocks((bs) => {
      const a = bs.findIndex((b) => b.id === from);
      const z = bs.findIndex((b) => b.id === to);
      if (a < 0 || z < 0 || a === z) return bs;
      const next = [...bs];
      const [x] = next.splice(a, 1);
      next.splice(z, 0, x);
      return next;
    });

  // Растягивание за угол: шаг — одна колонка сетки и один ряд.
  function resize(e: React.PointerEvent, b: Block) {
    e.preventDefault();
    const el = grid.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 10;
    const colW = (el.clientWidth - gap * 11) / 12 + gap;
    const rowH = parseFloat(cs.gridAutoRows) + (parseFloat(cs.rowGap) || 10);
    const sx = e.clientX;
    const sy = e.clientY;
    const { w, h } = b;
    const min = BLOCKS[b.type];
    const onMove = (ev: PointerEvent) => {
      const nw = Math.max(min.minW ?? 3, Math.min(12, Math.round(w + (ev.clientX - sx) / colW)));
      const nh = Math.max(min.minH ?? 2, Math.min(7, Math.round(h + (ev.clientY - sy) / rowH)));
      patch(b.id, { w: nw, h: nh });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('desk-resizing');
    };
    document.body.classList.add('desk-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div className={`desk ${edit ? 'desk-edit' : ''}`}>
      <div className="desk-bar">
        <LayoutDashboard size={16} />
        <b>Мой стол</b>
        <span className="muted">{edit ? 'Перетаскивайте блоки за ручку, растягивайте за правый нижний угол' : 'Ваше рабочее место — соберите из блоков, как удобно'}</span>
        <span className="desk-sp" />
        {edit && (
          <>
            <div className="desk-presets">
              {PRESETS.map((p) => (
                <button key={p.id} className="btn btn-sm btn-ghost" title={p.hint} onClick={() => setBlocks(p.make())}>
                  {p.name}
                </button>
              ))}
            </div>
            <button className="btn btn-sm" onClick={() => setAdding((a) => !a)}>
              <Plus size={14} /> Блок
            </button>
          </>
        )}
        <button className={`btn btn-sm ${edit ? 'btn-primary' : ''}`} onClick={() => (setEdit((v) => !v), setAdding(false))}>
          {edit ? 'Готово' : 'Настроить стол'}
        </button>
      </div>

      {adding && (
        <div className="desk-add">
          {(Object.keys(BLOCKS) as BlockType[]).map((t) => {
            const d = BLOCKS[t];
            return (
              <button key={t} className={`desk-add-item ${used.has(t) ? 'used' : ''}`} disabled={used.has(t)} onClick={() => add(t)}>
                <d.icon size={16} />
                <b>{d.name}</b>
                <span className="muted">{used.has(t) ? 'уже на столе' : d.hint}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="desk-grid" ref={grid}>
        {!blocks.length && (
          <div className="desk-empty">
            Стол пуст.
            <div className="desk-presets">
              {PRESETS.map((p) => (
                <button key={p.id} className="btn" onClick={() => setBlocks(p.make())}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {blocks.map((b) => {
          const d = BLOCKS[b.type];
          return (
            <section
              key={b.id}
              data-block={b.id}
              className={`desk-block db-${b.type} ${drag === b.id ? 'dragging' : ''} ${over === b.id && drag !== b.id ? 'over' : ''}`}
              style={{ gridColumn: `span ${b.w}`, gridRow: `span ${b.h}` }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                setOver(b.id);
              }}
              onDragLeave={() => setOver((o) => (o === b.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) move(drag, b.id);
                setDrag(null);
                setOver(null);
              }}
            >
              <header
                className="desk-h"
                draggable={edit}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', b.id);
                  setDrag(b.id);
                }}
                onDragEnd={() => (setDrag(null), setOver(null))}
              >
                {edit && <GripVertical size={14} className="desk-grip" />}
                <d.icon size={14} />
                <span>{d.name}</span>
                {edit && (
                  <>
                    <span className="desk-size num">
                      {b.w}×{b.h}
                    </span>
                    <button className="icon-btn" onClick={() => remove(b.id)} aria-label={`Убрать блок «${d.name}»`} title="Убрать со стола">
                      <X size={14} />
                    </button>
                  </>
                )}
              </header>
              <div className="desk-body">
                <BlockBody type={b.type} />
              </div>
              {edit && <span className="desk-resize" onPointerDown={(e) => resize(e, b)} title="Потяните, чтобы изменить размер" />}
            </section>
          );
        })}
        {edit && (
          <button className="desk-block desk-plus" style={{ gridColumn: 'span 3', gridRow: 'span 2' }} onClick={() => setAdding(true)}>
            <Plus size={22} />
            Добавить блок
          </button>
        )}
      </div>
    </div>
  );
}

// ─── содержимое блоков ─────────────────────────────────────────────────────

function BlockBody({ type }: { type: BlockType }) {
  switch (type) {
    case 'kpi':
      return <Kpi />;
    case 'inbox':
      return <InboxBlock />;
    case 'card':
      return <CardBlock />;
    case 'map':
      return <RFMap />;
    case 'detector':
      return <Detector />;
    case 'teams':
      return <TeamsBlock />;
    case 'signals':
      return <SignalsBlock />;
    case 'requests':
      return <RequestsBlock />;
    case 'myshift':
      return <MyShift />;
    case 'roster':
      return <Roster />;
    case 'ai':
      return <AiBlock />;
  }
}

function Kpi() {
  const incidents = useStore((s) => s.incidents);
  const signals = useStore((s) => s.signals);
  const requests = useStore((s) => s.requests);
  const stats = useStore((s) => s.stats);
  const staff = useStore((s) => s.staff);
  const now = useNow(10_000);
  const open = [...incidents.values()].filter((i) => i.status !== 'resolved');
  const tiles: [string, number | string, string?][] = [
    ['жалоб в минуту', stats?.flowPerMin ?? 0],
    ['на пункте', open.filter((i) => i.status === 'coordinators').length, open.some((i) => i.status === 'coordinators' && !i.coordinatorId) ? 'warn' : undefined],
    ['у команд', open.filter((i) => i.status !== 'coordinators').length],
    ['наивысший', open.filter((i) => i.priority === 'P1' || i.p1Proposal).length, open.some((i) => i.priority === 'P1' || i.p1Proposal) ? 'hot' : undefined],
    ['сигналы', [...signals.values()].filter((s) => s.status === 'open').length, [...signals.values()].some((s) => s.status === 'open') ? 'hot' : undefined],
    ['запросы', [...requests.values()].filter((r) => r.status === 'pending').length],
    ['дежурных на смене', staff.filter((p) => p.role === 'coordinator' && isOn(p, now)).length],
  ];
  return (
    <div className="desk-kpi">
      {tiles.map(([label, v, tone]) => (
        <div key={label} className={`dk-tile ${tone ?? ''}`}>
          <span key={String(v)} className="num pop">
            {v}
          </span>
          {label}
        </div>
      ))}
    </div>
  );
}

function InboxBlock() {
  const me = useStore((s) => s.me)!;
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(10_000);
  const [scope, setScope] = useState<'mine' | 'free' | 'all'>('all');
  const at = useMemo(() => [...incidents.values()].filter((i) => i.status === 'coordinators').sort((a, b) => urgency(b, now) - urgency(a, now)), [incidents, now]);
  const list = scope === 'mine' ? at.filter((i) => i.coordinatorId === me.personId) : scope === 'free' ? at.filter((i) => !i.coordinatorId) : at;
  hotNav.list = list.slice(0, 100).map((i) => i.id);
  return (
    <>
      <div className="seg seg-sm desk-seg">
        {(
          [
            ['all', 'Все', at.length],
            ['mine', 'Мои', at.filter((i) => i.coordinatorId === me.personId).length],
            ['free', 'Без дежурного', at.filter((i) => !i.coordinatorId).length],
          ] as const
        ).map(([id, label, n]) => (
          <button key={id} className={scope === id ? 'on' : ''} onClick={() => setScope(id)}>
            {label} <span className="num">{n}</span>
          </button>
        ))}
      </div>
      <div className="pl-rows">
        {!list.length && <div className="empty sm">Пусто</div>}
        {list.slice(0, 60).map((i) => (
          <IncidentRow key={i.id} inc={i} sel={i.id === selectedId} onClick={() => select(i.id)} />
        ))}
      </div>
    </>
  );
}

function CardBlock() {
  const selectedId = useStore((s) => s.selectedId);
  const inc = useStore((s) => (selectedId ? s.incidents.get(selectedId) : undefined));
  if (!inc) return <div className="empty sm">Выберите инцидент в любом списке на столе — он откроется здесь</div>;
  return <IncidentCard key={inc.id} inc={inc} />;
}

function TeamsBlock() {
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(10_000);
  const list = [...incidents.values()].filter((i) => i.status === 'assigned' || i.status === 'in_progress').sort((a, b) => urgency(b, now) - urgency(a, now));
  return (
    <div className="pl-rows">
      {!list.length && <div className="empty sm">У команд сейчас ничего нет</div>}
      {list.slice(0, 60).map((i) => (
        <TeamRow key={i.id} i={i} sel={i.id === selectedId} now={now} />
      ))}
    </div>
  );
}
function TeamRow({ i, sel, now }: { i: Incident; sel: boolean; now: number }) {
  const h = heatOf(i, now);
  return (
    <div className={`trow p-${i.priority} ${sel ? 'sel' : ''} ${heatClass(h)}`} style={heatStyle(h)} role="button" tabIndex={0} onClick={() => select(i.id)} onKeyDown={(e) => e.key === 'Enter' && select(i.id)}>
      <PrioDot p={i.priority} />
      <span className="tr-main">
        <span className="pr-title">{i.title}</span>
        <span className="pr-meta">
          {teamName(i.teamId)}
          {i.assigneeName ? ` · ${i.assigneeName}` : ' · ещё не взяли'}
        </span>
      </span>
      <Deadline inc={i} />
    </div>
  );
}

function SignalsBlock() {
  const signals = useStore((s) => s.signals);
  return <Signals list={[...signals.values()]} />;
}

function RequestsBlock() {
  const requests = useStore((s) => s.requests);
  const pending = [...requests.values()].filter((r) => r.status === 'pending').sort((a, b) => a.at - b.at);
  if (!pending.length) return <div className="empty sm">Новых запросов от команд нет</div>;
  return (
    <div className="desk-cards">
      {pending.map((r) => (
        <RequestCard key={r.id} r={r} />
      ))}
    </div>
  );
}

function AiBlock() {
  const incidents = useStore((s) => s.incidents);
  const entries = useMemo(() => {
    const out: { at: number; text: string; id: string; title: string }[] = [];
    for (const i of incidents.values()) for (const h of i.history) if (h.kind === 'ai') out.push({ at: h.at, text: h.text.replace(/^ИИ:\s*/, ''), id: i.id, title: i.title });
    return out.sort((a, b) => b.at - a.at).slice(0, 40);
  }, [incidents]);
  return (
    <div className="desk-ai">
      {!entries.length && <div className="empty sm">ИИ пока ничего не делал</div>}
      {entries.map((e, k) => (
        <button key={k} className="dai-row" onClick={() => select(e.id)}>
          <span className="num muted">{new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
          <span>
            {e.text}
            <span className="muted"> · {e.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
