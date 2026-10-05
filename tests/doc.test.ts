import { describe, expect, it } from 'vitest';
import { BLENDS, blendOp, dabsAlong, moveLayer, nextLayerName, parseDoc, placeOnCanvas, pressureCurve } from '../src/shared/doc';

const layer = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kind: 'paint', visible: true, opacity: 1, blend: 'normal', ...extra });

describe('edit canvas document', () => {
  it('has the 16 blend modes, each a canvas operation', () => {
    expect(BLENDS).toHaveLength(16);
    expect(blendOp('multiply')).toBe('multiply');
    expect(blendOp('normal')).toBe('source-over');
    expect(blendOp('nonsense')).toBe('source-over');
  });

  it('parses and normalises a stored document', () => {
    const d = parseDoc({ width: 100, height: 50, layers: [layer('base', { kind: 'picture', source: '0f8c1b2a-1111-2222-3333-444455556666' }), layer('p1', { opacity: 3, blend: 'bogus' })], active: 'zz' }, 'item');
    expect(d).not.toBeNull();
    expect(d!.layers[0].painted).toBe(false); // an unchanged picture layer is loaded from its item
    expect(d!.layers[1].painted).toBe(true);
    expect(d!.layers[1].opacity).toBe(1);
    expect(d!.layers[1].blend).toBe('normal');
    expect(d!.active).toBe('p1'); // unknown active → the top layer
    expect(d!.itemId).toBe('item');
  });

  it('rejects broken documents', () => {
    expect(parseDoc(null)).toBeNull();
    expect(parseDoc({ width: 0, height: 10, layers: [layer('a')] })).toBeNull();
    expect(parseDoc({ width: 10, height: 10, layers: [] })).toBeNull();
    expect(parseDoc({ width: 10, height: 10, layers: [layer('a'), layer('a')] })).toBeNull();
    expect(parseDoc({ width: 10, height: 10, layers: [layer('../x')] })).toBeNull();
  });

  it('moves layers and names new ones', () => {
    expect(moveLayer(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveLayer(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(nextLayerName(['Picture', 'Layer 1', 'Layer 4'])).toBe('Layer 5');
    expect(nextLayerName([])).toBe('Layer 1');
  });

  it('places pictures on the canvas', () => {
    expect(placeOnCanvas(1024, 1024, 1000, 1000)).toEqual({ x: 0, y: 0, w: 1000, h: 1000, exact: true });
    expect(placeOnCanvas(1008, 1000, 1000, 1000).exact).toBe(true); // within 2%: an AI result of the canvas
    expect(placeOnCanvas(2000, 1000, 1000, 1000)).toEqual({ x: 0, y: 250, w: 1000, h: 500, exact: false });
  });

  it('maps pen pressure with a floor', () => {
    expect(pressureCurve(0)).toBeCloseTo(0.08);
    expect(pressureCurve(1)).toBe(1);
    expect(pressureCurve(NaN)).toBeGreaterThan(0.08);
  });

  it('spaces brush dabs evenly across segments', () => {
    const a = dabsAlong({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, 0);
    expect(a.pts.map((p) => p.x)).toEqual([4, 8]);
    const b = dabsAlong({ x: 10, y: 0 }, { x: 13, y: 0 }, 4, a.carry);
    expect(b.pts.map((p) => p.x)).toEqual([12]);
  });
});
