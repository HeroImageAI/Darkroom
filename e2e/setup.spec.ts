/**
 * Setup (DECISIONS 138): the models screen says what is installed and what a fresh PC would download. No download
 * runs here (the test PC has every required model); the downloader itself is covered by tests/models.test.ts.
 */
import { expect, test } from '@playwright/test';

test('Setup: Home leads to the models screen; everything required is installed; extras can be added', async ({ page }) => {
  await page.goto('/#/home');
  await page.getByRole('button', { name: /Models and setup/ }).click();
  await expect(page).toHaveURL(/#\/setup$/);
  const summary = page.getByRole('status', { name: 'Setup summary' });
  await expect(summary).toContainText('Everything Darkroom needs is installed', { timeout: 30_000 });
  // nothing missing, so no banner asks for setup, and no Hugging Face steps are shown
  await expect(page.getByRole('alert', { name: 'Models missing' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Hugging Face sign-in' })).toHaveCount(0);
  for (const g of ['Klein 9B', 'Qwen-Image 2.1', 'LTX 2.5', 'Tools']) await expect(page.getByRole('region', { name: new RegExp(g) })).toContainText('installed');
  // Klein counts under either file name (Black Forest Labs' or ComfyUI's repack)
  const api = (await (await page.request.get('/api/setup/models')).json()) as { models: { file: string; status: string; presentAs?: string; optional?: boolean }[]; dir: string };
  expect(api.dir).toBeTruthy();
  expect(api.models.filter((m) => !m.optional && m.status !== 'present')).toEqual([]);
  await page.screenshot({ path: 'proof/setup-installed.png' });

  // extras: shown with their size when ticked; the button offers to download them (not pressed here)
  const missingExtras = api.models.filter((m) => m.optional && m.status !== 'present');
  test.skip(!missingExtras.length, 'every extra is installed on this PC');
  await page.getByLabel('Include extras').check();
  await expect(summary.getByRole('button', { name: /^Download \d+ GB$/ })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Extras' })).toContainText(missingExtras[0].file);
  await page.screenshot({ path: 'proof/setup-extras.png' });
  await page.getByLabel('Include extras').uncheck();
});

test('Setup: a token that is not a Hugging Face token is refused, and none is stored', async ({ page }) => {
  const r = await page.request.post('/api/setup/token', { data: { token: 'not-a-token' } });
  expect(r.status()).toBe(400);
  expect((await (await page.request.get('/api/setup/models')).json()).signedIn).toBe(false);
});
