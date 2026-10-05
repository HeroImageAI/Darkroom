import { useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { api } from '../api';
import { compositionToEdit } from '../lib/canvasStart';
import { go } from '../router';
import { toast, useApp } from '../store';
import type { Composition } from '../../shared/compose';

/**
 * Compositions made with the old Compose screen (DECISIONS 87), listed on Edit's start screen now that Compose is part
 * of Edit (DECISIONS 125, 126). "Open in Edit" makes a layered copy; the composition itself stays as it was.
 */
export function OldCompositions() {
  const online = useApp((s) => s.status?.comfy === 'online');
  const [comps, setComps] = useState<Omit<Composition, 'doc'>[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api
      .get<Omit<Composition, 'doc'>[]>('/api/compositions')
      .then(setComps)
      .catch(() => setComps([]));
  }, []);
  if (!comps.length) return null;
  const open = async (cid: string) => {
    if (!online) return toast('Start ComfyUI first (top right): the canvas is saved into your Library.', 'info');
    setOpening(cid);
    try {
      go('edit', await compositionToEdit(await api.get<Composition>(`/api/compositions/${cid}`)));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setOpening(null);
    }
  };
  return (
    <div className="old-compositions">
      <p className="section-label" style={{ marginTop: 16 }}>
        Your compositions <span className="mono">{comps.length}</span>
      </p>
      <p className="note" style={{ marginTop: 0 }}>
        Made with the old Compose screen. Open one to keep working on it as layers (a copy: the composition stays as it was).
      </p>
      <div className="compose-list" role="list" aria-label="Compositions">
        {(all ? comps : comps.slice(0, 6)).map((c) => (
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
      {comps.length > 6 && !all && (
        <button type="button" className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setAll(true)}>
          Show all {comps.length}
        </button>
      )}
    </div>
  );
}
