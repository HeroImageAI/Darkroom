import { useEffect, useState } from 'react';
import { ArrowRight, ImagePlus, Loader2, Layers as LayersIcon, Scissors, Move, Sparkles } from 'lucide-react';
import { api, type Item } from '../api';
import { LibraryPicker } from '../components/LibraryPicker';
import { NewCanvasButton } from '../components/CanvasTools';
import { compositionToEdit, createCanvas, openWithLayers } from '../lib/canvasStart';
import { go } from '../router';
import { toast, useApp } from '../store';
import type { Composition } from '../../shared/compose';

/**
 * Compose lives in Edit now (DECISIONS 125): one canvas with layers, cut-outs, transform, paint, and the Compose renders
 * (Blend edges, Harmonise, Reimagine) in Edit's AI panel. This screen starts a scene and opens your earlier
 * compositions in Edit (as a copy — the compositions themselves stay as they were).
 */
export function Compose({ id }: { id?: string }) {
  const online = useApp((s) => s.status?.comfy === 'online');
  const [comps, setComps] = useState<Omit<Composition, 'doc'>[] | null>(null);
  const [picker, setPicker] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<Omit<Composition, 'doc'>[]>('/api/compositions')
      .then(setComps)
      .catch(() => setComps([]));
  }, []);
  const open = async (cid: string) => {
    if (!online) return toast('Start ComfyUI first (top right): the canvas is saved into your Library.', 'info');
    setOpening(cid);
    try {
      const comp = await api.get<Composition>(`/api/compositions/${cid}`);
      go('edit', await compositionToEdit(comp));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setOpening(null);
    }
  };
  // an old link straight to a composition: open it in Edit
  useEffect(() => {
    if (id && online) void open(id);
  }, [id, online]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="screen" style={{ placeItems: 'start center', overflowY: 'auto' }}>
      <div className="compose-home">
        <h2>Compose</h2>
        <p className="lede">Build a scene on one canvas in Edit, then let the AI turn it into one picture.</p>
        <ol className="compose-steps">
          <li>
            <LayersIcon size={16} /> Start a canvas, or a picture as the background
          </li>
          <li>
            <ImagePlus size={16} /> Add pictures as layers (Layers › Picture…), and paint
          </li>
          <li>
            <Scissors size={16} /> Cut pieces out (the scissors on a layer)
          </li>
          <li>
            <Move size={16} /> Place them with Transform (T): move, scale, turn, perspective
          </li>
          <li>
            <Sparkles size={16} /> AI › Compose: Blend edges, Harmonise or Reimagine
          </li>
        </ol>
        <div className="field-row" style={{ gap: 8, justifyContent: 'center' }}>
          <NewCanvasButton onCreate={(w, h, bg) => void createCanvas(w, h, bg, 'Scene')} />
          <button className="btn sm" onClick={() => setPicker(true)} title="A picture from the Library as the background of the scene">
            <ImagePlus size={14} /> Start from a picture…
          </button>
        </div>
        {comps && comps.length > 0 && (
          <>
            <p className="section-label" style={{ marginTop: 24 }}>
              Your compositions <span className="mono">{comps.length}</span>
            </p>
            <p className="note" style={{ marginTop: 0 }}>
              Opening one in Edit makes a layered copy of it (each picture and paint layer in its place, the scene description as the Compose prompt). The composition itself stays as it was.
            </p>
            <div className="compose-list" role="list" aria-label="Compositions">
              {comps.map((c) => (
                <div key={c.id} className="compose-card" role="listitem">
                  {c.thumb ? <img src={c.thumb} alt="" /> : <div className="compose-thumb-empty" />}
                  <div className="compose-card-text">
                    <strong>{c.name}</strong>
                    <small className="muted">{new Date(c.updated_at).toLocaleDateString()}</small>
                  </div>
                  <button className="btn sm" disabled={!!opening} onClick={() => void open(c.id)} aria-label={`Open ${c.name} in Edit`}>
                    {opening === c.id ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />} Open in Edit
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {picker && (
        <LibraryPicker
          title="The background of the scene"
          onClose={() => setPicker(false)}
          onPick={(it: Item) => {
            setPicker(false);
            openWithLayers(it.id);
          }}
        />
      )}
    </div>
  );
}
