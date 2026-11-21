// Свои блоки стены через ChatGPT: описание словами → безопасное описание блока (что показать и как),
// портрет нового персонажа (GPT рисует картинку) и короткие реплики персонажа об обстановке.
import { cleanSpec, type CustomSpec } from '../shared/dashCustom.ts';
import type { Point } from './point.ts';
import { key, openrouter } from './jarvis.ts';
import { DESIGN_MODEL } from './design.ts';
import { briefByRules, briefContext } from './jarvis-dash.ts';

const FALLBACK = 'openai/gpt-6.2-sol';
const IMAGE_MODELS = () => [process.env.IMAGE_MODEL || 'openai/gpt-5-image-mini', 'google/gemini-3.1-flash-image'];

const SYSTEM = `Ты собираешь блоки для видеостены координаторов массовых инцидентов. Человек описывает, какой блок ему нужен; ты отвечаешь строго одним JSON-объектом, без текста вокруг:
{"title": "короткое название блока по-русски (до 30 символов)", "kind": "list|counter|bars|character|note", "hint": "одной фразой, что показывает",
 "filter": {"priority": ["P1","P2","P3","P4"] — P1 критический/наивысший, P2 высокий, P3 средний, P4 низкий; "status": ["coordinators","assigned","in_progress","resolved"] — на координаторах, назначен команде, в работе, решён; "group": "crit|coord|high|research"; "origin": "complaints|dataset" — из жалоб абонентов или из выгрузки ITSM; "overdue": true — срок прошёл; "notTaken": true — команда не берёт; "text": "слова для поиска в названии, сервисе, продукте, команде"},
 "groupBy": "team|service|product|priority|status" — для bars, "sort": "deadline|priority|created|complaints", "limit": 3..15,
 "note": "текст заметки" — для note,
 "character": {"name": "имя", "style": "как говорит — характер и манера", "avatar": "эмодзи одним символом", "color": "#rrggbb"} — для character,
 "w": 2..12, "h": 2..12 — удобный размер на поле 12×12}
Виды: list — список инцидентов; counter — одно большое число (сколько подходит под фильтр); bars — полосы: сколько по командам/сервисам/уровням; character — персонаж, который время от времени комментирует обстановку; note — просто текст.
Фильтр — только то, о чём просили. Решённые показываются, только если явно просят (status: resolved).`;

export async function makeBlock(prompt: string, character: boolean): Promise<{ spec: CustomSpec; w: number; h: number; model: string }> {
  if (!key()) throw new Error('нет ключа OpenRouter на сервере');
  const msgs = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${character ? 'Нужен персонаж (kind: character). ' : ''}${prompt.slice(0, 600)}` },
  ];
  let last = '';
  for (const model of [DESIGN_MODEL(), FALLBACK]) {
    try {
      const r = await openrouter('/chat/completions', { model, messages: msgs, max_tokens: 700, temperature: 0.5, response_format: { type: 'json_object' } }, 40_000);
      if (r.status !== 200) {
        last = `${model}: ${r.status}`;
        continue;
      }
      const text = (JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] }).choices[0]?.message.content ?? '';
      const o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
      if (character) o.kind = 'character';
      const spec = cleanSpec(o);
      if (!spec) throw new Error('модель вернула непонятный блок');
      const w = Math.max(2, Math.min(12, Math.round(Number(o.w) || (spec.kind === 'counter' ? 3 : spec.kind === 'character' ? 3 : 4))));
      const h = Math.max(2, Math.min(12, Math.round(Number(o.h) || (spec.kind === 'counter' ? 3 : spec.kind === 'character' ? 5 : 6))));
      return { spec, w, h, model };
    } catch (err) {
      last = `${model}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`модель не ответила (${last})`);
}

/** Портрет персонажа: GPT рисует картинку, отдаём data:image/... — браузер уменьшает и хранит у себя. */
export async function drawAvatar(description: string): Promise<{ image: string; model: string }> {
  if (!key()) throw new Error('нет ключа OpenRouter на сервере');
  const prompt = `Нарисуй аватар персонажа для интерфейса диспетчерской: ${description.slice(0, 300)}. Объёмная 3D-иллюстрация как в анимационном кино, мягкий свет, персонаж по пояс (голова, плечи, руки), стоит прямо по центру, смотрит в камеру, дружелюбный. Фон — сплошной чистый пурпурный #FF00FF, ровный, без градиента, теней, пола и предметов; в самом персонаже не используй пурпурный, розовый и фиолетовый. Без текста и надписей. Квадрат.`;
  let last = '';
  for (const model of IMAGE_MODELS()) {
    try {
      const r = await openrouter('/chat/completions', { model, modalities: ['image', 'text'], messages: [{ role: 'user', content: prompt }] }, 150_000);
      if (r.status !== 200) {
        last = `${model}: ${r.status}`;
        continue;
      }
      const j = JSON.parse(r.buf.toString('utf8')) as { choices: { message: { images?: { image_url?: { url?: string } }[] } }[] };
      const url = j.choices[0]?.message.images?.[0]?.image_url?.url ?? '';
      if (/^data:image\/(png|jpeg|webp);base64,/.test(url)) return { image: url, model };
      last = `${model}: без картинки`;
    } catch (err) {
      last = `${model}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`картинка не получилась (${last})`);
}

/** Реплика персонажа об обстановке — в его манере, одна-две фразы. Кэш на минуту. */
const said = new Map<string, { at: number; text: string; llm: boolean }>();
export async function characterSays(point: Point, name: string, style: string): Promise<{ text: string; llm: boolean }> {
  const { key: k, text: ctx } = briefContext(point);
  const id = `${name}|${style}|${k}`;
  const hit = said.get(id) ?? [...said.entries()].find(([x, v]) => x.startsWith(`${name}|${style}|`) && Date.now() - v.at < 45_000)?.[1];
  if (hit && Date.now() - hit.at < 90_000) return hit;
  let out = { text: briefByRules(point), llm: false };
  if (key()) {
    try {
      const r = await openrouter(
        '/chat/completions',
        {
          model: DESIGN_MODEL(),
          messages: [
            { role: 'system', content: `Ты — ${name.slice(0, 30)}, персонаж на видеостене координаторов инцидентов. Говоришь ${style.slice(0, 200)}. По данным ниже скажи одну-две короткие фразы (до 30 слов): что сейчас главное и что сделать. Без номеров INC, без разметки, по делу, в своём характере.` },
            { role: 'user', content: ctx },
          ],
          max_tokens: 160,
          temperature: 0.8,
        },
        25_000,
      );
      if (r.status === 200) {
        const t = ((JSON.parse(r.buf.toString('utf8')) as { choices: { message: { content: string | null } }[] }).choices[0]?.message.content ?? '').trim();
        if (t) out = { text: t.slice(0, 300), llm: true };
      }
    } catch (err) {
      console.error('Реплика персонажа: модель недоступна —', err instanceof Error ? err.message : err);
    }
  }
  said.set(id, { at: Date.now(), ...out });
  if (said.size > 50) said.delete(said.keys().next().value!);
  return out;
}
