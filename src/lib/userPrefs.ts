// Настройки закреплены за сотрудником: раскладка и стиль стены, персонаж, голос, «работа Джарвиса».
// При входе подтягиваются с сервера (на любом компьютере так же), любые изменения сохраняются обратно.
import { getDash, setDash, subscribeDash, type DashLayout } from './dashLayout';
import { jarvisPrefs, setJarvisPref, subscribeJarvisPrefs } from '../components/Jarvis';

type JarvisSaved = Partial<Pick<typeof jarvisPrefs, 'persona' | 'voice' | 'speak' | 'announce' | 'work'>>;
interface Saved {
  dash?: Partial<DashLayout>;
  jarvis?: JarvisSaved;
}
const JKEYS = ['persona', 'voice', 'speak', 'announce', 'work'] as const;

let stop: (() => void) | null = null;
let owner = '';

export async function startPrefsSync(login: string) {
  if (owner === login && stop) return;
  stop?.();
  stop = null;
  owner = login;
  let applying = true;
  try {
    const r = await fetch('/api/prefs');
    const saved = r.ok ? (((await r.json()) as { prefs: Saved | null }).prefs ?? null) : null;
    if (owner !== login) return;
    // версия — своя у сохранённой раскладки: старая (без версии) один раз переводится на новую базовую
    if (saved?.dash) setDash({ ...saved.dash, ver: saved.dash.ver ?? 0 });
    if (saved?.jarvis) for (const k of JKEYS) if (saved.jarvis[k] !== undefined && saved.jarvis[k] !== jarvisPrefs[k]) setJarvisPref(k, saved.jarvis[k] as never);
  } catch {
    /* без сети — живём настройками браузера */
  }
  applying = false;
  let timer = 0;
  const push = () => {
    if (applying) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const jarvis: JarvisSaved = {};
      for (const k of JKEYS) (jarvis as Record<string, unknown>)[k] = jarvisPrefs[k];
      const body: Saved = { dash: getDash(), jarvis };
      void fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: body }) }).catch(() => undefined);
    }, 1200);
  };
  const a = subscribeDash(push);
  const b = subscribeJarvisPrefs(push);
  stop = () => {
    a();
    b();
    clearTimeout(timer);
  };
}
export function stopPrefsSync() {
  stop?.();
  stop = null;
  owner = '';
}
