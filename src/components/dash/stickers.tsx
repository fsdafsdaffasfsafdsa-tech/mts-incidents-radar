// Персонажи ChatGPT поверх стены — на прозрачном фоне, где угодно. Дежурный сам ставит их, куда хочет:
//   тянуть за фигуру — переставить; уголок справа снизу или колёсико — размер; кружок сверху или Shift+колёсико —
//   повернуть; кнопки у выделенного — отразить зеркально и убрать. Положение запоминается вместе с раскладкой стены.
// Новый персонаж: «Джарвис, нарисуй персонажа…» или галерея блоков → «Персонаж».
import { useEffect, useRef, useState } from 'react';
import { FlipHorizontal2, RotateCw, Trash2 } from 'lucide-react';
import { setDash, useDash, useDashEvents, type Sticker } from '../../lib/dashLayout';

type Drag = { id: string; mode: 'move' | 'size' | 'rot'; sx: number; sy: number; start: Sticker };

export function Stickers() {
  const d = useDash();
  const box = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [live, setLiveState] = useState<Sticker | null>(null); // пока тянут — без записи в настройки на каждый кадр
  const liveRef = useRef<Sticker | null>(null); // то же — для отпускания кнопки сразу после движения
  const setLive = (s: Sticker | null) => {
    liveRef.current = s;
    setLiveState(s);
  };
  const drag = useRef<Drag | null>(null);

  useDashEvents((e) => e.type === 'sticker' && setSel(e.id));
  // щелчок мимо персонажа — снять выделение
  useEffect(() => {
    const off = (e: PointerEvent) => !(e.target as Element)?.closest?.('.stk') && setSel(null);
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, []);

  const save = (s: Sticker) => setDash({ stickers: d.stickers.map((x) => (x.id === s.id ? s : x)) });
  const rect = () => box.current!.getBoundingClientRect();

  function down(e: React.PointerEvent, s: Sticker, mode: Drag['mode']) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSel(s.id);
    drag.current = { id: s.id, mode, sx: e.clientX, sy: e.clientY, start: s };
  }
  function move(e: React.PointerEvent) {
    const g = drag.current;
    if (!g) return;
    const r = rect();
    const s = g.start;
    const cx = r.left + s.x * r.width;
    const cy = r.top + s.y * r.height;
    if (g.mode === 'move') setLive({ ...s, x: Math.min(1, Math.max(0, s.x + (e.clientX - g.sx) / r.width)), y: Math.min(1, Math.max(0, s.y + (e.clientY - g.sy) / r.height)) });
    else if (g.mode === 'size') {
      const d0 = Math.hypot(g.sx - cx, g.sy - cy) || 1;
      const d1 = Math.hypot(e.clientX - cx, e.clientY - cy);
      setLive({ ...s, w: Math.min(0.8, Math.max(0.04, (s.w * d1) / d0)) });
    } else {
      const a0 = Math.atan2(g.sy - cy, g.sx - cx);
      const a1 = Math.atan2(e.clientY - cy, e.clientX - cx);
      let rot = s.rot + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) rot = Math.round(rot / 15) * 15; // с Shift — шагом 15°
      setLive({ ...s, rot: ((rot % 360) + 360) % 360 });
    }
  }
  function up() {
    if (drag.current && liveRef.current) save(liveRef.current);
    drag.current = null;
    setLive(null);
  }
  function wheel(e: React.WheelEvent, s: Sticker) {
    if (sel !== s.id) return;
    e.preventDefault();
    if (e.shiftKey) save({ ...s, rot: (((s.rot + Math.sign(e.deltaY || e.deltaX) * 8) % 360) + 360) % 360 });
    else save({ ...s, w: Math.min(0.8, Math.max(0.04, s.w * (e.deltaY > 0 ? 0.92 : 1.08))) });
  }

  if (!d.stickers.length) return null;
  return (
    <div className="stk-layer" ref={box} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {d.stickers.map((s0) => {
        const s = live?.id === s0.id ? live : s0;
        return (
          <div
            key={s.id}
            className={`stk ${sel === s.id ? 'sel' : ''}`}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, transform: `translate(-50%, -50%) rotate(${s.rot}deg)` }}
            onPointerDown={(e) => down(e, s, 'move')}
            onWheel={(e) => wheel(e, s)}
            title={`${s.name} — тяните, чтобы переставить; колёсико — размер, Shift+колёсико — поворот`}
          >
            <img src={s.src} alt={s.name} draggable={false} style={s.flip ? { transform: 'scaleX(-1)' } : undefined} />
            {sel === s.id && (
              <>
                <span className="stk-rot" onPointerDown={(e) => down(e, s, 'rot')} title="Повернуть (с Shift — шагом 15°)">
                  <RotateCw />
                </span>
                <span className="stk-size" onPointerDown={(e) => down(e, s, 'size')} title="Размер" />
                <span className="stk-tools" onPointerDown={(e) => e.stopPropagation()}>
                  <button onClick={() => save({ ...s, flip: !s.flip })} title="Отразить зеркально">
                    <FlipHorizontal2 />
                  </button>
                  <button
                    onClick={() => {
                      setDash({ stickers: d.stickers.filter((x) => x.id !== s.id) });
                      setSel(null);
                    }}
                    title="Убрать персонажа"
                  >
                    <Trash2 />
                  </button>
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
