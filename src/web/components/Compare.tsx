import { useEffect, useRef } from 'react';

/**
 * Before/after compare that follows the cursor. The split is written straight to the DOM inside
 * requestAnimationFrame, so moving the mouse never re-renders React (smooth at 60 fps).
 * - Hovering: the split follows the cursor X.
 * - Pointer leaves the picture: shows "after".
 * - Holding Space (or `showBefore`): shows "before".
 * Both images sit in the same transformed box (sized to the after image), so they stay aligned at any zoom/pan.
 * A before image with a different aspect is letterboxed (object-fit: contain) rather than stretched.
 */
export function CompareView({ before, after, holdKey = ' ' }: { before: string; after: string; holdKey?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const beforeImg = useRef<HTMLImageElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const state = useRef({ frac: 1, hovering: false, held: false, raf: 0 });

  const paint = () => {
    state.current.raf = 0;
    const s = state.current;
    const f = s.held ? 1 : s.hovering ? s.frac : 0; // fraction of the width that shows "before"
    if (beforeImg.current) beforeImg.current.style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
    if (line.current) {
      line.current.style.left = `${f * 100}%`;
      line.current.style.opacity = s.hovering && !s.held ? '1' : '0';
    }
    if (label.current) label.current.textContent = s.held ? 'Before (holding Space)' : s.hovering ? 'Before | After' : 'After — hover to compare, hold Space for before';
  };
  const schedule = () => {
    if (!state.current.raf) state.current.raf = requestAnimationFrame(paint);
  };

  useEffect(() => {
    const el = box.current!;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      state.current.frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      state.current.hovering = true;
      schedule();
    };
    const leave = () => {
      state.current.hovering = false;
      schedule();
    };
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    const down = (e: KeyboardEvent) => {
      if (e.key === holdKey && !typing(e.target)) {
        e.preventDefault();
        state.current.held = true;
        schedule();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === holdKey) {
        state.current.held = false;
        schedule();
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    paint();
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      cancelAnimationFrame(state.current.raf);
    };
  }, [holdKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={box} data-testid="compare" style={{ position: 'absolute', inset: 0, cursor: 'ew-resize' }}>
      <img src={after} alt="After" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', userSelect: 'none' }} />
      <img
        ref={beforeImg}
        src={before}
        alt="Before"
        draggable={false}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#0c0c0b', clipPath: 'inset(0 100% 0 0)', willChange: 'clip-path', userSelect: 'none' }}
      />
      <div ref={line} style={{ position: 'absolute', top: 0, bottom: 0, left: '0%', width: 2, marginLeft: -1, background: 'var(--accent)', opacity: 0, pointerEvents: 'none', willChange: 'left' }} />
      <span ref={label} className="btn sm" style={{ position: 'absolute', left: 8, top: 8, pointerEvents: 'none' }} />
    </div>
  );
}
