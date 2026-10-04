/**
 * Walk-through 3 (2026-10-04): Compose like a creative — a backdrop from the Library, a cut-out from Edit placed and
 * scaled on it, Harmonise into one picture; then rough paint on a blank canvas (Reimagine). PASS/FAIL per check.
 *   npx tsx tests/run/walk-compose.ts
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const OUT = 'tests/results/screenshots/WALK-3-compose';
fs.mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext('tests/results/.edge-profile', { channel: 'msedge', headless: false, slowMo: 120, viewport: { width: 1440, height: 900 } });
const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(30_000);
const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png` });
const results: string[] = [];
const check = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    results.push(`PASS ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    await shot(`FAIL-${name.replace(/\W+/g, '_')}`).catch(() => undefined);
    results.push(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`);
  }
  console.log(results[results.length - 1]);
};
const items = async (q: string) => (await (await page.request.get(`${URL}/api/items?q=${encodeURIComponent(q)}&limit=50`)).json()).items as any[];
const titled = async (t: string) => (await items(t)).find((i) => i.title === t);

/** Generate a backdrop through the Generate screen and title it (skipped when it exists). */
async function backdrop(title: string, board: string, prompt: string, aspect: string) {
  if (await titled(title)) return;
  await page.goto(URL + '/#/library');
  await page.getByRole('combobox', { name: 'Working board' }).selectOption({ label: board });
  await page.goto(URL + '/#/generate');
  await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Klein 9B/ }).click();
  await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: aspect, exact: true }).click();
  await page.getByRole('group', { name: 'Style preset' }).getByRole('button', { name: 'Photographic', exact: true }).click();
  await page.getByLabel('Prompt').fill(prompt);
  const before = (await items('')).length ? (await items(''))[0].id : null;
  await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
  for (let t = 0; t < 120; t++) {
    const top = (await items(''))[0];
    if (top && top.id !== before && top.mode === 'generate') {
      await page.request.patch(`${URL}/api/items/${top.id}`, { data: { title } });
      return;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`backdrop ${title} did not arrive`);
}

/** Pick from the Library picker by searching a title. */
async function pick(title: string) {
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Search library').fill(title);
  await page.waitForTimeout(1200);
  await dlg.getByRole('listitem').first().click();
}

async function placeAndHarmonise(name: string, bg: string, piece: string, at: [number, number], shrink: number, scene: string) {
  await page.goto(URL + '/#/compose');
  await page.getByRole('region', { name: 'Start from a picture' }).getByRole('button', { name: 'From Library' }).click();
  await pick(bg);
  await page.waitForURL(/#\/compose\/[0-9a-f-]+$/, { timeout: 60_000 });
  await page.getByLabel('Composition name').fill(name);
  await page.getByRole('button', { name: 'From Library' }).first().click();
  await pick(piece);
  const sel = page.locator('.compose-select');
  await sel.waitFor({ timeout: 60_000 });
  const box = (await sel.boundingBox())!;
  const canvas = (await page.getByRole('application', { name: 'Canvas' }).boundingBox())!;
  // scale first (top-left handle towards the centre), then drag onto the ground
  const nw = (await page.locator('.compose-handle.nw').boundingBox())!;
  await page.mouse.move(nw.x + 7, nw.y + 7);
  await page.mouse.down();
  await page.mouse.move(nw.x + 7 + box.width * shrink, nw.y + 7 + box.height * shrink, { steps: 6 });
  await page.mouse.up();
  const b2 = (await sel.boundingBox())!;
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * at[0], canvas.y + canvas.height * at[1], { steps: 8 });
  await page.mouse.up();
  await shot(`${name}-placed`);
  const modes = page.getByRole('group', { name: 'Render mode' });
  const suggested = (await modes.getByRole('button', { pressed: true }).innerText()).split('\n')[0];
  await page.getByLabel('Scene description').fill(scene);
  await page.getByRole('button', { name: /^Render/ }).click();
  await page.locator('.compose-view img').waitFor({ timeout: 240_000 });
  await page.waitForTimeout(1500);
  await shot(`${name}-render`);
  return `suggested mode: ${suggested}`;
}

await check('Backdrops for the composites', async () => {
  await backdrop('Alpine trail backdrop', 'Footwear', 'A rocky alpine trail at sunrise, granite boulders and low heather, mist in the valley below, no people, wide view.', '3:2');
  await backdrop('City street backdrop', 'Automotive', 'An empty city street at night after rain, wet asphalt reflecting neon signs and street lights, modern buildings, no cars, no people.', '16:9');
});

await check('Shoe cut-out on the alpine trail, Harmonised', () =>
  placeAndHarmonise('Trail shoe on the trail', 'Alpine trail backdrop', 'Trail shoe · cut-out', [0.5, 0.62], 0.45, 'the green trail running shoe standing on a granite boulder on an alpine trail at sunrise, warm low sunlight from the left, mist in the valley'),
);

await check('EV cut-out on the wet city street, Harmonised', () =>
  placeAndHarmonise('EV crossover in the city', 'City street backdrop', 'EV crossover · cut-out', [0.5, 0.66], 0.3, 'the midnight-blue electric crossover parked on a wet city street at night, neon reflections on the paint and the asphalt'),
);

await check('Rough paint on a blank canvas suggests Reimagine and renders', async () => {
  await page.goto(URL + '/#/compose');
  await page.getByRole('region', { name: 'Blank canvas' }).getByRole('button', { name: '16:9', exact: true }).click();
  await page.getByRole('button', { name: 'New composition' }).click();
  await page.waitForURL(/#\/compose\/[0-9a-f-]+$/);
  await page.getByLabel('Composition name').fill('Painted race poster');
  await page.getByRole('button', { name: 'Paint (B)' }).click();
  const c = (await page.getByRole('application', { name: 'Canvas' }).boundingBox())!;
  const band = async (colour: string, y0: number, y1: number, size: number) => {
    await page.getByLabel(`Colour ${colour}`).click();
    await page.getByLabel('Brush size').fill(String(size));
    for (let y = y0; y <= y1; y += 0.1) {
      await page.mouse.move(c.x + 2, c.y + c.height * y);
      await page.mouse.down();
      await page.mouse.move(c.x + c.width - 2, c.y + c.height * y, { steps: 4 });
      await page.mouse.up();
    }
  };
  const colours = (await page.locator('[aria-label^="Colour "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.slice(7))));
  await band(colours.find((x) => /blue/i.test(x)) ?? colours[0], 0.05, 0.5, 220);
  await band(colours.find((x) => /green/i.test(x)) ?? colours[1], 0.6, 0.95, 220);
  await shot('painted');
  const modes = page.getByRole('group', { name: 'Render mode' });
  const suggested = (await modes.getByRole('button', { pressed: true }).innerText()).split('\n')[0];
  await page.getByLabel('Scene description').fill('a trail race poster scene: runners on a ridge path across green alpine meadows under a deep blue sky');
  await page.getByRole('button', { name: /^Render/ }).click();
  await page.locator('.compose-view img').waitFor({ timeout: 240_000 });
  await page.waitForTimeout(1500);
  await shot('painted-render');
  if (!/Reimagine/.test(suggested)) throw new Error(`suggested ${suggested}`);
  return `suggested mode: ${suggested}`;
});

fs.writeFileSync(`${OUT}/checks.txt`, results.join('\n') + '\n');
await ctx.close();
