// «Сценарий для жюри»: одна кнопка — и за пару минут разыгрывается весь путь инцидента.
// Сбой в Сибири → жалобы на карте → ИИ собирает инцидент → тревога и объявление Джарвиса →
// дежурного играет другой ИИ (своя модель и свой голос) и говорит с Джарвисом: что случилось, объясни, кому дать, выдай →
// команда берёт и решает → ИИ пишет разбор. Всё по-настоящему: те же данные и действия, что у живого дежурного.
import { useEffect, useRef, useState } from 'react';
import { Bot, Clapperboard, Square, UserRound } from 'lucide-react';
import type { Incident, Review } from '../../shared/types';
import { getState, select, setReplay, setTab } from '../store';
import { jarvisAsk, jarvisPrefs, jarvisSpeak, say, setScenarioMode, stopVoice, unlockJarvisAudio } from './Jarvis';

const STEPS = ['Абоненты жалуются', 'ИИ собрал инцидент — тревога', 'Дежурный спрашивает Джарвиса', 'Джарвис показывает и объясняет', 'Кому передать — советует ИИ', 'Дежурный решает — Джарвис выполняет', 'Команда берёт и решает', 'ИИ пишет разбор'];
const ACTOR_VOICE = (jarvisVoice: string) => (jarvisVoice === 'el-matilda' ? 'el-brian' : 'el-matilda'); // голос ИИ-дежурного — не как у Джарвиса
// Цель каждой реплики задана, формулировку выбирает ИИ-дежурный. В последнем шаге — точное название команды из совета ИИ.
const DIALOG: [step: number, goal: (team: string) => string, fallback: (team: string) => string][] = [
  [2, () => 'спросить у Джарвиса, что случилось', () => 'Джарвис, что случилось?'],
  [3, () => 'попросить открыть этот инцидент и коротко объяснить ситуацию', () => 'Открой его и объясни ситуацию.'],
  [4, () => 'спросить, кому из команд можно передать этот инцидент', () => 'Кому можно его дать?'],
  [5, (t) => `подтвердить наивысший уровень и сказать передать инцидент команде «${t}» (именно команде, не дежурному)`, (t) => `Подтверди наивысший и передай команде «${t}».`],
];

export const startScenario = () => window.dispatchEvent(new Event('radar:scenario'));

class Stop extends Error {}
const post = async <T,>(url: string, body: unknown): Promise<T> => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? 'ошибка');
  return data;
};

