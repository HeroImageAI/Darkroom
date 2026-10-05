import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Circle, Eraser, Minus, Pipette, Square, SquareSplitHorizontal, SquareSplitVertical } from 'lucide-react';
import { BRUSHES, brushById } from '../../shared/brushes';
import type { BrushSettings } from '../lib/brush';
import { ColourPicker } from './ColourPicker';

/** A button that opens a small panel above the tool bar; a click elsewhere closes it. */
function Pop({ label, title, children, className = '' }: { label: ReactNode; title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('pointerdown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);
  return (
    <div className={`pop ${className}`} ref={ref}>
      <button type="button" className={`btn sm pop-btn ${open ? 'on' : ''}`} title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div className="pop-panel" role="dialog" aria-label={title}>
          {children}
        </div>
      )}
    </div>
  );
}

export interface ColourState {
  colour: string;
  setColour: (c: string) => void;
  recent: string[];
  swatches: string[];
  setSwatches: (s: string[]) => void;
}

function ColourButton({ c }: { c: ColourState }) {
  return (
    <Pop
      className="colour-pop"
      title="Colour (Alt-click the picture to pick one)"
      label={<span className="colour-dot" style={{ background: c.colour }} />}
    >
      <ColourPicker value={c.colour} onChange={c.setColour} recent={c.recent} swatches={c.swatches} onSwatches={c.setSwatches} />
    </Pop>
  );
}

function Mini({ label, value, min, max, step = 1, onChange, aria, title }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; aria: string; title?: string }) {
  return (
    <label className="mini" title={title}>
      {label} <b className="mono">{value}</b>
      {/* let go of the slider so P, X, [ ] work again straight away */}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={(e) => e.currentTarget.blur()} aria-label={aria} />
    </label>
  );
}

export type Symmetry = 'off' | 'v' | 'h' | 'both';

