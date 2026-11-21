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
