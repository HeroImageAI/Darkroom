/**
 * Mask layer: an offscreen canvas at the image's native size that stores the
 * mask as white-on-transparent, plus a visible tinted view.
 */
export class MaskLayer {
  readonly mask: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private undoStack: ImageData[] = [];
  private redoStack: ImageData[] = [];
  private last: { x: number; y: number } | null = null;

  constructor(
    public width: number,
    public height: number,
    private view: HTMLCanvasElement,
    private tint = 'rgba(240,180,76,0.55)',
  ) {
    this.mask = document.createElement('canvas');
    this.mask.width = width;
    this.mask.height = height;
    this.ctx = this.mask.getContext('2d', { willReadFrequently: true })!;
    view.width = width;
    view.height = height;
    this.render();
  }

  /** Save state before a change (for undo). */
  checkpoint(): void {
    this.undoStack.push(this.ctx.getImageData(0, 0, this.width, this.height));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.ctx.getImageData(0, 0, this.width, this.height));
    this.ctx.putImageData(prev, 0, 0);
    this.render();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.ctx.getImageData(0, 0, this.width, this.height));
    this.ctx.putImageData(next, 0, 0);
    this.render();
    return true;
  }

  beginStroke(x: number, y: number, size: number, erase: boolean): void {
    this.checkpoint();
    this.last = { x, y };
    this.dab(x, y, size, erase);
  }

  strokeTo(x: number, y: number, size: number, erase: boolean): void {
    if (!this.last) return;
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    c.strokeStyle = '#fff';
    c.lineWidth = size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(this.last.x, this.last.y);
    c.lineTo(x, y);
    c.stroke();
    c.restore();
    this.last = { x, y };
    this.render();
  }

  endStroke(): void {
    this.last = null;
  }

  private dab(x: number, y: number, size: number, erase: boolean): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(x, y, size / 2, 0, Math.PI * 2);
    c.fill();
    c.restore();
    this.render();
  }

  fillPolygon(points: { x: number; y: number }[], erase: boolean): void {
    if (points.length < 3) return;
    this.checkpoint();
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
    c.fill();
    c.restore();
    this.render();
  }

  invert(): void {
    this.checkpoint();
    const d = this.ctx.getImageData(0, 0, this.width, this.height);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
      d.data[i + 3] = 255 - d.data[i + 3];
    }
    this.ctx.putImageData(d, 0, 0);
    this.render();
  }

  clear(): void {
    if (this.isEmpty()) return;
    this.checkpoint();
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.render();
  }

  /** Apply a mask picture (white = selected) with add / subtract / replace. */
  applyMaskImage(img: CanvasImageSource, op: 'add' | 'subtract' | 'replace'): void {
    this.checkpoint();
    const t = document.createElement('canvas');
    t.width = this.width;
    t.height = this.height;
    const tc = t.getContext('2d', { willReadFrequently: true })!;
    tc.drawImage(img, 0, 0, this.width, this.height);
    const d = tc.getImageData(0, 0, this.width, this.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const a = d.data[i];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
      d.data[i + 3] = a;
    }
    tc.putImageData(d, 0, 0);
    if (op === 'replace') this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.save();
    this.ctx.globalCompositeOperation = op === 'subtract' ? 'destination-out' : 'source-over';
    this.ctx.drawImage(t, 0, 0);
    this.ctx.restore();
    this.render();
  }

  isEmpty(): boolean {
    const d = this.ctx.getImageData(0, 0, this.width, this.height).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 8) return false;
    return true;
  }

  render(): void {
    const v = this.view.getContext('2d')!;
    v.clearRect(0, 0, this.width, this.height);
    v.globalCompositeOperation = 'source-over';
    v.drawImage(this.mask, 0, 0);
    v.globalCompositeOperation = 'source-in';
    v.fillStyle = this.tint;
    v.fillRect(0, 0, this.width, this.height);
    v.globalCompositeOperation = 'source-over';
  }

  /** Black background, white = change. Feather in image pixels. */
  exportPng(feather: number): Promise<Blob> {
    const out = document.createElement('canvas');
    out.width = this.width;
    out.height = this.height;
    const c = out.getContext('2d')!;
    c.fillStyle = '#000';
    c.fillRect(0, 0, this.width, this.height);
    if (feather > 0) c.filter = `blur(${feather}px)`;
    c.drawImage(this.mask, 0, 0);
    return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not export mask'))), 'image/png'));
  }
}

/** Padding to reach an aspect ratio by growing the canvas (multiples of 8, split evenly). */
export function padToAspect(w: number, h: number, aspect: number): { left: number; right: number; top: number; bottom: number } {
  const r8 = (n: number) => Math.max(0, Math.round(n / 8) * 8);
  if (w / h < aspect) {
    const total = r8(h * aspect - w);
    const left = r8(total / 2);
    return { left, right: total - left, top: 0, bottom: 0 };
  }
  const total = r8(w / aspect - h);
  const top = r8(total / 2);
  return { left: 0, right: 0, top, bottom: total - top };
}

export function zoomOut(w: number, h: number, factor: number) {
  const r8 = (n: number) => Math.max(0, Math.round(n / 8) * 8);
  const px = r8(((factor - 1) * w) / 2);
  const py = r8(((factor - 1) * h) / 2);
  return { left: px, right: px, top: py, bottom: py };
}
