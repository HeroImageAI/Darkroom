import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Film, Heart, Layers, Maximize2, RotateCcw, Search, Share2, Sparkles, Trash2 } from 'lucide-react';
import { api, downloadUrl, fileUrl, graphUrl, thumbUrl, type Item } from '../api';
import { Dialog, formatDuration, Pills } from '../components/common';
import { usePersistent } from '../lib/hooks';
import { go } from '../router';
import { toast, useApp } from '../store';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'favourites', label: 'Favourites' },
  { value: 'klein', label: 'Klein' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'edits', label: 'Edits' },
  { value: 'videos', label: 'Videos' },
  { value: 'deleted', label: 'Recently deleted' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

const PAGE = 60;

export function Library() {
  const rev = useApp((s) => s.libraryRev);
  const comfyUrl = useApp((s) => s.status?.url ?? s.boot?.comfyUrl ?? null);
  const [filter, setFilter] = usePersistent<Filter>('library.filter', 'all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = usePersistent<string | null>('library.selected', null);
  /** Multi-select (Ctrl/Cmd-click toggles, Shift-click selects a range); drives the selection bar and Delete. */
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[] } | { all: true } | null>(null);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const trash = filter === 'deleted';

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      api
        .items({ filter, q, limit: PAGE })
        .then((r) => {
          if (!live) return;
          setItems(r.items);
          setTotal(r.total);
          setPicked((p) => p.filter((id) => r.items.some((i) => i.id === id)));
        })
        .catch((e) => toast((e as Error).message, 'error'))
        .finally(() => live && setLoading(false));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filter, q, rev]);
  // switching filter drops the old list at once, so nothing from the previous view can be clicked or acted on
  useEffect(() => {
    setPicked([]);
    setAnchor(null);
    setItems([]);
    setLoading(true);
  }, [filter]);

  const more = async () => {
    const r = await api.items({ filter, q, limit: PAGE, offset: items.length });
    setItems((x) => [...x, ...r.items]);
  };

  const sel = items.find((i) => i.id === selected) ?? null;
  /** What Delete / Restore acts on: the multi-selection, else the item open in the details panel. */
  const targets = picked.length ? picked : sel ? [sel.id] : [];
  const count = (n: number) => (n === 1 ? '1 item' : `${n} items`);

  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await api.deleteItems(ids);
      setPicked([]);
      if (selected && r.deleted.includes(selected)) setSelected(null);
      toast(`${count(r.deleted.length)} moved to Recently deleted.`, 'ok', 8000, {
        label: 'Undo',
        run: () => void api.restoreItems(r.deleted).then(() => toast('Restored.', 'ok')),
      });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const restore = async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await api.restoreItems(ids);
      setPicked([]);
      toast(`${count(r.restored.length)} restored to the Library.`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const purge = async (body: { ids: string[] } | { all: true }) => {
    setConfirm(null);
    try {
      const r = await api.purgeItems(body);
      setPicked([]);
      setSelected(null);
      if (r.failed.length) toast(`Deleted ${count(r.purged)} for good; ${r.failed.length} file(s) could not be moved to the Recycle Bin.`, 'error');
      else toast(`Deleted ${count(r.purged)} for good. The files are in the Windows Recycle Bin.`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const pick = (it: Item, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => i.id === anchor);
      const b = items.findIndex((i) => i.id === it.id);
      const range = items.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.id);
      setPicked((p) => [...new Set([...p, ...range])]);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setPicked((p) => (p.includes(it.id) ? p.filter((x) => x !== it.id) : [...p, it.id]));
      setAnchor(it.id);
      return;
    }
    setPicked([]);
    setAnchor(it.id);
    setSelected(it.id);
  };

  // one stable listener reading the latest state through a ref: re-subscribing per render missed a Delete pressed
  // right after a click (the new listener was not attached yet)
  const keys = useRef({ targets, trash, confirm, picked, items, remove });
  keys.current = { targets, trash, confirm, picked, items, remove };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const st = keys.current;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Delete' && !typing && st.targets.length && !st.confirm) {
        e.preventDefault();
        if (st.trash) setConfirm({ ids: st.targets });
        else void st.remove(st.targets);
      } else if (e.key === 'Escape' && st.picked.length && !st.confirm) {
        setPicked([]);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing) {
        e.preventDefault();
        setPicked(st.items.map((i) => i.id));
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const confirmText =
    confirm && 'all' in confirm
      ? `All ${count(total)} in Recently deleted`
      : confirm && confirm.ids.length === 1
        ? 'This item'
        : `These ${confirm?.ids.length ?? 0} items`;

  return (
    <div className="screen" style={{ gridTemplateColumns: '1fr minmax(340px, 420px)' }}>
      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }} aria-label="Library">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <Pills label="Filter" options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} value={filter} onChange={setFilter} />
          <div style={{ flex: 1 }} />
          <label style={{ position: 'relative', width: 'min(320px, 100%)' }}>
            <span className="sr">Search</span>
            <Search size={15} style={{ position: 'absolute', left: 12, top: 13, color: 'var(--muted)' }} />
            <input ref={searchRef} className="input" style={{ paddingLeft: 34 }} placeholder="Search prompt, seed or tag  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <span className="mono muted" style={{ fontSize: 12, minWidth: 70, textAlign: 'right' }}>
            {total} items
          </span>
        </div>
        {(picked.length > 0 || trash) && (
          <div className="selection-bar" role="toolbar" aria-label="Selection">
            {picked.length > 0 ? (
              <>
                <span>
                  <b>{picked.length}</b> selected
                </span>
                <button className="btn sm ghost" onClick={() => setPicked(items.map((i) => i.id))}>
                  Select all
                </button>
                <button className="btn sm ghost" onClick={() => setPicked([])}>
                  Clear
                </button>
                <div style={{ flex: 1 }} />
                {trash ? (
                  <>
                    <button className="btn sm" onClick={() => void restore(picked)}>
                      <RotateCcw size={14} /> Restore
                    </button>
                    <button className="btn sm danger" onClick={() => setConfirm({ ids: picked })}>
                      <Trash2 size={14} /> Delete forever
                    </button>
                  </>
                ) : (
                  <button className="btn sm danger" onClick={() => void remove(picked)}>
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </>
            ) : (
              <>
                <span className="muted">Deleted items wait here until you delete them for good; their files then go to the Windows Recycle Bin.</span>
                <div style={{ flex: 1 }} />
                <button className="btn sm danger" disabled={!total} onClick={() => setConfirm({ all: true })}>
                  <Trash2 size={14} /> Empty
                </button>
              </>
            )}
          </div>
        )}
        <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
          {!loading && items.length === 0 ? (
            <div className="empty" style={{ margin: '80px auto' }}>
              <h2>{trash ? 'Nothing deleted' : q || filter !== 'all' ? 'Nothing matches' : 'Your library is empty'}</h2>
              <p>
                {trash
                  ? 'Items you delete wait here, so you can change your mind.'
                  : q || filter !== 'all'
                    ? 'Try another filter or search term.'
                    : 'Everything you generate, edit or animate is saved here automatically, with all its settings.'}
              </p>
              {!q && filter === 'all' && (
                <button className="btn primary" onClick={() => go('generate')}>
                  Go to Generate
                </button>
              )}
            </div>
          ) : (
            <div className="library-grid" role="list">
              {items.map((it) => (
                <Tile
                  key={it.id}
                  item={it}
                  selected={it.id === selected && !picked.length}
                  picked={picked.includes(it.id)}
                  onPick={(e) => pick(it, e)}
                  onSelect={() => {
                    setPicked([]);
                    setSelected(it.id);
                  }}
                  onDelete={trash ? undefined : () => void remove([it.id])}
                />
              ))}
            </div>
          )}
          {items.length < total && (
            <div style={{ display: 'grid', placeItems: 'center', padding: 20 }}>
              <button className="btn" onClick={more}>
                Load more
              </button>
            </div>
          )}
        </div>
      </section>
      <aside className="panel right" aria-label="Details">
        {picked.length > 1 ? (
          <div className="empty" style={{ margin: 'auto' }}>
            <h2>{picked.length} selected</h2>
            <p>Ctrl-click to add or remove, Shift-click for a range. Press Delete to {trash ? 'delete them for good' : 'move them to Recently deleted'}.</p>
          </div>
        ) : sel ? (
          <Detail item={sel} comfyUrl={comfyUrl} trash={!!sel.deleted_at} onDelete={() => void remove([sel.id])} onRestore={() => void restore([sel.id])} onPurge={() => setConfirm({ ids: [sel.id] })} />
        ) : (
          <div className="empty" style={{ margin: 'auto' }}>
            <h2>No item selected</h2>
            <p>Click a picture or video to see its settings and actions. Ctrl-click or Shift-click to select several, then press Delete to tidy up.</p>
          </div>
        )}
      </aside>
      {confirm && (
        <Dialog title="Delete for good?" onClose={() => setConfirm(null)}>
          <p style={{ marginTop: 0 }}>
            {confirmText} will be removed from the Library, and the files moved to the Windows Recycle Bin. Empty the Recycle Bin to free the disk space.
          </p>
          <div className="field-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => void purge(confirm)}>
              <Trash2 size={14} /> Delete forever
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Right-click "Use as…" (Addendum 1 H): send a picture straight to a slot or mode on another screen. */
function UseAsMenu({ item, x, y, onClose, onDelete }: { item: Item; x: number; y: number; onClose: () => void; onDelete?: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const editIn = (mode: string) => {
    sessionStorage.setItem('dr.edit.mode', mode);
    go('edit', item.id);
  };
  const lastEdit = (() => {
    try {
      return sessionStorage.getItem('dr.edit.last');
    } catch {
      return null;
    }
  })();
  const entries: [string, () => void, boolean?][] = [
    ['Edit', () => go('edit', item.id)],
    ['Inpaint', () => editIn('inpaint')],
    ['Outpaint', () => editIn('outpaint')],
    ['Enhance', () => editIn('enhance')],
    ['Upscale', () => editIn('upscale')],
    ['Generate reference', () => go('generate', undefined, { ref: item.id })],
    [
      'Edit reference (for the picture open in Edit)',
      () => {
        sessionStorage.setItem('dr.edit.ref', item.id);
        go('edit', lastEdit!);
      },
      !lastEdit || lastEdit === item.id,
    ],
    ['Video start frame', () => go('video', undefined, { start: item.id })],
    ['Video end frame', () => go('video', undefined, { end: item.id })],
  ];
  return (
    <div role="menu" aria-label="Use as" className="menu" style={{ position: 'fixed', left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 400), zIndex: 50, width: 270, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 6, boxShadow: '0 12px 32px rgba(0,0,0,.45)' }}>
      <div className="section-label" style={{ padding: '4px 8px' }}>Use as…</div>
      {entries.map(([label, run, disabled]) => (
        <button key={label} role="menuitem" type="button" className="btn ghost sm" disabled={!!disabled} style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => (onClose(), run())}>
          {label}
        </button>
      ))}
      {onDelete && (
        <>
          <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
          <button role="menuitem" type="button" className="btn ghost sm danger-text" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => (onClose(), onDelete())}>
            <Trash2 size={14} /> Delete
          </button>
        </>
      )}
    </div>
  );
}

function Tile({
  item,
  selected,
  picked,
  onPick,
  onSelect,
  onDelete,
}: {
  item: Item;
  selected: boolean;
  picked: boolean;
  onPick: (e: React.MouseEvent) => void;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const vid = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
    {menu && <UseAsMenu item={item} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onDelete={onDelete} />}
    <button
      role="listitem"
      className="tile"
      onContextMenu={(e) => {
        if (item.kind !== 'image') return;
        e.preventDefault();
        onSelect();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onClick={onPick}
      onDoubleClick={() => (item.kind === 'video' ? go('video', undefined, { take: item.id }) : go('edit', item.id))}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-darkroom-item', item.id)}
      aria-pressed={selected || picked}
      aria-label={`${item.kind} ${item.prompt || item.mode}`}
      style={{
        position: 'relative',
        aspectRatio: '1',
        padding: 0,
        borderRadius: 10,
        overflow: 'hidden',
        border: `2px solid ${selected || picked ? 'var(--accent)' : 'transparent'}`,
        background: 'var(--panel)',
      }}
    >
      {item.kind === 'video' && hover ? (
        <video ref={vid} src={fileUrl(item.id)} autoPlay muted loop playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <img src={thumbUrl(item.id)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      )}
      <span style={{ position: 'absolute', left: 6, bottom: 6, display: 'flex', gap: 4 }}>
        {item.kind === 'video' && (
          <span className="mono" style={{ fontSize: 11, background: 'rgba(18,18,16,.85)', padding: '2px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Film size={11} /> {item.duration ? `${item.duration.toFixed(1)}s` : 'video'}
          </span>
        )}
        {item.kind === 'image' && item.version > 1 && (
          <span className="mono" style={{ fontSize: 11, background: 'rgba(18,18,16,.85)', padding: '2px 6px', borderRadius: 4 }}>
            v{item.version}
          </span>
        )}
      </span>
      {item.favourite && <Heart size={16} fill="#F0B44C" color="#F0B44C" style={{ position: 'absolute', right: 8, top: 8 }} />}
      {picked && (
        <span className="tile-check" aria-hidden>
          <Check size={14} strokeWidth={3} />
        </span>
      )}
    </button>
    </>
  );
}

const MODE_LABEL: Record<string, string> = {
  generate: 'Generated',
  'edit:instruct': 'Instruction edit',
  'edit:inpaint': 'Inpaint',
  'edit:outpaint': 'Outpaint',
  'edit:remove_bg': 'Background removed',
  'edit:crop': 'Crop',
  upscale: 'Upscale',
  video: 'Video',
  smooth: 'Smoothed video',
  extend: 'Extended video',
  frame: 'Video frame',
  import: 'Imported',
};

function Detail({
  item,
  comfyUrl,
  trash,
  onDelete,
  onRestore,
  onPurge,
}: {
  item: Item;
  comfyUrl: string | null;
  trash: boolean;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const [fav, setFav] = useState(item.favourite);
  const [vlm, setVlm] = useState<{ busy: string | null; text: string | null; label: string }>({ busy: null, text: (item.ui as any)?.caption ?? null, label: 'Caption' });
  useEffect(() => setVlm({ busy: null, text: (item.ui as any)?.caption ?? null, label: 'Caption' }), [item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const runVlm = async (task: 'caption' | 'reverse', variant: string, label: string) => {
    setVlm((v) => ({ ...v, busy: label }));
    try {
      const r = await api.vlm({ task, variant, itemId: item.id, save: task === 'caption' });
      setVlm({ busy: null, text: r.text, label });
    } catch (e) {
      toast((e as Error).message, 'error');
      setVlm((v) => ({ ...v, busy: null }));
    }
  };
  useEffect(() => setFav(item.favourite), [item.id, item.favourite]);
  const p = item.params as Record<string, unknown>;
  const hidden = new Set(['prompt', 'motion_prompt', 'negative', 'output']);
  return (
    <>
      <div className="panel-scroll">
        <div style={{ borderRadius: 10, overflow: 'hidden', background: 'var(--bg)', display: 'grid', placeItems: 'center', maxHeight: 360 }}>
          {item.kind === 'video' ? (
            <video key={item.id} src={fileUrl(item.id)} poster={item.poster ? fileUrl(item.id, 'poster') : undefined} controls loop style={{ width: '100%', height: 360, objectFit: 'contain', display: 'block' }} />
          ) : (
            <img
              key={item.id}
              src={fileUrl(item.id)}
              alt={item.prompt}
              // full file comes through ComfyUI; while it is offline show Darkroom's cached thumbnail instead of alt text
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.src.includes('/thumb')) img.src = thumbUrl(item.id);
              }}
              style={{ width: '100%', height: 360, objectFit: 'contain', display: 'block' }}
            />
          )}
        </div>
        {trash ? (
          <div className="field-row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={onRestore}>
              <RotateCcw size={14} /> Restore
            </button>
            <button className="btn sm danger" onClick={onPurge}>
              <Trash2 size={14} /> Delete forever
            </button>
            <a className="btn sm ghost" href={downloadUrl(item.id)} download>
              <Download size={14} /> Download
            </a>
          </div>
        ) : (
          <>
            {/* primary actions first; the rest under "More" (the flat row of 11 buttons had no hierarchy) */}
            <div className="field-row" style={{ flexWrap: 'wrap' }}>
              {item.kind === 'image' ? (
                <button className="btn sm primary" onClick={() => go('edit', item.id)}>
                  <Layers size={14} /> Send to Edit
                </button>
              ) : (
                <button className="btn sm primary" onClick={() => go('video', undefined, { take: item.id })} title="Open in the Video screen">
                  <Film size={14} /> Open in Video
                </button>
              )}
              {item.kind === 'image' && (
                <button className="btn sm" onClick={() => go('video', undefined, { start: item.id })}>
                  <Film size={14} /> Animate
                </button>
              )}
              <a className="btn sm" href={downloadUrl(item.id)} download>
                <Download size={14} /> Download
              </a>
              <button
                className={`btn sm ${fav ? 'on' : ''}`}
                aria-pressed={fav}
                onClick={async () => {
                  setFav(!fav);
                  await api.favourite(item.id, !fav);
                }}
              >
                <Heart size={14} fill={fav ? 'currentColor' : 'none'} /> Favourite
              </button>
              <button className="btn sm ghost danger-text" onClick={onDelete} title="Move to Recently deleted (Delete key)">
                <Trash2 size={14} /> Delete
              </button>
            </div>
            <div>
              <p className="section-label">More</p>
              <div className="field-row" style={{ flexWrap: 'wrap' }}>
                <button
                  className="btn sm ghost"
                  onClick={() => go(item.kind === 'image' ? 'generate' : 'video', undefined, { reuse: item.id })}
                  title={item.kind === 'video' ? "Load this clip's frames, motion prompt, model and length into the Video screen" : 'Load these settings into Generate'}
                >
                  <Copy size={14} /> Reuse settings
                </button>
                {item.kind === 'image' && (
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      sessionStorage.setItem('dr.edit.mode', 'enhance');
                      go('edit', item.id);
                    }}
                  >
                    <Sparkles size={14} /> Enhance
                  </button>
                )}
                {item.kind === 'image' && (
                  <button
                    className="btn sm ghost"
                    title="SeedVR2 2x. More options (4-8x, tile size) in Edit > Upscale."
                    onClick={async () => {
                      try {
                        const inp = await api.asInput(item.id);
                        await api.submit({
                          workflow: 'upscale',
                          params: { image_1: inp.name, scale: 2, seed: Math.floor(Math.random() * 2 ** 31) },
                          meta: { mode: 'upscale', model: 'SeedVR2 7B 2×', prompt: item.prompt, parentId: item.id, ui: item.ui },
                        });
                        toast('Upscaling 2× with SeedVR2 — the new version appears in the Library when it is ready.', 'info');
                      } catch (e) {
                        toast((e as Error).message, 'error');
                      }
                    }}
                  >
                    <Maximize2 size={14} /> Upscale 2×
                  </button>
                )}
                <a className="btn sm ghost" href={`/api/items/${item.id}/settings`} download title="The settings as a JSON file (also works for videos); load it in Generate > Restore">
                  Settings (JSON)
                </a>
                <button
                  className="btn sm ghost"
                  title="Downloads the exact API graph and opens ComfyUI. Drop the file onto the ComfyUI canvas to load it."
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = graphUrl(item.id);
                    a.download = '';
                    a.click();
                    if (comfyUrl) window.open(comfyUrl, '_blank', 'noopener');
                    toast('Graph downloaded. In ComfyUI, drag the .json file onto the canvas to load the exact graph.', 'info', 9000);
                  }}
                >
                  <ExternalLink size={14} /> Open graph in ComfyUI
                </button>
              </div>
            </div>
          </>
        )}

        <div>
          <p className="section-label">Describe with Qwen3-VL {vlm.busy && <span className="mono">{vlm.busy}…</span>}</p>
          <div className="pills">
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('caption', 'short', 'Short caption')}>Caption: short</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('caption', 'detailed', 'Detailed caption')}>Detailed</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('caption', 'klein', 'Klein-style caption')}>Klein-style</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('reverse', 'klein', 'Prompt for Klein 9B')}>Prompt → Klein</button>
            <button className="pill" disabled={!!vlm.busy} onClick={() => runVlm('reverse', 'qwen', 'Prompt for Qwen-Image 2.1')}>Prompt → Qwen</button>
          </div>
          {vlm.text && (
            <div style={{ marginTop: 8, background: 'var(--bg)', border: '1px solid var(--input)', borderRadius: 8, padding: 10 }}>
              <p className="note" style={{ margin: '0 0 4px' }}>{vlm.label}</p>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}>{vlm.text}</p>
              <div className="field-row" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(vlm.text!); toast('Copied.', 'ok'); }}>
                  <Copy size={14} /> Copy
                </button>
                <button
                  className="btn sm"
                  onClick={() => go('generate', undefined, { prompt: vlm.text!, model: /Qwen/.test(vlm.label) ? 'qwen' : 'klein' })}
                >
                  Use as prompt
                </button>
              </div>
            </div>
          )}
        </div>
        <div>
          <p className="section-label">Prompt</p>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.prompt || <span className="muted">—</span>}</p>
        </div>
        <dl className="kv">
          <dt>Type</dt>
          <dd>{MODE_LABEL[item.mode] ?? item.mode}</dd>
          <dt>Model</dt>
          <dd>{item.model || '—'}</dd>
          <dt>Workflow</dt>
          <dd>{item.workflow}.json</dd>
          <dt>Seed</dt>
          <dd>{item.seed ?? '—'}</dd>
          <dt>Size</dt>
          <dd>{item.width && item.height ? `${item.width} × ${item.height}` : '—'}</dd>
          {item.kind === 'video' && (
            <>
              <dt>Length</dt>
              <dd>
                {item.duration ? `${item.duration.toFixed(2)} s` : '—'} · {item.fps ?? '–'} fps · {item.frames ?? '–'} frames
              </dd>
            </>
          )}
          <dt>Render time</dt>
          <dd>{item.render_ms ? formatDuration(item.render_ms / 1000) : '—'}</dd>
          <dt>Version</dt>
          <dd>
            v{item.version}
            {item.parent_id ? ' (edited from an earlier version)' : ''}
          </dd>
          <dt>Created</dt>
          <dd>{new Date(item.created_at).toLocaleString()}</dd>
          <dt>File</dt>
          <dd>
            {item.file.subfolder ? `${item.file.subfolder}/` : ''}
            {item.file.filename}
          </dd>
          {Object.entries(p)
            .filter(([k]) => !hidden.has(k))
            .map(([k, v]) => (
              <FragmentKV key={k} k={k} v={v} />
            ))}
        </dl>
      </div>
      <div className="panel-foot">
        <button
          className="btn sm ghost"
          onClick={() => {
            void navigator.clipboard.writeText(JSON.stringify({ prompt: item.prompt, seed: item.seed, model: item.model, workflow: item.workflow, params: item.params }, null, 2));
            toast('Settings copied to the clipboard.', 'ok');
          }}
        >
          <Share2 size={14} /> Copy settings as JSON
        </button>
      </div>
    </>
  );
}

function FragmentKV({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
    </>
  );
}
