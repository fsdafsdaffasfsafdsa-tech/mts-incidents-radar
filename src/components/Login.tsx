// Вход: роль → (команда) → кто вы → пароль. Сразу видно, кто сейчас на смене.
import { useEffect, useRef, useState } from 'react';
import { Headset, LogIn, Radar, Users, Wrench } from 'lucide-react';
import type { Person, Role } from '../../shared/types';
import { SCHEDULE_TEXT } from '../../shared/schedule';
import { doLogin, readLocal, writeLocal } from '../store';
import { Initials } from './ui';
import { Duty, isOn, shiftHint } from './kit';

const ROLES: { id: Role; title: string; hint: string; icon: typeof Radar }[] = [
  { id: 'coordinator', title: 'Дежурный пункта', hint: 'ведёт инциденты, передаёт командам', icon: Headset },
  { id: 'engineer', title: 'Сотрудник команды', hint: 'решает инциденты команды', icon: Wrench },
  { id: 'lead', title: 'Руководитель команды', hint: 'назначает в команде, видит сигналы', icon: Users },
];

type LoginPerson = Person & { teamName: string };

export function Login() {
  const last = readLocal<{ role: Role; login: string; team?: { id: string; name: string } } | null>('radar.lastLogin2', null);
  const [role, setRole] = useState<Role>(last?.role ?? 'coordinator');
  const [team, setTeam] = useState<{ id: string; name: string } | null>(last?.team ?? null);
  const [teamQ, setTeamQ] = useState('');
  const [teams, setTeams] = useState<{ id: string; name: string; schedule: Person['schedule'] }[]>([]);
  const [people, setPeople] = useState<LoginPerson[]>([]);
  const [login, setLogin] = useState(last?.login ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pass = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const teamRole = role === 'engineer' || role === 'lead';

  useEffect(() => {
    if (!teamRole) return;
    const t = setTimeout(() => {
      void fetch(`/api/login-teams?q=${encodeURIComponent(teamQ)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setTeams);
    }, 200);
    return () => clearTimeout(t);
  }, [teamQ, teamRole]);

  useEffect(() => {
    if (teamRole && !team) return setPeople([]);
    const qs = new URLSearchParams({ role, ...(teamRole && team ? { team: team.id } : {}) });
    void fetch(`/api/login-people?${qs}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: LoginPerson[]) => {
        const sorted = list.sort((a, b) => Number(isOn(b, Date.now())) - Number(isOn(a, Date.now())) || a.crew - b.crew);
        setPeople(sorted);
        if (!sorted.some((p) => p.id === login)) setLogin(sorted.find((p) => isOn(p, Date.now()))?.id ?? sorted[0]?.id ?? '');
      });
  }, [role, team?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!login || !password || busy) return;
    setBusy(true);
    setError(null);
    const err = await doLogin(login, password);
    setBusy(false);
    if (err) {
      setError(err);
      setPassword('');
      pass.current?.focus();
    } else writeLocal('radar.lastLogin2', { role, login, team: team ?? undefined });
  };

  return (
    <div className="login">
      <form className="login-card wide" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark">
            <Radar size={20} />
          </span>
          <div>
            <b>Координирующий пункт ИТ</b>
            <span className="muted">жалобы → инциденты → команды</span>
          </div>
        </div>

        <div className="role-tiles three" role="radiogroup" aria-label="Роль">
          {ROLES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={role === r.id} className={`role-tile ${role === r.id ? 'on' : ''}`} onClick={() => setRole(r.id)}>
              <r.icon size={20} />
              <b>{r.title}</b>
              <span>{r.hint}</span>
            </button>
          ))}
        </div>

        {teamRole && (
          <div className="team-pick">
            {team ? (
              <div className="tp-chosen">
                <b>{team.name}</b>
                <button type="button" className="link" onClick={() => setTeam(null)}>
                  сменить команду
                </button>
              </div>
            ) : (
              <>
                <input className="login-search" placeholder="Ваша команда: «Радиосеть · Новосибирская», «Мой МТС», «KION»…" value={teamQ} onChange={(e) => setTeamQ(e.target.value)} aria-label="Поиск команды" />
                <div className="tp-list">
                  {teams.map((t) => (
                    <button key={t.id} type="button" onClick={() => setTeam({ id: t.id, name: t.name })}>
                      <b>{t.name}</b>
                      <span className="muted">{SCHEDULE_TEXT[t.schedule]}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {(!teamRole || team) && (
          <div className="who-list" role="listbox" aria-label="Учётная запись">
            {people.map((p) => (
              <button key={p.id} type="button" role="option" aria-selected={login === p.id} className={`who-item ${login === p.id ? 'on' : ''}`} onClick={() => (setLogin(p.id), setTimeout(() => pass.current?.focus(), 0))}>
                <Initials name={p.name} />
                <span>
                  <b>{p.name}</b>
                  <span className="muted">
                    {p.spec ?? p.id} · {shiftHint(p, now)}
                  </span>
                </span>
                <Duty on={isOn(p, now)} />
              </button>
            ))}
            {!people.length && <div className="empty">Нет учётных записей</div>}
          </div>
        )}

        <label className="login-field">
          <span>Пароль</span>
          <input ref={pass} type="password" aria-label="Пароль" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary login-go" type="submit" disabled={!login || !password || busy}>
          <LogIn size={16} /> {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
