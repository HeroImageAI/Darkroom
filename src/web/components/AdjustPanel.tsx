import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Wand2 } from 'lucide-react';
import { autoLevels, curveTable, LOOKS, mergeAdjust, NEUTRAL, type Adjust, type CurvePoint } from '../../shared/adjust';

type Channel = 'rgb' | 'r' | 'g' | 'b';
const CH_COLOUR: Record<Channel, string> = { rgb: '#edebe5', r: '#e8765f', g: '#6fcf8e', b: '#6fa8e8' };

/** A labelled slider that resets on double-click. */
function Slider({ label, value, min, max, step = 0.01, fmt, onChange, neutral = 0 }: { label: string; value: number; min: number; max: number; step?: number; fmt?: (v: number) => string; onChange: (v: number) => void; neutral?: number }) {
  return (
    <label className="field adj-slider" onDoubleClick={() => onChange(neutral)} title="Double-click to reset">
      <span>
        {label} <b className="mono">{fmt ? fmt(value) : value.toFixed(2)}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={(e) => e.currentTarget.blur()} />
    </label>
  );
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

/** Curves: drag points, click to add one, double-click a point to remove it. */
function CurveEditor({ pts, channel, onChange, hist }: { pts: CurvePoint[]; channel: Channel; onChange: (p: CurvePoint[]) => void; hist?: Uint32Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const S = 200;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#0f0e0c';
    g.fillRect(0, 0, S, S);
    if (hist) {
      let mx = 1;
      for (const v of hist) mx = Math.max(mx, v);
      g.fillStyle = 'rgba(237,235,229,.12)';
      for (let i = 0; i < 256; i++) {
        const h = (Math.sqrt(hist[i] / mx) * S) | 0;
        g.fillRect((i / 256) * S, S - h, S / 256 + 0.5, h);
      }
    }
    g.strokeStyle = 'rgba(237,235,229,.12)';
    for (let k = 1; k < 4; k++) {
      g.beginPath();
      g.moveTo((k * S) / 4, 0);
      g.lineTo((k * S) / 4, S);
      g.moveTo(0, (k * S) / 4);
      g.lineTo(S, (k * S) / 4);
      g.stroke();
    }
    g.strokeStyle = 'rgba(237,235,229,.25)';
    g.beginPath();
    g.moveTo(0, S);
    g.lineTo(S, 0);
    g.stroke();
    const t = curveTable(pts);
    g.strokeStyle = CH_COLOUR[channel];
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * S;
      const y = S - t[i] * S;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = CH_COLOUR[channel];
    for (const p of pts) {
      g.beginPath();
      g.arc(p.x * S, S - p.y * S, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  }, [pts, channel, hist]);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) };
  };
  const near = (p: CurvePoint) => pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.05);
  return (
    <canvas
      ref={ref}
      width={S}
      height={S}
      className="curve-editor"
      role="img"
      aria-label={`Curve ${channel.toUpperCase()}: click to add a point, drag to move it, double-click to remove it`}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const p = at(e);
        let i = near(p);
        let cur = pts;
        if (i < 0) {
          cur = [...pts, p].sort((a, b) => a.x - b.x);
          i = cur.indexOf(p);
          onChange(cur);
        }
        const move = (ev: PointerEvent) => {
          const q = at(ev);
          const next = cur.slice();
          // keep the points in order: a point can't pass its neighbours
          const lo = i > 0 ? next[i - 1].x + 0.01 : 0;
          const hi = i < next.length - 1 ? next[i + 1].x - 0.01 : 1;
          next[i] = { x: Math.min(hi, Math.max(lo, q.x)), y: q.y };
          cur = next;
          onChange(next);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      onDoubleClick={(e) => {
        const i = near(at(e));
        if (i >= 0) onChange(pts.filter((_, k) => k !== i));
      }}
    />
  );
}

/** Levels: input black, midtone and white over the histogram, and the output range. */
function LevelsEditor({ a, set, hist }: { a: Adjust; set: (p: Partial<Adjust>, label: string, key?: string) => void; hist?: Uint32Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#0f0e0c';
    g.fillRect(0, 0, c.width, c.height);
    if (!hist) return;
    let mx = 1;
    for (const v of hist) mx = Math.max(mx, v);
    g.fillStyle = 'rgba(237,235,229,.55)';
    for (let i = 0; i < 256; i++) {
      const h = Math.sqrt(hist[i] / mx) * c.height;
      g.fillRect((i / 256) * c.width, c.height - h, c.width / 256 + 0.5, h);
    }
    g.fillStyle = 'rgba(240,180,76,.25)';
    g.fillRect(0, 0, (a.levels.black / 255) * c.width, c.height);
    g.fillRect((a.levels.white / 255) * c.width, 0, c.width, c.height);
  }, [hist, a.levels.black, a.levels.white]);
  const L = a.levels;
  const lv = (p: Partial<Adjust['levels']>, key: string) => set({ levels: { ...L, ...p } }, 'Levels', key);
  return (
    <div className="levels">
      <canvas ref={ref} width={200} height={60} className="levels-hist" aria-hidden="true" />
      <Slider label="Black point" value={L.black} min={0} max={254} step={1} fmt={(v) => String(v)} onChange={(v) => lv({ black: Math.min(v, L.white - 1) }, 'lv-b')} />
      <Slider label="Midtones" value={L.gamma} min={0.2} max={5} step={0.01} neutral={1} fmt={(v) => v.toFixed(2)} onChange={(v) => lv({ gamma: v }, 'lv-g')} />
      <Slider label="White point" value={L.white} min={1} max={255} step={1} neutral={255} fmt={(v) => String(v)} onChange={(v) => lv({ white: Math.max(v, L.black + 1) }, 'lv-w')} />
      <Slider label="Output black" value={L.outBlack} min={0} max={254} step={1} fmt={(v) => String(v)} onChange={(v) => lv({ outBlack: v }, 'lv-ob')} />
      <Slider label="Output white" value={L.outWhite} min={1} max={255} step={1} neutral={255} fmt={(v) => String(v)} onChange={(v) => lv({ outWhite: v }, 'lv-ow')} />
      <button type="button" className="btn sm" disabled={!hist} onClick={() => hist && set({ levels: { ...L, ...autoLevels(hist) } }, 'Auto levels')}>
        <Wand2 size={14} /> Auto
      </button>
    </div>
  );
}

