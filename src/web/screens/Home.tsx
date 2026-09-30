import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Film, ImagePlus, Layers, Library as LibraryIcon, Loader2, Wand2 } from 'lucide-react';
import { api, thumbUrl, type Item } from '../api';
import { importFailedMessage, importPictures } from '../lib/importer';
import { go, lastRoute, type Screen } from '../router';
import { toast, useApp } from '../store';

const CARDS: { screen: Screen; title: string; text: string; icon: typeof Wand2 }[] = [
  { screen: 'generate', title: 'Generate', text: 'Create a new picture from a prompt with Klein 9B or Qwen-Image 2.1.', icon: Wand2 },
  { screen: 'edit', title: 'Edit', text: 'Change, fix, extend or upscale a picture — one of yours or one you made.', icon: Layers },
  { screen: 'video', title: 'Video', text: 'Bring a picture to life as a clip with Wan 2.2 or LTX 2.5.', icon: Film },
  { screen: 'library', title: 'Library', text: 'Everything you have made or brought in, with its settings.', icon: LibraryIcon },
];

const SCREEN_LABEL: Record<string, string> = { generate: 'Generate', edit: 'Edit', video: 'Video', library: 'Library' };

/** Start screen: pick what to do, bring in your own pictures, or carry on where you left off. */
export function Home() {
  const online = useApp((s) => s.status?.comfy === 'online');
  const rev = useApp((s) => s.libraryRev);
  const [recent, setRecent] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const last = lastRoute();
  const lastId = last?.path.match(/^(?:edit)\/([^?]+)/)?.[1] ?? last?.path.match(/[?&]take=([^&]+)/)?.[1] ?? null;

  useEffect(() => {
    api
      .items({ filter: 'all', limit: 12 })
      .then((r) => setRecent(r.items.slice(0, 9)))
      .catch(() => undefined);
  }, [rev]);

  const bringIn = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/'));
    if (!pics.length) return toast('Choose picture files (JPG, PNG, WebP…).', 'info');
    if (!online) return toast('Start ComfyUI first (top right): it saves the pictures into your library.', 'info');
    setBusy(pics.length === 1 ? 'Bringing in your picture…' : `Bringing in 1 of ${pics.length}…`);
    const { ids, failed } = await importPictures(pics, (done, total) => done < total && setBusy(`Bringing in ${done + 1} of ${total}…`));
    setBusy(null);
    if (failed.length) toast(importFailedMessage(failed), 'error', 12000);
    if (!ids.length) return;
    if (ids.length > 1) toast(`${ids.length} pictures added to your Library. Opening the first one in Edit.`, 'ok', 6000);
    go('edit', ids[0]);
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.some((f) => f.type.startsWith('image/'))) void bringIn(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  return (
    <div className="screen home" style={{ gridTemplateColumns: '1fr', overflowY: 'auto' }}>
      <div className="home-inner">
        <h1 className="home-title">What would you like to do?</h1>

        <nav className="home-cards" aria-label="Start">
          {CARDS.map((c) => (
            <button key={c.screen} className="home-card" onClick={() => go(c.screen)}>
              <c.icon size={26} aria-hidden />
              <span className="home-card-title">{c.title}</span>
              <span className="home-card-text">{c.text}</span>
            </button>
          ))}
        </nav>

        <div className="home-row">
          <section
            className={`drop home-drop ${over ? 'drag' : ''}`}
            aria-label="Edit your own picture"
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void bringIn([...e.dataTransfer.files]);
            }}
          >
            {busy ? <Loader2 size={24} className="spin" /> : <ImagePlus size={24} aria-hidden />}
            <strong>{busy ?? 'Edit your own picture'}</strong>
            <span className="muted">Drop photos here, paste (Ctrl+V) or browse — several at once. They stay on this PC and are added to your Library.</span>
            <button className="btn primary sm" disabled={!!busy} onClick={() => input.current?.click()}>
              Upload pictures
            </button>
            {!online && <span className="note">ComfyUI needs to be running to bring pictures in.</span>}
            <input
              ref={input}
              className="sr"
              type="file"
              accept="image/*"
              multiple
              aria-label="Upload pictures"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void bringIn(files);
              }}
            />
          </section>

          {last && (
            <button className="home-continue" onClick={() => (location.hash = `#/${last.path}`)}>
              {lastId ? (
                <img src={thumbUrl(lastId)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
              ) : (
                <span className="home-continue-icon">{(() => { const I = CARDS.find((c) => c.screen === last.screen)?.icon ?? ArrowRight; return <I size={26} />; })()}</span>
              )}
              <span>
                <span className="section-label" style={{ margin: 0 }}>Continue where you left off</span>
                <strong>{SCREEN_LABEL[last.screen]}</strong>
              </span>
              <ArrowRight size={18} aria-hidden />
            </button>
          )}
        </div>

        {recent.length > 0 && (
          <section aria-label="Recent">
            <p className="section-label">
              Recent
              <button className="btn ghost sm" onClick={() => go('library')}>
                Open the Library <ArrowRight size={14} />
              </button>
            </p>
            <div className="home-recent" role="list">
              {recent.map((i) => (
                <button
                  key={i.id}
                  role="listitem"
                  className="home-thumb"
                  onClick={() => (i.kind === 'video' ? go('video', undefined, { take: i.id }) : go('edit', i.id))}
                  aria-label={`${i.kind === 'video' ? 'Open video' : 'Edit'}: ${i.prompt || i.mode}`}
                >
                  <img src={thumbUrl(i.id)} alt="" loading="lazy" />
                  {i.kind === 'video' && (
                    <span className="home-thumb-badge">
                      <Film size={11} /> video
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
