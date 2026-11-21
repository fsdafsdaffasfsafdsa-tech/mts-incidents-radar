// Стили дашборда (видеостены): 26 оформлений. Каждое — набор цветов и характер (шрифт, карточки, скругления).
// Один и тот же список видят стена (рисует) и Джарвис (может переключить по названию).
export type DashFont = 'sans' | 'mono' | 'cond' | 'serif';
export type DashCard = 'solid' | 'glass' | 'outline' | 'flat';
export interface DashStyle {
  id: string;
  name: string;
  words: string[]; // как его может назвать человек голосом
  dark: boolean;
  bg: string; // фон стены (можно градиент)
  panel: string;
  panel2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  crit: string;
  high: string;
  mid: string;
  low: string;
  ok: string;
  warn: string;
  font?: DashFont;
  card?: DashCard;
  radius?: number; // px
  glow?: boolean; // мягкое свечение у критических и цифр
  deco?: 'snow'; // украшения: снег и гирлянда (новогодняя тема)
  custom?: boolean; // придумано ИИ по описанию
}

export const DASH_STYLES: DashStyle[] = [
  { id: 'mts', name: 'МТС', words: ['мтс', 'фирменн', 'красн'], dark: false, bg: '#f2f3f7', panel: '#ffffff', panel2: '#f7f8fa', line: '#e2e5eb', text: '#1d2023', muted: '#626c77', accent: '#ff0032', crit: '#ff0032', high: '#fa8a00', mid: '#e5b800', low: '#007cff', ok: '#00b956', warn: '#fa8a00', radius: 16 },
  { id: 'mts-dark', name: 'МТС тёмный', words: ['мтс тёмн', 'мтс темн', 'тёмный мтс', 'темный мтс'], dark: true, bg: '#1d2023', panel: '#2c3135', panel2: '#343a40', line: '#434a51', text: '#fafafa', muted: '#a3abb5', accent: '#ff0032', crit: '#ff0032', high: '#ff9a1f', mid: '#f9d23c', low: '#45b6fe', ok: '#26cd58', warn: '#ff9a1f', radius: 16 },
  { id: 'newyear', name: 'Новогодний', words: ['новогодн', 'новый год', 'праздничн', 'ёлк', 'елк', 'зимн'], dark: true, bg: 'radial-gradient(1200px 600px at 20% -10%,#123a4a,transparent 60%),radial-gradient(900px 500px at 90% 110%,#3a0f1f,transparent 60%),#07141c', panel: 'rgba(10,32,42,.86)', panel2: 'rgba(16,46,58,.82)', line: 'rgba(255,214,120,.22)', text: '#f5f8ff', muted: '#a9c2cc', accent: '#ffd166', crit: '#ff4d5e', high: '#ff9a4a', mid: '#ffd166', low: '#6fc3ff', ok: '#4ade80', warn: '#ffb84a', card: 'glass', radius: 18, glow: true, deco: 'snow' },
  { id: 'focus', name: 'Фокус (стена)', words: ['фокус', 'для стены', 'читаем'], dark: true, bg: '#0B1019', panel: '#151E2D', panel2: '#1A2536', line: '#293548', text: '#F1F5F9', muted: '#AAB8CC', accent: '#4285FF', crit: '#FF5269', high: '#FFB547', mid: '#F2D16B', low: '#42C5F5', ok: '#37D9A0', warn: '#FFB547', radius: 14 },
  { id: 'graphite', name: 'Графит', words: ['графит', 'серый'], dark: true, bg: '#121418', panel: '#1b1e24', panel2: '#22262e', line: '#2c313b', text: '#eef1f6', muted: '#8b94a6', accent: '#ff4d5e', crit: '#ff4d5e', high: '#ff9640', mid: '#f2c94c', low: '#6c9bff', ok: '#33c48d', warn: '#ffb020', radius: 14 },
  { id: 'midnight', name: 'Полночь', words: ['полноч', 'синий ноч', 'тёмно-син', 'темно-син'], dark: true, bg: 'linear-gradient(160deg,#0b1020,#0e1630 60%,#0b1020)', panel: '#121a33', panel2: '#18224a', line: '#243163', text: '#e8edff', muted: '#8e9bc9', accent: '#5b8cff', crit: '#ff4a6b', high: '#ff9a4a', mid: '#ffd166', low: '#5b8cff', ok: '#3ddc97', warn: '#ffb347', radius: 16, glow: true },
  { id: 'mission', name: 'Центр управления', words: ['центр управлен', 'цуп', 'миссия', 'космическ центр'], dark: true, bg: 'radial-gradient(1200px 600px at 50% -10%,#0d2236,#05080d 70%)', panel: 'rgba(11,18,32,.92)', panel2: '#0f1a2e', line: '#1b3150', text: '#d8f1ff', muted: '#6f93b3', accent: '#39d0ff', crit: '#ff3b5c', high: '#ff9e3d', mid: '#ffe066', low: '#39d0ff', ok: '#2ee6a6', warn: '#ffb020', font: 'mono', card: 'outline', radius: 6, glow: true },
  { id: 'contrast', name: 'Высокий контраст', words: ['контраст'], dark: true, bg: '#000000', panel: '#000000', panel2: '#111111', line: '#ffffff', text: '#ffffff', muted: '#d0d0d0', accent: '#ffd400', crit: '#ff2a2a', high: '#ff9900', mid: '#ffd400', low: '#4da3ff', ok: '#00e676', warn: '#ffd400', card: 'outline', radius: 4 },
  { id: 'paper', name: 'Бумага', words: ['бумаг', 'газет'], dark: false, bg: '#f3eee3', panel: '#fffdf7', panel2: '#f7f2e6', line: '#e4dccb', text: '#2b2620', muted: '#7d7364', accent: '#b5401e', crit: '#c0301c', high: '#d9731a', mid: '#a88300', low: '#2f6db5', ok: '#2e8a57', warn: '#c77700', font: 'serif', radius: 6 },
  { id: 'terminal', name: 'Терминал', words: ['терминал', 'зелён', 'зелен', 'хакер', 'матриц'], dark: true, bg: '#020a04', panel: '#04140a', panel2: '#06200f', line: '#0f3d1d', text: '#7dffa0', muted: '#3fa860', accent: '#33ff66', crit: '#ff4d4d', high: '#ffb000', mid: '#d4ff4d', low: '#33ff66', ok: '#33ff66', warn: '#ffb000', font: 'mono', card: 'outline', radius: 2, glow: true },
  { id: 'amber', name: 'Янтарный монитор', words: ['янтар', 'ретро монитор'], dark: true, bg: '#0d0700', panel: '#160c00', panel2: '#201200', line: '#4a2c00', text: '#ffc04d', muted: '#b07a1e', accent: '#ffb000', crit: '#ff5533', high: '#ffb000', mid: '#ffd27a', low: '#e6a23c', ok: '#ffd27a', warn: '#ffb000', font: 'mono', card: 'outline', radius: 2, glow: true },
  { id: 'ocean', name: 'Океан', words: ['океан', 'море', 'бирюз'], dark: true, bg: 'linear-gradient(170deg,#04161b,#06252c)', panel: '#08262d', panel2: '#0b3139', line: '#124650', text: '#e2fbf8', muted: '#7fb5b0', accent: '#19c3b0', crit: '#ff5470', high: '#ff9f5a', mid: '#ffd36b', low: '#4fb3ff', ok: '#19c3b0', warn: '#ffb347', radius: 16 },
  { id: 'aurora', name: 'Северное сияние', words: ['сияни', 'аврор'], dark: true, bg: 'linear-gradient(135deg,#0b0f24 0%,#13213b 40%,#0f3b3a 75%,#1d1240 100%)', panel: 'rgba(16,22,44,.72)', panel2: 'rgba(28,38,70,.7)', line: 'rgba(140,170,255,.18)', text: '#eef3ff', muted: '#9fb0d6', accent: '#7cf2c9', crit: '#ff5d8f', high: '#ffab5e', mid: '#ffe17a', low: '#7aa8ff', ok: '#7cf2c9', warn: '#ffc56b', card: 'glass', radius: 18, glow: true },
  { id: 'neon', name: 'Неон', words: ['неон', 'киберпанк'], dark: true, bg: 'radial-gradient(900px 500px at 80% 0%,#2a0040,#0a0014 60%)', panel: 'rgba(20,4,36,.88)', panel2: '#1c0833', line: '#3d1466', text: '#f6e9ff', muted: '#b493d6', accent: '#ff2bd6', crit: '#ff2b6a', high: '#ff9a2b', mid: '#fff03a', low: '#2bf0ff', ok: '#3bff9c', warn: '#ffb02b', card: 'outline', radius: 10, glow: true },
  { id: 'nordic', name: 'Север', words: ['север', 'норд', 'скандинав'], dark: true, bg: '#2e3440', panel: '#3b4252', panel2: '#434c5e', line: '#4c566a', text: '#eceff4', muted: '#a3adbf', accent: '#88c0d0', crit: '#d94f5c', high: '#d08770', mid: '#ebcb8b', low: '#81a1c1', ok: '#a3be8c', warn: '#ebcb8b', radius: 10 },
  { id: 'solar-dark', name: 'Солнечный тёмный', words: ['солнечн тёмн', 'солнечн темн', 'соляр тёмн', 'соляр темн'], dark: true, bg: '#002b36', panel: '#073642', panel2: '#0a404e', line: '#124d5c', text: '#eee8d5', muted: '#93a1a1', accent: '#268bd2', crit: '#dc322f', high: '#cb4b16', mid: '#b58900', low: '#268bd2', ok: '#859900', warn: '#b58900', radius: 8 },
  { id: 'solar-light', name: 'Солнечный светлый', words: ['солнечн светл', 'соляр светл'], dark: false, bg: '#fdf6e3', panel: '#fffbef', panel2: '#eee8d5', line: '#e2dbc4', text: '#073642', muted: '#657b83', accent: '#268bd2', crit: '#dc322f', high: '#cb4b16', mid: '#b58900', low: '#268bd2', ok: '#5f7a00', warn: '#b58900', radius: 8 },
  { id: 'mono', name: 'Монохром', words: ['монохром', 'чёрно-бел', 'черно-бел'], dark: false, bg: '#f4f4f4', panel: '#ffffff', panel2: '#f0f0f0', line: '#d9d9d9', text: '#111111', muted: '#6b6b6b', accent: '#111111', crit: '#d0021b', high: '#444444', mid: '#777777', low: '#999999', ok: '#111111', warn: '#555555', card: 'outline', radius: 0 },
  { id: 'forest', name: 'Лес', words: ['лес', 'хвой'], dark: true, bg: 'linear-gradient(170deg,#0d1912,#13261b)', panel: '#15281d', panel2: '#1b3325', line: '#26432f', text: '#e9f5ec', muted: '#8fb39a', accent: '#5fd38d', crit: '#ff5b5b', high: '#ff9d47', mid: '#e8d36a', low: '#6fb6ff', ok: '#5fd38d', warn: '#f3b13b', radius: 14 },
  { id: 'sunset', name: 'Закат', words: ['закат', 'вечер'], dark: true, bg: 'linear-gradient(160deg,#1a0f14,#2a1220 55%,#3a1a1a)', panel: 'rgba(42,20,30,.9)', panel2: '#3a1c2a', line: '#552a3a', text: '#fff0ea', muted: '#d1a49a', accent: '#ff7a45', crit: '#ff3d5a', high: '#ff7a45', mid: '#ffc65c', low: '#8aa2ff', ok: '#5fdca0', warn: '#ffb04a', radius: 16, glow: true },
  { id: 'space', name: 'Космос', words: ['космос', 'звёзд', 'звезд', 'галакт'], dark: true, bg: 'radial-gradient(1px 1px at 20% 30%,#fff8,transparent),radial-gradient(1px 1px at 70% 60%,#fff6,transparent),radial-gradient(1px 1px at 40% 80%,#fff5,transparent),radial-gradient(1400px 700px at 30% -20%,#1b1440,#05040d 65%)', panel: 'rgba(14,12,32,.82)', panel2: 'rgba(26,22,56,.8)', line: 'rgba(138,125,255,.2)', text: '#ecebff', muted: '#a09bd1', accent: '#8a7dff', crit: '#ff4f7b', high: '#ff9f5a', mid: '#ffe07a', low: '#7db8ff', ok: '#56e3b0', warn: '#ffbf5a', card: 'glass', radius: 18, glow: true },
  { id: 'glass', name: 'Стекло', words: ['стекл', 'прозрачн'], dark: true, bg: 'linear-gradient(135deg,#1e3a8a 0%,#6d28d9 45%,#be185d 100%)', panel: 'rgba(255,255,255,.12)', panel2: 'rgba(255,255,255,.18)', line: 'rgba(255,255,255,.22)', text: '#ffffff', muted: 'rgba(255,255,255,.72)', accent: '#ffffff', crit: '#ff4d6d', high: '#ffb04d', mid: '#ffe66d', low: '#9cc7ff', ok: '#6dffb5', warn: '#ffd166', card: 'glass', radius: 20 },
  { id: 'airport', name: 'Табло аэропорта', words: ['аэропорт', 'табло', 'вокзал'], dark: true, bg: '#0a0a0a', panel: '#141414', panel2: '#1c1c1c', line: '#2a2a2a', text: '#f5f5f5', muted: '#9a9a9a', accent: '#ffd000', crit: '#ff3b30', high: '#ff9500', mid: '#ffd000', low: '#5ac8fa', ok: '#34c759', warn: '#ffd000', font: 'cond', card: 'flat', radius: 3 },
  { id: 'bridge', name: 'Капитанский мостик', words: ['мостик', 'капитан', 'звездолёт', 'звездолет'], dark: true, bg: '#05070f', panel: '#0c1020', panel2: '#121833', line: '#1f2a52', text: '#e6ecff', muted: '#8996c7', accent: '#ff9933', crit: '#ff4040', high: '#ff9933', mid: '#ffcc66', low: '#9999ff', ok: '#66dd99', warn: '#ffcc66', font: 'cond', card: 'solid', radius: 24 },
  { id: 'minimal', name: 'Минимализм', words: ['минимал', 'простой', 'чист'], dark: false, bg: '#ffffff', panel: '#ffffff', panel2: '#fafafa', line: '#ececec', text: '#141414', muted: '#8a8a8a', accent: '#141414', crit: '#e5262d', high: '#ef7d22', mid: '#d6a400', low: '#2f74ff', ok: '#1c9b5e', warn: '#e09600', card: 'flat', radius: 10 },
  { id: 'sand', name: 'Песок', words: ['песок', 'песоч', 'терракот'], dark: false, bg: '#efe6d8', panel: '#fbf6ee', panel2: '#f3eadc', line: '#e0d2bd', text: '#33281c', muted: '#86745e', accent: '#c4562b', crit: '#c63b2b', high: '#d9762b', mid: '#b38a12', low: '#3f74a8', ok: '#4b8a4f', warn: '#c98216', radius: 16 },
  { id: 'arctic', name: 'Арктика', words: ['арктик', 'ледян', 'холодн'], dark: false, bg: 'linear-gradient(180deg,#eaf4ff,#f6fbff)', panel: '#ffffff', panel2: '#f0f7ff', line: '#d6e6f7', text: '#0f2540', muted: '#6383a6', accent: '#1e88e5', crit: '#e53950', high: '#f2843a', mid: '#d4a514', low: '#1e88e5', ok: '#16a37a', warn: '#e39a14', radius: 16 },
  { id: 'ruby', name: 'Рубин', words: ['рубин', 'бордо', 'вишн'], dark: true, bg: 'linear-gradient(160deg,#16070b,#24090f)', panel: '#220b11', panel2: '#2e0f17', line: '#4a1824', text: '#ffeef1', muted: '#c99aa5', accent: '#ff3d63', crit: '#ff3d63', high: '#ff8a4d', mid: '#ffcf66', low: '#8fb0ff', ok: '#5fd6a0', warn: '#ffb24d', radius: 12, glow: true },
  { id: 'app', name: 'Как приложение', words: ['как приложен', 'обычн', 'стандарт'], dark: true, bg: '#0f1218', panel: '#171b23', panel2: '#1e232d', line: '#2a3040', text: '#e9edf5', muted: '#8892a6', accent: '#ff3150', crit: '#ff3150', high: '#ff8a3d', mid: '#f4c74a', low: '#5b8cff', ok: '#2fbf7f', warn: '#ffae3d', radius: 12 },
];
export const DASH_STYLE_IDS = DASH_STYLES.map((s) => s.id);
export const dashStyleById = (id: string | null | undefined) => DASH_STYLES.find((s) => s.id === id) ?? DASH_STYLES[0];
/** Найти стиль по словам человека: «сделай неон», «стиль табло аэропорта». */
export function findDashStyle(text: string): DashStyle | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const norm = (w: string) => w.toLowerCase().replace(/ё/g, 'е');
  let best: DashStyle | null = null;
  let bestLen = 0;
  for (const s of DASH_STYLES)
    for (const w of [s.name, ...s.words]) {
      const n = norm(w);
      const hit = n.split(' ').every((part) => t.includes(part.slice(0, Math.max(4, part.length - 2))));
      if (hit && n.length > bestLen) ((best = s), (bestLen = n.length));
    }
  return best;
}
