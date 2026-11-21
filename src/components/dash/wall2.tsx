// Видеостена по предложению ChatGPT: меньше текста — пиктограммы, цвет, анимация; читаемо с 3 метров.
// Здесь общие помощники (пиктограмма сервиса, «Сервис · Город», аватар команды) и блоки:
// избранное. Шапка — в header.tsx, почта — в mail.tsx, команды — в teams.tsx, Джарвис — в jarvisBlock.tsx.
import {
  AppWindow,
  Bell,
  Building2,
  CheckCircle2,
  CreditCard,
  Inbox,
  Landmark,
  Mail,
  MessageSquare,
  Music,
  Network,
  RadioTower,
  Router,
  Server,
  Smartphone,
  Star,
  Tv,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { Incident } from '../../../shared/types';
import { teamName } from '../../store';
import { fmtClock } from '../../lib/format';
import { BlockHead, type BlockCtx } from './Dashboard';

// ─── общее ────────────────────────────────────────────────────────────────
const SERVICE_ICON: [RegExp, LucideIcon][] = [
  [/мобильный интернет/i, Wifi],
  [/мобильная связь/i, RadioTower],
  [/домашний интернет/i, Router],
  [/домашнее тв|kion/i, Tv],
  [/мой мтс|приложени/i, Smartphone],
  [/оплата|баланс|billing|биллинг/i, CreditCard],
  [/банк/i, Landmark],
  [/sms|смс/i, MessageSquare],
  [/music|музык/i, Music],
  [/личный кабинет/i, AppWindow],
  [/b2b|корпоратив/i, Building2],
  [/письмо|почт/i, Mail],
  [/сеть|network|радио/i, Network],
];
/** Пиктограмма сервиса: вышка, роутер, телевизор, карта… — по сервису и названию. */
export const serviceIcon = (i: Incident): LucideIcon => SERVICE_ICON.find(([re]) => re.test(`${i.service} ${i.title}`))?.[1] ?? Server;
/** «Жалобы: Мобильный интернет · Сургут» → сервис и место. */
export function splitTitle(i: Incident): { name: string; place: string } {
  const m = /^Жалобы:\s*(.+?)\s*·\s*(.+)$/.exec(i.title);
  if (m) return { name: m[1], place: m[2] };
  const w = /^Письмо:\s*(.+)$/.exec(i.title);
  return { name: w ? w[1] : i.title, place: '' };
}
/** «Москва, Белгород, Тула» → «Москва +2». */
export const shortPlace = (place: string) => {
  const parts = place.split(/,\s*/).filter(Boolean);
  return parts.length > 2 ? `${parts[0]} +${parts.length - 1}` : place;
};
/** Одна строка: «Сервис · Город». */
export const oneLine = (i: Incident) => {
  const { name, place } = splitTitle(i);
  return place ? `${name} · ${shortPlace(place)}` : name;
};
const hue = (s: string) => [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
/** Аватар команды (или дежурного пункта): две буквы в цветном кружке, полное имя — подсказкой. */
export function TeamAvatar({ i }: { i: Incident }) {
  const name = i.status === 'coordinators' ? i.coordinatorName ?? '' : teamName(i.teamId);
  if (!name)
    return (
      <span className="tav none" title="На пункте, никто не ведёт">
        <Inbox size={14} />
      </span>
    );
  const letters = name
    .replace(/[«»"()]/g, '')
    .split(/[\s·—-]+/)
    .filter((w) => /^[A-ZА-ЯЁ0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
  return (
    <span className="tav" style={{ ['--h' as string]: hue(name) }} title={name}>
      {letters}
    </span>
  );
}

// ─── избранное смены — коротко ────────────────────────────────────────────
export function FavsBlock2({ ctx }: { ctx: BlockCtx }) {
  const list = ctx.snap.pinned;
  if (!list.length)
    return (
      <div className="db db-fav2 empty" title="Избранное пусто: закрепите важное звёздочкой на карточке">
        <BlockHead title="Избранное" icon={<Star size={18} />} />
        <Star className="fav2-empty" />
      </div>
    );
  return (
    <div className="db db-fav2">
      <BlockHead title="Избранное" count={list.length} icon={<Star size={18} />} />
      {list.slice(0, 3).map((i) => {
        const Icon = serviceIcon(i);
        const due = i.pin?.remindAt ?? null;
        return (
          <button key={i.id} className={`fav2-row p-${i.priority} ${i.status === 'resolved' ? 'done' : ''}`} onClick={() => ctx.open(i)} title={i.pin?.note ? `${i.title}\n«${i.pin.note}»` : i.title}>
            <Icon className="fav2-ic" />
            <b>{oneLine(i)}</b>
            {i.status === 'resolved' ? (
              <CheckCircle2 className="fav2-ok" />
            ) : due ? (
              <span className={`fav2-bell ${due <= ctx.now ? 'due' : ''}`}>
                <Bell size={16} /> {fmtClock(due)}
              </span>
            ) : null}
          </button>
        );
      })}
      {list.length > 3 && <span className="fav2-more">+{list.length - 3}</span>}
    </div>
  );
}
