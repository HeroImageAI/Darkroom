import type { Box } from './cropstitch.js';

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  stroke: number;
}

/**
 * The red circle for the circle quick edit (Addenda Phase 3, circle A/B in DECISIONS 73): an ellipse round the mask's
 * box with a little air, stroke scaled to the picture. Same geometry as the A/B (`setup.p3c` in scripts/ab-addenda.ts).
 */
export function circleFor(bbox: Box, width: number, height: number): Ellipse {
  const stroke = Math.max(5, Math.round(Math.min(width, height) / 150));
  return {
    cx: bbox.x + bbox.w / 2,
    cy: bbox.y + bbox.h / 2,
    rx: bbox.w * 0.62 + stroke,
    ry: bbox.h * 0.62 + stroke,
    stroke,
  };
}

export const CIRCLE_COLOUR = '#ff1a1a';
