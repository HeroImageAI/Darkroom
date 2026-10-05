/**
 * End-to-end: real UI → real ComfyUI → real models.
 * Generate → Edit (instruct + remove BG) → Animate (video) → Library.
 * Screenshots go to proof/.
 */
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `proof/${name}.png` });

async function libraryCount(page: Page): Promise<number> {
  const r = await page.request.get('/api/items?limit=1');
  return (await r.json()).total as number;
}

test.describe.serial('Darkroom end to end', () => {
  let startCount = 0;
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
  });
  test.afterAll(async () => page.close());

  test('ComfyUI is connected', async () => {
    await page.goto('/#/generate');
    await expect(page.locator('.status-pill.online')).toBeVisible({ timeout: 60_000 });
    startCount = await libraryCount(page);
    await shot(page, 'E0-connected');
  });

  test('Generate an image with Klein', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    await page.getByRole('button', { name: '16:9' }).click();
    await page.getByRole('button', { name: 'Photographic', exact: true }).click();
    await page.getByRole('button', { name: '×2' }).click();
    await page.getByLabel('Prompt').fill('A lighthouse keeper in a yellow raincoat standing on wet rocks, stormy sea, dramatic clouds');
    await page.getByLabel('Prompt').press('Control+Enter');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await page.waitForTimeout(2500);
    await shot(page, 'E1-generate-progress');
    await expect(page.getByRole('toolbar', { name: 'Result actions' })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Variations').getByRole('button')).toHaveCount(2);
    await shot(page, 'E2-generate-result');
  });

  test('Generate typography with Qwen-Image 2.1', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await page.getByRole('button', { name: '4:5' }).click();
    await page.getByRole('button', { name: 'Screen print', exact: true }).click();
    await page.getByRole('button', { name: '×1' }).click();
    await page.getByLabel('Prompt').fill('Poster with the bold headline "DARKROOM" and the line "open every night" beneath, a crescent moon over rooftops');
    await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Result actions' })).toBeVisible({ timeout: 400_000 });
    await shot(page, 'E3-generate-qwen');
    // back to Klein for the rest of the run
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
  });

  test('Edit: instruction edit makes a new version', async () => {
    await page.goto('/#/generate');
    await expect(page.getByRole('toolbar', { name: 'Result actions' })).toBeVisible();
    await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Edit' }).click();
    await expect(page).toHaveURL(/#\/edit\//);
    const firstUrl = page.url();
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByLabel('Instruction').fill('Make it a calm golden sunset with a clear sky. Keep everything else unchanged.');
    await shot(page, 'E4-edit-before');
    await page.getByRole('button', { name: /Apply instruction/ }).click();
    await page.waitForURL((u) => u.toString() !== firstUrl, { timeout: 400_000 });
    await expect(page.getByRole('group', { name: 'Versions' }).getByRole('button')).toHaveCount(2);
    await page.getByRole('button', { name: 'Compare' }).click();
    await page.waitForTimeout(1000);
    await shot(page, 'E5-edit-compare');
    await page.getByRole('button', { name: 'Compare' }).click();
  });

  test('Edit: remove background', async () => {
    await page.goto('/#/generate');
    await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Edit' }).click();
    const firstUrl = page.url();
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Cut-out', exact: true }).click();
    await page.getByRole('button', { name: /Remove background/ }).click();
    await page.waitForURL((u) => u.toString() !== firstUrl, { timeout: 180_000 });
    await page.waitForTimeout(1500);
    await shot(page, 'E6-edit-cutout');
  });

  test('Animate: draft video from the generated image', async () => {
    await page.goto('/#/generate');
    await page.getByRole('toolbar', { name: 'Result actions' }).getByRole('button', { name: 'Animate' }).click();
    await expect(page).toHaveURL(/#\/video/);
    await expect(page.getByAltText('Start frame')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Motion prompt').fill('Waves crash against the rocks and the raincoat flaps in the wind.');
    await page.getByRole('button', { name: 'Slow push-in' }).click();
    // LTX 2.5 is the only video model (DECISIONS 95)
    await expect(page.getByText('LTX 2.5 · length and quality')).toBeVisible();
    await page.getByRole('button', { name: '3 s' }).click();
    await page.getByRole('button', { name: /Draft/ }).click();
    await page.getByLabel('Notify when done').uncheck();
    await shot(page, 'E7-video-setup');
    await page.getByRole('button', { name: 'Animate Ctrl+Enter' }).click();
    const take = page.getByTestId('take').first();
    await expect(take).toHaveAttribute('data-status', /queued|running/, { timeout: 30_000 });
    await page.waitForTimeout(8000);
    await shot(page, 'E8-video-running');
    // survives a reload: the running take is still there
    await page.reload();
    await expect(page.getByTestId('take').first()).toHaveAttribute('data-status', /queued|running|done/);
    await expect(page.getByTestId('take').first()).toHaveAttribute('data-status', 'done', { timeout: 900_000 });
    await expect(page.getByLabel('Video preview')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    await shot(page, 'E9-video-done');
    await expect(page.getByText('Happy with the motion?')).toBeVisible();
  });

  test('Library shows everything with metadata', async () => {
    await page.goto('/#/library');
    expect(await libraryCount(page)).toBeGreaterThan(startCount + 4);
    await page.getByRole('button', { name: 'Videos' }).click();
    await expect(page.getByRole('listitem').first()).toBeVisible();
    await page.getByRole('listitem').first().click();
    await expect(page.getByLabel('Details').getByText('Length')).toBeVisible();
    await shot(page, 'E10-library-video');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByPlaceholder(/^Search/).fill('lighthouse');
    await expect(page.getByRole('listitem').first()).toBeVisible();
    await page.getByRole('listitem').first().click();
    await expect(page.getByRole('button', { name: /Reuse settings/ })).toBeVisible();
    await shot(page, 'E11-library-search');
  });
});
