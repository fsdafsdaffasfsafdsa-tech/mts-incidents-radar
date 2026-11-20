import { useEffect, useRef, useState } from 'react';
import { FileJson, FlaskConical, LogOut, Moon, Sun, Volume2, VolumeX } from 'lucide-react';
import { demoAuto, demoOutage, doLogout, teamName, toggleSound, toggleTheme, useStore } from '../store';
import { fmtClockSec } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Initials } from './ui';
import { ROLE_TEXT } from './kit';

const SCENARIOS: { title: string; service: string; regions: string[]; perSec: number }[] = [
  { title: 'Нет мобильного интернета · Новосибирская обл.', service: 'Мобильный интернет', regions: ['nsk'], perSec: 0.8 },
  { title: 'Не проходят звонки · Краснодарский край', service: 'Мобильная связь', regions: ['krd'], perSec: 0.7 },
  { title: 'Мой МТС не открывается · Москва и Петербург', service: 'Мой МТС', regions: ['msk', 'spb'], perSec: 0.7 },
  { title: 'Не проходит оплата · три региона (ИИ предложит P1)', service: 'Оплата и баланс', regions: ['msk', 'svr', 'tat'], perSec: 1.4 },
];

export function TopBar() {
  const connected = useStore((s) => s.connected);
  const sound = useStore((s) => s.sound);
  const theme = useStore((s) => s.theme);
  const me = useStore((s) => s.me);
  const source = useStore((s) => s.config?.source ?? '');
  const now = useNow(1000);
  const [demo, setDemo] = useState(false);
  const [auto, setAuto] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const atPoint = me?.role === 'coordinator' || me?.role === 'commander';

  useEffect(() => {
    if (!demo) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setDemo(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [demo]);

  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="16" r="11" className="ring1" />
          <circle cx="16" cy="16" r="6" className="ring2" />
          <g className="sweep">
            <path d="M16 16 L16 4 A12 12 0 0 1 26.4 10 Z" />
          </g>
          <circle cx="16" cy="16" r="2.4" className="core" />
        </svg>
        <div className="brand-name">{atPoint ? 'Координирующий пункт' : teamName(me?.teamId)}</div>
      </div>



      <div className="topbar-spacer" />

      {atPoint && (
        <span className={`src-chip ${source.startsWith('ошибка') ? 'bad' : ''}`} title={`Выгрузка ITSM: ${source}`}>
          <FileJson size={14} />
          <span>{source.startsWith('ошибка') ? 'ошибка выгрузки' : 'ITSM'}</span>
        </span>
      )}
      <div className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Поток подключён' : 'Нет связи'}>
        <span className="live-dot" />
        <span className="live-text">{connected ? 'LIVE' : 'нет связи'}</span>
      </div>

      {atPoint && (
        <div className="demo-wrap" ref={ref}>
          <button className={`tb-btn ${demo ? 'active' : ''}`} onClick={() => setDemo((v) => !v)} title="Демо: сбои">
            <FlaskConical size={16} />
            <span>Демо</span>
          </button>
          {demo && (
            <div className="popover demo-pop">
              <div className="demo-h">Устроить сбой — пойдут жалобы</div>
              {SCENARIOS.map((s) => (
                <button
                  key={s.title}
                  className="scenario"
                  onClick={() => {
                    demoOutage(s.service, s.regions, 7, s.perSec);
                    setDemo(false);
                  }}
                >
                  <b>{s.title}</b>
                </button>
              ))}
              <label className="chk">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => {
                    setAuto(e.target.checked);
                    demoAuto(e.target.checked);
                  }}
                />
                случайные сбои раз в 3–7 минут
              </label>
            </div>
          )}
        </div>
      )}
      <button className={`tb-icon ${sound ? '' : 'muted'}`} onClick={toggleSound} aria-label="Звук">
        {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
      </button>
      <button className="tb-icon" onClick={toggleTheme} aria-label="Тема">
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <div className="clock num" title="Московское время">
        {fmtClockSec(now)} <span className="muted">МСК</span>
      </div>
      {me && (
        <div className="user-chip" title={`${me.name} · ${me.login}`}>
          <Initials name={me.name} />
          <span className="user-name">
            {me.name}
            <span className="muted">{ROLE_TEXT[me.role]}</span>
          </span>
          <button className="tb-icon" onClick={() => void doLogout()} aria-label="Выйти" title="Выйти">
            <LogOut size={16} />
          </button>
        </div>
      )}
    </header>
  );
}
