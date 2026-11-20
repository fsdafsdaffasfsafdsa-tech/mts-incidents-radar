// Справочник команд (~900): направления, регионы, графики, кто на смене. Пункт знает, куда отправить.
import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Person, Team } from '../../shared/types';
import { SCHEDULE_TEXT, fmtTz, onDuty } from '../../shared/schedule';
import { fetchTeam, teamName, useStore } from '../store';
import { useNow } from '../lib/hooks';
import { PersonRow, isOn } from './kit';

/** Команда работает сейчас по своему графику (без учёта отдельных людей). */
export const teamOpen = (t: Team, now: number) =>
  t.schedule === '24/7' || (t.schedule === '8-22' ? onDuty('8-22', 0, t.tz, now) || onDuty('8-22', 1, t.tz, now) : onDuty('5/2', 0, t.tz, now));

export function Directory() {
  const teams = useStore((s) => s.teams);
  const regions = useStore((s) => s.regions);
  const load = useStore((s) => s.load);
  const now = useNow(60_000);
  const dirQuery = useStore((s) => s.dirQuery);
  const [q, setQ] = useState(dirQuery);
  useEffect(() => setQ(dirQuery), [dirQuery]);
  const [dir, setDir] = useState('');
  const [region, setRegion] = useState('');
  const [sched, setSched] = useState('');
  const [openNow, setOpenNow] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const directions = useMemo(() => [...new Set(teams.map((t) => t.direction))].sort(), [teams]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return teams.filter(
      (t) =>
        t.id !== 'kp' &&
        (!s || t.name.toLowerCase().includes(s) || t.services.some((x) => x.toLowerCase().includes(s))) &&
        (!dir || t.direction === dir) &&
        (!region || t.regionId === region || (region.startsWith('d:') && t.district === region.slice(2))) &&
        (!sched || t.schedule === sched) &&
        (!openNow || teamOpen(t, now)),
    );
  }, [teams, q, dir, region, sched, openNow, now]);
  const total = teams.length - 1;
  const allDay = teams.filter((t) => t.schedule === '24/7').length;
  return (
    <div className="directory">
      <section className="panel dir-list">
        <header className="pl-head">
          <h2>Справочник команд</h2>
          <span className="muted">
            {total} команд · круглосуточно {allDay} · сейчас работают {teams.filter((t) => t.id !== 'kp' && teamOpen(t, now)).length}
          </span>
        </header>
        <div className="dir-filters">
          <label className="dir-q">
            <Search size={15} />
            <input placeholder="Команда или сервис: «Биллинг», «Новосибирск», «KION»…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <select className="fsel" value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="">Все направления</option>
            {directions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select className="fsel" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Все регионы</option>
            {['cfo', 'szfo', 'yufo', 'skfo', 'pfo', 'ufo', 'sfo', 'dfo'].map((d) => (
              <option key={d} value={`d:${d}`}>
                — округ {d.toUpperCase()}
              </option>
            ))}
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select className="fsel" value={sched} onChange={(e) => setSched(e.target.value)}>
            <option value="">Любой график</option>
            <option value="24/7">Круглосуточно</option>
            <option value="8-22">08–22</option>
            <option value="5/2">Пн–пт 09–18</option>
          </select>
          <label className="chk">
            <input type="checkbox" checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} /> работают сейчас
          </label>
        </div>
        <div className="dir-rows">
          <div className="dr head">
            <span>Команда</span>
            <span>Сервисы</span>
            <span>График</span>
            <span>Сейчас</span>
          </div>
          {list.slice(0, 300).map((t) => {
            const open = teamOpen(t, now);
            return (
              <div key={t.id} className={`dr ${sel === t.id ? 'sel' : ''}`} role="button" tabIndex={0} onClick={() => setSel(t.id)} onKeyDown={(e) => e.key === 'Enter' && setSel(t.id)}>
                <span>
                  <b>{t.name}</b>
                  <span className="muted">
                    {t.direction}
                    {t.itsm ? ' · из выгрузки ITSM' : ''}
                  </span>
                </span>
                <span className="muted">{t.services.join(', ') || '—'}</span>
                <span>
                  {SCHEDULE_TEXT[t.schedule]} <span className="muted">{fmtTz(t.tz)}</span>
                </span>
                <span>
                  <span className={`duty ${open ? 'on' : 'off'}`}>{open ? 'работает' : 'не работает'}</span>
                  {load[t.id] ? <span className="tag">в работе {load[t.id]}</span> : null}
                </span>
              </div>
            );
          })}
          {list.length > 300 && <div className="empty">Показаны первые 300 из {list.length} — уточните поиск</div>}
        </div>
      </section>
      {sel ? <TeamCard id={sel} onClose={() => setSel(null)} /> : <section className="panel empty-panel">Выберите команду — покажем состав и графики</section>}
    </div>
  );
}

function TeamCard({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ team: Team; members: Person[] } | null>(null);
  const now = useNow(30_000);
  useEffect(() => {
    setData(null);
    void fetchTeam(id).then(setData);
  }, [id]);
  if (!data) return <section className="panel empty-panel">Загружаем…</section>;
  const { team, members } = data;
  const on = members.filter((p) => p.role === 'engineer' && isOn(p, now)).length;
  return (
    <section className="panel team-card">
      <header className="pl-head">
        <h2>{team.name}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <X size={16} />
        </button>
      </header>
      <dl className="kv">
        <dt>Направление</dt>
        <dd>{team.direction}</dd>
        <dt>Сервисы</dt>
        <dd>{team.services.join(', ') || '—'}</dd>
        <dt>График</dt>
        <dd>
          {SCHEDULE_TEXT[team.schedule]}, местное время {fmtTz(team.tz)}
        </dd>
        <dt>Сейчас на смене</dt>
        <dd>
          {on} из {members.filter((p) => p.role === 'engineer').length}
        </dd>
        {team.backupId && (
          <>
            <dt>Если не работает</dt>
            <dd>передаём в «{teamName(team.backupId)}»</dd>
          </>
        )}
      </dl>
      <h3 className="cm-h">Состав и графики на сутки</h3>
      <div className="pl-rows">
        {members
          .sort((a, b) => Number(isOn(b, now)) - Number(isOn(a, now)) || a.crew - b.crew)
          .map((p) => (
            <PersonRow key={p.id} p={p} now={now} />
          ))}
      </div>
    </section>
  );
}
