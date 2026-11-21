// Шапка стены («главное»): крупно — то, что сейчас важнее всего (критические, иначе «срок горит»,
// иначе высокие, иначе «на пункте», иначе «спокойно»); остальные группы — маленькими значками;
// справа мини-счётчики и часы. Кнопок нет — на большом экране фильтры делает Джарвис голосом
// («покажи только критические»); щелчок мышью по группе — тоже фильтр.
import { CheckCircle2, Clapperboard, Flame, LayoutGrid, Network, Radar, RotateCcw, Siren, Timer, UserX, X, type LucideIcon } from 'lucide-react';
import { DASH_GROUPS, GROUP_NAME, type DashGroup, type DashSnapshot } from '../../../shared/dash';
import { openWork, setDash, type DashLayout } from '../../lib/dashLayout';
import { fmtClock } from '../../lib/format';
import { openHandover } from './handover';

const GROUPS: DashGroup[] = ['crit', 'coord', 'high', 'research'];
const GROUP_ICON: Record<DashGroup, LucideIcon> = { crit: Siren, coord: Network, high: Flame, research: Radar };
const GROUP_SHORT: Record<DashGroup, string> = { crit: 'Критические', coord: 'На координаторах', high: 'Высокий', research: 'Исследование' };
const hint = (g: DashGroup) => `${DASH_GROUPS.find((x) => x.id === g)!.hint}. Щелчок — только эта группа`;

type Hero = { g: DashGroup | 'threat' | 'calm'; n: number; word: string };
/** Что сейчас важнее всего показать крупно. */
function heroOf(c: DashSnapshot['counts']): Hero {
  if (c.crit > 0) return { g: 'crit', n: c.crit, word: 'критических' };
  if (c.threat > 0) return { g: 'threat', n: c.threat, word: 'срок горит' };
  if (c.high > 0) return { g: 'high', n: c.high, word: 'высоких' };
  if (c.coord > 0) return { g: 'coord', n: c.coord, word: 'на пункте' };
  return { g: 'calm', n: 0, word: 'спокойно' };
}

export function CounterHeader({ snap, now, d, home }: { snap: DashSnapshot; now: number; d: DashLayout; home?: boolean }) {
  const c = snap.counts;
  const hero = heroOf(c);
  const heroGroup = hero.g === 'threat' || hero.g === 'calm' ? null : hero.g;
  const HeroIcon = hero.g === 'threat' ? Timer : hero.g === 'calm' ? CheckCircle2 : GROUP_ICON[hero.g];
  const toggle = (g: DashGroup) => setDash({ filter: d.filter === g ? null : g });
  return (
    <header className="wh">
      <div
        className={`wh-hero h-${hero.g} ${heroGroup && d.filter === heroGroup ? 'sel' : ''}`}
        key={`${hero.g}:${hero.n}`}
        role={heroGroup ? 'button' : undefined}
        tabIndex={heroGroup ? 0 : undefined}
        onClick={heroGroup ? () => toggle(heroGroup) : undefined}
        title={heroGroup ? hint(heroGroup) : hero.g === 'threat' ? 'Срок под угрозой: меньше 30 минут или уже прошёл' : 'Критических нет, сроки не горят'}
      >
        <HeroIcon className="wh-hero-ic" />
        {hero.g !== 'calm' && <b className="num">{hero.n}</b>}
        <span>{hero.word}</span>
      </div>
      <div className="wh-chips">
        {GROUPS.filter((g) => g !== hero.g).map((g) => {
          const Icon = GROUP_ICON[g];
          return (
            <span key={g} role="button" tabIndex={0} className={`wh-chip g-${g} ${c[g] ? '' : 'zero'} ${d.filter === g ? 'sel' : ''}`} onClick={() => toggle(g)} title={`${GROUP_SHORT[g]}: ${c[g]}. ${hint(g)}`}>
              <Icon />
              <b className="num" key={c[g]}>
                {c[g]}
              </b>
            </span>
          );
        })}
      </div>
      <div className="wh-mini">
        <span className={`m-recur ${c.recur ? 'on' : ''}`} title="Решили, а жалобы снова идут">
          <RotateCcw />
          <b className="num">{c.recur}</b>
        </span>
        <span className={`m-sla ${c.threat ? 'on' : ''}`} title="Срок под угрозой: меньше 30 минут или уже прошёл">
          <Timer />
          <b className="num">{c.threat}</b>
        </span>
        <span className={`m-take ${c.notTaken ? 'on' : ''}`} title="Команда не берёт больше 10 минут">
          <UserX />
          <b className="num">{c.notTaken}</b>
        </span>
        <span className="m-ok on" title="Решено за последний час">
          <CheckCircle2 />
          <b className="num">{c.doneHour}</b>
        </span>
      </div>
      <span className="wh-video" role="button" tabIndex={0} onClick={openHandover} title="Видео пересменки: что было за смену, что добить и проследить (Ctrl+Shift+H)">
        <Clapperboard />
        <b>Пересменка</b>
      </span>
      <div className="wh-clock num">{fmtClock(now)}</div>
      {d.filter && (
        <span className="wh-filter" role="button" tabIndex={0} onClick={() => setDash({ filter: null })} title="Показать все группы (или скажите Джарвису)">
          {GROUP_NAME[d.filter]} <X size={14} />
        </span>
      )}
      {home && (
        <span className="wh-work" role="button" tabIndex={0} onClick={openWork} title="Рабочее место: вкладки, карточки инцидентов, справочник">
          <LayoutGrid />
        </span>
      )}
    </header>
  );
}
