/**
 * Phase 0 of the test-suite run (tests/ui-map.md): open Darkroom like a user, visit every screen and mode, and save
 * a screenshot plus the accessibility tree (the names a user and the test runner see). Read-only: it clicks tabs and
 * mode pills, never Generate / Apply / Delete.
 *   npx tsx tests/ui-map-capture.ts [url]
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5178';
const out = 'tests/results/screenshots/phase0';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false, slowMo: 150 });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const snap = async (name: string) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}.png` });
  fs.writeFileSync(`${out}/${name}.aria.yml`, await page.locator('body').ariaSnapshot());
  console.log('captured', name);
};
await page.goto(url + '/#/');
await snap('00-home');
await page.goto(url + '/#/generate');
await snap('10-generate');
await page.getByText('Advanced').click();
await snap('11-generate-advanced');
// Edit: open the newest picture in the Library
const items = (await (await page.request.get(url + '/api/items?filter=generated&limit=1')).json()).items;
if (items[0]) {
  await page.goto(url + `/#/edit/${items[0].id}`);
  await snap('20-edit-instruct');
  for (const mode of ['Inpaint', 'Outpaint', 'Enhance', 'Layers', 'Remove BG', 'Upscale']) {
    const b = page.getByRole('button', { name: mode, exact: true }).first();
    if (await b.count()) {
      await b.click();
      await snap(`2${['Inpaint', 'Outpaint', 'Enhance', 'Layers', 'Remove BG', 'Upscale'].indexOf(mode) + 1}-edit-${mode.toLowerCase().replace(' ', '-')}`);
    }
  }
}
await page.goto(url + '/#/compose');
await snap('30-compose');
await page.goto(url + '/#/video');
await snap('40-video');
await page.goto(url + '/#/timeline');
await snap('50-timeline');
await page.goto(url + '/#/library');
await snap('60-library');
const tile = page.getByRole('list', { name: 'Library items' }).getByRole('listitem').first();
if (await tile.count()) {
  await tile.click();
  await snap('61-library-details');
}
await browser.close();
