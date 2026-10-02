/**
 * Facts about an MP4 straight from its header boxes (DECISIONS 100): size, frame rate, frame count, length, sound.
 * Used for clips whose length Darkroom does not set itself — imported videos, Auto Duration, restored clips.
 * Reads moov > trak > tkhd (size), mdia > hdlr (video / sound), mdhd (time scale, duration), minf > stbl > stts
 * (frames). No decoding.
 */
export interface Mp4Info {
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  duration: number | null;
  hasAudio: boolean;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header || p + size > to) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const child = (buf: Buffer, b: Box, type: string) => boxes(buf, b.start, b.end).find((x) => x.type === type);

export function mp4Info(buf: Buffer): Mp4Info {
  const info: Mp4Info = { width: null, height: null, fps: null, frames: null, duration: null, hasAudio: false };
  const moov = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
  if (!moov) return info;
  for (const trak of boxes(buf, moov.start, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(buf, mdia, 'hdlr');
    const kind = hdlr ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : '';
    if (kind === 'soun') {
      info.hasAudio = true;
      continue;
    }
    if (kind !== 'vide') continue;
    const tkhd = child(buf, trak, 'tkhd');
    if (tkhd) {
      // width / height: the last 8 bytes, 16.16 fixed point
      info.width = Math.round(buf.readUInt32BE(tkhd.end - 8) / 65536);
      info.height = Math.round(buf.readUInt32BE(tkhd.end - 4) / 65536);
    }
    const mdhd = child(buf, mdia, 'mdhd');
    let timescale = 0;
    let duration = 0;
    if (mdhd) {
      const v = buf.readUInt8(mdhd.start);
      if (v === 1) {
        timescale = buf.readUInt32BE(mdhd.start + 20);
        duration = Number(buf.readBigUInt64BE(mdhd.start + 24));
      } else {
        timescale = buf.readUInt32BE(mdhd.start + 12);
        duration = buf.readUInt32BE(mdhd.start + 16);
      }
    }
    const stbl = (() => {
      const minf = child(buf, mdia, 'minf');
      return minf ? child(buf, minf, 'stbl') : undefined;
    })();
    const stts = stbl ? child(buf, stbl, 'stts') : undefined;
    let frames = 0;
    if (stts) {
      const n = buf.readUInt32BE(stts.start + 4);
      for (let i = 0; i < n; i++) frames += buf.readUInt32BE(stts.start + 8 + i * 8);
    }
    if (timescale && duration) info.duration = duration / timescale;
    if (frames) info.frames = frames;
    if (frames && info.duration) info.fps = Math.round((frames / info.duration) * 1000) / 1000;
  }
  return info;
}
