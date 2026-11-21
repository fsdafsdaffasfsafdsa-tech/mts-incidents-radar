// «Настройки дашборда»: раскладка блоков (готовая или своя), стиль из 26, тревоги, Джарвис и поведение.
// Всё сохраняется в этом браузере и сразу доходит до окна стены.
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Lock, Plus, RotateCcw, Sparkles, Trash2, Unlock, X } from 'lucide-react';
import { BLOCKS, DASH_GROUPS, PRESETS, type BlockId, type DashGroup } from '../../../shared/dash';
import { DASH_STYLES, type DashStyle } from '../../../shared/dashStyles';
import { DEFAULT_DASH, applyDashOp, dashEvent, setDash, useDash } from '../../lib/dashLayout';
import { applyDesign, askDesign, type DesignTurn } from '../../lib/dashDesign';
import { PersonaPicker, jarvisPrefs, setJarvisPref } from '../Jarvis';

export function DashSettings({ onClose }: { onClose: () => void }) {
  const d = useDash();
  const cols = d.columns;
  const setCols = (next: typeof cols) => setDash({ preset: 'custom', columns: next });
  return (
    <div className="dset-wrap" onClick={onClose}>
      <aside className="dset" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Настройки дашборда">
        <header className="dset-h">
          <b>Настройки дашборда</b>
          <span>Блоки, стиль, тревоги и Джарвис. Всё это можно сказать и голосом: «Джарвис, поменяй местами блоки».</span>
          <button className="dset-x" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>

        <section>
          <div className={`dset-lock ${d.locked ? 'on' : ''}`}>
            {d.locked ? <Lock size={18} /> : <Unlock size={18} />}
            <span style={{ flex: 1 }}>
              <b>{d.locked ? 'Интерфейс закреплён за вами' : 'Закрепить интерфейс за мной'}</b>
              <small>Раскладка, стиль, персонаж и голос хранятся в вашей учётной записи — на любом компьютере после входа будет так же. Пока закреплено, Джарвис и случайные нажатия ничего не меняют.</small>
            </span>
            <button className={`dset-btn ${d.locked ? 'on' : ''}`} onClick={() => setDash({ locked: !d.locked })}>
              {d.locked ? 'Открепить' : 'Закрепить'}
            </button>
          </div>
        </section>

        <fieldset className="dset-body" disabled={d.locked}>
        <section>
          <h3>Персонаж ИИ-помощника</h3>
          <PersonaPicker compact />
          <label className="dset-check">
            <input type="checkbox" defaultChecked={jarvisPrefs.work} onChange={(e) => setJarvisPref('work', e.target.checked)} /> Показывать работу Джарвиса: по шагам, что он делает на сайте прямо сейчас
          </label>
          <label className="dset-check">
            <input type="checkbox" defaultChecked={jarvisPrefs.speak} onChange={(e) => setJarvisPref('speak', e.target.checked)} /> Отвечать голосом (у каждого персонажа свой)
          </label>
        </section>

        <section>
          <h3>Готовые раскладки</h3>
          <div className="dset-presets">
            {PRESETS.map((p) => (
              <button key={p.id} className={d.preset === p.id ? 'on' : ''} onClick={() => applyDashOp({ op: 'preset', preset: p.id })}>
                <b>{p.name}</b>
                <small>{p.hint}</small>
              </button>
            ))}
          </div>
        </section>

        {d.preset !== 'legacy' && (
          <section>
            <h3>Своя раскладка — колонки слева направо</h3>
            <div className="dset-cols">
              {cols.map((c, k) => (
                <div key={k} className="dset-col">
                  <span className="dset-n">{k + 1}</span>
                  <select value={c.block} onChange={(e) => applyDashOp({ op: 'replace', at: k, block: e.target.value as BlockId })} aria-label={`Блок в колонке ${k + 1}`}>
                    {BLOCKS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <label className="dset-w" title="Ширина колонки">
                    <input type="range" min={0.6} max={3} step={0.05} value={c.width} onChange={(e) => setCols(cols.map((x, n) => (n === k ? { ...x, width: +e.target.value } : x)))} aria-label={`Ширина колонки ${k + 1}`} />
                    <b className="num">{c.width.toFixed(1)}</b>
                  </label>
                  <button disabled={k === 0} onClick={() => applyDashOp({ op: 'swap', a: k, b: k - 1 })} aria-label="Левее">
                    <ArrowLeft size={14} />
                  </button>
                  <button disabled={k === cols.length - 1} onClick={() => applyDashOp({ op: 'swap', a: k, b: k + 1 })} aria-label="Правее">
                    <ArrowRight size={14} />
                  </button>
                  <button disabled={cols.length <= 1} onClick={() => setCols(cols.filter((_, n) => n !== k))} aria-label="Убрать колонку">
                    <Trash2 size={14} />
                  </button>
                  <small className="dset-hint">
                    {BLOCKS.find((b) => b.id === c.block)?.hint}{' '}
                    <button
                      className="dset-link"
                      onClick={() => {
                        dashEvent({ type: 'edit', on: true, k });
                        onClose();
                      }}
                    >
                      Настроить блок на стене →
                    </button>
                  </small>
                </div>
              ))}
            </div>
            <div className="dset-row">
              <button className="dset-btn" disabled={cols.length >= 4} onClick={() => setCols([...cols, { block: BLOCKS.find((b) => !cols.some((c) => c.block === b.id))?.id ?? 'events', width: 1 }])}>
                <Plus size={14} /> Добавить колонку
              </button>
              <button
                className="dset-btn on"
                onClick={() => {
                  dashEvent({ type: 'edit', on: true });
                  onClose();
                }}
              >
                Изменить блоки прямо на стене
              </button>
              <label className="dset-check">
                <input type="checkbox" checked={d.counters} onChange={(e) => setDash({ counters: e.target.checked })} /> Шапка со счётчиками групп
              </label>
              <label className="dset-check">
                <input type="checkbox" checked={d.ticker} onChange={(e) => setDash({ ticker: e.target.checked })} /> Бегущая строка событий
              </label>
            </div>
          </section>
        )}

        <section>
          <h3>
            Стиль <small>{DASH_STYLES.length} оформлений{d.customStyles.length ? ` + ${d.customStyles.length} ваших` : ''}</small>
          </h3>
          <DesignBox />
          <div className="dset-styles">
            {[...d.customStyles].reverse().map((s) => (
              <span key={s.id} style={{ display: 'grid' }}>
                <StyleSwatch s={s} on={d.style === s.id} />
                <button className="dset-del" onClick={() => applyDashOp({ op: 'removeStyle', id: s.id })}>
                  убрать
                </button>
              </span>
            ))}
            {DASH_STYLES.map((s) => (
              <button key={s.id} className={d.style === s.id ? 'on' : ''} onClick={() => setDash({ style: s.id })} title={s.name}>
                <span className="dset-sw" style={{ background: s.bg }}>
                  <i style={{ background: s.panel, borderColor: s.line }}>
                    <em style={{ background: s.crit }} />
                    <em style={{ background: s.high }} />
                    <em style={{ background: s.low }} />
                  </i>
                  <i style={{ background: s.panel, borderColor: s.line }}>
                    <u style={{ background: s.text }} />
                    <u style={{ background: s.muted }} />
                  </i>
                </span>
                <span>{s.name}</span>
              </button>
            ))}
          </div>
          <div className="dset-row">
            <span>Размер:</span>
            <button className={`dset-btn ${d.density === 'normal' ? 'on' : ''}`} onClick={() => setDash({ density: 'normal' })}>
              Обычный
            </button>
            <button className={`dset-btn ${d.density === 'large' ? 'on' : ''}`} onClick={() => setDash({ density: 'large' })}>
              Крупный — видно издалека
            </button>
          </div>
        </section>

        <section>
          <h3>Что показывать</h3>
          <div className="dset-row wrap">
            <button className={`dset-btn ${!d.filter ? 'on' : ''}`} onClick={() => setDash({ filter: null })}>
              Все группы
            </button>
            {DASH_GROUPS.map((g) => (
              <button key={g.id} className={`dset-btn ${d.filter === g.id ? 'on' : ''}`} onClick={() => setDash({ filter: g.id as DashGroup })} title={g.hint}>
                Только «{g.label}»
              </button>
            ))}
          </div>
          <label className="dset-check">
            <input type="checkbox" checked={d.onlyFile} onChange={(e) => setDash({ onlyFile: e.target.checked })} /> Только инциденты из файла ITSM (без инцидентов из жалоб) — для показа по кейсу
          </label>
          <div className="dset-row">
            <label className="dset-range">
              Сменяемая панель — каждые <b className="num">{d.rotateSec}</b> с
              <input type="range" min={8} max={60} step={1} value={d.rotateSec} onChange={(e) => setDash({ rotateSec: +e.target.value })} />
            </label>
            <label className="dset-range">
              Листание списков — каждые <b className="num">{d.pageSec}</b> с
              <input type="range" min={6} max={40} step={1} value={d.pageSec} onChange={(e) => setDash({ pageSec: +e.target.value })} />
            </label>
          </div>
        </section>

        <section>
          <h3>Тревоги</h3>
          <label className="dset-check">
            <input type="checkbox" checked={d.banners} onChange={(e) => setDash({ banners: e.target.checked })} /> Баннер на всю стену: новый критический, критический решён, назначен на координаторов
          </label>
          <label className="dset-check">
            <input type="checkbox" checked={d.sound} onChange={(e) => setDash({ sound: e.target.checked })} /> Звук тревоги
          </label>
          <div className="dset-row">
            <span>Проверить:</span>
            <button className="dset-btn" onClick={() => dashEvent({ type: 'test-alarm', kind: 'crit' })}>
              Критический
            </button>
            <button className="dset-btn" onClick={() => dashEvent({ type: 'test-alarm', kind: 'resolved' })}>
              Решён
            </button>
            <button className="dset-btn" onClick={() => dashEvent({ type: 'test-alarm', kind: 'coord' })}>
              На координаторах
            </button>
          </div>
        </section>

        <section>
          <h3>Джарвис и ИИ-помощник</h3>
          <label className="dset-check">
            <input type="checkbox" checked={d.jarvisEdit} onChange={(e) => setDash({ jarvisEdit: e.target.checked })} /> Джарвис может перестраивать дашборд: блоки, раскладку, стиль, фильтр, «покажи крупно»
          </label>
          <label className="dset-check">
            <input type="checkbox" checked={d.jarvis} onChange={(e) => setDash({ jarvis: e.target.checked })} /> Джарвис на отдельном экране стены (шар в углу, слушает команды)
          </label>
          <p className="dset-note">
            Примеры: «Джарвис, покажи только критические», «поменяй местами левый и правый блоки», «добавь карту», «убери ленту», «сделай стиль неон», «покажи крупно самый срочный», «раскладка ИИ-центр», «сделай крупнее», «верни как было». Он же выполняет задачи: «кому передать?», «передай», «возьми на меня». Чтобы он слушал без кнопки — включите «Джарвис управляет экраном» в общих настройках.
          </p>
        </section>

        </fieldset>
        <footer className="dset-f">
          <button className="dset-btn" onClick={() => setDash({ ...DEFAULT_DASH, columns: DEFAULT_DASH.columns.map((c) => ({ ...c })) })}>
            <RotateCcw size={14} /> Вернуть всё по умолчанию
          </button>
        </footer>
      </aside>
    </div>
  );
}

function StyleSwatch({ s, on }: { s: DashStyle; on: boolean }) {
  return (
    <button className={on ? 'on' : ''} onClick={() => setDash({ style: s.id })} title={s.name}>
      <span className="dset-sw" style={{ background: s.bg }}>
        <i style={{ background: s.panel, borderColor: s.line }}>
          <em style={{ background: s.crit }} />
          <em style={{ background: s.high }} />
          <em style={{ background: s.low }} />
        </i>
        <i style={{ background: s.panel, borderColor: s.line }}>
          <u style={{ background: s.text }} />
          <u style={{ background: s.muted }} />
        </i>
      </span>
      <span>
        {s.custom ? '✦ ' : ''}
        {s.name}
      </span>
    </button>
  );
}

/** Дизайн по описанию: ChatGPT придумывает стиль сразу или сначала задаёт уточняющие вопросы. */
// Разговор с ChatGPT о дизайне не пропадает, если закрыть и снова открыть настройки.
const keep = { mode: 'quick' as 'quick' | 'ask', chat: [] as DesignTurn[], options: [] as string[] };
function useKept<K extends keyof typeof keep>(k: K) {
  const [v, set] = useState(keep[k]);
  return [v, (x: (typeof keep)[K] | ((p: (typeof keep)[K]) => (typeof keep)[K])) => {
    const next = typeof x === 'function' ? (x as (p: (typeof keep)[K]) => (typeof keep)[K])(keep[k]) : x;
    keep[k] = next;
    set(next);
  }] as const;
}
function DesignBox() {
  const [text, setText] = useState('');
  const [mode, setMode] = useKept('mode');
  const [chat, setChat] = useKept('chat');
  const [options, setOptions] = useKept('options');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async (msg: string) => {
    if (!msg.trim() || busy) return;
    setBusy(true);
    setErr('');
    setOptions([]);
    const history = chat;
    setChat((c) => [...c, { role: 'user', content: msg }]);
    setText('');
    try {
      const r = await askDesign(msg, mode, history);
      if (r.kind === 'question') {
        setChat((c) => [...c, { role: 'assistant', content: r.question }]);
        setOptions(r.options);
      } else {
        applyDesign(r);
        setChat((c) => [...c, { role: 'assistant', content: `Готово: «${r.style.name}». ${r.note}` }]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  return (
    <div className="dset-design">
      <div className="dset-row">
        <Sparkles size={15} />
        <b>Дизайн по описанию — ChatGPT</b>
        <span style={{ flex: 1 }} />
        <button className={`dset-btn ${mode === 'quick' ? 'on' : ''}`} onClick={() => setMode('quick')} title="Сразу делает оформление по одному описанию">
          Одним запросом
        </button>
        <button className={`dset-btn ${mode === 'ask' ? 'on' : ''}`} onClick={() => setMode('ask')} title="Сначала задаст 1–2 уточняющих вопроса">
          С уточнениями
        </button>
      </div>
      {chat.length > 0 && (
        <div className="dset-chat">
          {chat.map((m, k) => (
            <div key={k} className={`dset-msg ${m.role}`}>
              {m.content}
            </div>
          ))}
        </div>
      )}
      {options.length > 0 && (
        <div className="dset-opts">
          {options.map((o) => (
            <button key={o} className="dset-btn" onClick={() => void send(o)} disabled={busy}>
              {o}
            </button>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={chat.length ? 'Ответьте или уточните…' : 'Например: строго и по-деловому, тёмно-синий с бирюзой, крупные цифры. Или: новогодняя стена с золотом и снегом.'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(text);
        }}
        disabled={busy}
      />
      <div className="dset-row">
        <button className="dset-btn on" onClick={() => void send(text)} disabled={busy || !text.trim()}>
          <Sparkles size={14} /> {busy ? 'ChatGPT думает…' : chat.length ? 'Отправить' : 'Придумать оформление'}
        </button>
        {chat.length > 0 && (
          <button
            className="dset-btn"
            onClick={() => {
              setChat([]);
              setOptions([]);
            }}
            disabled={busy}
          >
            Заново
          </button>
        )}
        {err && <span className="dset-err">{err}</span>}
      </div>
    </div>
  );
}
