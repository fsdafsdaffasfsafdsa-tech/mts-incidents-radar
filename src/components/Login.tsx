// Вход: роль → кто вы → пароль. Логин запоминается, чтобы утром входить в два касания.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Headset, LogIn, Radar, Truck, UserCog } from 'lucide-react';
import type { Me, Role } from '../../shared/types';
import { doLogin, readLocal, writeLocal } from '../store';
import { Initials } from './ui';

const ROLES: { id: Role; title: string; hint: string; icon: typeof Radar }[] = [
  { id: 'coordinator', title: 'Координатор', hint: 'распределяет задачи', icon: UserCog },
  { id: 'online', title: 'Онлайн-сотрудник', hint: 'решает удалённо', icon: Headset },
  { id: 'offline', title: 'Выездной', hint: 'едет на площадку', icon: Truck },
];

export function Login() {
  const last = readLocal<{ role: Role; login: string } | null>('radar.lastLogin', null);
  const [accounts, setAccounts] = useState<Me[]>([]);
  const [role, setRole] = useState<Role>(last?.role ?? 'coordinator');
  const [login, setLogin] = useState(last?.login ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const pass = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch('/api/accounts')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Me[]) => setAccounts(list));
  }, []);

  const people = useMemo(
    () => accounts.filter((a) => a.role === role && (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.login.includes(q.toLowerCase()))),
    [accounts, role, q],
  );

  // При смене роли подставляем первого из списка, если прежний логин к ней не относится.
  useEffect(() => {
    if (!accounts.length) return;
    const ok = accounts.some((a) => a.role === role && a.login === login);
    if (!ok) setLogin(accounts.find((a) => a.role === role)?.login ?? '');
  }, [role, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

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
    } else writeLocal('radar.lastLogin', { role, login });
  };

  const pick = (l: string) => {
    setLogin(l);
    setTimeout(() => pass.current?.focus(), 0);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark">
            <Radar size={20} />
          </span>
          <div>
            <b>Радар инцидентов</b>
            <span className="muted">МТС · ЮФО</span>
          </div>
        </div>

        <div className="role-tiles" role="radiogroup" aria-label="Роль">
          {ROLES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={role === r.id} className={`role-tile ${role === r.id ? 'on' : ''}`} onClick={() => setRole(r.id)}>
              <r.icon size={22} />
              <b>{r.title}</b>
              <span>{r.hint}</span>
            </button>
          ))}
        </div>

        {role !== 'coordinator' && accounts.length > 6 && (
          <input className="login-search" placeholder="Найти себя…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск по имени" />
        )}
        <div className={`who-list ${role === 'coordinator' ? 'short' : ''}`} role="listbox" aria-label="Учётная запись">
          {people.map((a) => (
            <button key={a.login} type="button" role="option" aria-selected={login === a.login} className={`who-item ${login === a.login ? 'on' : ''}`} onClick={() => pick(a.login)}>
              <Initials name={a.name} />
              <span>
                <b>{a.name}</b>
                <span className="muted">{a.login}</span>
              </span>
            </button>
          ))}
          {!people.length && <div className="empty">Нет учётных записей</div>}
        </div>

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
