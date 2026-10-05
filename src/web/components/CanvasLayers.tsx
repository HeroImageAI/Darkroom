import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, Eye, EyeOff, ImagePlus, Layers as LayersIcon, Lock, Merge, Plus, Save, SquareDashed, Trash2, Unlock, History, Loader2, SlidersHorizontal } from 'lucide-react';
import { BLENDS, type Blend } from '../../shared/doc';
import type { Item } from '../api';
import type { CanvasDoc, Layer } from '../lib/doc';
import { toast } from '../store';
import { LibraryPicker } from './LibraryPicker';

const CHECKER =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='%23222'/%3E%3Crect width='4' height='4' fill='%232b2b2b'/%3E%3Crect x='4' y='4' width='4' height='4' fill='%232b2b2b'/%3E%3C/svg%3E\")";

/** A layer (or its mask) in miniature, redrawn when the document changes. */
function Thumb({ src, version, mask }: { src: HTMLCanvasElement; version: number; mask?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const s = Math.min(40 / src.width, 40 / src.height);
    c.width = Math.max(1, Math.round(src.width * s));
    c.height = Math.max(1, Math.round(src.height * s));
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (mask) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
    }
    g.drawImage(src, 0, 0, c.width, c.height);
  }, [src, version, mask]);
  return <canvas ref={ref} className="layer-thumb" style={{ background: mask ? '#000' : CHECKER }} aria-hidden="true" />;
}

const KIND_LABEL: Record<Layer['kind'], string> = { picture: 'picture', paint: 'paint', result: 'AI result', adjust: 'adjustment' };

