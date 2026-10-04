import { useEffect, useState } from 'react';
import { api, thumbUrl, type Item } from '../api';
import { Dialog } from './common';

/** "Choose from library" dialog (the non-drag alternative). Images only. */
export function LibraryPicker({ title, onPick, onClose }: { title: string; onPick: (item: Item) => void; onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      api.items({ filter: 'all', q, limit: 60 }).then((r) => setItems(r.items.filter((i) => i.kind === 'image')));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Dialog title={title} onClose={onClose}>
      <input className="input" placeholder="Search title, prompt or seed" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search library" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, maxHeight: 360, overflowY: 'auto' }} role="list">
        {items === null && <p className="note">Loading…</p>}
        {items?.length === 0 && <p className="note">No pictures match.</p>}
        {items?.map((it) => (
          <button key={it.id} role="listitem" className="btn" style={{ padding: 0, aspectRatio: '1', overflow: 'hidden', minHeight: 0 }} onClick={() => onPick(it)} title={it.title || it.prompt} aria-label={`Use ${it.title || it.prompt || 'picture'}`}>
            <img src={thumbUrl(it.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
