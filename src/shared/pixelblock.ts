/**
 * Detect nearest-neighbour pixelation (a small picture blown up in blocks). SeedVR2 treats the blocks as detail and
 * keeps them; shrinking the picture back to its real resolution first lets it rebuild real detail (Phase 5 A/B:
 * a 96 px cat blown up to 384 px stayed blocky at 4x, but pre-shrunk to 96 px it came back as a realistic cat at 8x).
 *
 * Method: along sampled rows, the lengths of runs of identical pixels. In a block-scaled picture almost every run is
 * a whole multiple of the block size b; the most common run length is b.
 */
export function detectPixelBlock(data: Uint8Array | Uint8ClampedArray, width: number, height: number): number {
  const counts = new Map<number, number>();
  let runs = 0;
  const rowStep = Math.max(1, Math.floor(height / 64));
  for (let y = 0; y < height; y += rowStep) {
    let run = 1;
    for (let x = 1; x <= width; x++) {
      const same =
        x < width &&
        data[(y * width + x) * 4] === data[(y * width + x - 1) * 4] &&
        data[(y * width + x) * 4 + 1] === data[(y * width + x - 1) * 4 + 1] &&
        data[(y * width + x) * 4 + 2] === data[(y * width + x - 1) * 4 + 2];
      if (same) run++;
      else {
        if (x < width || run < width) {
          counts.set(run, (counts.get(run) ?? 0) + 1);
          runs++;
        }
        run = 1;
      }
    }
  }
  if (!runs) return 1;
  let best = 1;
  let bestN = 0;
  for (const [len, n] of counts) if (n > bestN) [best, bestN] = [len, n];
  // a natural photo's most common run is 1; require most runs to be multiples of the candidate block
  if (best < 2) return 1;
  let multiples = 0;
  for (const [len, n] of counts) if (len % best === 0) multiples += n;
  return multiples / runs >= 0.8 ? best : 1;
}
