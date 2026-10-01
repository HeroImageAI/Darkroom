import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/db';
import { autoMode, canvasSizeFor, coverLayer, emptyDoc, placeLayer, renderPlan, sanitiseDoc, seamWidths } from '../src/shared/compose';

describe('compose sizing', () => {
  it('canvas keeps the picture shape at about 1 MP, sides multiples of 16', () => {
    const { width, height } = canvasSizeFor(4000, 3000);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
    expect(width / height).toBeCloseTo(4 / 3, 1);
    expect((width * height) / 2 ** 20).toBeGreaterThan(0.9);
    expect((width * height) / 2 ** 20).toBeLessThan(1.1);
  });
  it('a new piece is centred and fitted; a background covers the canvas', () => {
    expect(placeLayer(1000, 500, 1000, 1000, 0.5)).toEqual({ x: 250, y: 375, w: 500, h: 250 });
    const c = coverLayer(1000, 500, 1000, 1000);
    expect(c.h).toBe(1000);
    expect(c.w).toBe(2000);
    expect(c.x).toBe(-500);
  });
  it('seam band scales with the canvas', () => {
    expect(seamWidths(1216, 832)).toEqual({ outside: 21, inside: 7 });
  });
});

describe('compose modes', () => {
  it('suggests Reimagine for paint and Harmonise for photo pieces', () => {
    expect(autoMode(0.6, 0).mode).toBe('reimagine');
    expect(autoMode(0.3, 2).mode).toBe('reimagine');
    expect(autoMode(0.02, 2).mode).toBe('harmonise');
  });
  it('plans: Blend edges and Harmonise run Qwen, Reimagine runs Klein; the description is added', () => {
    const b = renderPlan('blend', '');
    expect(b).toMatchObject({ workflow: 'qwen_edit', mask: true });
    expect(renderPlan('harmonise', 'a quiet harbour at dusk')).toMatchObject({ workflow: 'qwen_edit', mask: false });
    expect(renderPlan('harmonise', 'a quiet harbour at dusk').prompt).toMatch(/The scene: a quiet harbour at dusk\.$/);
    expect(renderPlan('reimagine', 'Cottage!').prompt).toMatch(/The scene: Cottage!$/);
    expect(renderPlan('reimagine', '').workflow).toBe('klein_edit');
  });
});

describe('sanitiseDoc', () => {
  it('keeps a good document and drops bad layers', () => {
    const doc = sanitiseDoc({
      width: 1216,
      height: 832,
      mode: 'blend',
      description: 'x',
      layers: [
        { id: 'a', kind: 'picture', name: 'Room', src: 'room.png', x: 0, y: 0, w: 1216, h: 832 },
        { id: 'b', kind: 'picture', src: '../evil.png', x: 0, y: 0, w: 5, h: 5 },
        { id: 'b2', kind: 'picture', src: 'C:/x.png', x: 0, y: 0, w: 5, h: 5 },
        { id: 'f', kind: 'picture', src: 'darkroom/in_1.png', x: 0, y: 0, w: 5, h: 5 },
        { id: 'c', kind: 'paint', paint: 'data:image/png;base64,AAAA', x: 0, y: 0, w: 1216, h: 832 },
        { id: 'd', kind: 'paint', paint: 'javascript:alert(1)' },
        { id: 'e', kind: 'video' },
      ],
    })!;
    expect(doc.layers.map((l) => l.id)).toEqual(['a', 'f', 'c']);
    expect(doc.mode).toBe('blend');
  });
  it('refuses a document without a size', () => {
    expect(sanitiseDoc({ layers: [] })).toBeNull();
    expect(sanitiseDoc(null)).toBeNull();
  });
});

describe('compositions store', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('saves, updates, hides and restores', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-compose-'));
    const s = new Store(dir);
    s.saveComposition('comp-1', 'Harbour', emptyDoc(), 'data:image/jpeg;base64,AA', 1000);
    s.saveComposition('comp-1', 'Harbour at dusk', { ...emptyDoc(), description: 'dusk' }, null, 2000);
    const c = s.composition('comp-1')!;
    expect(c.name).toBe('Harbour at dusk');
    expect(c.doc.description).toBe('dusk');
    expect(c.thumb).toBe('data:image/jpeg;base64,AA'); // an update without a thumbnail keeps the old one
    expect(c.created_at).toBe(1000);
    expect(s.deleteComposition('comp-1')).toBe(true);
    expect(s.compositions()).toHaveLength(0);
    expect(s.composition('comp-1')).toBeNull();
    expect(s.restoreComposition('comp-1')).toBe(true);
    expect(s.compositions().map((x) => x.name)).toEqual(['Harbour at dusk']);
    s.db.close();
  });
});
