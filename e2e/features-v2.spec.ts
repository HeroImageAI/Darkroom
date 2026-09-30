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

  // Addenda Phase 4: Klein outpaints via the server's black-canvas prep + crop-and-stitch; Qwen via its own graph
  for (const model of ['Klein 9B', 'Qwen-Image 2.1']) {
    test(`Edit: outpaint to 16:9 (${model})`, async () => {
      const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && (i.height ?? 0) >= (i.width ?? 1));
      test.skip(!it, 'needs a portrait or square picture in the library');
      await page.goto(`/#/edit/${it.id}`);
      await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Outpaint' }).click();
      await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: new RegExp(`^${model}`) }).click();
      await page.getByRole('button', { name: 'To 16:9' }).click();
      await expect(page.getByText('Seam feather')).toHaveCount(model.startsWith('Klein') ? 1 : 0);
      const before = page.url();
      await page.getByRole('button', { name: /Extend canvas/ }).click();
      await expect(page.getByText('New version saved')).toBeVisible({ timeout: 300_000 });
      expect(page.url()).not.toBe(before);
      const next = await page.request.get(`/api/items/${page.url().split('/').pop()}`);
      const { item } = await next.json();
      expect(item.width / item.height).toBeGreaterThan(1.6); // the canvas really grew to ~16:9
      await shot(page, `edit-outpaint-${model.startsWith('Klein') ? 'klein' : 'qwen'}`);
    });
  }

  // Addenda Phase 5
  test('Edit: remove background with Qwen (best quality) keeps real transparency', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && /lighthouse/i.test(i.prompt));
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Remove BG' }).click();
    await page.getByRole('group', { name: 'Background removal method' }).getByRole('button', { name: /Best quality/ }).click();
    const before = page.url();
    await page.getByRole('button', { name: /Remove background/ }).click();
    await expect(page.getByText('New version saved')).toBeVisible({ timeout: 300_000 });
    expect(page.url()).not.toBe(before);
    const id = page.url().split('/').pop()!;
    const png = Buffer.from(await (await page.request.get(`/api/items/${id}/file`)).body());
    expect(png.readUInt8(25)).toBe(6); // PNG colour type 6 = RGBA
    await shot(page, 'edit-remove-bg-qwen');
  });

  test('Edit: layers per object with Qwen 2.1', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && /lighthouse/i.test(i.prompt));
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Layers' }).click();
    await page.getByRole('group', { name: 'Layer method' }).getByRole('button', { name: 'Objects (Qwen 2.1)' }).click();
    await page.getByPlaceholder(/the red car, the potted palm/).fill('the person');
    await page.getByRole('button', { name: /Make layers/ }).click();
    await expect(page.getByText('Layers ready')).toBeVisible({ timeout: 400_000 });
    // layer names are editable text boxes
    await expect(page.locator('input[value="Background plate"]')).toHaveCount(1);
    await expect(page.locator('input[value="The person"]')).toHaveCount(1);
    // the stacked preview must let lower layers show through (regression: a checkerboard on every layer hid the plate)
    const bgs = await page.locator('img[alt="The person"], img[alt="Background plate"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundImage));
    expect(bgs.every((b) => b === 'none')).toBe(true);
    await shot(page, 'edit-layers-qwen21');
  });

  test('Edit: upscale through the new panel (factor + tile size)', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && (i.width ?? 9999) <= 1400);
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Upscale' }).click();
    await page.getByRole('group', { name: 'Upscale factor' }).getByRole('button', { name: '2×' }).click();
    await page.getByLabel(/Tile size/).selectOption('256');
    const before = page.url();
    await page.getByRole('button', { name: /Upscale/ }).last().click();
    await expect(page.getByText('New version saved')).toBeVisible({ timeout: 300_000 });
    expect(page.url()).not.toBe(before);
    const { item } = await (await page.request.get(`/api/items/${page.url().split('/').pop()}`)).json();
    expect(item.width).toBe(it.width * 2);
  });

  // Addenda Phase 2 (no rendering needed)
  test('Edit: Enhance defaults to Restore; the strength slider lives only under Subtle', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate');
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Enhance' }).click();
    const kinds = page.getByRole('group', { name: 'Enhance strength' });
    await expect(kinds.getByRole('button', { name: 'Restore', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Advanced')).toHaveCount(0);
    await kinds.getByRole('button', { name: 'Restore + upscale' }).click();
    await expect(page.getByLabel('Advanced')).toHaveCount(0);
    await kinds.getByRole('button', { name: 'Subtle' }).click();
    await page.getByLabel('Advanced').check();
    await expect(page.getByText(/Strength \(denoise\)/)).toBeVisible();
    await kinds.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByText(/Strength \(denoise\)/)).toHaveCount(0);
  });

  // Addenda Phase 6 (no rendering needed)
  test('Edit: presets fill the instruction, select the [SLOT] and follow the model', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate');
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Klein 9B/ }).click();
    await page.getByLabel('Presets').selectOption({ label: 'Text edit' });
    const box = page.getByLabel('Instruction');
    await expect(box).toHaveValue(/^Replace the existing text "\[OLD TEXT\]"/);
    const sel = await box.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(sel).toBe('[OLD TEXT]');
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await expect(box).toHaveValue(/^In <image1>, replace the text "\[OLD TEXT\]"/);
    await shot(page, 'edit-presets');
  });

  test('Library: right-click "Use as…" sends a picture to the video end frame', async () => {
    await page.goto('/#/library');
    const tile = page.getByRole('listitem').filter({ has: page.locator('img') }).first();
    await tile.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Use as' })).toBeVisible();
    await shot(page, 'library-use-as');
    await page.getByRole('menuitem', { name: 'Video end frame' }).click();
    await expect(page.getByAltText('End frame (optional)')).toBeVisible({ timeout: 30_000 });
  });

  test('Generate: restore settings from a Darkroom PNG', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && !!i.prompt);
    const png = Buffer.from(await (await page.request.get(`/api/items/${it.id}/file`)).body());
    await page.goto('/#/generate');
    await page.getByLabel('Prompt').fill('');
    await page.locator('input[type=file][accept*="application/json"]').setInputFiles({ name: 'darkroom.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByText(/restored/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Prompt')).not.toHaveValue('');
  });

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