export function PaintBar({
  brushId,
  onBrush,
  s,
  set,
  c,
  erase,
  setErase,
  symmetry,
  setSymmetry,
  penFeel,
  setPenFeel,
  target,
  clipped,
  onDeselect,
  clone,
}: {
  /** the Clone brush: is a source set, and does it copy from all layers */
  clone?: { set: boolean; merged: boolean; setMerged: (v: boolean) => void };
  clipped?: boolean;
  onDeselect?: () => void;
  brushId: string;
  onBrush: (id: string) => void;
  s: BrushSettings;
  set: (patch: Partial<BrushSettings>) => void;
  c: ColourState;
  erase: boolean;
  setErase: (v: boolean) => void;
  symmetry: Symmetry;
  setSymmetry: (v: Symmetry) => void;
  penFeel: number;
  setPenFeel: (v: number) => void;
  target: { layer: string; mask: boolean } | null;
}) {
  const preset = brushById(brushId);
  return (
    <div className="paint-bar" role="toolbar" aria-label="Paint" onPointerDown={(e) => e.stopPropagation()}>
      <Pop
        className="brush-pop"
        title="Brush"
        label={
          <>
            {preset.label} <ChevronDown size={13} />
          </>
        }
      >
        <div className="brush-grid" role="listbox" aria-label="Brushes">
          {BRUSHES.map((b) => (
            <button key={b.id} type="button" role="option" aria-selected={b.id === brushId} className={`brush-cell ${b.id === brushId ? 'on' : ''}`} title={b.tip} onClick={() => onBrush(b.id)}>
              <BrushIcon id={b.id} />
              <span>{b.label}</span>
            </button>
          ))}
        </div>
        <p className="note" style={{ margin: '6px 0' }}>
          {preset.tip}
          {preset.engine === 'smudge' || preset.engine === 'filter' ? ' Works on the selected layer’s own pixels.' : ''}
        </p>
        <div className="brush-more">
          <Mini label="Hardness" value={Math.round(s.hardness * 100)} min={0} max={100} onChange={(v) => set({ hardness: v / 100 })} aria="Brush hardness" />
          <Mini label="Spacing" value={Math.round(s.spacing * 100)} min={2} max={60} onChange={(v) => set({ spacing: v / 100 })} aria="Brush spacing" />
          <div className="pen-toggles" title="What pen pressure changes">
            Pen
            <button type="button" className={`pill ${s.pressureSize ? 'on' : ''}`} aria-pressed={s.pressureSize} onClick={() => set({ pressureSize: !s.pressureSize })}>
              size
            </button>
            <button type="button" className={`pill ${s.pressureOpacity ? 'on' : ''}`} aria-pressed={s.pressureOpacity} onClick={() => set({ pressureOpacity: !s.pressureOpacity })}>
              opacity
            </button>
          </div>
          {s.engine === 'paint' && (
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={s.texture} onChange={(e) => set({ texture: e.target.checked })} /> Paper grain
            </label>
          )}
          <label className="mini wide" title="How hard you need to press: soft reaches full size with a light touch, firm needs pressure. For all brushes.">
            Pen feel <b className="mono">{penFeel < -0.15 ? 'soft' : penFeel > 0.15 ? 'firm' : 'even'}</b>
            <input type="range" min={-100} max={100} value={Math.round(penFeel * 100)} onChange={(e) => setPenFeel(Number(e.target.value) / 100)} aria-label="Pen feel" />
          </label>
        </div>
      </Pop>
      {s.engine === 'paint' && <ColourButton c={c} />}
      {s.engine === 'paint' && (
        <div className="swatches" aria-label="Recent colours">
          {c.recent.slice(0, 5).map((x) => (
            <button key={x} type="button" style={{ background: x }} title={x} aria-label={`Use ${x}`} onClick={() => c.setColour(x)} />
          ))}
        </div>
      )}
      {s.engine === 'paint' && (
        <span className="note" title="Alt-click the picture to pick a colour">
          <Pipette size={13} /> Alt
        </span>
      )}
      {s.engine === 'clone' && clone && (
        <>
          <span className={`note ${clone.set ? '' : 'clip-note'}`}>{clone.set ? 'Alt-click to copy from somewhere else' : 'Alt-click where to copy from'}</span>
          <label className="check" style={{ margin: 0 }} title="Copy what you see (all layers); off copies only the selected layer">
            <input type="checkbox" checked={clone.merged} onChange={(e) => clone.setMerged(e.target.checked)} /> All layers
          </label>
        </>
      )}
      <Mini label="Size" value={s.size} min={1} max={500} onChange={(v) => set({ size: v })} aria="Brush size" title="Brush size ([ and ])" />
      <Mini label={s.engine === 'paint' ? 'Opacity' : 'Strength'} value={Math.round(s.opacity * 100)} min={1} max={100} onChange={(v) => set({ opacity: v / 100 })} aria="Brush opacity" />
      <Mini label="Smooth" value={Math.round(s.smoothing * 100)} min={0} max={90} onChange={(v) => set({ smoothing: v / 100 })} aria="Stabiliser" title="Stabiliser: the line lags behind the pen to smooth out wobble" />
      <button type="button" className={`btn sm ${erase ? 'on' : ''}`} aria-pressed={erase} onClick={() => setErase(!erase)} title="Erase (X). The pen's eraser end erases too.">
        <Eraser size={14} /> {target?.mask ? (erase ? 'Show' : 'Hide') : 'Erase'}
      </button>
      <div className="segmented sym" role="group" aria-label="Symmetry" title="Mirror what you paint across the middle of the picture">
        <button type="button" aria-pressed={symmetry === 'v' || symmetry === 'both'} aria-label="Mirror left and right" onClick={() => setSymmetry(symmetry === 'v' ? 'off' : symmetry === 'both' ? 'h' : symmetry === 'h' ? 'both' : 'v')}>
          <SquareSplitHorizontal size={14} />
        </button>
        <button type="button" aria-pressed={symmetry === 'h' || symmetry === 'both'} aria-label="Mirror top and bottom" onClick={() => setSymmetry(symmetry === 'h' ? 'off' : symmetry === 'both' ? 'v' : symmetry === 'v' ? 'both' : 'h')}>
          <SquareSplitVertical size={14} />
        </button>
      </div>
      {target && (
        <span className="paint-target">
          on <b>{target.layer}</b>
          {target.mask ? ' · mask' : ''}
        </span>
      )}
      {clipped && (
        <span className="clip-note" title="You paint only inside the selection">
          inside the selection
          <button type="button" className="btn xs ghost" onClick={onDeselect} title="Deselect (Ctrl+D)">
            Deselect
          </button>
        </span>
      )}
    </div>
  );
}

