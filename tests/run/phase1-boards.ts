/**
 * Test-suite run, Phase 1 (darkroom-test-runner-brief.md): the Library structure, made through Darkroom's own UI in a
 * visible Edge window. Boards cannot nest, so one board per industry plus the inputs (tests/ui-map.md §3).
 * Resumable: a board that already exists is left alone.  npx tsx tests/run/phase1-boards.ts [url] [date]
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5178';
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
export const BOARDS = ['00 Inputs', '01 Apparel', '02 Footwear', '03 Gaming', '04 Movie', '05 Automotive'].map((b) => `TS ${date} · ${b}`);
const shots = 'tests/results/screenshots/phase1';
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: false, slowMo: 250 });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(url + '/#/library');
const row = page.getByRole('group', { name: 'Boards' });
await row.waitFor();
for (const name of BOARDS) {
  // board pills read "<name> <count>"
  const exists = await row.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`) }).count();
  if (exists) {
    console.log('exists ', name);
    continue;
  }
  await row.getByRole('button', { name: 'New board' }).click();
  await page.getByLabel('Board name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  console.log('created', name);
}
await page.screenshot({ path: `${shots}/library-boards.png` });
await browser.close();
