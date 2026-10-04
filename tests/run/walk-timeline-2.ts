/**
 * Walk-through 5b (2026-10-04): on the "Darkroom reel" film — zoom out so the whole film is visible, split the
 * turntable at 2.5 s with "Split at playhead", remove its tail (leaving a gap), fill that gap with AI, export again.
 *   npx tsx tests/run/walk-timeline-2.ts
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const OUT = 'tests/results/screenshots/WALK-5-timeline';
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
const films = (await (await page.request.get(`${URL}/api/timelines`)).json()) as any;
const film = (films.timelines ?? films).find((f: any) => f.name === 'Darkroom reel').id as string;
const saved = async () => (await (await page.request.get(`${URL}/api/timelines/${film}`)).json()).doc;
const track = () => page.getByRole('list', { name: 'Video track' });
const inspector = () => page.getByRole('complementary', { name: 'Inspector' });
const ZOOM = 30;
await page.goto(`${URL}/#/timeline/${film}`);
await track().getByRole('listitem').first().waitFor();
await page.getByLabel('Zoom').fill(String(ZOOM));
await page.locator('.tl-lanes').evaluate((el) => el.scrollTo(0, 0));
const at = async (s: number) => {
  await page.getByRole('button', { name: 'To the start' }).click();
  for (let i = 0; i < Math.round(s * 24); i++) await page.keyboard.press('ArrowRight');
};
const clickAt = async (s: number) => {
  const lane = (await track().boundingBox())!;
  await page.mouse.click(lane.x + s * ZOOM, lane.y + lane.height / 2);
};

let gapAt = 0;
await check('Split the turntable at 2.5 s and remove its tail (leaves a gap)', async () => {
  const doc = await saved();
  const sorted = [...doc.clips].sort((a: any, b: any) => a.start - b.start);
  const tt = sorted[1];
  await at(tt.start + 2.5);
  await clickAt(tt.start + 1);
  await inspector().getByRole('button', { name: 'Split at playhead' }).click();
  await page.waitForTimeout(800);
  const n = (await saved()).clips.length;
  if (n !== doc.clips.length + 1) throw new Error(`${n} clips after the split`);
  await clickAt(tt.start + 3.5);
  await inspector().getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForTimeout(800);
  const after = [...(await saved()).clips].sort((a: any, b: any) => a.start - b.start);
  gapAt = tt.start + 2.5;
  await shot('split-gap');
  return `${after.length} clips, a gap from ${gapAt.toFixed(1)} s`;
});

await check('Fill the gap with AI (LTX)', async () => {
  await clickAt(gapAt + 0.8);
  await page.getByLabel('Selected gap').waitFor();
  const fill = page.getByRole('region', { name: 'Fill with AI' });
  await fill.getByLabel('Fill with AI: what happens').fill('The shoe keeps turning on the turntable and the studio light slowly warms to sunrise colours.');
  const label = await fill.getByRole('button', { name: /^Fill with AI/ }).innerText();
  await fill.getByRole('button', { name: /^Fill with AI/ }).click();
  await track().locator('.tl-pending').waitFor({ timeout: 30_000 });
  await shot('filling');
  await track().locator('.tl-pending').waitFor({ state: 'detached', timeout: 600_000 });
  await page.waitForTimeout(1500);
  await shot('filled');
  return `${label.replace(/\s+/g, ' ')}; ${(await saved()).clips.length} clips`;
});

await check('Export the edited reel', async () => {
  const doc = await saved();
  const total = Math.max(...doc.clips.map((c: any) => c.start + c.out - c.in));
  const sent = page.waitForResponse((r) => r.url().endsWith(`/api/timelines/${film}/export`), { timeout: 600_000 });
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const item = await (await sent).json();
  await page.request.patch(`${URL}/api/items/${item.id}`, { data: { title: 'Darkroom reel · with AI fill' } });
  await shot('exported-2');
  if (Math.abs(item.duration - total) > 0.15) throw new Error(`film ${item.duration}s vs timeline ${total}s`);
  return `${item.duration.toFixed(1)} s`;
});

fs.appendFileSync(`${OUT}/checks.txt`, results.join('\n') + '\n');
await ctx.close();