export function Scenario() {
  const [st, setSt] = useState<{ step: number; note: string; who?: 'actor' | 'jarvis'; line?: string; done?: boolean; err?: string } | null>(null);
  const running = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    const go = () => void run();
    window.addEventListener('radar:scenario', go);
    return () => window.removeEventListener('radar:scenario', go);
  }, []);

  const wait = (ms: number) =>
    new Promise<void>((ok, fail) => {
      const t0 = Date.now();
      const tick = () => (stopped.current ? fail(new Stop()) : Date.now() - t0 >= ms ? ok() : setTimeout(tick, 200));
      tick();
    });
  const check = () => {
    if (stopped.current) throw new Stop();
  };

  async function run() {
    if (running.current) return;
    running.current = true;
    stopped.current = false;
    unlockJarvisAudio();
    setScenarioMode(true);
    try {
      // 1. Сбой — жалобы идут на карту.
      setSt({ step: 0, note: 'Мобильный интернет падает в Новосибирской, Омской и Томской областях — жалобы абонентов идут на карту.' });
      setReplay(null);
      setTab('map');
      const start = await post<{ startedAt: number; regionIds: string[] }>('/api/demo/scenario', { step: 'start' });
      let inc: Incident | undefined;
      for (let t = 0; t < 90 && !inc; t++) {
        await wait(1000);
        inc = [...getState().incidents.values()].find((i) => i.origin === 'complaints' && i.service === 'Мобильный интернет' && i.status === 'coordinators' && (i.regionIds ?? []).some((r) => start.regionIds.includes(r)) && i.createdAt >= start.startedAt - 60_000);
      }
      if (!inc) throw new Error('ИИ ещё не собрал инцидент — попробуйте запустить сценарий ещё раз');
      // 2. Инцидент собран — ждём, пока жалобы наберут «Наивысший», тревога и объявление.
      setSt({ step: 1, note: 'ИИ заметил всплеск, собрал жалобы в инцидент и поднимает тревогу.' });
      for (let t = 0; t < 40; t++) {
        const cur = getState().incidents.get(inc.id);
        if (cur?.p1Proposal || cur?.priority === 'P1' || (cur?.regionIds?.length ?? 0) >= 3) break;
        await wait(1000);
      }
      inc = getState().incidents.get(inc.id) ?? inc;
      window.dispatchEvent(new CustomEvent('radar:alarm-for', { detail: inc.id }));
      await wait(1800);
      const brief = await fetch(`/api/jarvis/brief/${inc.id}`)
        .then((r) => r.json() as Promise<{ text: string }>)
        .then((d) => d.text)
        .catch(() => `Сэр, критический инцидент: ${inc!.title}.`);
      setSt({ step: 1, note: 'Джарвис объявляет голосом, что случилось.', who: 'jarvis', line: brief });
      await jarvisSpeak(brief, inc.id);
      check();
      // 3–6. Дежурного играет другой ИИ.
      let last = brief;
      // Команда из совета ИИ — чтобы ИИ-дежурный передал именно ей.
      const route = await fetch(`/api/incidents/${inc.id}/route`)
        .then((r) => r.json() as Promise<{ picks: { teamId: string }[] }>)
        .catch(() => null);
      const team = (route?.picks[0] && getState().teamIndex.get(route.picks[0].teamId)?.name) || 'Центр управления сетью · СФО';
      for (const [step, goalOf, fallbackOf] of DIALOG) {
        const goal = goalOf(team);
        const fallback = fallbackOf(team);
        check();
        setSt({ step, note: 'ИИ-дежурный формулирует реплику…', who: 'actor' });
        const line = await post<{ text: string }>('/api/demo/scenario', { step: 'actor', goal, last, fallback })
          .then((d) => d.text)
          .catch(() => fallback);
        check();
        setSt({ step, note: STEPS[step], who: 'actor', line });
        await say(line, { voice: ACTOR_VOICE(jarvisPrefs.voice), asJarvis: false });
        check();
        setSt({ step, note: 'Джарвис отвечает и действует на экране.', who: 'jarvis' });
        last = (await jarvisAsk(line)) || last;
        check();
        setSt({ step, note: STEPS[step], who: 'jarvis', line: last });
        await wait(900);
      }
      // Если после разговора инцидент всё ещё на пункте — дежурный дожимает одной репликой.
      if (getState().incidents.get(inc.id)?.status === 'coordinators') {
        const line = `Да, передай команде «${team}».`;
        setSt({ step: 5, note: STEPS[5], who: 'actor', line });
        await say(line, { voice: ACTOR_VOICE(jarvisPrefs.voice), asJarvis: false });
        check();
        setSt({ step: 5, note: 'Джарвис отвечает и действует на экране.', who: 'jarvis' });
        last = (await jarvisAsk(line)) || last;
        setSt({ step: 5, note: STEPS[5], who: 'jarvis', line: last });
        await wait(900);
      }
      // 7. Команда берёт и решает.
      const routed = getState().incidents.get(inc.id);
      if (routed && routed.status !== 'coordinators') {
        setSt({ step: 6, note: `Команда «${routed.teamId ? getState().teamIndex.get(routed.teamId)?.name : ''}» берёт инцидент в работу…` });
        setTab('teams');
        select(inc.id);
        await post('/api/demo/scenario', { step: 'team', id: inc.id }).catch(() => undefined);
        await wait(5000);
        setSt({ step: 6, note: 'Команда устранила причину — жалобы прекратились.' });
        await post('/api/demo/scenario', { step: 'resolve', id: inc.id }).catch(() => undefined);
        await wait(2500);
        // 8. Разбор.
        setSt({ step: 7, note: 'ИИ пишет разбор по истории инцидента.' });
        select(inc.id);
        setTab('reviews');
        const rv = await fetch(`/api/reviews/${inc.id}`).then((r) => (r.ok ? (r.json() as Promise<Review>) : null)).catch(() => null);
        check();
        const end = rv ? `Разбор готов, сэр. ${rv.summary}` : 'Инцидент решён, сэр. Разбор — на вкладке «Разборы».';
        setSt({ step: 7, note: 'Разбор готов — его можно скопировать и отправить.', who: 'jarvis', line: end });
        await jarvisSpeak(end, inc.id);
      } else {
        setSt({ step: 6, note: 'Инцидент ещё на пункте — передайте его команде в карточке, сценарий завершён.' });
      }
      setSt((s) => (s ? { ...s, done: true } : s));
      await wait(6000).catch(() => undefined);
      setSt(null);
    } catch (e) {
      if (e instanceof Stop) setSt(null);
      else setSt((s) => ({ step: s?.step ?? 0, note: s?.note ?? '', err: e instanceof Error ? e.message : String(e) }));
    } finally {
      running.current = false;
      setScenarioMode(false);
    }
  }

  if (!st) return null;
  return (
    <div className={`scn ${st.done ? 'done' : ''}`} role="status" aria-live="polite">
      <div className="scn-top">
        <Clapperboard size={15} />
        <b>Сценарий для жюри</b>
        <span className="num muted">
          {Math.min(st.step + 1, STEPS.length)} / {STEPS.length}
        </span>
        <span className="scn-sp" />
        <button
          className="icon-btn"
          onClick={() => {
            stopped.current = true;
            stopVoice();
            setSt(null);
          }}
          title="Остановить сценарий"
          aria-label="Остановить сценарий"
        >
          <Square size={13} />
        </button>
      </div>
      <div className="scn-steps">
        {STEPS.map((s, k) => (
          <i key={s} className={k < st.step ? 'ok' : k === st.step ? 'on' : ''} title={s} />
        ))}
      </div>
      <div className="scn-title">{st.done ? 'Готово: инцидент прошёл весь путь' : STEPS[st.step]}</div>
      <div className="scn-note">{st.err ?? st.note}</div>
      {st.line && (
        <div className={`scn-line ${st.who}`}>
          {st.who === 'actor' ? <UserRound size={14} /> : <Bot size={14} />}
          <span>
            <b>{st.who === 'actor' ? 'Дежурный (ИИ)' : 'Джарвис'}:</b> {st.line}
          </span>
        </div>
      )}
    </div>
  );
}
