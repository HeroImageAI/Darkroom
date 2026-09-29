import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/common';

/** Ask the browser to share a screen/window and grab one frame as a canvas. */
export async function grabScreenFrame(): Promise<HTMLCanvasElement> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 250));
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    return c;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** Let the user drag a rectangle on the captured frame; resolves with the cropped PNG. */
export function CropDialog({ source, onDone, onCancel }: { source: HTMLCanvasElement; onDone: (b: Blob) => void; onCancel: () => void }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const url = useRef(source.toDataURL('image/png'));

  const rel = (e: React.PointerEvent) => {
    const b = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(0, e.clientX - b.left), b.width), y: Math.min(Math.max(0, e.clientY - b.top), b.height) };
  };

  const finish = () => {
    const img = imgRef.current!;
    const scale = source.width / img.clientWidth;
    const r = rect && rect.w > 8 && rect.h > 8 ? rect : { x: 0, y: 0, w: img.clientWidth, h: img.clientHeight };
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * scale);
    c.height = Math.round(r.h * scale);
    c.getContext('2d')!.drawImage(source, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, c.width, c.height);
    c.toBlob((b) => b && onDone(b), 'image/png');
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Enter' && finish();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <Dialog title="Select a region" onClose={onCancel}>
      <p className="note">Drag to select the part of the screen to use as a reference. Press Enter or click “Use selection”. No selection uses the whole frame.</p>
      <div style={{ position: 'relative', userSelect: 'none', touchAction: 'none' }}>
        <img
          ref={imgRef}
          src={url.current}
          alt="Captured screen"
          style={{ width: '100%', display: 'block', borderRadius: 8, cursor: 'crosshair' }}
          draggable={false}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            start.current = rel(e);
            setRect({ ...start.current, w: 0, h: 0 });
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            const p = rel(e);
            const s = start.current;
            setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
          }}
          onPointerUp={() => (start.current = null)}
        />
        {rect && rect.w > 0 && (
          <div style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, border: '2px solid var(--accent)', pointerEvents: 'none' }} />
        )}
      </div>
      <div className="row">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={finish}>
          Use selection
        </button>
      </div>
    </Dialog>
  );
}
