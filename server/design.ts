// Дизайн видеостены по описанию: ChatGPT (через OpenRouter) придумывает оформление — цвета, шрифт, карточки,
// при желании раскладку. Два режима: сразу по одному запросу или сначала уточняющие вопросы.
// Ответ модели проверяется: только безопасные цвета и градиенты, читаемый контраст текста.
import type { DashStyle } from '../shared/dashStyles.ts';
import { DASH_STYLES } from '../shared/dashStyles.ts';
import { PRESETS } from '../shared/dash.ts';
import { key, openrouter } from './jarvis.ts';

export const DESIGN_MODEL = () => process.env.DESIGN_MODEL || 'openai/gpt-chat-latest';
const FALLBACK_MODEL = 'openai/gpt-6.2-sol';

export interface DesignAsk {
  prompt: string;
  mode: 'quick' | 'ask';
  history: { role: 'user' | 'assistant'; content: string }[];
}
export type DesignReply = { kind: 'question'; question: string; options: string[] } | { kind: 'style'; style: DashStyle; note: string; preset: string | null; density: 'normal' | 'large' | null; model: string };

const SYSTEM = `Ты — дизайнер интерфейсов. Оформляешь видеостену координаторов массовых инцидентов: большой экран над рабочими местами, панели с карточками инцидентов, счётчики, таблицы. Она должна читаться издалека.
Отвечай строго одним JSON-объектом, без текста вокруг.
Если режим «с уточнениями» и описания мало (непонятно настроение, светлая или тёмная, какие цвета), задай ОДИН короткий вопрос по-русски с 2–4 вариантами ответа: {"question": "...", "options": ["...", "..."]}. Всего за разговор не больше двух вопросов; после двух — сразу оформление.
Иначе верни оформление:
{"name": "короткое название по-русски", "dark": true|false, "bg": "фон стены", "panel": "фон панелей", "panel2": "фон карточек внутри панелей", "line": "линии и рамки", "text": "основной текст", "muted": "второстепенный текст", "accent": "акцент", "crit": "критический (явно красный)", "high": "высокий (оранжевый)", "mid": "средний (жёлтый)", "low": "низкий (синий)", "ok": "успех (зелёный)", "warn": "внимание", "font": "sans|mono|cond|serif", "card": "solid|glass|outline|flat", "radius": 0..24, "glow": true|false, "snow": true|false, "density": "normal|large"|null, "preset": ${JSON.stringify(PRESETS.map((p) => p.id))} или null, "note": "одной фразой, что получилось"}
Правила: цвета только #rrggbb или rgba(r,g,b,a); bg можно linear-gradient(...) или radial-gradient(...) из таких цветов; текст обязательно контрастен панелям (как минимум 4.5:1); критический — красный и самый заметный; snow=true только для зимней или новогодней темы; preset — только если человек просит другую раскладку; без url() и картинок.`;

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
const BG_WORDS = /^(linear-gradient|radial-gradient|rgba?|transparent|circle|ellipse|at|to|top|bottom|left|right|center|closest-side|farthest-corner|deg|px|%)$/i;
/** Фон: цвет или градиент только из цветов и разрешённых слов — ничего, что может загрузить чужое. */
function safeBg(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  const s = v.trim();
  if (COLOR.test(s)) return s;
  if (/url|expression|image|var\(|[;{}<>"'\\]/i.test(s)) return null;
  if (!/^(linear|radial)-gradient\(/i.test(s)) return null;
  const words = s.replace(/#[0-9a-f]{3,8}/gi, ' ').replace(/[\d.]+/g, ' ').split(/[\s(),]+/).filter(Boolean);
  return words.every((w) => BG_WORDS.test(w)) ? s : null;
}
const safeColor = (v: unknown) => (typeof v === 'string' && COLOR.test(v.trim()) ? v.trim() : null);

function rgb(c: string): [number, number, number] | null {
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map((x) => parseInt(x + x, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) return [0, 2, 4].map((k) => parseInt(m![1].slice(k, k + 2), 16)) as [number, number, number];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function lum([r, g, b]: [number, number, number]) {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: string, b: string): number | null {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Ответ модели → безопасный стиль. Чего нет или что опасно — берём из базового стиля. */
export function toStyle(o: Record<string, unknown>): DashStyle {
  const dark = o.dark !== false;
  const base = DASH_STYLES.find((s) => s.id === (dark ? 'graphite' : 'mts'))!;
  const col = (k: keyof DashStyle) => safeColor(o[k]) ?? (base[k] as string);
  const st: DashStyle = {
    id: `ai-${Date.now().toString(36)}`,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : 'Мой стиль',
    words: [],
    dark,
    bg: safeBg(o.bg) ?? base.bg,
    panel: col('panel'),
    panel2: col('panel2'),
    line: col('line'),
    text: col('text'),
    muted: col('muted'),
    accent: col('accent'),
    crit: col('crit'),
    high: col('high'),
    mid: col('mid'),
    low: col('low'),
    ok: col('ok'),
    warn: col('warn'),
    font: ['sans', 'mono', 'cond', 'serif'].includes(String(o.font)) ? (o.font as DashStyle['font']) : 'sans',
    card: ['solid', 'glass', 'outline', 'flat'].includes(String(o.card)) ? (o.card as DashStyle['card']) : 'solid',
    radius: Math.max(0, Math.min(24, Math.round(Number(o.radius) || 12))),
    glow: o.glow === true,
    deco: o.snow === true ? 'snow' : undefined,
    custom: true,
  };
  // Текст должен читаться на панелях; если модель промахнулась — белый или почти чёрный.
  const c = contrast(st.text, st.panel);
  if (c !== null && c < 4.5) st.text = (contrast('#ffffff', st.panel) ?? 0) >= (contrast('#111111', st.panel) ?? 0) ? '#ffffff' : '#111111';
  const m = contrast(st.muted, st.panel);
  if (m !== null && m < 2.6) st.muted = st.text;
  return st;
}

export async function design(q: DesignAsk): Promise<DesignReply> {
  if (!key()) throw new Error('нет ключа OpenRouter на сервере');
  const asked = q.history.filter((h) => h.role === 'assistant').length;
  const msgs = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `Режим: ${q.mode === 'ask' && asked < 2 ? 'с уточнениями' : 'сразу оформление, без вопросов'}.` },
    ...q.history.slice(-6).map((h) => ({ role: h.role, content: h.content.slice(0, 600) })),
    { role: 'user', content: q.prompt.slice(0, 800) },
  ];
  let lastErr = '';
  for (const model of [DESIGN_MODEL(), FALLBACK_MODEL]) {
    try {
      const r = await openrouter('/chat/completions', { model, messages: msgs, max_tokens: 900, temperature: 0.7, response_format: { type: 'json_object' } }, 40_000);
      if (r.status !== 200) {
        lastErr = `${model}: ${r.status}`;
        continue;
      }
      const text = (JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] }).choices[0]?.message.content ?? '';
      const o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
      if (typeof o.question === 'string' && q.mode === 'ask' && asked < 2) {
        const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 60)).slice(0, 4) : [];
        return { kind: 'question', question: o.question.slice(0, 200), options };
      }
      const preset = typeof o.preset === 'string' && PRESETS.some((p) => p.id === o.preset) ? o.preset : null;
      return { kind: 'style', style: toStyle(o), note: typeof o.note === 'string' ? o.note.slice(0, 200) : '', preset, density: o.density === 'large' ? 'large' : o.density === 'normal' ? 'normal' : null, model };
    } catch (err) {
      lastErr = `${model}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`модель не ответила (${lastErr})`);
}