/** Tiny drawings of each brush for the brush grid. */
function BrushIcon({ id }: { id: string }) {
  const p = brushById(id);
  const stroke = 'currentColor';
  if (p.engine === 'filter') {
    const fill = { blur: 'url(#bi-soft)', dodge: '#f2efe6', burn: '#3a332a', sponge: '#8a8a8a', saturate: '#e0573d' }[p.filter ?? 'blur'];
    return (
      <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true">
        <defs>
          <radialGradient id="bi-soft">
            <stop offset="0" stopColor="#bbb" />
            <stop offset="1" stopColor="#bbb" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="17" cy="11" r="9" fill={fill} stroke={p.filter === 'blur' ? 'none' : stroke} strokeOpacity=".35" />
      </svg>
    );
  }
  if (id === 'clone')
    return (
      <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true">
        <circle cx="10" cy="11" r="6" fill="none" stroke={stroke} strokeDasharray="2 2" />
        <circle cx="24" cy="11" r="6" fill={stroke} opacity=".7" />
        <path d="M15 11 h4" stroke={stroke} />
      </svg>
    );
  const w = { pencil: 1.2, ink: 2.4, marker: 6, airbrush: 9, chalk: 5, round: 4, smudge: 5 }[id] ?? 3;
  return (
    <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true">
      <path d="M3 16 C 10 4, 20 20, 31 7" fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round" opacity={id === 'marker' ? 0.55 : id === 'airbrush' ? 0.35 : 1} strokeDasharray={id === 'chalk' || id === 'pencil' ? '1.5 1' : undefined} style={id === 'airbrush' ? { filter: 'blur(1.5px)' } : undefined} />
      {id === 'smudge' && <path d="M24 9 l6 -3" stroke={stroke} strokeWidth="1.5" />}
    </svg>
  );
}

export function FillBar({ c, tolerance, setTolerance, contiguous, setContiguous, merged, setMerged, opacity, setOpacity }: { c: ColourState; tolerance: number; setTolerance: (v: number) => void; contiguous: boolean; setContiguous: (v: boolean) => void; merged: boolean; setMerged: (v: boolean) => void; opacity: number; setOpacity: (v: number) => void }) {
  return (
    <div className="paint-bar" role="toolbar" aria-label="Fill" onPointerDown={(e) => e.stopPropagation()}>
      <ColourButton c={c} />
      <Mini label="Tolerance" value={tolerance} min={0} max={255} onChange={setTolerance} aria="Fill tolerance" title="How different a colour may be and still be filled" />
      <Mini label="Opacity" value={Math.round(opacity * 100)} min={1} max={100} onChange={(v) => setOpacity(v / 100)} aria="Fill opacity" />
      <label className="check" style={{ margin: 0 }} title="Only the connected area you click; off fills that colour everywhere">
        <input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} /> Connected only
      </label>
      <label className="check" style={{ margin: 0 }} title="Find the edges in the whole picture (e.g. fill line art drawn on another layer)">
        <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} /> Use all layers
      </label>
      <span className="note">Click to fill the selected layer</span>
    </div>
  );
}

export type ShapeKind = 'line' | 'rect' | 'ellipse';

export function ShapeBar({ c, kind, setKind, filled, setFilled, size, setSize, opacity, setOpacity }: { c: ColourState; kind: ShapeKind; setKind: (k: ShapeKind) => void; filled: boolean; setFilled: (v: boolean) => void; size: number; setSize: (v: number) => void; opacity: number; setOpacity: (v: number) => void }) {
  return (
    <div className="paint-bar" role="toolbar" aria-label="Shapes" onPointerDown={(e) => e.stopPropagation()}>
      <div className="segmented sym" role="group" aria-label="Shape">
        {(
          [
            ['line', <Minus key="l" size={14} />, 'Line'],
            ['rect', <Square key="r" size={14} />, 'Rectangle'],
            ['ellipse', <Circle key="e" size={14} />, 'Ellipse'],
          ] as const
        ).map(([k, icon, label]) => (
          <button key={k} type="button" aria-pressed={kind === k} aria-label={label} title={label} onClick={() => setKind(k)}>
            {icon}
          </button>
        ))}
      </div>
      <ColourButton c={c} />
      {kind !== 'line' && (
        <div className="segmented sym" role="group" aria-label="Outline or filled">
          <button type="button" aria-pressed={!filled} onClick={() => setFilled(false)}>
            Outline
          </button>
          <button type="button" aria-pressed={filled} onClick={() => setFilled(true)}>
            Filled
          </button>
        </div>
      )}
      {(!filled || kind === 'line') && <Mini label="Width" value={size} min={1} max={200} onChange={setSize} aria="Line width" />}
      <Mini label="Opacity" value={Math.round(opacity * 100)} min={1} max={100} onChange={(v) => setOpacity(v / 100)} aria="Shape opacity" />
      <span className="note">Drag to draw · Shift keeps it square / straight</span>
    </div>
  );
}

