// Вырезать персонажа из картинки ChatGPT: GPT рисует его на сплошном пурпурном (#FF00FF) фоне, а здесь фон
// становится прозрачным — фигура стоит прямо на стене, без круга и рамки. Тот же способ, которым вырезаны
// встроенные персонажи: фон — «пурпурное», связанное с верхом и боками картинки, плюс закрытые пурпурные «дырки»
// (между рукой и телом); край мягкий, пурпурный отсвет убран. Не получилось — null, тогда остаётся круглый портрет.

const MAX_SIDE = 512; // считаем на уменьшенной копии — быстро и хватает для стены
const OUT_H = 360; // высота готовой фигуры
const LIMIT = 190_000; // столько символов data URL помещается в настройки блока

export async function cutOut(dataUrl: string): Promise<string | null> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const W = Math.max(1, Math.round(img.width * k));
  const H = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g2 = c.getContext('2d', { willReadFrequently: true })!;
  g2.drawImage(img, 0, 0, W, H);
  const data = g2.getImageData(0, 0, W, H);
  const px = data.data;
  const N = W * H;

  // «пурпурность» и близость к #FF00FF
  const mag = new Float32Array(N);
  const dist = new Float32Array(N);
  const near = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const r = px[p * 4];
    const g = px[p * 4 + 1];
    const b = px[p * 4 + 2];
    mag[p] = Math.min(r, b) - g;
    dist[p] = Math.sqrt((255 - r) ** 2 + g ** 2 + (255 - b) ** 2);
    near[p] = dist[p] < 150 || mag[p] > 110 || (mag[p] > 30 && Math.abs(r - b) < 90) ? 1 : 0;
  }

  // связные области «пурпурного»
  const lab = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  type Comp = { size: number; dist: number; mag: number; border: boolean; bottom: boolean };
  const comps: Comp[] = [];
  for (let s = 0; s < N; s++) {
    if (!near[s] || lab[s] >= 0) continue;
    const id = comps.length;
    const cp: Comp = { size: 0, dist: 0, mag: 0, border: false, bottom: false };
    let top = 0;
    stack[top++] = s;
    lab[s] = id;
    while (top) {
      const p = stack[--top];
      const x = p % W;
      const y = (p / W) | 0;
      cp.size++;
      cp.dist += dist[p];
      cp.mag += mag[p];
      if (y === 0 || x === 0 || x === W - 1) cp.border = true; // низ не считаем: там обрез фигуры и её детали
      if (y === H - 1) cp.bottom = true;
      if (x > 0 && near[p - 1] && lab[p - 1] < 0) ((lab[p - 1] = id), (stack[top++] = p - 1));
      if (x < W - 1 && near[p + 1] && lab[p + 1] < 0) ((lab[p + 1] = id), (stack[top++] = p + 1));
      if (y > 0 && near[p - W] && lab[p - W] < 0) ((lab[p - W] = id), (stack[top++] = p - W));
      if (y < H - 1 && near[p + W] && lab[p + W] < 0) ((lab[p + W] = id), (stack[top++] = p + W));
    }
    comps.push(cp);
  }
  const minHole = 150 * (W * H) / (1024 * 1024);
  const isBg = comps.map((cp) => {
    if (cp.border) return true;
    const md = cp.dist / cp.size;
    const mm = cp.mag / cp.size;
    return cp.size > minHole && (md < 120 || (mm > 40 && !cp.bottom));
  });
  const bg = new Uint8Array(N);
  let bgCount = 0;
  for (let p = 0; p < N; p++) if (lab[p] >= 0 && isBg[lab[p]]) ((bg[p] = 1), bgCount++);
  const share = bgCount / N;
  if (share < 0.12 || share > 0.92) return null; // фон не пурпурный или пропал персонаж — не трогаем

  // мягкий край: в полосе 2 px от фона прозрачность по близости к пурпурному
  const alpha = new Float32Array(N);
  for (let p = 0; p < N; p++) alpha[p] = bg[p] ? 0 : 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (bg[p]) continue;
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && bg[yy * W + xx]) {
            edge = true;
            break;
          }
        }
      if (edge) alpha[p] = Math.min(1, Math.max(0, (dist[p] - 60) / 140));
    }
  // лёгкое сглаживание края 3×3
  const soft = alpha.slice();
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (bg[p]) continue;
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += alpha[p + dy * W + dx];
      soft[p] = Math.min(alpha[p], s / 9 + 0.15);
    }
  // без пурпурного отсвета: красный и синий не выше зелёного с запасом
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let p = 0; p < N; p++) {
    const a = bg[p] ? 0 : soft[p];
    if (!bg[p] && mag[p] > 25) {
      const lim = px[p * 4 + 1] + 25;
      px[p * 4] = Math.min(px[p * 4], lim);
      px[p * 4 + 2] = Math.min(px[p * 4 + 2], lim);
    }
    px[p * 4 + 3] = Math.round(a * 255);
    if (a > 0.03) {
      const x = p % W;
      const y = (p / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  g2.putImageData(data, 0, 0);

  // обрезать по фигуре и уменьшить
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  for (const h of [OUT_H, 300, 240]) {
    const s = Math.min(1, h / ch);
    const o = document.createElement('canvas');
    o.width = Math.max(1, Math.round(cw * s));
    o.height = Math.max(1, Math.round(ch * s));
    const og = o.getContext('2d')!;
    og.imageSmoothingQuality = 'high';
    og.drawImage(c, x0, y0, cw, ch, 0, 0, o.width, o.height);
    const url = o.toDataURL('image/webp', 0.84);
    if (url.startsWith('data:image/webp') && url.length < LIMIT) return url;
  }
  return null;
}
