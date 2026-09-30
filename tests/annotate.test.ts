import { describe, expect, it } from 'vitest';
import { circleFor } from '../src/shared/annotate';

describe('circleFor', () => {
  it('centres the ellipse on the mask box with some air around it', () => {
    const e = circleFor({ x: 100, y: 200, w: 100, h: 50 }, 1500, 1000);
    expect(e.cx).toBe(150);
    expect(e.cy).toBe(225);
    expect(e.rx).toBeGreaterThan(50);
    expect(e.ry).toBeGreaterThan(25);
  });
  it('scales the stroke with the picture, never thinner than 5 px', () => {
    expect(circleFor({ x: 0, y: 0, w: 10, h: 10 }, 300, 300).stroke).toBe(5);
    expect(circleFor({ x: 0, y: 0, w: 10, h: 10 }, 3000, 1500).stroke).toBe(10);
  });
});
