/**
 * Read Darkroom's settings back out of a PNG (Addendum 1 H, "Restore settings from image"). ComfyUI's SaveImage writes
 * every extra_pnginfo key as a tEXt chunk whose text is JSON; Darkroom's key is "darkroom" (see jobs.ts). Also accepts
 * iTXt (uncompressed) in case another tool re-saved the file.
 */
export interface DarkroomMeta {
  app?: string;
  workflow?: string;
  mode?: string;
  model?: string;
  prompt?: string;
  params?: Record<string, unknown>;
  ui?: Record<string, unknown> | null;
  parent?: string | null;
  job?: string;
}

export function pngTextChunks(buf: Uint8Array): Record<string, string> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) return {};
  const out: Record<string, string> = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder('utf-8');
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) out[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(z + 1));
    } else if (type === 'iTXt') {
      // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
      const z = data.indexOf(0);
      if (z > 0 && data[z + 1] === 0) {
        let q = z + 3;
        q = data.indexOf(0, q) + 1; // language tag
        q = data.indexOf(0, q) + 1; // translated keyword
        if (q > 0) out[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(q));
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/** Darkroom settings from a PNG, or from a settings JSON (sidecar); null when neither holds them. */
export function readDarkroomMeta(buf: Uint8Array): DarkroomMeta | null {
  const text = pngTextChunks(buf).darkroom;
  const raw = text ?? (buf[0] === 0x7b ? new TextDecoder().decode(buf) : null); // "{" = a JSON sidecar
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const m = (j.darkroom ?? j) as DarkroomMeta;
    return m && (m.prompt !== undefined || m.params || m.ui) ? m : null;
  } catch {
    return null;
  }
}
