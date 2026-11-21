// Дизайн стены по описанию: спросить ChatGPT (через сервер) и применить придуманный стиль.
import type { DashStyle } from '../../shared/dashStyles';
import { applyDashOp, dashEvent } from './dashLayout';

export type DesignReply = { kind: 'question'; question: string; options: string[] } | { kind: 'style'; style: DashStyle; note: string; preset: string | null; density: 'normal' | 'large' | null; model: string };
export type DesignTurn = { role: 'user' | 'assistant'; content: string };

export async function askDesign(prompt: string, mode: 'quick' | 'ask', history: DesignTurn[] = []): Promise<DesignReply> {
  const r = await fetch('/api/dash/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, mode, history }) });
  const data = (await r.json()) as DesignReply & { error?: string };
  if (!r.ok) throw new Error(data.error ?? 'не получилось');
  return data;
}

export function applyDesign(d: Extract<DesignReply, { kind: 'style' }>) {
  return applyDashOp({ op: 'customStyle', style: d.style, preset: (d.preset as never) ?? null, density: d.density });
}

/** По команде Джарвиса: сразу, без вопросов; пока думает — на стене надпись. */
export async function designNow(prompt: string): Promise<string> {
  dashEvent({ type: 'designing', text: prompt });
  try {
    const d = await askDesign(prompt, 'quick');
    if (d.kind !== 'style') return 'ChatGPT задал вопрос — ответьте в настройках дашборда';
    applyDesign(d);
    return `«${d.style.name}»`;
  } catch (e) {
    return `не вышло: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    dashEvent({ type: 'designing', text: null });
  }
}

// ─── свой блок и новый персонаж через ChatGPT ───
import type { CustomSpec } from '../../shared/dashCustom';
import { cutOut } from './cutout';

/** Уменьшить картинку до 256×256 webp — портрет занимает ~20 КБ и хранится в настройках сотрудника. */
export async function shrinkImage(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const m = Math.min(img.width, img.height);
  c.getContext('2d')!.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, 256, 256);
  return c.toDataURL('image/webp', 0.82);
}

/** Описание словами → блок на поле. character — персонаж; draw — GPT рисует ему портрет. */
export async function makeCustomBlock(prompt: string, opts: { character?: boolean; draw?: boolean; at?: { x: number; y: number } | null; onStep?: (s: string) => void } = {}): Promise<string> {
  opts.onStep?.(opts.character ? 'ChatGPT придумывает персонажа…' : 'ChatGPT собирает блок…');
  const r = await fetch('/api/dash/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, character: !!opts.character }) });
  const data = (await r.json()) as { spec: CustomSpec; w: number; h: number; error?: string };
  if (!r.ok) throw new Error(data.error ?? 'не получилось');
  const spec = data.spec;
  if (spec.kind === 'character' && opts.draw !== false && spec.character) {
    opts.onStep?.('GPT рисует портрет — около 40 секунд…');
    try {
      const a = await fetch('/api/dash/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: `${spec.character.name}: ${prompt}` }) });
      const img = (await a.json()) as { image?: string };
      if (a.ok && img.image) {
        opts.onStep?.('Вырезаю фон — персонаж встанет прямо на стену…');
        const fig = await cutOut(img.image).catch(() => null);
        if (fig) spec.character = { ...spec.character, avatar: fig, cut: true };
        else spec.character.avatar = await shrinkImage(img.image);
      }
    } catch {
      /* без портрета — с эмодзи */
    }
  }
  const res = applyDashOp({ op: 'add', block: 'custom', custom: spec, w: data.w, h: data.h, ...(opts.at ? { x: opts.at.x, y: opts.at.y } : {}) });
  if (/нет места|закреплён/.test(res)) throw new Error(res);
  return spec.title;
}

/** По команде Джарвиса: собрать блок и показать надпись на стене, пока ChatGPT думает. */
export async function makeBlockNow(prompt: string, character: boolean): Promise<string> {
  try {
    return await makeCustomBlock(prompt, { character, draw: true, onStep: (t) => dashEvent({ type: 'designing', text: t }) });
  } catch (e) {
    return `не вышло: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    dashEvent({ type: 'designing', text: null });
  }
}
