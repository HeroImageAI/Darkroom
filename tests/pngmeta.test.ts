import { describe, expect, it } from 'vitest';
import { pngTextChunks, readDarkroomMeta } from '../src/shared/pngmeta';

// Minimal PNG with tEXt chunks (CRC is not checked by the reader, so zeros are fine here).
function png(chunks: [string, string][]): Uint8Array {
  const parts: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  const enc = new TextEncoder();
  const add = (type: string, data: Uint8Array) => {
    const len = data.length;
    parts.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...enc.encode(type), ...data, 0, 0, 0, 0);
  };
  for (const [k, v] of chunks) add('tEXt', new Uint8Array([...enc.encode(k), 0, ...enc.encode(v)]));
  add('IEND', new Uint8Array());
  return new Uint8Array(parts);
}

describe('PNG settings (Restore settings from image)', () => {
  const meta = { app: 'Darkroom', mode: 'generate', model: 'Klein 9B', prompt: 'A fox', params: { seed: 7, steps: 4 }, ui: { model: 'klein', seed: 7 } };
  it('reads the darkroom tEXt chunk ComfyUI writes from extra_pnginfo', () => {
    const b = png([['prompt', '{"1":{}}'], ['darkroom', JSON.stringify(meta)]]);
    expect(Object.keys(pngTextChunks(b))).toEqual(['prompt', 'darkroom']);
    expect(readDarkroomMeta(b)).toEqual(meta);
  });
  it('accepts a JSON sidecar', () => {
    expect(readDarkroomMeta(new TextEncoder().encode(JSON.stringify({ darkroom: meta })))).toEqual(meta);
  });
  it('returns null for a PNG without Darkroom settings and for non-PNG data', () => {
    expect(readDarkroomMeta(png([['prompt', '{}']]))).toBeNull();
    expect(readDarkroomMeta(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
