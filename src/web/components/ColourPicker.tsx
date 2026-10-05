import { useEffect, useRef, useState } from 'react';
import { hexToHsv, hexToRgb, hsvToHex, type Hsv } from '../../shared/colour';

/**
 * Colour picker for painting (Edit suite v3.26): a saturation/brightness square and a hue strip you can drag with the
 * pen, hex entry, your saved swatches and recent colours.
 */
export function ColourPicker({
  value,
  onChange,
  recent,
  swatches,
  onSwatches,
}: {
  value: string;
  onChange: (hex: string) => void;
  recent: string[];
  swatches: string[];
  onSwatches: (s: string[]) => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hex, setHex] = useState(value);
  const sq = useRef<HTMLCanvasElement>(null);
  // follow outside changes (eyedropper, swatches) but keep the hue when the colour is grey
  useEffect(() => {
    if (hsvToHex(hsv) === value.toLowerCase()) return;
    const n = hexToHsv(value);
    setHsv((p) => (n.s === 0 || n.v === 0 ? { ...n, h: p.h } : n));
    setHex(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = sq.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const w = c.width;
    const h = c.height;
    g.fillStyle = hsvToHex({ h: hsv.h, s: 1, v: 1 });
    g.fillRect(0, 0, w, h);
    const white = g.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = white;
    g.fillRect(0, 0, w, h);
    const black = g.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    g.fillStyle = black;
    g.fillRect(0, 0, w, h);
  }, [hsv.h]);
  const set = (n: Hsv) => {
    setHsv(n);
    const x = hsvToHex(n);
    setHex(x);
    onChange(x);
  };
  const drag = (el: HTMLElement, e: React.PointerEvent, f: (x: number, y: number) => void) => {
    el.setPointerCapture?.(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      f(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="colour-picker" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cp-square" onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => set({ h: hsv.h, s: x, v: 1 - y }))} role="slider" aria-label="Saturation and brightness" aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`} aria-valuenow={Math.round(hsv.v * 100)}>
        <canvas ref={sq} width={180} height={140} />
        <span className="cp-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }} />
      </div>
      <div className="cp-hue" onPointerDown={(e) => drag(e.currentTarget, e, (x) => set({ ...hsv, h: Math.min(359.9, x * 360) }))} role="slider" aria-label="Hue" aria-valuenow={Math.round(hsv.h)}>
        <span className="cp-hue-dot" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div className="field-row" style={{ gap: 6 }}>
        <span className="cp-now" style={{ background: value }} />
        <input
          className="input sm mono"
          value={hex}
          aria-label="Hex colour"
          onChange={(e) => {
            setHex(e.target.value);
            const v = e.target.value.trim();
            if (hexToRgb(v)) {
              const n = v.startsWith('#') ? v : '#' + v;
              const full = hsvToHex(hexToHsv(n));
              setHsv(hexToHsv(full));
              onChange(full);
            }
          }}
        />
        <button type="button" className="btn xs" title="Keep this colour in your swatches" onClick={() => onSwatches([value, ...swatches.filter((s) => s !== value)].slice(0, 16))}>
          + Swatch
        </button>
      </div>
      {swatches.length > 0 && (
        <div className="cp-row" aria-label="Your swatches">
          {swatches.map((c) => (
            <button
              key={c}
              type="button"
              style={{ background: c }}
              title={`${c} (right-click to remove)`}
              aria-label={`Swatch ${c}`}
              onClick={() => onChange(c)}
              onContextMenu={(e) => (e.preventDefault(), onSwatches(swatches.filter((s) => s !== c)))}
            />
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div className="cp-row" aria-label="Recent colours">
          {recent.map((c) => (
            <button key={c} type="button" style={{ background: c }} title={c} aria-label={`Recent ${c}`} onClick={() => onChange(c)} />
          ))}
        </div>
      )}
    </div>
  );
}
