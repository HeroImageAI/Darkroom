/**
 * Walk-through 5 (2026-10-04): cut the walk-through takes into one reel on the Timeline — add from the bin in order,
 * crossfades, a split, a gap filled with AI (LTX), export MP4 to the Library. PASS/FAIL per check.
 *   npx tsx tests/run/walk-timeline.ts
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const OUT = 'tests/results/screenshots/WALK-5-timeline';
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
const CLIPS = ['Trail shoe · clay to colour', 'Trail shoe · turntable', 'Trail shoe · sunrise on the trail', 'Rain shell · first raindrops', 'Lighthouse keeper · the storm'];
let film = '';
const saved = async () => (await (await page.request.get(`${URL}/api/timelines/${film}`)).json()).doc;
const track = () => page.getByRole('list', { name: 'Video track' });
const inspector = () => page.getByRole('complementary', { name: 'Inspector' });

await check('A new film from five takes, in order, found by title in the bin', async () => {
  await page.goto(URL + '/#/timeline');
  await page.getByRole('button', { name: 'New film' }).click();
  await page.waitForURL(/#\/timeline\/[0-9a-f-]{36}$/);
  film = page.url().split('/').pop()!;
  await page.getByLabel('Film name').fill('Darkroom reel');
  const bin = page.getByRole('list', { name: 'Videos to add' });
  for (const c of CLIPS) {
    await page.getByLabel('Search videos').fill(c);
    await page.waitForTimeout(1200);
    const names = await bin.locator('.tl-bin-name').allInnerTexts();
    if (!names.includes(c)) throw new Error(`"${c}" not shown by title in the bin (got ${JSON.stringify(names.slice(0, 3))})`);
    await bin.getByRole('button', { name: /^Add .* to the end$/ }).first().click();
  }
  await page.getByLabel('Search videos').fill('');
  await page.waitForFunction(async () => true);
  for (let t = 0; t < 20 && (await saved()).clips.length < CLIPS.length; t++) await page.waitForTimeout(500);
  const n = (await saved()).clips.length;
  if (n !== CLIPS.length) throw new Error(`${n} clips saved`);
  await shot('assembled');
  return `${n} clips`;
});

await check('Crossfades between the clips', async () => {
  for (let i = 1; i < CLIPS.length; i++) {
    await track().getByRole('listitem').nth(i).click({ position: { x: 40, y: 20 } });
    await inspector().getByRole('group', { name: 'Transition' }).getByRole('button', { name: 'Fade ½ s' }).click();
  }
  await page.waitForTimeout(800);
  const fades = await track().locator('.tl-fade').count();
  if (fades !== CLIPS.length - 1) throw new Error(`${fades} fades`);
  return `${fades} crossfades`;
});

await check('Split the turntable at 2.5 s and drop its tail', async () => {
  const doc = await saved();
  const tt = doc.clips.find((c: any) => c === doc.clips[1]);
  await page.getByRole('button', { name: 'To the start' }).click();
  const at = tt.start + 2.5;
  for (let i = 0; i < Math.round(at * 24); i++) await page.keyboard.press('ArrowRight');
  await track().getByRole('listitem').nth(1).click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('s');
  await page.waitForTimeout(600);
  const n = (await saved()).clips.length;
  if (n !== CLIPS.length + 1) throw new Error(`${n} clips after split`);
  await track().getByRole('listitem').nth(2).click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Delete');
  await page.waitForTimeout(600);
  return `${(await saved()).clips.length} clips after removing the tail`;
});

await check('Make room before the storm and fill the gap with AI', async () => {
  const items = track().getByRole('listitem');
  const last = items.last();
  const box = (await last.boundingBox())!;
  const doc0 = await saved();
  const before = Math.max(...doc0.clips.map((c: any) => c.start));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const doc = await saved();
  const storm = doc.clips.reduce((a: any, b: any) => (b.start > a.start ? b : a));
  const prevEnd = Math.max(...doc.clips.filter((c: any) => c !== storm).map((c: any) => c.start + c.out - c.in));
  const gap = storm.start - prevEnd;
  if (gap < 0.5) throw new Error(`gap ${gap.toFixed(2)} s (storm moved ${before} → ${storm.start})`);
  // click into the gap
  const lane = (await track().boundingBox())!;
  const ruler = page.locator('.tl-ruler span');
  const x1 = (await ruler.nth(1).boundingBox())!.x - (await ruler.nth(0).boundingBox())!.x; // px per ruler step
  const step = Number((await ruler.nth(1).innerText()).replace(/[^\d.]/g, '')) - Number((await ruler.nth(0).innerText()).replace(/[^\d.]/g, ''));
  const pxPerS = x1 / (step || 1);
  await page.mouse.click(lane.x + (prevEnd + gap / 2) * pxPerS + 1, lane.y + lane.height / 2);
  await page.getByLabel('Selected gap').waitFor();
  const fill = page.getByRole('region', { name: 'Fill with AI' });
  await fill.getByLabel('Fill with AI: what happens').fill('Dark storm clouds roll in over the sea and the first lightning flashes on the horizon.');
  await fill.getByRole('button', { name: /^Fill with AI/ }).click();
  await track().locator('.tl-pending').waitFor({ timeout: 30_000 });
  await shot('filling');
  await track().locator('.tl-pending').waitFor({ state: 'detached', timeout: 600_000 });
  await page.waitForTimeout(1000);
  await shot('filled');
  return `${gap.toFixed(2)} s gap filled; ${(await saved()).clips.length} clips`;
});

await check('Export the reel as one MP4 in the Library', async () => {
  const doc = await saved();
  const total = Math.max(...doc.clips.map((c: any) => c.start + c.out - c.in));
  const sent = page.waitForResponse((r) => r.url().endsWith(`/api/timelines/${film}/export`), { timeout: 600_000 });
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const item = await (await sent).json();
  await page.getByText(/exported .* It is in your Library\./).last().waitFor({ timeout: 60_000 });
  await page.request.patch(`${URL}/api/items/${item.id}`, { data: { title: 'Darkroom reel' } });
  await shot('exported');
  if (Math.abs(item.duration - total) > 0.15) throw new Error(`film ${item.duration}s vs timeline ${total}s`);
  return `${item.duration.toFixed(1)} s, ${item.width}×${item.height}`;
});

fs.writeFileSync(`${OUT}/checks.txt`, results.join('\n') + '\n');
await ctx.close();
