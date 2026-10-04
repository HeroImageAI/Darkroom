import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clapperboard, Film, ImagePlus, Layers, Library as LibraryIcon, Loader2, Shapes, Wand2 } from 'lucide-react';
import { api, thumbUrl, type Item } from '../api';
import { importFailedMessage, importPictures, importVideos, isVideoFile } from '../lib/importer';
import { go, lastRoute, type Screen } from '../router';
import { toast, useApp } from '../store';

const CARDS: { screen: Screen; title: string; text: string; icon: typeof Wand2 }[] = [
  { screen: 'generate', title: 'Generate', text: 'Create a new picture from a prompt with Klein 9B or Qwen-Image 2.1.', icon: Wand2 },
  { screen: 'edit', title: 'Edit', text: 'Change, fix, extend or upscale a picture — one of yours or one you made.', icon: Layers },
  { screen: 'compose', title: 'Compose', text: 'Arrange pictures, cut-outs and rough paint, then render them into one picture.', icon: Shapes },
  { screen: 'video', title: 'Video', text: 'Bring a picture to life as a clip with LTX 2.5, with sound.', icon: Film },
  { screen: 'timeline', title: 'Timeline', text: 'Put your clips, your own videos and your own sound together into one film.', icon: Clapperboard },
  { screen: 'library', title: 'Library', text: 'Everything you have made or brought in, with its settings.', icon: LibraryIcon },
];

const SCREEN_LABEL: Record<string, string> = { generate: 'Generate', edit: 'Edit', compose: 'Compose', video: 'Video', timeline: 'Timeline', library: 'Library' };

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
    const vids = files.filter(isVideoFile);
    // your own videos (DECISIONS 100): into the Library, then the first one opens on Video
    if (!pics.length && vids.length) {
      if (!online) return toast('Start ComfyUI first (top right): it saves your videos into your library.', 'info');
      setBusy(vids.length === 1 ? 'Bringing in your video…' : `Bringing in 1 of ${vids.length} videos…`);
      const { ids, failed } = await importVideos(vids, (done, total) => done < total && setBusy(`Bringing in ${done + 1} of ${total} videos…`));
      setBusy(null);
      if (failed.length) toast(`Could not bring in ${failed.join(', ')}. If it is an iPhone .mov, export it as MP4 (H.264) first.`, 'error', 12000);
      if (ids[0]) go('video', undefined, { take: ids[0] });
      return;
    }
    if (!pics.length) return toast('Choose picture or video files (JPG, PNG, WebP, MP4…).', 'info');
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
        <h1 className="home-title">What are we developing today?</h1>

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
              accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"
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
