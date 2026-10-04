/**
 * Screenshots of the darkroom look while something develops (DECISIONS 108): the red safelight on the stage and in the
 * top bar, then the print developing into view. Runs one Klein picture on the given Darkroom (use the test stack).
 *   npx tsx scripts/brand-shots.ts [url] [out dir]
 */
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? 'docs/audit-2026-10/brand';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(url + '/#/generate');
await page.getByRole('button', { name: /^Klein 9B/ }).click();
await page.getByLabel('Prompt').fill('A black and white darkroom print of a lighthouse on a cliff, hanging on a line to dry, red safelight glow');
await page.getByRole('button', { name: /^Generate Ctrl\+Enter/ }).click();
await page.locator('.progress-overlay').waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/70-developing.png` });
await page.locator('img.develop').waitFor({ timeout: 180_000 });
await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/71-print-developing-in.png` });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/72-print-developed.png` });
await browser.close();
