import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Eye, EyeOff } from 'lucide-react';
import { api, fileUrl, thumbUrl, type Item } from '../api';
import { toast, useApp } from '../store';

export interface LayerRow {
  id: string;
  name: string;
  visible: boolean;
}

const CHECKER =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'%3E%3Crect width='12' height='12' fill='%23222'/%3E%3Crect width='6' height='6' fill='%232b2b2b'/%3E%3Crect x='6' y='6' width='6' height='6' fill='%232b2b2b'/%3E%3C/svg%3E\")";

function defaultName(it: Item, i: number): string {
  if (it.mode === 'edit:plate') return 'Background plate';
  return `Layer ${i + 1}`;
}

/** Layers of one decomposition (group). Rows are top-to-bottom. */
export function useLayerGroup(groupId: string | null) {
  const rev = useApp((s) => s.libraryRev);
  const [rows, setRows] = useState<LayerRow[]>([]);
  const [items, setItems] = useState<Record<string, Item>>({});
  useEffect(() => {
    if (!groupId) {
      setRows([]);
      return;
    }
    api.get<Item[]>(`/api/groups/${groupId}`).then((list) => {
      setItems(Object.fromEntries(list.map((i) => [i.id, i])));
      setRows((prev) => {
        const known = new Map(prev.map((r) => [r.id, r]));
        // object layers on top, background plate at the bottom
        const ordered = [...list.filter((i) => i.mode !== 'edit:plate'), ...list.filter((i) => i.mode === 'edit:plate')];
        return ordered.map((it, i) => known.get(it.id) ?? { id: it.id, name: defaultName(it, i), visible: true });
      });
    });
  }, [groupId, rev]);
  return { rows, setRows, items };
}

/** Stack of visible layers drawn over the canvas area (bottom first). */
export function LayerStack({ rows }: { rows: LayerRow[] }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: CHECKER }}>
      {rows
        .slice()
        .reverse()
        .filter((r) => r.visible)
        .map((r) => (
          <img key={r.id} src={fileUrl(r.id)} alt={r.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
        ))}
    </div>
  );
}

export function LayersPanel({ rows, setRows }: { rows: LayerRow[]; setRows: (f: (r: LayerRow[]) => LayerRow[]) => void }) {
  const [busy, setBusy] = useState(false);
  const move = (i: number, d: number) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const c = r.slice();
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  const exportAs = async (format: 'psd' | 'zip') => {
    setBusy(true);
    try {
      const res = await fetch('/api/layers/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format, layers: rows }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `darkroom-layers.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!rows.length) return null;
  return (
    <div>
      <p className="section-label">
        Layers <span className="mono">{rows.length}</span>
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} role="list" aria-label="Layers">
        {rows.map((r, i) => (
          <div key={r.id} role="listitem" style={{ display: 'grid', gridTemplateColumns: '36px 44px 1fr 32px 32px', gap: 6, alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--input)', borderRadius: 8, padding: 4 }}>
            <button className="btn icon ghost" style={{ width: 36, minHeight: 36 }} aria-pressed={r.visible} aria-label={r.visible ? `Hide ${r.name}` : `Show ${r.name}`} onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, visible: !x.visible } : x)))}>
              {r.visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
            <img src={thumbUrl(r.id)} alt="" style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 4, background: CHECKER }} />
            <input className="input" style={{ minHeight: 34, padding: '4px 8px' }} value={r.name} aria-label="Layer name" onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} />
            <button className="btn icon ghost" style={{ width: 32, minHeight: 32 }} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={14} />
            </button>
            <button className="btn icon ghost" style={{ width: 32, minHeight: 32 }} aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="field-row" style={{ marginTop: 8 }}>
        <button className="btn sm" disabled={busy} onClick={() => exportAs('psd')}>
          <Download size={14} /> Layered PSD
        </button>
        <button className="btn sm" disabled={busy} onClick={() => exportAs('zip')}>
          <Download size={14} /> ZIP of PNGs
        </button>
      </div>
    </div>
  );
}