export function CanvasLayers({
  doc,
  version,
  starting,
  onStart,
  lineage,
  itemId,
  onAddItem,
  onMaskFromSelection,
  hasSelection,
  onFlatten,
  flattening,
  onExport,
  onUndoTo,
  saveState,
  onOpenAdjust,
}: {
  doc: CanvasDoc | null;
  version: number;
  starting: boolean;
  onStart: () => void;
  lineage: Item[];
  itemId: string;
  onAddItem: (it: Item) => void;
  onMaskFromSelection: (layerId: string) => void;
  hasSelection: boolean;
  onFlatten: () => void;
  flattening: boolean;
  onExport: () => void;
  /** undo `n` steps */
  onUndoTo: (n: number) => void;
  saveState: 'saved' | 'saving' | 'unsaved' | 'error' | 'none';
  /** show the Adjust tab for an adjustment layer */
  onOpenAdjust: () => void;
}) {
  const [picker, setPicker] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  if (!doc)
    return (
      <div className="canvas-layers">
        <p className="section-label">Layers</p>
        <p className="note" style={{ marginTop: 0 }}>
          Paint, add pictures and keep AI results as layers, each with its own opacity, blend mode and mask. The picture itself stays as it is: Flatten saves the result as a new version.
        </p>
        <button className="btn" onClick={onStart} disabled={starting}>
          {starting ? <Loader2 size={15} className="spin" /> : <LayersIcon size={15} />} Start layers
        </button>
      </div>
    );
  const a = doc.activeLayer;
  const rows = [...doc.layers].reverse();
  const idx = a ? doc.layers.findIndex((l) => l.id === a.id) : -1;
  const versions = lineage.filter((v) => v.id !== itemId && v.kind === 'image');
  return (
    <div className="canvas-layers" data-version={version}>
      <div className="layers-head">
        <p className="section-label" style={{ margin: 0 }}>
          Layers <span className="mono">{doc.layers.length}</span>
        </p>
        <span className={`save-state ${saveState}`} role="status" aria-label="Layers saved">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : saveState === 'unsaved' ? 'Unsaved' : ''}
        </span>
      </div>
      <div className="field-row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => doc.addPaintLayer()} title="A new empty layer above the selected one, to paint on">
          <Plus size={14} /> New layer
        </button>
        <button className="btn sm" onClick={() => setPicker(true)} title="A picture from the Library as a layer, fitted to the canvas">
          <ImagePlus size={14} /> Picture…
        </button>
      </div>
      {versions.length > 0 && (
          <select
            className="input sm"
            aria-label="Add a version as a layer"
            value=""
            onChange={(e) => {
              const v = versions.find((x) => x.id === e.target.value);
              if (v) onAddItem(v);
            }}
          >
            <option value="">Version as layer…</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} · {v.title || v.mode}
              </option>
            ))}
          </select>
      )}
      <ul className="layer-list" role="listbox" aria-label="Layer stack">
        {rows.map((l) => (
          <li
            key={l.id}
            role="option"
            aria-selected={l.id === doc.active}
            className={`layer-row ${l.id === doc.active ? 'on' : ''} ${l.visible ? '' : 'hidden'}`}
            onClick={() => doc.select(l.id, 'pixels')}
            title={`${l.name} · ${KIND_LABEL[l.kind]}`}
          >
            <button
              className="btn icon ghost xs"
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
              onClick={(e) => (e.stopPropagation(), doc.setProps(l.id, { visible: !l.visible }, l.visible ? 'Hide layer' : 'Show layer'))}
            >
              {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <span className={`thumb-wrap ${l.id === doc.active && doc.target === 'pixels' ? 'target' : ''}`} onClick={(e) => (e.stopPropagation(), doc.select(l.id, 'pixels'))}>
              {l.kind === 'adjust' ? (
                <span
                  className="layer-thumb adj-thumb"
                  title="Adjustment layer: open it in Adjust"
                  onDoubleClick={(e) => (e.stopPropagation(), onOpenAdjust())}
                >
                  <SlidersHorizontal size={16} />
                </span>
              ) : (
                <Thumb src={l.canvas} version={l.rev} />
              )}
            </span>
            {l.maskCanvas && (
              <span
                className={`thumb-wrap mask ${l.id === doc.active && doc.target === 'mask' ? 'target' : ''} ${l.maskOn ? '' : 'off'}`}
                title="Layer mask: click to paint on it (the brush hides, the eraser shows). Shift-click turns it off and on."
                aria-label={`Mask of ${l.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) doc.setProps(l.id, { maskOn: !l.maskOn }, l.maskOn ? 'Turn mask off' : 'Turn mask on');
                  else doc.select(l.id, 'mask');
                }}
              >
                <Thumb src={l.maskCanvas} version={l.maskRev} mask />
              </span>
            )}
            {renaming === l.id ? (
              <input
                className="input sm layer-name"
                autoFocus
                defaultValue={l.name}
                aria-label="Layer name"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== l.name) doc.setProps(l.id, { name: v.slice(0, 80) }, 'Rename layer');
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="layer-name" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(l.id))}>
                {l.name}
                <small>
                  {l.blend !== 'normal' ? BLENDS.find((b) => b.id === l.blend)!.label : ''}
                  {l.opacity < 1 ? ` ${Math.round(l.opacity * 100)}%` : ''}
                </small>
              </span>
            )}
            <button
              className={`btn icon ghost xs ${l.locked ? 'on' : ''}`}
              aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
              aria-pressed={l.locked}
              onClick={(e) => (e.stopPropagation(), doc.setProps(l.id, { locked: !l.locked }, l.locked ? 'Unlock layer' : 'Lock layer'))}
            >
              {l.locked ? <Lock size={13} /> : <Unlock size={13} />}
            </button>
          </li>
        ))}
      </ul>
      {a && (
        <div className="layer-props">
          <div className="field-row" style={{ gap: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Blend</span>
              <select className="input sm" value={a.blend} aria-label="Blend mode" onChange={(e) => doc.setProps(a.id, { blend: e.target.value as Blend }, 'Blend mode')}>
                {BLENDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 1.4 }}>
              <span>
                Opacity <b className="mono">{Math.round(a.opacity * 100)}%</b>
              </span>
              <input type="range" min={0} max={100} value={Math.round(a.opacity * 100)} aria-label="Layer opacity" onChange={(e) => doc.setProps(a.id, { opacity: Number(e.target.value) / 100 }, 'Opacity', 'opacity')} />
            </label>
          </div>
          <label className="check" title="Paint only where the layer already has pixels — recolour a shape without going over its edges">
            <input type="checkbox" checked={a.alphaLock} onChange={(e) => doc.setProps(a.id, { alphaLock: e.target.checked }, e.target.checked ? 'Alpha lock on' : 'Alpha lock off')} />
            Alpha lock
          </label>
          <div className="field-row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {a.maskCanvas ? (
              <>
                <button className={`btn sm ${doc.target === 'mask' ? 'on' : ''}`} onClick={() => doc.select(a.id, doc.target === 'mask' ? 'pixels' : 'mask')} title="Paint on the mask: the brush hides, the eraser shows">
                  <SquareDashed size={14} /> {doc.target === 'mask' ? 'Painting the mask' : 'Paint the mask'}
                </button>
                <button className="btn sm ghost" onClick={() => doc.removeMask(a.id)}>
                  <Trash2 size={14} /> Delete mask
                </button>
              </>
            ) : (
              <>
                <button className="btn sm" onClick={() => doc.addMask(a.id)} title="A mask that shows the whole layer; paint on it to hide parts">
                  <SquareDashed size={14} /> Add mask
                </button>
                <button className="btn sm" disabled={!hasSelection} onClick={() => onMaskFromSelection(a.id)} title={hasSelection ? 'Show the layer only where your mask (selection) is' : 'Paint a mask or use Smart select first'}>
                  <SquareDashed size={14} /> Mask from selection
                </button>
              </>
            )}
          </div>
          <div className="field-row layer-actions" style={{ gap: 4 }}>
            <button className="btn icon sm" title="Move up" aria-label="Move layer up" disabled={idx >= doc.layers.length - 1} onClick={() => doc.move(a.id, 1)}>
              <ArrowUp size={14} />
            </button>
            <button className="btn icon sm" title="Move down" aria-label="Move layer down" disabled={idx <= 0} onClick={() => doc.move(a.id, -1)}>
              <ArrowDown size={14} />
            </button>
            <button className="btn icon sm" title="Duplicate" aria-label="Duplicate layer" onClick={() => doc.duplicate(a.id)}>
              <Copy size={14} />
            </button>
            <button className="btn icon sm" title="Merge down" aria-label="Merge layer down" disabled={idx <= 0} onClick={() => {
                const why = doc.mergeDown(a.id);
                if (why) toast(why, 'info');
              }}>
              <Merge size={14} />
            </button>
            <button className="btn icon sm" title="Delete layer (Undo brings it back)" aria-label="Delete layer" disabled={doc.layers.length < 2} onClick={() => doc.remove(a.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
      <details className="adv layer-history" open={showHistory} onToggle={(e) => setShowHistory((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <History size={14} /> History <span className="muted adv-summary">{doc.history.length} step{doc.history.length === 1 ? '' : 's'}</span>
        </summary>
        <ol className="history-list">
          {doc.history.length === 0 && <li className="muted">Nothing yet</li>}
          {doc.history.map((h, i) => (
            <li key={i}>
              <button className="btn xs ghost" title="Undo back to here" aria-label={`Undo back to: ${h}`} onClick={() => onUndoTo(doc.history.length - 1 - i)}>
                {h}
              </button>
            </li>
          ))}
          {doc.future.map((h, i) => (
            <li key={`f${i}`} className="muted future">
              {h}
            </li>
          ))}
        </ol>
      </details>
      <div className="field-row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn sm primary" style={{ flex: 1 }} onClick={onFlatten} disabled={flattening} title="Merge the layers into a new version of the picture (your layers stay here)">
          {flattening ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Flatten to new version
        </button>
        <button className="btn sm" onClick={onExport} title="Download the merged picture as a PNG">
          <Download size={14} /> PNG
        </button>
      </div>
      {picker && (
        <LibraryPicker
          title="Add a picture as a layer"
          onClose={() => setPicker(false)}
          onPick={(it) => {
            setPicker(false);
            onAddItem(it);
          }}
        />
      )}
    </div>
  );
}
