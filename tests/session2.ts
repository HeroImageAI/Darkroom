/**
 * Creative session 2 (polish review): apparel, movie and gaming work plus the Library and the Timeline, on real
 * models, with a screenshot after each step and every message Darkroom shows. Judges nothing.
 *   npx tsx tests/session2.ts [url] [out dir]
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? 'tests/results/session2';
fs.mkdirSync(out, { recursive: true });
const log: string[] = [];
const say = (s: string) => (console.log(s), log.push(s));
const browser = await chromium.launch({ channel: 'msedge' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
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
const snap = async (name: string) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png` });
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
const generate = async (model: RegExp, aspect: string, style: string, prompt: string) => {
  await page.goto(url + '/#/generate');
  await page.getByRole('button', { name: model }).first().click();
  await page.getByRole('button', { name: aspect, exact: true }).click();
  await page.getByRole('button', { name: style, exact: true }).click();
  await page.getByRole('button', { name: '×1' }).click();
  await page.getByLabel('Prompt').fill(prompt);
  await page.getByLabel('Prompt').press('Control+Enter');
  await page.getByRole('button', { name: 'Cancel' }).waitFor();
  await page.getByRole('toolbar', { name: 'Result actions' }).waitFor({ timeout: 400_000 });
  await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Edit' }).click();
  await page.waitForURL(/#\/edit\/[0-9a-f-]+/);
  await page.waitForTimeout(1500);
  return page.url().split('/').pop()!;
};
/** Run the panel's main button and wait until Edit has moved on to a new version. */
const runAndWaitVersion = async (button: RegExp) => {
  const before = page.url();
  await page.locator('.panel-foot').getByRole('button', { name: button }).click();
  await page.waitForTimeout(3000);
  await snap('running');
  await page.waitForURL((u) => u.toString() !== before, { timeout: 400_000 });
  await page.waitForTimeout(1500);
};
const modes = () => page.getByRole('group', { name: 'Edit mode' });

// Apparel: a hoodie flat lay in Qwen, then Turn it (see the side)
await step('apparel', async () => {
  await generate(/^Qwen-Image 2.1/, '4:5', 'Apparel flat', 'A heavyweight oversized hoodie in washed terracotta, kangaroo pocket, dropped shoulders, ribbed cuffs');
  await snap('apparel-generated');
  await modes().getByRole('button', { name: 'Turn it', exact: true }).click();
  await snap('apparel-turn-panel');
  await runAndWaitVersion(/^Turn it/);
  await snap('apparel-turned');
});

// Movie: a film still, Expand to 16:9, then Refine
await step('movie', async () => {
  await generate(/^Klein 9B/, '1:1', 'Film still', 'A lone astronaut walking through a flooded neon-lit alley at night, rain, reflections');
  await modes().getByRole('button', { name: 'Expand', exact: true }).click();
  await page.getByRole('button', { name: 'To 16:9' }).click();
  await snap('movie-expand-panel');
  await runAndWaitVersion(/Extend canvas/);
  await snap('movie-expanded');
  await modes().getByRole('button', { name: 'Refine', exact: true }).click();
  await snap('movie-refine-panel');
  await runAndWaitVersion(/^Refine at/);
  await snap('movie-refined');
});

// Gaming: a character, Try both models, then Cut-out
await step('gaming', async () => {
  await generate(/^Klein 9B/, '4:5', 'Game concept', 'A desert scavenger character, full body, patched cloth wraps, brass goggles, long rifle, plain grey background');
  await modes().getByRole('button', { name: 'Instruct', exact: true }).click();
  await page.getByRole('textbox', { name: 'Instruction', exact: true }).fill('Make the cloth wraps deep indigo and add a small robot companion at his feet. Keep everything else unchanged.');
  await page.getByRole('button', { name: 'Try both models' }).click();
  await page.waitForTimeout(3000);
  await snap('gaming-both-running');
  const pick = page.getByRole('dialog', { name: 'Both models' });
  await pick.waitFor({ timeout: 400_000 });
  await snap('gaming-both-pick');
  await pick.getByRole('button', { name: /^Keep Klein/ }).click();
  await page.waitForTimeout(1500);
  await modes().getByRole('button', { name: 'Cut-out', exact: true }).click();
  await snap('gaming-cutout-panel');
  await runAndWaitVersion(/Remove background/);
  await snap('gaming-cutout');
});

// Library: a board for the session, the work put on it, two versions compared
await step('library', async () => {
  await page.goto(url + '/#/library');
  await page.waitForTimeout(2500);
  await snap('library');
  await page.locator('.library-grid [role="listitem"] button').first().click();
  await page.waitForTimeout(1200);
  await snap('library-details');
  await page.locator('.library-grid [role="listitem"] button').first().click({ button: 'right' });
  await page.waitForTimeout(600);
  await snap('library-menu');
  await page.keyboard.press('Escape');
});

// Timeline: two takes, exported
await step('timeline', async () => {
  await page.goto(url + '/#/timeline');
  await page.getByRole('button', { name: 'New film' }).click();
  await page.waitForURL(/#\/timeline\/[0-9a-f-]{36}$/);
  const bin = page.getByRole('list', { name: 'Videos to add' });
  await bin.getByRole('listitem').first().waitFor();
  const add = bin.getByRole('button', { name: /^Add .* to the end$/ });
  await add.nth(0).click();
  await add.nth(1).click();
  await snap('timeline-two-clips');
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await page.getByText(/exported .* It is in your Library\./).last().waitFor({ timeout: 300_000 });
  await snap('timeline-exported');
});

say(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
fs.writeFileSync(`${out}/log.txt`, log.join('\n') + '\n');
await browser.close();
process.exit(0);