export type SelOpUi = 'add' | 'subtract' | 'intersect' | 'replace';

/**
 * Selection options (Edit suite v3.27): how a new selection combines with the one there is (Shift adds, Alt subtracts,
 * Shift+Alt intersects, whatever is chosen here), the marquee's shape, the wand's tolerance, and the selection menu.
 */
export function SelectBar({
  tool,
  op,
  setOp,
  marquee,
  setMarquee,
  wand,
  setWand,
  amount,
  setAmount,
  has,
  hasLayers,
  act,
}: {
  tool: 'marquee' | 'wand' | 'lasso';
  op: SelOpUi;
  setOp: (o: SelOpUi) => void;
  marquee: 'rect' | 'ellipse';
  setMarquee: (k: 'rect' | 'ellipse') => void;
  wand: { tolerance: number; contiguous: boolean; merged: boolean };
  setWand: (w: Partial<{ tolerance: number; contiguous: boolean; merged: boolean }>) => void;
  amount: number;
  setAmount: (n: number) => void;
  has: boolean;
  hasLayers: boolean;
  act: (a: 'all' | 'none' | 'invert' | 'grow' | 'shrink' | 'feather' | 'border' | 'layer') => void;
}) {
  return (
    <div className="paint-bar" role="toolbar" aria-label="Selection" onPointerDown={(e) => e.stopPropagation()}>
      <div className="segmented sym" role="group" aria-label="Selection mode" title="Shift adds, Alt takes away, Shift+Alt keeps only the overlap">
        {(['add', 'subtract', 'intersect', 'replace'] as SelOpUi[]).map((o) => (
          <button key={o} type="button" aria-pressed={op === o} onClick={() => setOp(o)}>
            {{ add: 'Add', subtract: 'Subtract', intersect: 'Overlap', replace: 'New' }[o]}
          </button>
        ))}
      </div>
      {tool === 'marquee' && (
        <div className="segmented sym" role="group" aria-label="Marquee shape">
          <button type="button" aria-pressed={marquee === 'rect'} aria-label="Rectangle selection" onClick={() => setMarquee('rect')}>
            <Square size={14} />
          </button>
          <button type="button" aria-pressed={marquee === 'ellipse'} aria-label="Ellipse selection" onClick={() => setMarquee('ellipse')}>
            <Circle size={14} />
          </button>
        </div>
      )}
      {tool === 'wand' && (
        <>
          <Mini label="Tolerance" value={wand.tolerance} min={0} max={255} onChange={(v) => setWand({ tolerance: v })} aria="Wand tolerance" title="How different a colour may be and still be selected" />
          <label className="check" style={{ margin: 0 }} title="Only the connected area you click; off selects that colour everywhere">
            <input type="checkbox" checked={wand.contiguous} onChange={(e) => setWand({ contiguous: e.target.checked })} /> Connected only
          </label>
          <label className="check" style={{ margin: 0 }} title="Look at the whole picture, not just the selected layer">
            <input type="checkbox" checked={wand.merged} onChange={(e) => setWand({ merged: e.target.checked })} /> Use all layers
          </label>
        </>
      )}
      <span className="sel-menu" role="group" aria-label="Selection menu">
        <button type="button" className="btn xs" onClick={() => act('all')} title="Select all (Ctrl+A)">
          All
        </button>
        <button type="button" className="btn xs" disabled={!has} onClick={() => act('none')} title="Deselect (Ctrl+D)">
          None
        </button>
        <button type="button" className="btn xs" disabled={!has} onClick={() => act('invert')} title="Invert (Ctrl+Shift+I)">
          Invert
        </button>
        {hasLayers && (
          <button type="button" className="btn xs" onClick={() => act('layer')} title="Select what is painted on the selected layer">
            From layer
          </button>
        )}
        <label className="px-input" title="Pixels for Grow, Shrink, Feather and Border">
          <input className="input sm mono" type="number" min={1} max={200} value={amount} onChange={(e) => setAmount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} aria-label="Selection pixels" />
          px
        </label>
        <button type="button" className="btn xs" disabled={!has} onClick={() => act('grow')}>
          Grow
        </button>
        <button type="button" className="btn xs" disabled={!has} onClick={() => act('shrink')}>
          Shrink
        </button>
        <button type="button" className="btn xs" disabled={!has} onClick={() => act('feather')}>
          Feather
        </button>
        <button type="button" className="btn xs" disabled={!has} onClick={() => act('border')}>
          Border
        </button>
      </span>
    </div>
  );
}
