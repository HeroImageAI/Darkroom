/**
 * Creative session 3 (polish round 3): the newest Edit tools at work on real models — Live painting (footwear),
 * Regions (movie), Sketch › Depth (automotive) and Sketch › Pose (gaming) — with a screenshot after each step and
 * every message Darkroom shows, then the new panels at a laptop size. Judges nothing.
 *   npx tsx tests/session3.ts [url] [out dir]
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? 'tests/results/session3';
fs.mkdirSync(out, { recursive: true });
const log: string[] = [];
const say = (s: string) => (console.log(s), log.push(s));
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const seen = new Set<string>();
setInterval(() => {
  void page
    .locator('.toast')
    .allInnerTexts()
    .then((ts) => ts.forEach((t) => !seen.has(t) && (seen.add(t), say(`   toast: ${t.replace(/\s+/g, ' ')}`))))
    .catch(() => undefined);
}, 400).unref();
page.on('pageerror', (e) => say(`   PAGE ERROR: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/WebSocket/.test(m.text()) && say(`   console error: ${m.text().slice(0, 200)}`));
let n = 0;
const t0 = Date.now();
const snap = async (name: string, p: Page = page) => {
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png` });
  say(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${n} ${name}`);
};
const step = async (name: string, f: () => Promise<void>) => {
  const s0 = Date.now();
  try {
    await f();
    say(`== ${name} ok in ${((Date.now() - s0) / 1000).toFixed(0)}s`);
  } catch (e) {
    say(`!! ${name} failed: ${(e as Error).message.split('\n')[0]}`);
    await snap(`${name}-FAILED`);
  }
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
const item = async (id: string) => (await (await page.request.get(`${url}/api/items/${id}`)).json()).item;
const firstItem = async (re: RegExp) => ((await (await page.request.get(`${url}/api/items?limit=2000&filter=generated`)).json()).items as any[]).find((i) => i.kind === 'image' && re.test(i.prompt ?? ''));
const layerNames = async (id: string) => (((await (await page.request.get(`${url}/api/items/${id}/project`)).json()).layers ?? []) as any[]).map((l) => l.name);
const modes = () => page.getByRole('group', { name: 'Edit mode' });
const tools = () => page.getByRole('navigation', { name: 'Tools' });

// Footwear: draw on a blank canvas with Live on
await step('live', async () => {
  await page.goto(url + '/#/edit');
  await page.getByRole('button', { name: 'Start from a blank canvas' }).click();
  await page.getByRole('button', { name: 'Paper White' }).click();
  await page.getByRole('button', { name: 'Canvas 3:2' }).click();
  await page.waitForURL(/#\/edit\/[0-9a-f-]+$/);
  const id = page.url().split('/').pop()!;
  const it = await item(id);
  const W = it.width;
  const H = it.height;
  await page.getByRole('button', { name: /^Live$/ }).click();
  const panel = page.getByRole('complementary', { name: 'Live' });
  await panel.getByLabel('Live: what it should look like').fill('a white leather court sneaker with a gum sole, studio product photo');
  await snap('live-on');
  await tools().getByRole('button', { name: /^Paint on a layer/ }).click();
  await drag([[W * 0.15, H * 0.7], [W * 0.85, H * 0.7], [W * 0.88, H * 0.62], [W * 0.15, H * 0.62], [W * 0.15, H * 0.7]], W, H);
  await drag([[W * 0.15, H * 0.62], [W * 0.18, H * 0.38], [W * 0.35, H * 0.33], [W * 0.5, H * 0.45], [W * 0.75, H * 0.52], [W * 0.88, H * 0.62]], W, H);
  await snap('live-drawn');
  await panel.getByRole('status').filter({ hasText: 'Up to date' }).waitFor({ timeout: 180_000 });
  await snap('live-frame');
  await drag([[W * 0.38, H * 0.36], [W * 0.46, H * 0.48]], W, H);
  await panel.getByRole('status').filter({ hasText: 'Up to date' }).waitFor({ timeout: 180_000 });
  await snap('live-frame-2');
  await panel.getByRole('button', { name: 'Keep as layer' }).click();
  await page.waitForTimeout(1500);
  await snap('live-kept');
  await panel.getByRole('button', { name: 'Stop live' }).click();
  say(`   layers: ${(await layerNames(id)).join(' | ')}`);
});

// Movie: a film still with two regions
await step('regions', async () => {
  const pic = await firstItem(/lighthouse on a cliff|city street|alley|film still/i);
  await page.goto(`${url}/#/edit/${pic.id}`);
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: /AI/ }).click();
  await modes().getByRole('button', { name: 'Regions', exact: true }).click();
  await page.getByRole('textbox', { name: 'The whole picture (optional)' }).fill('a cinematic storm at dusk, film still');
  await tools().getByRole('button', { name: /^Lasso/ }).click();
  const W = pic.width;
  const H = pic.height;
  await drag([[W * 0.05, H * 0.08], [W * 0.95, H * 0.08], [W * 0.95, H * 0.35], [W * 0.05, H * 0.4], [W * 0.05, H * 0.08]], W, H);
  await page.getByRole('button', { name: 'Add the selection as a region' }).click();
  await page.getByLabel('Region 1: what it is').fill('a forked lightning bolt splitting the clouds');
  await tools().getByRole('button', { name: /^Marquee/ }).click();
  await drag([[W * 0.1, H * 0.75], [W * 0.45, H * 0.97]], W, H);
  await page.getByRole('button', { name: 'Add the selection as a region' }).click();
  await page.getByLabel('Region 2: what it is').fill('a small rowing boat pulled up on the rocks');
  await snap('regions-ready');
  await page.locator('.panel-foot').getByRole('button', { name: /Render 2 regions/ }).click();
  await page.waitForTimeout(4000);
  await snap('regions-running');
  await page.getByText(/All 2 regions are rendered/).waitFor({ timeout: 400_000 });
  await snap('regions-done');
  say(`   layers: ${(await layerNames(pic.id)).join(' | ')}`);
});

// Automotive: a car's depth, a new concept
await step('depth', async () => {
  const pic = await firstItem(/hatchback|car/i);
  await page.goto(`${url}/#/edit/${pic.id}`);
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: /AI/ }).click();
  await modes().getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.getByRole('group', { name: 'Follow' }).getByRole('button', { name: 'Depth' }).click();
  await page.getByLabel('What should it become?').fill('a matte black electric SUV concept with copper accents, studio photo');
  await snap('depth-ready');
  await page.locator('.panel-foot').getByRole('button', { name: /Render from the depth/ }).click();
  await page.waitForTimeout(6000);
  await snap('depth-running');
  for (let i = 0; i < 120 && !(await layerNames(pic.id).catch(() => [] as string[])).some((n) => n.startsWith('Depth ·')); i++) await page.waitForTimeout(2500);
  await page.waitForTimeout(1500);
  await snap('depth-done');
  say(`   layers: ${(await layerNames(pic.id)).join(' | ')}`);
});

// Gaming: a figure's pose, a new character
await step('pose', async () => {
  const pic = await firstItem(/walking|full body|standing/i);
  await page.goto(`${url}/#/edit/${pic.id}`);
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: /AI/ }).click();
  await modes().getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.getByRole('group', { name: 'Follow' }).getByRole('button', { name: 'Pose' }).click();
  await page.getByLabel('Who takes the pose?').fill('a hooded elven ranger with a longbow, game concept art');
  await snap('pose-ready');
  await page.locator('.panel-foot').getByRole('button', { name: /Render in the pose/ }).click();
  for (let i = 0; i < 120 && !(await layerNames(pic.id).catch(() => [] as string[])).some((n) => n.startsWith('Pose ·')); i++) await page.waitForTimeout(2500);
  await page.waitForTimeout(1500);
  await snap('pose-done');
  say(`   layers: ${(await layerNames(pic.id)).join(' | ')}`);
});

// the new panels at a laptop size
await step('laptop', async () => {
  const small = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const pic = await firstItem(/car/i);
  await small.goto(`${url}/#/edit/${pic.id}`);
  await small.waitForTimeout(2000);
  await small.getByRole('tab', { name: /AI/ }).click();
  for (const m of ['Regions', 'Sketch']) {
    await small.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: m, exact: true }).click();
    await snap(`laptop-${m.toLowerCase()}`, small);
  }
  await small.getByRole('group', { name: 'Follow' }).getByRole('button', { name: 'Pose' }).click();
  await snap('laptop-sketch-pose', small);
  await small.getByRole('button', { name: /^Live$/ }).click();
  await snap('laptop-live', small);
  await small.context().close();
});

say(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
fs.writeFileSync(`${out}/log.txt`, log.join('\n') + '\n');
await browser.close();
process.exit(0);
