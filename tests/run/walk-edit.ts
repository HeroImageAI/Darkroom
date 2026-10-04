/**
 * Walk-through 2b (2026-10-04): the Edit features the runner's plan does not cover — Layers, Crop, Compare with the
 * previous version, Advanced (seed lock), and the Outpaint frame tool — on JP's Darkroom. PASS/FAIL per check.
 *   npx tsx tests/run/walk-edit.ts
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const OUT = 'tests/results/screenshots/WALK-2-edit';
fs.mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext('tests/results/.edge-profile', { channel: 'msedge', headless: false, slowMo: 120, viewport: { width: 1440, height: 900 } });
const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(30_000);
const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png` });
const results: string[] = [];
const ONLY = process.env.ONLY;
const check = async (name: string, fn: () => Promise<string | void>) => {
  if (ONLY && !name.startsWith(ONLY)) return;
  try {
    const note = await fn();
    results.push(`PASS ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    await shot(`FAIL-${name.replace(/\W+/g, '_')}`).catch(() => undefined);
    results.push(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`);
  }
  console.log(results[results.length - 1]);
};
const byTitle = async (t: string) => ((await (await page.request.get(`${URL}/api/items?q=${encodeURIComponent(t)}&limit=20`)).json()).items as any[]).find((i) => i.title === t);
const editUrl = () => (/#\/edit\/([0-9a-f-]{36})/.exec(page.url()) ?? [])[1];

await check('Layers: one picture becomes separate layers', async () => {
  const it = await byTitle('Desert scavenger · Klein');
  await page.goto(`${URL}/#/edit/${it.id}`);
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByPlaceholder(/person, dog/).fill('person, backpack');
  await shot('layers-settings');
  await page.getByRole('button', { name: /^Make layers/ }).click();
  await page.getByText(/Layers ready/).waitFor({ timeout: 600_000 });
  await page.waitForTimeout(1500);
  await shot('layers-result');
  const n = await page.locator('.layers-panel li, [aria-label="Layers"] li').count();
  return `${n} layers listed`;
});

await check('Crop: the front view out of the turnaround', async () => {
  const it = await byTitle('Desert scavenger · turnaround');
  await page.goto(`${URL}/#/edit/${it.id}`);
  await page.getByRole('button', { name: 'Crop (C)' }).click();
  const box = (await page.getByLabel('Canvas').locator('img').first().boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.0, box.y + box.height * 0.18);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.27, box.y + box.height * 0.82, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: /^Apply crop/ }).click();
  await page.waitForURL((u) => !u.toString().includes(it.id), { timeout: 120_000 });
  await page.waitForTimeout(1200);
  await shot('crop-result');
  const v = (await (await page.request.get(`${URL}/api/items/${editUrl()}`)).json()).item;
  await page.request.patch(`${URL}/api/items/${v.id}`, { data: { title: 'Desert scavenger · front view' } });
  return `${v.width}×${v.height}`;
});

await check('Compare with the previous version', async () => {
  const it = await byTitle('Trail shoe · clay render');
  await page.goto(`${URL}/#/edit/${it.id}`);
  await page.getByRole('button', { name: /Compare/ }).last().click();
  const box = (await page.getByLabel('Canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(600);
  await shot('compare-previous');
  await page.getByRole('button', { name: /Compare/ }).last().click();
});

await check('Advanced: a typed seed stays locked across runs', async () => {
  const it = await byTitle('Rain shell · Klein');
  await page.goto(`${URL}/#/edit/${it.id}`);
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct', exact: true }).click();
  const adv = page.locator('details.edit-adv');
  if ((await adv.getAttribute('open')) === null) await adv.locator('summary').click();
  await page.getByLabel('Seed').fill('7');
  await adv.locator('summary').click(); // close it: the summary still says the seed is locked
  const summary = (await adv.locator('summary').innerText()).replace(/\s+/g, ' ');
  if (!/seed 7 locked/.test(summary)) throw new Error(`summary "${summary}"`);
  await shot('advanced-closed-locked');
  return summary;
});

await check('Outpaint frame tool: drag an edge outwards', async () => {
  const it = await byTitle('Lighthouse keeper · Qwen');
  await page.goto(`${URL}/#/edit/${it.id}`);
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Outpaint', exact: true }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const box = (await page.getByLabel('Canvas').locator('img').first().boundingBox())!;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const right = await page.getByRole('spinbutton', { name: 'right' }).inputValue();
  await shot('outpaint-frame');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  if (Number(right) <= 0) throw new Error('right padding stayed 0');
  return `right padding ${right} px`;
});

fs.writeFileSync(`${OUT}/checks.txt`, results.join('\n') + '\n');
await ctx.close();
