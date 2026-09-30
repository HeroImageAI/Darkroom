/**
 * End-to-end tests for the v2 features (prompt system, local VLM, smart select, compare, video frames).
 * Real UI -> real ComfyUI. Screenshots to proof/v2-*.png.
 */
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `proof/v2-${name}.png` });

async function firstItem(page: Page, pred: (i: any) => boolean): Promise<any> {
  const r = await page.request.get('/api/items?limit=200');
  return ((await r.json()).items as any[]).find(pred);
}

test.describe.serial('Darkroom v2 features', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
  });
  test.afterAll(async () => page.close());

  test('Generate: Klein guidance is fixed, Qwen offers quality + transparency', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    await page.getByText('Advanced').click();
    await expect(page.getByText('1.0 (fixed)')).toBeVisible();
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await expect(page.getByRole('group', { name: 'Quality' })).toBeVisible();
    await expect(page.getByLabel('Transparent background')).toBeVisible();
    await shot(page, 'generate-qwen-options');
  });

  test('Generate: Enhance rewrites the prompt with the local VLM, Undo restores it', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    const box = page.getByLabel('Prompt');
    await box.fill('poster for a jazz night called "Blue Hour"');
    await page.getByRole('button', { name: /Enhance/ }).first().click();
    await expect(box).not.toHaveValue('poster for a jazz night called "Blue Hour"', { timeout: 240_000 });
    const enhanced = await box.inputValue();
    expect(enhanced.length).toBeGreaterThan(80);
    expect(enhanced).toContain('Blue Hour');
    await shot(page, 'generate-enhanced');
    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(box).toHaveValue('poster for a jazz night called "Blue Hour"');
  });

  test('Library: caption a picture with Qwen3-VL', async () => {
    await page.goto('/#/library');
    await page.getByRole('listitem').first().click();
    await page.getByRole('button', { name: 'Caption: short' }).click();
    await expect(page.getByText('Short caption')).toBeVisible({ timeout: 240_000 });
    await shot(page, 'library-caption');
  });

  test('Edit: smart select by text adds a mask', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && /fisherman|lighthouse|watch/i.test(i.prompt));
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Inpaint' }).click();
    await page.keyboard.press('s');
    await page.getByLabel('Select by text').fill('person');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText(/Selection added to the mask|Nothing was found/)).toBeVisible({ timeout: 240_000 });
    // the overlay draws a two-tone outline so the selection reads on any colour (the amber tint alone vanished on a yellow coat)
    expect(await page.getByTestId('mask-overlay').evaluate((el) => getComputedStyle(el).filter)).toContain('dr-mask-outline');
    await expect(page.locator('filter#dr-mask-outline')).toHaveCount(1);
    await shot(page, 'edit-smart-select');
  });

  // Addenda Phase 3: inpaint runs crop-and-stitch on both models (klein_inpaint_cs / qwen_inpaint_cs with the mask
  // shown as <image2>); this exercises the real Edit wiring: mask -> crop plan -> params -> ComfyUI -> new version.
  for (const model of ['Klein 9B', 'Qwen-Image 2.1']) {
    test(`Edit: inpaint with crop and stitch (${model})`, async () => {
      const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && /lighthouse/i.test(i.prompt));
      await page.goto(`/#/edit/${it.id}`);
      await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Inpaint' }).click();
      await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: new RegExp(`^${model}`) }).click();
      await page.keyboard.press('s');
      await page.getByLabel('Select by text').fill('person');
      await page.getByRole('button', { name: 'Find' }).click();
      await expect(page.getByText(/Selection added to the mask/)).toBeVisible({ timeout: 240_000 });
      await expect(page.getByText('Change strength')).toBeVisible();
      await page.getByLabel('What should fill the masked area?').fill('a lighthouse keeper in a bright red raincoat');
      const before = page.url();
      await page.getByRole('button', { name: /Fill masked area/ }).click();
      await expect(page.getByText('New version saved')).toBeVisible({ timeout: 300_000 });
      expect(page.url()).not.toBe(before);
      await shot(page, `edit-inpaint-cs-${model.startsWith('Klein') ? 'klein' : 'qwen'}`);
    });
  }

  test('Edit: compare follows the cursor', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && !!i.parent_id);
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('button', { name: 'Compare' }).click();
    const cmp = page.getByTestId('compare');
    const b = (await cmp.boundingBox())!;
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height / 2);
    await page.waitForTimeout(100);
    const clip = await page.getByAltText('Before').evaluate((el) => (el as HTMLElement).style.clipPath);
    expect(clip).toMatch(/inset\(0(px)? 7\d(\.\d+)?% 0(px)? 0(px)?\)/);
    await shot(page, 'edit-compare-hover');
    await page.mouse.move(b.x - 40, b.y - 40);
    await page.waitForTimeout(100);
    expect(await page.getByAltText('Before').evaluate((el) => (el as HTMLElement).style.clipPath)).toMatch(/100%/);
  });

  test('Video: pick frames from the library, swap, aspect warning', async () => {
    await page.goto('/#/video');
    await page.getByRole('button', { name: /^Wan 2.2/ }).click();
    await page.getByRole('button', { name: 'Start from library' }).click();
    await page.getByRole('dialog').getByRole('listitem').first().click();
    await expect(page.getByAltText('Start frame')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'End from library' }).click();
    await page.getByRole('dialog').getByRole('listitem').nth(1).click();
    await expect(page.getByAltText('End frame (optional)')).toBeVisible({ timeout: 30_000 });
    const before = await page.getByAltText('Start frame').getAttribute('src');
    await page.getByRole('button', { name: 'Swap start and end frames' }).click();
    expect(await page.getByAltText('End frame (optional)').getAttribute('src')).toBe(before);
    await shot(page, 'video-frames');
  });
});
