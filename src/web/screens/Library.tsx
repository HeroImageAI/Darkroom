import { useEffect, useRef, useState } from 'react';
import { Copy, Download, ExternalLink, Film, Heart, Layers, Search, Share2, Sparkles } from 'lucide-react';
import { api, downloadUrl, fileUrl, graphUrl, thumbUrl, type Item } from '../api';
import { formatDuration, Pills } from '../components/common';
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
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

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
        })
        .catch((e) => toast((e as Error).message, 'error'))
        .finally(() => live && setLoading(false));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filter, q, rev]);

  const more = async () => {
    const r = await api.items({ filter, q, limit: PAGE, offset: items.length });
    setItems((x) => [...x, ...r.items]);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const sel = items.find((i) => i.id === selected) ?? null;

  return (
    <div className="screen" style={{ gridTemplateColumns: '1fr 420px' }}>
      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }} aria-label="Library">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
          <Pills label="Filter" options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} value={filter} onChange={setFilter} />
          <div style={{ flex: 1 }} />
          <label style={{ position: 'relative', width: 320 }}>
            <span className="sr">Search</span>
            <Search size={15} style={{ position: 'absolute', left: 12, top: 13, color: 'var(--muted)' }} />
            <input ref={searchRef} className="input" style={{ paddingLeft: 34 }} placeholder="Search prompt, seed or tag  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <span className="mono muted" style={{ fontSize: 12, minWidth: 70, textAlign: 'right' }}>
            {total} items
          </span>
        </div>
        <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
          {!loading && items.length === 0 ? (
            <div className="empty" style={{ margin: '80px auto' }}>
              <h2>{q || filter !== 'all' ? 'Nothing matches' : 'Your library is empty'}</h2>
              <p>{q || filter !== 'all' ? 'Try another filter or search term.' : 'Everything you generate, edit or animate is saved here automatically, with all its settings.'}</p>
              {!q && filter === 'all' && (
                <button className="btn primary" onClick={() => go('generate')}>
                  Go to Generate
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }} role="list">
              {items.map((it) => (
                <Tile key={it.id} item={it} selected={it.id === selected} onSelect={() => setSelected(it.id)} />
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
        {sel ? <Detail item={sel} comfyUrl={comfyUrl} /> : <div className="empty" style={{ margin: 'auto' }}>Select an item to see its settings and actions.</div>}
      </aside>
    </div>
  );
}

function Tile({ item, selected, onSelect }: { item: Item; selected: boolean; onSelect: () => void }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  return (
    <button
      role="listitem"
      className="tile"
      onClick={onSelect}
      onDoubleClick={() => (item.kind === 'video' ? go('video', undefined, { take: item.id }) : go('edit', item.id))}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-darkroom-item', item.id)}
      aria-pressed={selected}
      aria-label={`${item.kind} ${item.prompt || item.mode}`}
      style={{
        position: 'relative',
        aspectRatio: '1',
        padding: 0,
        borderRadius: 10,
        overflow: 'hidden',
        border: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
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
    </button>
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

function Detail({ item, comfyUrl }: { item: Item; comfyUrl: string | null }) {
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
            <img src={fileUrl(item.id)} alt={item.prompt} style={{ width: '100%', height: 360, objectFit: 'contain', display: 'block' }} />
          )}
        </div>
        <div className="field-row" style={{ flexWrap: 'wrap' }}>
          {item.kind === 'image' && (
            <button className="btn sm" onClick={() => go('generate', undefined, { reuse: item.id })}>
              <Copy size={14} /> Reuse settings
            </button>
          )}
          {item.kind === 'video' && (
            <button className="btn sm" onClick={() => go('video', undefined, { reuse: item.id })} title="Load this clip's frames, motion prompt, model and length into the Video screen">
              <Copy size={14} /> Reuse settings
            </button>
          )}
          {item.kind === 'video' && (
            <button className="btn sm" onClick={() => go('video', undefined, { take: item.id })} title="Open in the Video screen">
              <Film size={14} /> Open in Video
            </button>
          )}
          {item.kind === 'image' && (
            <button className="btn sm" onClick={() => go('edit', item.id)}>
              <Layers size={14} /> Send to Edit
            </button>
          )}
          {item.kind === 'image' && (
            <button
              className="btn sm"
              onClick={() => {
                sessionStorage.setItem('dr.edit.mode', 'enhance');
                go('edit', item.id);
              }}
            >
              <Sparkles size={14} /> Enhance
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
          <button
            className="btn sm"
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
