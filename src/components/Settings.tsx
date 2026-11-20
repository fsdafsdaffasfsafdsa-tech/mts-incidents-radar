// Настройки рабочего места: тема экрана, звуковое сопровождение (набор, громкость, события), анимации.
// Сохраняются в этом браузере — у каждого дежурного свои.
import { useEffect, useState } from 'react';
import { Check, Play, Settings2, Volume2, VolumeX, X } from 'lucide-react';
import { CUE_TEXT, SOUND_PACKS, type Cue } from '../lib/sound';
import { HOT_ACTIONS, keyLabel, type HotAction } from '../lib/hotkeys';
import { THEMES } from '../lib/themes';
import { JarvisSettings } from './Jarvis';
import { previewCue, resetHotkeys, setAlarmOn, setHotkey, setHotkeysOn, setMotion, setSettings, setSkin, setSoundEvent, setSoundPack, setVolume, toggleSound, useStore } from '../store';

const CUES: Cue[] = ['p1', 'coord', 'warn', 'request', 'resolved'];

export function Settings() {
  const open = useStore((s) => s.settings);
  const skin = useStore((s) => s.skin);
  const sound = useStore((s) => s.sound);
  const pack = useStore((s) => s.soundPack);
  const volume = useStore((s) => s.volume);
  const events = useStore((s) => s.soundEvents);
  const motion = useStore((s) => s.motion);
  const alarmOn = useStore((s) => s.alarmOn);
  const role = useStore((s) => s.me?.role);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setSettings(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-back" onClick={() => setSettings(false)}>
      <div className="settings" role="dialog" aria-label="Настройки" onClick={(e) => e.stopPropagation()}>
        <header>
          <Settings2 size={18} />
          <h2>Настройки</h2>
          <span className="muted">сохраняются в этом браузере</span>
          <button className="icon-btn" onClick={() => setSettings(false)} aria-label="Закрыть">
            <X size={16} />
          </button>
        </header>

        <section>
          <h3>Тема экрана</h3>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button key={t.id} className={`theme-card ${skin === t.id ? 'on' : ''}`} onClick={() => setSkin(t.id)} aria-pressed={skin === t.id}>
                <span className="theme-prev" style={{ background: t.swatch[0] }}>
                  <span className="tp-panel" style={{ background: t.swatch[1], color: t.swatch[2] }}>
                    <i style={{ background: t.swatch[2] }} />
                    <i style={{ background: t.swatch[2], opacity: 0.45 }} />
                    <span className="tp-dots">
                      <b style={{ background: t.swatch[3] }} />
                      <b style={{ background: t.swatch[4] }} />
                    </span>
                  </span>
                </span>
                <span className="theme-name">
                  {skin === t.id && <Check size={13} />} {t.name}
                </span>
                <span className="muted">{t.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>
            Звуковое сопровождение
            <button className={`btn btn-sm ${sound ? '' : 'btn-ghost'}`} onClick={toggleSound}>
              {sound ? <Volume2 size={14} /> : <VolumeX size={14} />} {sound ? 'Включено' : 'Выключено'}
            </button>
          </h3>
          <div className={`sound-body ${sound ? '' : 'off'}`}>
            <div className="pack-grid">
              {SOUND_PACKS.map((p) => (
                <button key={p.id} className={`pack-card ${pack === p.id ? 'on' : ''}`} onClick={() => setSoundPack(p.id)} title="Выбрать и прослушать">
                  <b>
                    <Play size={12} /> {p.name}
                  </b>
                  <span className="muted">{p.hint}</span>
                </button>
              ))}
            </div>
            <label className="vol">
              Громкость
              <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} onMouseUp={() => previewCue('coord')} />
              <span className="num">{Math.round(volume * 100)}%</span>
            </label>
            <div className="cue-list">
              {CUES.map((c) => (
                <div key={c} className="cue-row">
                  <label className="chk">
                    <input type="checkbox" checked={events[c]} onChange={(e) => setSoundEvent(c, e.target.checked)} />
                    {CUE_TEXT[c]}
                  </label>
                  <button className="icon-btn" onClick={() => previewCue(c)} aria-label={`Прослушать: ${CUE_TEXT[c]}`} title="Прослушать">
                    <Play size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {role === 'coordinator' && (
          <section>
            <h3>Тревога для критических</h3>
            <label className="chk">
              <input type="checkbox" checked={alarmOn} onChange={(e) => setAlarmOn(e.target.checked)} /> Новый критический инцидент или предложение ИИ поднять до «Наивысшего» — экран мигает красным и звучит сирена «БУУМ-БУУМ», пока кто-то не нажмёт «Принял»
            </label>
            <button className="btn btn-sm" onClick={() => (setSettings(false), window.dispatchEvent(new Event('radar:alarm-test')))}>
              Проверить тревогу
            </button>
          </section>
        )}
        {role === 'coordinator' && <JarvisSettings />}

        <HotkeySettings />

        <section>
          <h3>Анимации</h3>
          <label className="chk">
            <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} /> Плавные появления, пульс колец на карте, «подскок» счётчиков
          </label>
        </section>
      </div>
    </div>
  );
}

function HotkeySettings() {
  const on = useStore((s) => s.hotkeysOn);
  const keys = useStore((s) => s.hotkeys);
  const role = useStore((s) => s.me?.role);
  const [wait, setWait] = useState<HotAction | null>(null);
  useEffect(() => {
    if (!wait) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') setHotkey(wait, e.code === 'Backspace' || e.code === 'Delete' ? '' : e.code);
      setWait(null);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [wait]);
  return (
    <section>
      <h3>
        Горячие клавиши
        <label className="chk hk-on">
          <input type="checkbox" checked={on} onChange={(e) => setHotkeysOn(e.target.checked)} /> включены
        </label>
        <button className="btn btn-sm btn-ghost" onClick={resetHotkeys}>
          По умолчанию
        </button>
      </h3>
      <p className="muted hk-note">Нажмите на клавишу справа и затем новую. Backspace — снять, Esc — отмена. Работают на любой раскладке и не мешают, когда вы печатаете.</p>
      <div className={`hk-grid ${on ? '' : 'off'}`}>
        {HOT_ACTIONS.filter((a) => !a.point || role === 'coordinator').map((a) => (
          <div key={a.id} className="hk-row">
            <span>{a.text}</span>
            <button className={`hk-key ${wait === a.id ? 'wait' : ''}`} onClick={() => setWait(wait === a.id ? null : a.id)}>
              {wait === a.id ? 'нажмите клавишу…' : <kbd>{keyLabel(keys[a.id])}</kbd>}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