/**
 * The Adjust panel for an adjustment layer: light, levels, curves, colour, black & white, split tone, grain and a row
 * of looks. Every change is a step on the layer (slider drags merge into one).
 */
export function AdjustPanel({ adjust, onChange, hist }: { adjust: Partial<Adjust>; onChange: (p: Partial<Adjust>, label: string, key?: string) => void; hist?: { l: Uint32Array; r: Uint32Array; g: Uint32Array; b: Uint32Array } }) {
  const a = mergeAdjust(adjust);
  const [ch, setCh] = useState<Channel>('rgb');
  const [open, setOpen] = useState<Record<string, boolean>>({ light: true, colour: true });
  const sec = (id: string, title: string, body: React.ReactNode) => (
    <details className="adv adj-sec" open={!!open[id]} onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
        setOpen((o) => ({ ...o, [id]: isOpen }));
      }}>
      <summary>{title}</summary>
      <div className="adj-body">{body}</div>
    </details>
  );
  return (
    <div className="adjust-panel">
      <div className="looks" role="group" aria-label="Looks">
        {LOOKS.map((l) => (
          <button key={l.id} type="button" className="pill" onClick={() => onChange({ ...NEUTRAL, ...l.adjust }, `Look: ${l.label}`)}>
            {l.label}
          </button>
        ))}
        <button type="button" className="pill" title="Back to no change" onClick={() => onChange({ ...NEUTRAL }, 'Reset adjustment')}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      {sec(
        'light',
        'Light',
        <>
          <Slider label="Exposure" value={a.exposure} min={-3} max={3} fmt={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} onChange={(v) => onChange({ exposure: v }, 'Exposure', 'exposure')} />
          <Slider label="Brightness" value={a.brightness} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ brightness: v }, 'Brightness', 'brightness')} />
          <Slider label="Contrast" value={a.contrast} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ contrast: v }, 'Contrast', 'contrast')} />
        </>,
      )}
      {sec('levels', 'Levels', <LevelsEditor a={a} set={onChange} hist={hist?.l} />)}
      {sec(
        'curves',
        'Curves',
        <>
          <div className="segmented sym" role="group" aria-label="Curve channel">
            {(['rgb', 'r', 'g', 'b'] as Channel[]).map((c) => (
              <button key={c} type="button" aria-pressed={ch === c} onClick={() => setCh(c)} style={{ color: ch === c ? CH_COLOUR[c] : undefined }}>
                {c.toUpperCase()}
              </button>
            ))}
          </div>
          <CurveEditor pts={a.curves[ch]} channel={ch} hist={hist?.[ch === 'rgb' ? 'l' : ch]} onChange={(p) => onChange({ curves: { ...a.curves, [ch]: p } }, 'Curves', `curve-${ch}`)} />
          <button type="button" className="btn xs ghost" onClick={() => onChange({ curves: { ...a.curves, [ch]: [] } }, 'Reset curve')}>
            Straighten {ch.toUpperCase()}
          </button>
        </>,
      )}
      {sec(
        'colour',
        'Colour',
        <>
          <Slider label="Temperature" value={a.temperature} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ temperature: v }, 'Temperature', 'temperature')} />
          <Slider label="Tint" value={a.tint} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ tint: v }, 'Tint', 'tint')} />
          <Slider label="Hue" value={a.hue} min={-180} max={180} step={1} fmt={(v) => `${Math.round(v)}°`} onChange={(v) => onChange({ hue: v }, 'Hue', 'hue')} />
          <Slider label="Saturation" value={a.saturation} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ saturation: v }, 'Saturation', 'saturation')} />
          <Slider label="Vibrance" value={a.vibrance} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ vibrance: v }, 'Vibrance', 'vibrance')} />
          <Slider label="Lightness" value={a.lightness} min={-1} max={1} fmt={pct} onChange={(v) => onChange({ lightness: v }, 'Lightness', 'lightness')} />
        </>,
      )}
      {sec(
        'bw',
        'Black & white and split tone',
        <>
          <Slider label="Black & white" value={a.bw} min={0} max={1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ bw: v }, 'Black & white', 'bw')} />
          <Slider label="Shadows hue" value={a.shadowsHue} min={0} max={360} step={1} neutral={210} fmt={(v) => `${Math.round(v)}°`} onChange={(v) => onChange({ shadowsHue: v }, 'Split tone', 'sh-h')} />
          <Slider label="Shadows tone" value={a.shadowsAmount} min={0} max={1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ shadowsAmount: v }, 'Split tone', 'sh-a')} />
          <Slider label="Highlights hue" value={a.highlightsHue} min={0} max={360} step={1} neutral={40} fmt={(v) => `${Math.round(v)}°`} onChange={(v) => onChange({ highlightsHue: v }, 'Split tone', 'hi-h')} />
          <Slider label="Highlights tone" value={a.highlightsAmount} min={0} max={1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ highlightsAmount: v }, 'Split tone', 'hi-a')} />
        </>,
      )}
      {sec('grain', 'Grain', <Slider label="Grain" value={a.grain} min={0} max={1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ grain: v }, 'Grain', 'grain')} />)}
    </div>
  );
}
