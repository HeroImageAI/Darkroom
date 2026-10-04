/**
 * Walk-through 1b (2026-10-04): Generate features beyond a plain prompt, used like a creative would, on JP's Darkroom.
 * Prompt Enhance (+ Undo), {a|b} variations, a reference from History, Vary, Upscale 2×, Quality High, Reuse settings.
 * Prints PASS/FAIL per check; screenshots in tests/results/screenshots/WALK-1-generate/.
 *   npx tsx tests/run/walk-generate.ts
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const OUT = 'tests/results/screenshots/WALK-1-generate';
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
const rail = () => page.getByRole('complementary', { name: 'History' }).locator('.rail-item img');
const topId = async () => (/\/api\/items\/([0-9a-f-]{36})\/thumb/.exec((await rail().first().getAttribute('src').catch(() => null)) ?? '') ?? [])[1] ?? null;
const waitNewTop = async (before: string | null, ms = 240_000) => {
  const t0 = Date.now();
  for (;;) {
    const now = await topId();
    if (now && now !== before) return now;
    if (await page.locator('.toast.error').count()) throw new Error((await page.locator('.toast.error').last().textContent()) ?? 'error');
    if (Date.now() - t0 > ms) throw new Error(`no new picture after ${ms / 1000} s`);
    await page.waitForTimeout(1500);
  }
};
const item = async (id: string) => (await (await page.request.get(`${URL}/api/items/${id}`)).json()).item;

await page.goto(URL + '/#/library');
await page.getByRole('combobox', { name: 'Working board' }).selectOption({ label: 'Footwear' });
await page.goto(URL + '/#/generate');
await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Klein 9B/ }).click();

await check('Prompt Enhance rewrites a short idea, Undo brings it back', async () => {
  await page.getByLabel('Prompt').fill('trail shoe poster for a mountain race');
  await page.getByRole('button', { name: 'Enhance', exact: true }).click();
  await page.waitForFunction(() => ((document.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement)?.value.length ?? 0) > 80, null, { timeout: 180_000 });
  const rewritten = await page.getByLabel('Prompt').inputValue();
  await shot('enhance');
  await page.getByRole('button', { name: 'Undo' }).first().click();
  const back = await page.getByLabel('Prompt').inputValue();
  if (back !== 'trail shoe poster for a mountain race') throw new Error(`Undo gave "${back}"`);
  return `${rewritten.split(' ').length} words: "${rewritten.slice(0, 90)}…"`;
});

await check('{a|b} variations make one picture each', async () => {
  await page.getByLabel('Prompt').fill('A trail running shoe in {moss green|desert sand}, side view, seamless white background');
  await page.locator('.variations summary').getByText('2 variations').waitFor();
  const before = await topId();
  await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
  await page.locator('.strip[aria-label="Variations"] button').nth(1).waitFor({ timeout: 240_000 });
  await waitNewTop(before);
  await shot('variations');
  return `${await page.locator('.strip[aria-label="Variations"] button').count()} in the strip`;
});

let refResult = '';
await check('A History picture as a reference', async () => {
  await page.getByRole('button', { name: /^New$/ }).first().click();
  const src = page.getByRole('complementary', { name: 'History' }).getByRole('button', { name: /^Show: A lightweight trail running shoe/ }).last();
  await src.dragTo(page.getByText(/^References/).locator('xpath=..'));
  await page.getByRole('img', { name: 'Reference 1' }).waitFor({ timeout: 30_000 });
  const token = (await page.locator('.slot.filled button.mono').first().textContent())!.trim();
  await page.getByLabel('Prompt').fill(`The shoe from ${token} standing on a wet mossy rock in a forest stream, low angle, soft morning light, shallow depth of field.`);
  const before = await topId();
  await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
  refResult = await waitNewTop(before);
  await shot('reference');
  return `token ${token}`;
});

await check('Vary makes a new take of the picture on screen', async () => {
  const before = await topId();
  await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Vary' }).click();
  const id = await waitNewTop(before);
  await shot('vary');
  return `${(await item(id)).seed !== (await item(refResult)).seed ? 'new seed' : 'SAME seed'}`;
});

await check('Upscale 2× from the result', async () => {
  const shown = await topId();
  const w0 = (await item(shown!)).width;
  await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: /^Upscale/ }).click();
  await page.waitForURL(/#\/edit\//, { timeout: 30_000 }).catch(() => undefined);
  const t0 = Date.now();
  let w = 0;
  while (Date.now() - t0 < 300_000) {
    const m = /#\/edit\/([0-9a-f-]{36})/.exec(page.url());
    if (m && m[1] !== shown) {
      w = (await item(m[1])).width;
      break;
    }
    await page.waitForTimeout(2000);
  }
  await shot('upscale');
  if (!w) throw new Error(`no upscaled version (screen: ${page.url()})`);
  return `${w0} → ${w} px wide`;
});

await check('Quality High renders about 2 MP', async () => {
  await page.goto(URL + '/#/generate');
  await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Klein 9B/ }).click();
  await page.getByRole('button', { name: 'High', exact: true }).click();
  await page.getByLabel('Prompt').fill('A trail running shoe, top-down view of the outsole lug pattern, seamless white background');
  const before = await topId();
  await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
  const id = await waitNewTop(before);
  const it = await item(id);
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  const mp = (it.width * it.height) / 1e6;
  if (mp < 1.6) throw new Error(`${it.width}×${it.height}`);
  return `${it.width}×${it.height} (${mp.toFixed(1)} MP)`;
});

await check('Reuse settings puts an older picture\'s prompt back', async () => {
  await page.getByRole('complementary', { name: 'History' }).getByRole('button', { name: /^Show: A lightweight trail running shoe/ }).last().click();
  await page.getByLabel('Prompt').fill('');
  await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Reuse settings' }).click();
  const p = await page.getByLabel('Prompt').inputValue();
  if (!p.startsWith('A lightweight trail running shoe')) throw new Error(`prompt "${p.slice(0, 60)}"`);
});

fs.writeFileSync(`${OUT}/checks.txt`, results.join('\n') + '\n');
await ctx.close();
