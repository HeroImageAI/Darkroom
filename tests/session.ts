/**
 * A creative session, end to end on real models: what a designer does in one sitting, step by step, with a screenshot
 * after each step and every message Darkroom shows. For the polish review (not an e2e test: it judges nothing).
 *   npx tsx tests/session.ts [url] [out dir]
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? 'tests/results/session';
fs.mkdirSync(out, { recursive: true });
const log: string[] = [];
const say = (s: string) => (console.log(s), log.push(s));
const browser = await chromium.launch({ channel: 'msedge' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const seen = new Set<string>();
setInterval(() => {
  void page
    .locator('.toast')
    .allInnerTexts()
    .then((ts) => ts.forEach((t) => !seen.has(t) && (seen.add(t), say(`   toast: ${t.replace(/\s+/g, ' ')}`))))
    .catch(() => undefined);
}, 400).unref();
page.on('pageerror', (e) => say(`   PAGE ERROR: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && say(`   console error: ${m.text().slice(0, 200)}`));
let n = 0;
const t0 = Date.now();
const snap = async (name: string) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png` });
  say(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${n} ${name}`);
};
const canvasAt = async (x: number, y: number, W: number, H: number) => {
  const b = (await page.getByAltText('Picture being edited').boundingBox())!;
  return { x: b.x + (x / W) * b.width, y: b.y + (y / H) * b.height };
};
const drag = async (pts: [number, number][], W: number, H: number) => {
  const a = await canvasAt(pts[0][0], pts[0][1], W, H);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) {
    const p = await canvasAt(x, y, W, H);
    await page.mouse.move(p.x, p.y, { steps: 10 });
  }
  await page.mouse.up();
};
const step = async (name: string, f: () => Promise<void>) => {
  try {
    await f();
  } catch (e) {
    say(`!! ${name} failed: ${(e as Error).message.split('\n')[0]}`);
    await snap(`${name}-FAILED`);
  }
};
const waitIdle = async (ms = 400_000) => {
  // a render is done when the queue in the top bar is empty again
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.querySelector('.topbar [data-busy="true"], .stage .progress-wrap'), null, { timeout: ms }).catch(() => undefined);
};

// 1. Automotive: generate a car
let carId = '';
await step('generate', async () => {
  await page.goto(url + '/#/generate');
  await page.getByRole('button', { name: /^Klein 9B/ }).click();
  await page.getByRole('button', { name: '16:9', exact: true }).click();
  await page.getByRole('button', { name: 'Car studio', exact: true }).click();
  await page.getByLabel('Prompt').fill('A compact electric hatchback concept in satin sage green, angular LED light bar, aero wheels, three-quarter front view');
  await page.getByLabel('Prompt').press('Control+Enter');
  await page.waitForTimeout(2500);
  await snap('generate-running');
  await page.getByRole('toolbar', { name: 'Result actions' }).waitFor({ timeout: 300_000 });
  await snap('generate-result');
  await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Edit' }).click();
  await page.waitForURL(/#\/edit\/[0-9a-f-]+/);
  carId = page.url().split('/').pop()!;
  await page.waitForTimeout(1500);
  await snap('edit-opened');
});

// 2. Fill the wheels: marquee over the front wheel, replace
await step('fill', async () => {
  const it = (await (await page.request.get(`${url}/api/items/${carId}`)).json()).item;
  const W = it.width;
  const H = it.height;
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Fill', exact: true }).click();
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Marquee/ }).click();
  await drag([[W * 0.1, H * 0.55], [W * 0.45, H * 0.95]], W, H);
  await snap('fill-selection');
  await page.getByLabel('What should fill the selection?').fill('a glossy black five-spoke alloy wheel with a copper brake caliper');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(3000);
  await snap('fill-running');
  await page.getByText(/new version|new layer|done/i).first().waitFor({ timeout: 300_000 }).catch(() => undefined);
  await waitIdle();
  await snap('fill-result');
});

// 3. Footwear: a blank canvas, a drawn sneaker, coloured, rendered with Sketch
await step('sketch', async () => {
  await page.goto(url + '/#/edit');
  await page.getByRole('button', { name: 'Start from a blank canvas' }).click();
  await page.getByRole('button', { name: 'Paper White' }).click();
  await page.getByRole('button', { name: 'Canvas 3:2' }).click();
  await page.waitForURL(/#\/edit\/[0-9a-f-]+$/);
  const id = page.url().split('/').pop()!;
  const it = (await (await page.request.get(`${url}/api/items/${id}`)).json()).item;
  const W = it.width;
  const H = it.height;
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Paint on a layer/ }).click();
  await snap('sketch-paint-tool');
  // a sneaker profile: sole, upper, toe, heel, laces
  await drag([[W * 0.15, H * 0.7], [W * 0.85, H * 0.7], [W * 0.88, H * 0.62], [W * 0.15, H * 0.62], [W * 0.15, H * 0.7]], W, H);
  await drag([[W * 0.15, H * 0.62], [W * 0.18, H * 0.35], [W * 0.35, H * 0.3], [W * 0.5, H * 0.42], [W * 0.75, H * 0.5], [W * 0.88, H * 0.62]], W, H);
  await drag([[W * 0.38, H * 0.33], [W * 0.45, H * 0.45]], W, H);
  await drag([[W * 0.43, H * 0.36], [W * 0.5, H * 0.47]], W, H);
  await drag([[W * 0.48, H * 0.4], [W * 0.55, H * 0.49]], W, H);
  await snap('sketch-drawn');
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Fill bucket/ }).click();
  await page.getByRole('button', { name: /^Colour/ }).click();
  await page.getByLabel('Hex colour').fill('#2f6fd6');
  await page.keyboard.press('Escape');
  const c = await canvasAt(W * 0.5, H * 0.66, W, H);
  await page.mouse.click(c.x, c.y);
  await snap('sketch-coloured');
  await page.getByRole('tab', { name: /AI/ }).click();
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Klein 9B/ }).click();
  await page.getByLabel('What should the drawing become?').fill('a photorealistic product photo of this running sneaker: white mesh upper, cobalt blue sole, light grey studio');
  await snap('sketch-ready');
  await page.keyboard.press('Control+Enter');
  await page.getByText(/The result is on a new layer/).waitFor({ timeout: 300_000 });
  await snap('sketch-result');
  // grade it: a look as an adjustment layer
  await page.getByRole('tab', { name: /Adjust/ }).click();
  await page.getByRole('button', { name: 'Golden hour', exact: true }).click();
  await snap('sketch-graded');
  await page.getByRole('tab', { name: /Layers/ }).click();
  await snap('sketch-layers');
});

// 4. Animate the car (Draft)
await step('animate', async () => {
  if (!carId) return;
  await page.goto(url + `/#/video?start=${carId}`);
  await page.waitForTimeout(1500);
  await snap('video-start');
  await page.getByPlaceholder(/She turns her head/).fill('The camera slowly orbits around the car as its LED light bar pulses on; reflections slide across the satin paint.');
  await snap('video-ready');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(4000);
  await snap('video-running');
  await page.locator('video').first().waitFor({ timeout: 900_000 });
  await page.waitForTimeout(2000);
  await snap('video-result');
});

// 5. Library: the session's work
await step('library', async () => {
  await page.goto(url + '/#/library');
  await page.waitForTimeout(3000);
  await snap('library');
});

say(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
fs.writeFileSync(`${out}/log.txt`, log.join('\n') + '\n');
await browser.close();
process.exit(0);
