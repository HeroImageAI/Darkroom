/**
 * End-to-end tests for the v2 features (prompt system, local VLM, smart select, compare, video frames).
 * Real UI -> real ComfyUI. Screenshots to proof/v2-*.png.
 */
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `proof/v2-${name}.png` });

/** Edit keeps Seed, LoRAs and the Klein version under Advanced (v3.22): open it when it is closed. */
async function openEditAdvanced(page: Page) {
  const d = page.locator('details.edit-adv');
  if ((await d.getAttribute('open')) === null) await d.locator('summary').click();
}

async function firstItem(page: Page, pred: (i: any) => boolean): Promise<any> {
  const r = await page.request.get('/api/items?limit=200');
  return ((await r.json()).items as any[]).find(pred);
}

test.describe.serial('Darkroom v2 features', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    // a real context (not browser.newPage) so a test can open a second tab, i.e. a fresh launch
    const ctx = await browser.newContext({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => page.context().close());

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

  test('Generate: Klein Quality High renders ~2 MP; each model keeps its own quality', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await page.getByRole('group', { name: 'Quality' }).getByRole('button', { name: 'Draft' }).click();
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    const quality = page.getByRole('group', { name: 'Quality' });
    await expect(page.getByLabel('Transparent background')).toHaveCount(0); // Qwen only
    await quality.getByRole('button', { name: 'High' }).click();
    await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '3:2' }).click();
    await expect(page.getByText('1728 × 1152')).toBeVisible();
    await page.getByLabel('Prompt').fill('a bakery storefront with a hand-painted sign reading "SUNRISE BAKERY", cobbled street');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
    const body = (await sent).postDataJSON();
    expect([body.params.width, body.params.height, body.params.steps]).toEqual([1728, 1152, 4]);
    await expect.poll(async () => ((await (await page.request.get('/api/items?limit=5&filter=generated')).json()).items as any[]).some((i) => i.width === 1728 && i.height === 1152), { timeout: 120_000 }).toBe(true);
    // Qwen kept Draft: Klein's High is its own setting
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await expect(page.getByRole('group', { name: 'Quality' }).getByRole('button', { name: 'Draft' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    await expect(quality.getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true');
    await quality.getByRole('button', { name: 'Standard' }).click();
    await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '1:1' }).click();
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
    expect(enhanced).toMatch(/blue[\s\S]{0,60}hour/i); // the enhancer may set the title in capitals, or split over two lines
    await shot(page, 'generate-enhanced');
    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(box).toHaveValue('poster for a jazz night called "Blue Hour"');
  });

  test('Generate: Enhance writes for the chosen style (Klein, Ink sketch)', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    const style = page.getByRole('group', { name: 'Style preset' });
    await style.getByRole('button', { name: 'Ink sketch' }).click();
    const box = page.getByLabel('Prompt');
    await box.fill('a fox in a snowy forest at dawn');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await page.getByRole('button', { name: /Enhance/ }).first().click();
    expect((await sent).postDataJSON()).toMatchObject({ task: 'enhance', variant: 'klein', style: 'ink' });
    await expect(box).not.toHaveValue('a fox in a snowy forest at dawn', { timeout: 120_000 });
    // written for a drawing: the language of ink, not of a camera
    const text = await box.inputValue();
    expect(text).toMatch(/ink|line|hatch|sketch|paper|stroke/i);
    expect(text).not.toMatch(/\b(lens|bokeh|aperture)\b/i);
    await expect(page.getByText(/Prompt enhanced for Ink sketch/).last()).toBeVisible();
    await style.getByRole('button', { name: 'None' }).click();
    await box.fill('');
  });

  test('Generate: with references, "From references" writes a prompt that names each one', async () => {
    const pics = (await (await page.request.get('/api/items?limit=200')).json()).items.filter((i: any) => i.kind === 'image' && i.mode === 'generate');
    await page.goto('/#/generate');
    await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click().catch(() => undefined);
    for (const it of pics.slice(0, 2)) {
      await page.goto(`/#/generate?ref=${it.id}`);
      await page.waitForTimeout(800);
    }
    const tools = page.locator('.prompt-tools');
    await expect(tools.getByRole('button', { name: 'From references' })).toBeVisible();
    await page.getByLabel('Prompt').fill('');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await tools.getByRole('button', { name: 'From references' }).click();
    const body = (await sent).postDataJSON();
    expect(body.task).toBe('compose');
    expect(body.inputs.length).toBeGreaterThanOrEqual(2);
    await expect(page.getByLabel('Prompt')).not.toHaveValue('', { timeout: 120_000 });
    const text = await page.getByLabel('Prompt').inputValue();
    expect(text).toMatch(body.variant === 'qwen' ? /<image1>/ : /image 1/);
    expect(text).toMatch(body.variant === 'qwen' ? /<image2>/ : /image 2/);
    expect(text).not.toMatch(/image ?3|<image3>/);
    await shot(page, 'generate-from-references');
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
    await expect(page.getByText(/Selection added to the mask|Nothing was found/).last()).toBeVisible({ timeout: 240_000 });
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
      await expect(page.getByText(/Selection added to the mask/).last()).toBeVisible({ timeout: 240_000 });
      await expect(page.getByText('Change strength')).toBeVisible();
      await page.getByLabel('What should fill the masked area?').fill('a lighthouse keeper in a bright red raincoat');
      const before = page.url();
      await page.getByRole('button', { name: /Fill masked area/ }).click();
      await expect(page.getByText('New version saved')).toBeVisible({ timeout: 300_000 });
      expect(page.url()).not.toBe(before);
      await shot(page, `edit-inpaint-cs-${model.startsWith('Klein') ? 'klein' : 'qwen'}`);
    });
  }

  // Addenda Phase 3, circle quick edit: Qwen gets the picture with a red circle round the painted mask (DECISIONS 73)
  test('Edit: point at an object with a red circle (Qwen)', async () => {
    const it = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && /lighthouse/i.test(i.prompt));
    await page.goto(`/#/edit/${it.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Klein 9B/ }).click();
    // the mask settings appear with the first stroke (v3.22): before that, only a hint
    await expect(page.getByLabel(/Point at it with a red circle/)).toHaveCount(0);
    await expect(page.getByText(/To change only part of the picture, paint over it/)).toBeVisible();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await page.keyboard.press('s');
    await page.getByLabel('Select by text').fill('person');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText(/Selection added to the mask/).last()).toBeVisible({ timeout: 240_000 });
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Klein 9B/ }).click();
    await expect(page.getByLabel(/Point at it with a red circle/)).toBeDisabled(); // Qwen only
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await page.getByLabel(/Point at it with a red circle/).check();
    await expect(page.getByLabel(/Only change the masked area/)).toBeDisabled();
    await page.getByLabel('Instruction').fill('Replace them with a lighthouse keeper in a bright red raincoat.');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    const before = page.url();
    await page.getByRole('button', { name: /Apply instruction/ }).click();
    const body = (await sent).postDataJSON();
    expect(body.workflow).toBe('qwen_edit');
    expect(body.params.image_1).toMatch(/(^|\/)dr_/); // the circled upload, not the library picture (lib_<id>_main)
    expect(body.params.mask).toBeUndefined();
    expect(body.params.prompt).toMatch(/circled in red.*Remove the red circle/);
    await expect(page.getByText('New version saved')).toBeVisible({ timeout: 300_000 });
    expect(page.url()).not.toBe(before);
    await shot(page, 'edit-circle-qwen');
  });

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
    // LTX 2.5 is the only video model (DECISIONS 95): no model cards, no Wan
    await expect(page.getByRole('group', { name: 'Video model' })).toHaveCount(0);
    await expect(page.getByText('LTX 2.5 · length and quality')).toBeVisible();
    await expect(page.getByText(/Wan 2.2/)).toHaveCount(0);
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

  test('Video: Suggest motion looks at the end frame too', async () => {
    // continues from the previous test: start and end frames are set
    await page.getByLabel('Motion prompt').fill('');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Suggest motion' }).click();
    const body = (await sent).postDataJSON();
    expect(body.task).toBe('motion');
    expect(body.input).toBeTruthy();
    expect(body.input2).toBeTruthy();
    expect(body.input2).not.toBe(body.input);
    await expect(page.getByLabel('Motion prompt')).not.toHaveValue('', { timeout: 120_000 });
    expect((await page.getByLabel('Motion prompt').inputValue()).split(/\s+/).length).toBeGreaterThan(15);
    await shot(page, 'video-motion-endframe');
  });

  test('Video: with camera chips, Suggest motion leaves the camera to them (DECISIONS 94)', async () => {
    // continues: frames are set; choose Static
    const chips = page.getByRole('button', { name: 'Static', exact: true });
    if ((await chips.getAttribute('aria-pressed')) !== 'true') await chips.click();
    await page.getByLabel('Motion prompt').fill('');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Suggest motion' }).click();
    expect((await sent).postDataJSON().camera).toEqual(['static']);
    await expect(page.getByLabel('Motion prompt')).not.toHaveValue('', { timeout: 120_000 });
    // no camera sentence of its own: Static's sentence is added at render time
    expect(await page.getByLabel('Motion prompt').inputValue()).not.toMatch(/(^|[.!?]\s+)the camera\b/i);
    await expect(page.getByText(/Motion prompt written for .* to suit Static/).last()).toBeVisible();
    await chips.click(); // off again
  });

  test('Video: 1080p uses the two-stage graph at full HD (DECISIONS 96)', async () => {
    // continues: frames are set
    const quality = page.getByRole('group', { name: 'Quality' });
    await quality.getByRole('button', { name: '1080p' }).click();
    await page.getByLabel('Motion prompt').fill('Leaves sway gently in a light breeze.');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Animate Ctrl+Enter' }).click();
    const req = await sent;
    const body = req.postDataJSON();
    expect(body.workflow).toBe('ltx25_i2v_hd');
    expect(Math.max(body.params.width, body.params.height)).toBe(1920);
    // no need to render it here: cancel straight away
    const job = await (await req.response())!.json();
    await page.request.post(`/api/jobs/${job.id}/cancel`);
    await quality.getByRole('button', { name: /^Draft/ }).click();
  });

  test('Video: Sound — Silent, or your own description; Suggest motion leaves it alone (DECISIONS 97)', async () => {
    // continues: frames are set
    const sound = page.getByRole('group', { name: 'Sound' });
    await page.getByLabel('Motion prompt').fill('Leaves sway gently in a light breeze.');
    const animate = async () => {
      const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
      await page.getByRole('button', { name: 'Animate Ctrl+Enter' }).click();
      const req = await sent;
      const job = await (await req.response())!.json();
      await page.request.post(`/api/jobs/${job.id}/cancel`);
      return req.postDataJSON();
    };
    await sound.getByRole('button', { name: 'Silent' }).click();
    const silent = await animate();
    expect(silent.params.silent).toBe(1);
    expect(silent.meta.ui.sound).toBe('off');
    await sound.getByRole('button', { name: 'Describe' }).click();
    await page.getByLabel('Sound description').fill('rain on the window and a distant train');
    const described = await animate();
    expect(described.params.silent).toBeUndefined();
    expect(described.params.motion_prompt).toMatch(/Leaves sway gently in a light breeze\. .*Rain on the window and a distant train\.$/);
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await page.getByLabel('Motion prompt').fill('');
    await page.getByRole('button', { name: 'Suggest motion' }).click();
    expect((await sent).postDataJSON().sound).toEqual({ mode: 'describe', text: 'rain on the window and a distant train' });
    await expect(page.getByLabel('Motion prompt')).not.toHaveValue('', { timeout: 120_000 });
    // it keeps no copy of the description (Video adds it itself)
    expect(await page.getByLabel('Motion prompt').inputValue()).not.toMatch(/rain on the window and a distant train/i);
    await shot(page, 'video-sound');
    await sound.getByRole('button', { name: 'From the scene' }).click();
  });

  test("Video: Lightricks' LTX LoRAs — Slow motion, Cinemagraph, Refine details (DECISIONS 98)", async () => {
    const cat = await (await page.request.get('/api/loras')).json();
    const has = (re: RegExp, list: any[]) => list.some((l: any) => re.test(l.name));
    test.skip(!has(/slow-motion-control/, cat.ltx) || !has(/cinemagraph/, cat.ltx) || !has(/refine-details/, cat.ltxTools), "Lightricks' LTX LoRAs are not on this machine");
    // continues: frames are set
    const effect = page.getByRole('group', { name: 'Effect' });
    await page.getByLabel('Motion prompt').fill('Pedestrians cross the street.');
    const animate = async () => {
      const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
      await page.getByRole('button', { name: 'Animate Ctrl+Enter' }).click();
      const req = await sent;
      const job = await (await req.response())!.json();
      await page.request.post(`/api/jobs/${job.id}/cancel`);
      return req.postDataJSON();
    };
    await effect.getByRole('button', { name: 'Slow motion' }).click();
    await page.getByRole('group', { name: 'Slow-motion speed' }).getByRole('button', { name: '¼ speed' }).click();
    const slow = await animate();
    expect(slow.params.motion_speed).toBe(0.25);
    expect(JSON.parse(slow.params.loras)[0].name).toMatch(/slow-motion-control/);
    await effect.getByRole('button', { name: 'Cinemagraph' }).click();
    const cine = await animate();
    expect(cine.params.motion_prompt).toMatch(/^CINEMAGRAPH_MOTION, Pedestrians cross the street\. The camera holds a locked-off static shot.* Seamless natural loop\.$/);
    expect(JSON.parse(cine.params.loras)[0]).toMatchObject({ strength: 1.1 });
    expect(cine.params.motion_speed).toBeUndefined();
    await effect.getByRole('button', { name: 'None' }).click();
    // the effect LoRAs are driven by the Effect control, not offered in the LoRA list
    await expect(page.locator('.lora-picker')).not.toContainText(/slow-motion|cinemagraph/i);
    // Refine details on a take up to 720p: the take itself goes in, at the Final size
    const take = ((await (await page.request.get('/api/items?limit=50&filter=videos')).json()).items as any[]).find((i) => i.workflow?.startsWith('ltx') && Math.max(i.width, i.height) <= 1280);
    await page.goto(`/#/video?take=${take.id}`);
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Refine details' }).click();
    const req = await sent;
    const body = req.postDataJSON();
    expect(body.workflow).toBe('ltx25_v2v_refine');
    expect(body.meta).toMatchObject({ mode: 'refine', parentId: take.id });
    expect(Math.max(body.params.width, body.params.height)).toBe(1280);
    const job = await (await req.response())!.json();
    await page.request.post(`/api/jobs/${job.id}/cancel`);
  });

  test('Video: Cut out — Alpha-Gen matte, then the take over a new background (DECISIONS 99)', async () => {
    const cat = await (await page.request.get('/api/loras')).json();
    test.skip(!cat.ltxTools.some((l: any) => /alpha-gen/.test(l.name)), 'Alpha-Gen is not on this machine');
    const take = ((await (await page.request.get('/api/items?limit=50&filter=videos')).json()).items as any[]).find((i) => i.workflow === 'ltx25_i2v' && Math.max(i.width, i.height) <= 1280 && i.frames <= 145);
    await page.goto(`/#/video?take=${take.id}`);
    await page.getByRole('button', { name: 'Cut out' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cut out: the new background' });
    await expect(dialog).toBeVisible();
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await dialog.getByRole('button', { name: 'Background #2fa45a' }).click();
    const req = await sent;
    const body = req.postDataJSON();
    expect(body.workflow).toBe('ltx25_v2v_alpha');
    expect(body.params).toMatchObject({ motion_prompt: '', width: take.width, height: take.height });
    expect(body.meta).toMatchObject({ mode: 'matte', parentId: take.id, chain: { kind: 'composite', firstItemId: take.id } });
    expect(body.meta.chain.background).toBeTruthy(); // the plain-colour picture Darkroom made and uploaded
    const job = await (await req.response())!.json();
    await page.request.post(`/api/jobs/${job.id}/cancel`);
  });

  test('Video: Auto length — LTX picks the length from the prompt, up to the longest allowed (DECISIONS 100)', async () => {
    // continues: frames are set
    await page.goto('/#/video');
    const length = page.getByRole('group', { name: 'Length' });
    await length.getByRole('button', { name: 'Auto' }).click();
    await expect(page.locator('.readout')).toContainText('Auto length, 2–8 s');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Animate Ctrl+Enter' }).click();
    const req = await sent;
    expect(req.postDataJSON().params.auto_duration).toBe(8);
    const job = await (await req.response())!.json();
    expect(job.status).not.toBe('failed'); // the server accepted the duration head on the graph
    await page.request.post(`/api/jobs/${job.id}/cancel`);
    await length.getByRole('button', { name: '5 s' }).click();
  });

  test('Library: Upload brings your own video in as it is, with its real size, frame rate and length (DECISIONS 100)', async () => {
    await page.goto('/#/library');
    const before = (await (await page.request.get('/api/items?limit=1')).json()).total;
    await page.getByLabel('Upload pictures to the Library').setInputFiles('tests/fixtures/old-footage-10s.mp4');
    await expect.poll(async () => (await (await page.request.get('/api/items?limit=1')).json()).total, { timeout: 60_000 }).toBe(before + 1);
    await expect(page.getByText('1 video added to your Library. Double-click to open.').last()).toBeVisible();
    const it = await firstItem(page, (i) => i.mode === 'import' && i.kind === 'video');
    expect(it).toMatchObject({ width: 640, height: 352, frames: 242, fps: 24 });
    expect(it.ui.sound).toBe('off'); // the file has no sound track
  });

  test('Video: Restore — old footage in 4-second parts that continue from each other (DECISIONS 100)', async () => {
    const cat = await (await page.request.get('/api/loras')).json();
    test.skip(!cat.ltxTools.some((l: any) => /ic-lora-restore/.test(l.name)), 'The Restore IC-LoRA is not on this machine');
    const take = await firstItem(page, (i) => i.mode === 'import' && i.kind === 'video' && i.frames === 242);
    await page.goto(`/#/video?take=${take.id}`);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore old footage' });
    await expect(dialog).toContainText('1280×704');
    await expect(dialog).toContainText('3 parts of 4 seconds');
    await dialog.getByLabel("What's in the clip (optional)").fill('A fishing harbour in the 1950s.');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await dialog.getByRole('button', { name: 'Restore' }).click();
    const req = await sent;
    const body = req.postDataJSON();
    expect(body.workflow).toBe('ltx25_v2v_restore');
    expect(body.params).toMatchObject({ start: 0, length: 97, width: 1280, height: 704 });
    expect(body.params.motion_prompt).toMatch(/^A fishing harbour in the 1950s\. Restored film footage/);
    expect(body.meta).toMatchObject({ mode: 'restore_part', chain: { kind: 'restore', firstItemId: take.id } });
    expect(body.meta.chain.windows.map((w: any) => w.start)).toEqual([0, 80, 160]);
    const job = await (await req.response())!.json();
    await page.request.post(`/api/jobs/${job.id}/cancel`);
  });

  test('Timeline: put clips together, split, crossfade, mute, move, add your sound, export one MP4 (DECISIONS 103)', async () => {
    await page.goto('/#/timeline');
    await page.getByRole('button', { name: 'New film' }).click();
    await expect(page).toHaveURL(/#\/timeline\/[0-9a-f-]{36}$/);
    const film = page.url().split('/').pop()!;
    const saved = async () => (await (await page.request.get(`/api/timelines/${film}`)).json()).doc;
    // two Library videos, each added to the end
    const bin = page.getByRole('list', { name: 'Videos to add' });
    await bin.getByRole('listitem').first().waitFor();
    const add = bin.getByRole('button', { name: /^Add .* to the end$/ });
    await add.nth(0).click();
    await add.nth(1).click();
    const track = page.getByRole('list', { name: 'Video track' });
    await expect(track.getByRole('listitem')).toHaveCount(2);
    await expect.poll(async () => (await saved()).clips.length).toBe(2);
    const [a, b] = (await saved()).clips;
    expect(b.start).toBeCloseTo(a.out - a.in, 2); // the second starts where the first ends
    // split the first clip at 1 s with S
    await page.getByRole('button', { name: 'To the start' }).click();
    for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowRight');
    await track.getByRole('listitem').first().click();
    await page.keyboard.press('s');
    await expect(track.getByRole('listitem')).toHaveCount(3);
    // crossfade the last clip in, mute the first
    await track.getByRole('listitem').nth(2).click({ position: { x: 40, y: 20 } });
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('group', { name: 'Transition' }).getByRole('button', { name: 'Fade ½ s' }).click();
    await expect(track.locator('.tl-fade')).toHaveCount(1);
    await track.getByRole('listitem').first().click({ position: { x: 20, y: 20 } });
    await inspector.getByLabel("The clip's own sound").uncheck();
    await expect.poll(async () => (await saved()).clips.filter((c: any) => c.muted).length).toBe(1);
    // undo brings the sound back; redo mutes again
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await saved()).clips.filter((c: any) => c.muted).length).toBe(0);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await saved()).clips.filter((c: any) => c.muted).length).toBe(1);
    // drag the first piece right: it moves and snaps back to 0 when dropped near it
    const first = track.getByRole('listitem').first();
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.min(...(await saved()).clips.map((c: any) => c.start))).toBeGreaterThan(0.5);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => Math.min(...(await saved()).clips.map((c: any) => c.start))).toBe(0);
    // your own sound on the sound track
    await page.getByLabel('Upload sound').setInputFiles('tests/fixtures/ltx-864x480-121f.mp4');
    await expect(page.getByRole('list', { name: 'Sound track' }).getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
    // export: one MP4 in the Library, as long as the film
    const doc = await saved();
    const total = Math.max(...doc.clips.map((c: any) => c.start + c.out - c.in), ...doc.sounds.map((s: any) => s.start + s.out - s.in));
    const sent = page.waitForResponse((r) => r.url().endsWith(`/api/timelines/${film}/export`), { timeout: 180_000 });
    await page.getByRole('button', { name: 'Export MP4' }).click();
    const item = await (await sent).json();
    expect(item).toMatchObject({ mode: 'timeline', kind: 'video' });
    expect(Math.abs(item.duration - total)).toBeLessThan(0.1);
    await expect(page.getByText(/exported .* It is in your Library\./).last()).toBeVisible();
    await shot(page, 'timeline');
  });

  test('Timeline AI: fill a gap (a real render drops into place), and a retake can be stopped and removed (DECISIONS 104)', async () => {
    // a film of two Library videos with a 1.5 s gap between them
    const vids = ((await (await page.request.get('/api/items?filter=videos&limit=40')).json()).items as any[]).filter((v) => v.mode !== 'timeline' && (v.duration ?? 0) >= 2.5);
    const film = crypto.randomUUID();
    const doc = { v: 1, size: 'auto', fps: 24, sounds: [], clips: [ { id: 'a', itemId: vids[0].id, start: 0, in: 0, out: 2 }, { id: 'b', itemId: vids[1].id, start: 3.5, in: 0, out: 2 } ] };
    await page.request.put(`/api/timelines/${film}`, { data: { name: 'AI test film', doc } });
    const saved = async () => (await (await page.request.get(`/api/timelines/${film}`)).json()).doc;
    await page.goto(`/#/timeline/${film}`);
    const track = page.getByRole('list', { name: 'Video track' });
    await expect(track.getByRole('listitem')).toHaveCount(2);
    // click the empty stretch: the gap is selected and the Fill form offered
    const lane = (await track.boundingBox())!;
    const zoom = 60;
    await page.mouse.click(lane.x + 2.75 * zoom, lane.y + lane.height / 2);
    await expect(page.getByLabel('Selected gap')).toBeVisible();
    const fill = page.getByRole('region', { name: 'Fill with AI' });
    await fill.getByLabel('Fill with AI: what happens').fill('The motion carries on smoothly.');
    await fill.getByRole('button', { name: /^Fill with AI \(1\.5 s\)$/ }).click();
    await expect(track.locator('.tl-pending')).toHaveCount(1);
    // the clip lands in place of its placeholder, overlapping its neighbours by the handles
    await expect(track.locator('.tl-pending')).toHaveCount(0, { timeout: 300_000 });
    await expect(track.getByRole('listitem')).toHaveCount(3);
    const filled = (await saved()).clips.find((c: any) => !['a', 'b'].includes(c.id));
    expect(filled.start).toBeCloseTo(2 - 4 / 24, 2);
    expect(filled.out - filled.in).toBeCloseTo(1.5 + 8 / 24, 1);
    // retake a moment of the first clip, then stop it: the placeholder goes, the clip is cut where it was
    await page.getByRole('button', { name: 'To the start' }).click();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    await track.getByRole('listitem').first().click({ position: { x: 10, y: 20 } });
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('group', { name: 'AI tool' }).getByRole('button', { name: 'Retake a moment' }).click();
    await inspector.getByRole('group', { name: 'Retake length' }).getByRole('button', { name: '1 s' }).click();
    await inspector.getByRole('button', { name: /^Retake \(1\.0 s\)$/ }).click();
    await expect(track.locator('.tl-pending')).toHaveCount(1);
    await track.locator('.tl-pending').click();
    await inspector.getByRole('button', { name: /Stop and remove|Remove/ }).click();
    await expect(track.locator('.tl-pending')).toHaveCount(0);
    await expect.poll(async () => (await saved()).pending?.length ?? 0).toBe(0);
    // the first clip is whole again
    await expect.poll(async () => (await saved()).clips.filter((c: any) => c.itemId === vids[0].id).map((c: any) => [c.start, c.in, c.out])).toEqual([[0, 0, 2]]);
    await shot(page, 'timeline-ai');
  });
  // UX review (2026-09-30)
  test('UX: the prompt tools fit the Generate panel', async () => {
    await page.goto('/#/generate');
    const panel = await page.getByRole('complementary', { name: 'Generate settings' }).boundingBox();
    for (const name of ['From picture', 'Restore', 'Enhance']) {
      const b = await page.locator('.prompt-tools').getByRole('button', { name, exact: true }).boundingBox();
      expect(b!.x + b!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
    }
  });

  test('Home: Darkroom opens on Home, with the five screens and "Continue where you left off"', async () => {
    await page.goto('/#/library');
    await expect(page.getByRole('region', { name: 'Library' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'What are we developing today?' })).toBeVisible();
    const start = page.getByRole('navigation', { name: 'Start' });
    for (const name of ['Generate', 'Edit', 'Compose', 'Video', 'Library']) await expect(start.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    await shot(page, 'home');
    await page.getByRole('button', { name: /Continue where you left off/ }).click();
    await expect(page).toHaveURL(/#\/library$/);
    await page.getByRole('button', { name: 'Darkroom — Home' }).click();
    await start.getByRole('button', { name: /^Generate/ }).click();
    await expect(page).toHaveURL(/#\/generate$/);
  });

  test('Home: upload your own picture and it opens in Edit', async () => {
    await page.goto('/');
    await page.getByLabel('Upload pictures', { exact: true }).setInputFiles('tests/golden/01_portrait.png');
    await expect(page).toHaveURL(/#\/edit\/[0-9a-f-]+$/, { timeout: 60_000 });
    const id = page.url().split('/').pop();
    const { item } = await (await page.request.get(`/api/items/${id}`)).json();
    expect(item.mode).toBe('import');
    expect(item.prompt).toBe('01_portrait');
    expect([item.width, item.height]).toEqual([896, 1120]);
    await expect(page.getByRole('group', { name: 'Versions' }).getByRole('button')).toHaveCount(1);
  });

  test('Edit: Upload with a picture open brings several in and opens the first', async () => {
    const before = (await (await page.request.get('/api/items?limit=1')).json()).total;
    const first = page.url();
    await page.getByLabel('Upload your own picture').setInputFiles(['tests/golden/09_car.png', 'tests/golden/10_interior.png']);
    await expect(page.getByText('2 pictures added to your Library. Opening the first one.')).toBeVisible({ timeout: 60_000 });
    expect(page.url()).not.toBe(first);
    expect((await (await page.request.get('/api/items?limit=1')).json()).total).toBe(before + 2);
  });

  // Large photos (DECISIONS 79): Restore comes back at full size; whole-picture edits offer Sharpen to full resolution
  test('Edit: a large photo keeps its size through Restore, and a whole-picture edit can be sharpened back', async () => {
    const big = path.join(os.tmpdir(), 'darkroom-e2e-DSC_1001.jpg');
    await sharp('tests/golden/09_car.png').resize(3000, 1714, { kernel: 'lanczos3' }).jpeg({ quality: 92 }).toFile(big);
    await page.goto('/');
    await page.getByLabel('Upload pictures', { exact: true }).setInputFiles(big);
    await expect(page).toHaveURL(/#\/edit\/[0-9a-f-]+$/, { timeout: 60_000 });
    const src = page.url();
    const apply = page.locator('.panel-foot .btn.primary').first();
    const sizeOf = async () => {
      const { item } = await (await page.request.get(`/api/items/${page.url().split('/').pop()}`)).json();
      return { size: `${item.width}x${item.height}`, mode: item.mode };
    };

    // Restore: the note explains the rebuild, and the version that opens is full size
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Enhance' }).click();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Klein 9B/ }).click();
    // 3000x1714 is above 4 MP: Klein + the restore LoRA at 4 MP, then SeedVR2 to the exact size (DECISIONS 83)
    await expect(page.getByText(/Large picture \(5 MP\).*restore LoRA, then SeedVR2 takes it to 3000×1714/)).toBeVisible();
    await apply.click();
    await expect.poll(sizeOf, { timeout: 400_000, intervals: [3000] }).toEqual({ size: '3000x1714', mode: 'upscale' });

    // whole-picture instruct: soft result, banner, Sharpen -> full-resolution version
    await page.goto(src);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByLabel('Instruction').fill('Make it an overcast day.');
    await apply.click();
    await expect.poll(async () => (page.url() !== src ? (await sizeOf()).mode : ''), { timeout: 300_000 }).toBe('edit:instruct');
    const sharpen = page.getByRole('button', { name: 'Sharpen to full resolution' });
    await expect(sharpen).toBeVisible();
    await shot(page, 'edit-large-sharpen');
    const soft = page.url();
    await sharpen.click();
    await expect.poll(async () => (page.url() !== soft ? await sizeOf() : null), { timeout: 300_000 }).toEqual({ size: '3000x1714', mode: 'upscale' });
    await page.goto(soft);
    await expect(page.getByRole('button', { name: 'Sharpen to full resolution' })).toHaveCount(0);
  });

  // History and Takes are views of the Library (DECISIONS 81)
  test('Generate History: delete a picture in place, Undo brings it back', async () => {
    const count = async (f: string) => (await (await page.request.get(`/api/items?limit=1&filter=${f}`)).json()).total as number;
    await page.goto('/#/generate');
    const rail = page.getByRole('complementary', { name: 'History' });
    await expect(rail.locator('.rail-item').first()).toBeVisible();
    const before = await count('all');
    const firstLabel = await rail.locator('.rail-item').first().getByRole('button').first().getAttribute('aria-label');
    await rail.locator('.rail-item').first().hover();
    await rail.getByRole('button', { name: 'Delete this picture' }).first().click();
    await expect(page.getByText('1 picture moved to Recently deleted.').last()).toBeVisible();
    expect(await count('all')).toBe(before - 1);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(page.getByText('Restored.').last()).toBeVisible();
    expect(await count('all')).toBe(before);
    await expect(rail.locator('.rail-item').first().getByRole('button').first()).toHaveAttribute('aria-label', firstLabel!);
    await expect(rail.getByRole('button', { name: 'See all in Library' })).toBeVisible();
  });

  test('Video Takes: failed renders can be dismissed, finished takes deleted with Undo', async () => {
    // a render cancelled straight away = a failed take (no video)
    const pic = (await (await page.request.get('/api/items?limit=50')).json()).items.find((i: any) => i.kind === 'image');
    const inp = await (await page.request.post(`/api/items/${pic.id}/as-input`, { data: { which: 'main' } })).json();
    const job = await (await page.request.post('/api/jobs', { data: { workflow: 'ltx25_i2v', params: { start_image: inp.name, motion_prompt: 'e2e cancelled take', seed: 1 }, meta: { mode: 'video', model: 'LTX 2.5', prompt: 'e2e' } } })).json();
    await page.request.post(`/api/jobs/${job.id}/cancel`);
    await expect.poll(async () => ((await (await page.request.get('/api/jobs?kind=video&limit=5')).json()) as any[]).find((j) => j.id === job.id)?.status, { timeout: 30_000 }).toBe('cancelled');

    await page.goto('/#/video');
    const takes = page.getByRole('complementary', { name: 'Takes' });
    await expect(takes.getByRole('button', { name: /Clear failed \(\d+\)/ })).toBeVisible({ timeout: 15_000 });
    await takes.getByRole('button', { name: /Clear failed/ }).click();
    await expect(takes.getByRole('button', { name: /Clear failed/ })).toHaveCount(0);
    await expect(takes.locator('[data-status="cancelled"], [data-status="error"], [data-status="lost"]')).toHaveCount(0);

    const videos = async () => (await (await page.request.get('/api/items?limit=1&filter=videos')).json()).total as number;
    const before = await videos();
    // the panel lists the newest 30 takes, so follow the deleted take itself rather than the count
    const id = await takes.getByTestId('take').first().getAttribute('data-job');
    await takes.getByTestId('take').first().hover();
    await takes.getByRole('button', { name: 'Delete this take' }).first().click();
    await expect(page.getByText('1 video moved to Recently deleted.').last()).toBeVisible();
    await expect(takes.locator(`[data-job="${id}"]`)).toHaveCount(0);
    expect(await videos()).toBe(before - 1);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(takes.locator(`[data-job="${id}"]`)).toHaveCount(1);
    expect(await videos()).toBe(before);
    await shot(page, 'video-takes');
  });

  // Clean workspace (DECISIONS 82): work in progress is per launch, preferences stay, deleted work leaves the screen
  test('Generate: a fresh launch starts clean but keeps preferences; New clears with Undo', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    await page.getByLabel('Prompt').fill('a ceramic teapot on linen, morning light');
    await page.getByRole('complementary', { name: 'History' }).locator('.rail-item').first().getByRole('button').first().click();
    await expect(page.getByText('Nothing developed yet')).toHaveCount(0);

    // a new tab = a fresh launch (sessionStorage is per tab, localStorage is shared)
    const fresh = await page.context().newPage();
    await fresh.goto('/#/generate');
    await expect(fresh.getByLabel('Prompt')).toHaveValue('');
    await expect(fresh.getByText('Nothing developed yet')).toBeVisible();
    await expect(fresh.getByRole('button', { name: /^Klein 9B/ })).toHaveAttribute('aria-pressed', 'true');
    await fresh.close();

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByLabel('Prompt')).toHaveValue('');
    await expect(page.getByText('Nothing developed yet')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(page.getByLabel('Prompt')).toHaveValue('a ceramic teapot on linen, morning light');
    await expect(page.getByText('Nothing developed yet')).toHaveCount(0);
  });

  test('Generate and Video: deleted work leaves the screen', async () => {
    const pics = (await (await page.request.get('/api/items?limit=20&filter=generated')).json()).items;
    const victim = pics[3];
    try {
      // Generate: the picture on screen is deleted in the Library -> clean stage
      await page.goto('/#/generate');
      // History lists the same pictures in the same order (many test pictures share a prompt, so pick by position)
      await page.getByRole('complementary', { name: 'History' }).locator('.rail-item').nth(3).getByRole('button').first().click();
      await expect(page.getByText('Nothing developed yet')).toHaveCount(0);
      await page.request.post('/api/items/delete', { data: { ids: [victim.id] } });
      await expect(page.getByText('Nothing developed yet')).toBeVisible();
      // Video: a start frame picked from that picture goes too
      await page.request.post('/api/items/restore', { data: { ids: [victim.id] } });
      await page.goto(`/#/video?start=${victim.id}`);
      await expect(page.getByAltText('Start frame')).toBeVisible({ timeout: 30_000 });
      await page.request.post('/api/items/delete', { data: { ids: [victim.id] } });
      await expect(page.getByAltText('Start frame')).toHaveCount(0);
    } finally {
      // never leave the shared test library with a deleted picture, even when a step fails
      await page.request.post('/api/items/restore', { data: { ids: [victim.id] } });
    }
  });

  // Boards (DECISIONS 84)
  test('Boards: the working board receives new pictures, versions stay with their picture, deleting a board keeps its pictures', async () => {
    const boardsApi = async () => (await (await page.request.get('/api/boards')).json()).boards as any[];
    await page.goto('/#/library');
    await page.getByLabel('Working board').selectOption('__new__');
    await page.getByLabel('Board name').fill('e2e board');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('New pictures now go to "e2e board".').last()).toBeVisible();
    const board = (await boardsApi()).find((b) => b.name === 'e2e board');
    try {
      await expect(page.getByLabel('Working board')).toHaveValue(board.id);
      // an upload goes to the working board
      await page.getByLabel('Upload pictures to the Library').setInputFiles('tests/golden/09_car.png');
      await expect(page.getByText(/1 picture added to your Library/).last()).toBeVisible({ timeout: 60_000 });
      const up = (await (await page.request.get(`/api/items?limit=1&board=${board.id}`)).json()).items[0];
      expect(up).toBeTruthy();
      // a new version of it stays in its board even when the working board is "No board"
      await page.getByLabel('Working board').selectOption('');
      const inp = await (await page.request.post(`/api/items/${up.id}/as-input`, { data: { which: 'main' } })).json();
      const job = await (
        await page.request.post('/api/jobs', { data: { workflow: 'crop', params: { image_1: inp.name, x: 0, y: 0, width: 400, height: 300 }, meta: { mode: 'edit:crop', model: 'Crop', parentId: up.id, boardId: null } } })
      ).json();
      await expect
        .poll(async () => ((await (await page.request.get(`/api/jobs/${job.id}/items`)).json()) as any[])[0]?.board_id, { timeout: 60_000 })
        .toBe(board.id);
      // the board in the Library, then moving two more pictures in
      const row = page.getByRole('group', { name: 'Boards' });
      await row.getByRole('button', { name: /e2e board/ }).click();
      // the upload and its crop are one picture: one tile, a stack of 2 (DECISIONS 90)
      await expect(page.getByRole('list', { name: 'Library items' }).getByRole('listitem')).toHaveCount(1);
      await expect(page.getByLabel('2 versions')).toBeVisible();
      await page.getByRole('button', { name: 'Stacks' }).click();
      await expect(page.getByRole('list', { name: 'Library items' }).getByRole('listitem')).toHaveCount(2);
      await page.getByRole('button', { name: 'Stacks' }).click();
      await shot(page, 'library-board');
      await row.getByRole('button', { name: 'All boards' }).click();
      const tiles = page.getByRole('list', { name: 'Library items' }).getByRole('listitem');
      await tiles.nth(4).click();
      await tiles.nth(5).click({ modifiers: ['Shift'] });
      await page.getByLabel('Move to board').selectOption({ label: 'e2e board' });
      await expect(page.getByText('2 items moved to "e2e board".').last()).toBeVisible();
      expect((await boardsApi()).find((b) => b.id === board.id).count).toBe(4);
      // delete the board: every picture stays in the Library
      const before = (await (await page.request.get('/api/items?limit=1')).json()).total;
      await row.getByRole('button', { name: /e2e board/ }).click();
      await page.getByRole('button', { name: 'Delete board' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete board' }).click();
      await expect(page.getByText(/Board "e2e board" deleted/).last()).toBeVisible();
      expect((await (await page.request.get('/api/items?limit=1')).json()).total).toBe(before);
    } finally {
      // never leave a test board behind in the shared test library
      if ((await boardsApi()).some((b) => b.id === board.id)) await page.request.delete(`/api/boards/${board.id}`);
      await page.getByLabel('Working board').selectOption('').catch(() => undefined);
    }
  });

  // Prompt variations (DECISIONS 85)
  test('Generate: {a|b} variations render one picture each on the same seed, shown together', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    await page.getByRole('group', { name: 'Batch size' }).getByRole('button', { name: '×4' }).click();
    await page.getByLabel('Prompt').fill('a {red|blue|green|white|black} vintage car');
    await expect(page.locator('.variations summary')).toHaveText('5 variations × batch 4 = 20 pictures');
    await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
    await expect(page.getByText(/= 20 pictures\. Keep it to 16 at most/).last()).toBeVisible();
    await page.getByRole('group', { name: 'Batch size' }).getByRole('button', { name: '×1' }).click();
    await page.getByLabel('Prompt').fill('a {red|blue} vintage car parked by the sea, photograph');
    await expect(page.locator('.variations summary')).toHaveText('2 variations');
    const sent: any[] = [];
    page.on('request', (r) => r.url().endsWith('/api/jobs') && r.method() === 'POST' && sent.push(r.postDataJSON()));
    await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
    // the Variations strip only: History tooltips carry the prompt too (v3.22)
    await expect(page.locator('.strip[aria-label="Variations"] button[title*="vintage car parked by the sea"]')).toHaveCount(2, { timeout: 240_000 });
    expect(sent).toHaveLength(2);
    expect(sent[0].params.seed).toBe(sent[1].params.seed);
    expect(sent[0].meta.prompt).toMatch(/a red vintage car/);
    expect(sent[1].meta.prompt).toMatch(/a blue vintage car/);
    expect(sent[0].meta.ui.prompt).toBe('a {red|blue} vintage car parked by the sea, photograph');
    await shot(page, 'generate-variations');
  });

  // Your own LoRAs (DECISIONS 86)
  test('LoRAs: only ones made for the model are offered, and a chosen LoRA is put on the graph', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    const cat = await (await page.request.get('/api/loras')).json();
    if (!cat.qwen.length) await expect(page.locator('.lora-picker .lora-none')).toHaveText('none for Qwen-Image 2.1');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    test.skip(!cat.klein.length, 'no Klein 9B LoRA installed on this machine');
    const offered = (await page.getByLabel('Add a LoRA').locator('option').allInnerTexts()).slice(1);
    expect(offered.length).toBe(cat.klein.length);
    // nothing from another model is offered
    for (const o of cat.other) expect(offered.some((t: string) => t.startsWith(o.name.replace(/^.*[\\/]/, '').replace(/\.safetensors$/, '')))).toBe(false);
    await page.getByLabel('Add a LoRA').selectOption({ index: 1 });
    const chosen = cat.klein.find((l: any) => offered[0].startsWith(l.label));
    await page.getByLabel(`Strength of ${chosen.label}`).fill('0.7');
    await page.getByLabel('Prompt').fill('portrait of an old fisherman with a weathered face, overcast light');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
    const body = (await sent).postDataJSON();
    expect(JSON.parse(body.params.loras)).toEqual([{ name: chosen.name, strength: 0.7 }]);
    let item: any;
    await expect
      .poll(
        async () => {
          item = ((await (await page.request.get('/api/items?limit=5&filter=generated')).json()).items as any[]).find((i) => i.params?.loras === body.params.loras);
          return !!item;
        },
        { timeout: 120_000 },
      )
      .toBe(true);
    const graph = await (await page.request.get(`/api/items/${item.id}/graph`)).json();
    const loraNode: any = Object.values(graph).find((n: any) => n._meta?.title === 'DR_USER_LORA_1');
    expect(loraNode.inputs).toMatchObject({ lora_name: chosen.name, strength_model: 0.7 });
    await page.getByRole('button', { name: `Remove ${chosen.label}` }).click();
    // a LoRA for another model is refused by the server
    const wrong = cat.other.find((o: any) => !/Unreadable/.test(o.reason));
    if (wrong) {
      const r = await page.request.post('/api/jobs', { data: { workflow: 'klein_t2i', params: { prompt: 'x', seed: 1, loras: JSON.stringify([{ name: wrong.name, strength: 1 }]) }, meta: { mode: 'generate', model: 'Klein' } } });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/is not a Klein 9B LoRA/);
    }
  });

  // Compose (DECISIONS 87)
  let compositionUrl = '';
  test('Compose: start from a picture, cut out a piece, move and scale it on the ground line, undo, Harmonise into the Library', async () => {
    await page.goto('/#/compose');
    await page.getByLabel('Upload a background picture').setInputFiles('tests/golden/08_lowres_src.png');
    await expect(page).toHaveURL(/#\/compose\/[0-9a-f-]+$/, { timeout: 60_000 });
    compositionUrl = page.url();
    await expect(page.getByRole('button', { name: 'Select Background' })).toBeVisible();
    await expect(page.getByLabel('Composition name')).toHaveValue(/^Composition \d+$/);
    // the canvas takes the background's shape at about 1 MP
    await expect(page.getByText('1248 × 832')).toBeVisible();

    await page.getByLabel('Upload pictures to the canvas').setInputFiles('tests/golden/09_car.png');
    await expect(page.getByRole('button', { name: /^Select 09_car/ })).toBeVisible({ timeout: 60_000 });
    const sel = page.locator('.compose-select');
    const boxed = (await sel.boundingBox())!;
    await page.getByRole('button', { name: 'Cut out' }).click();
    await expect(page.getByText('cut-out', { exact: true })).toBeVisible({ timeout: 90_000 });
    // trimmed to the car: a smaller box than the whole photo, and the cut-out is in the Library
    const trimmed = (await sel.boundingBox())!;
    expect(trimmed.height).toBeLessThan(boxed.height);
    expect((await firstItem(page, (i) => i.mode === 'edit:remove_bg' && i.prompt === '09_car'))?.id).toBeTruthy();

    // drag: the ground line shows where it stands
    const canvas = (await page.getByRole('application', { name: 'Canvas' }).boundingBox())!;
    await page.mouse.move(trimmed.x + trimmed.width / 2, trimmed.y + trimmed.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.75, canvas.y + canvas.height * 0.78, { steps: 6 });
    await expect(page.locator('.compose-ground')).toBeVisible();
    await page.mouse.up();
    await expect(page.locator('.compose-ground')).toHaveCount(0);
    // scale from the top-left corner, keeping the shape
    const before = (await sel.boundingBox())!;
    const nw = (await page.locator('.compose-handle.nw').boundingBox())!;
    await page.mouse.move(nw.x + 7, nw.y + 7);
    await page.mouse.down();
    await page.mouse.move(nw.x + 7 + before.width * 0.3, nw.y + 7 + before.height * 0.3, { steps: 5 });
    await page.mouse.up();
    const after = (await sel.boundingBox())!;
    expect(after.width).toBeLessThan(before.width * 0.8);
    expect(after.width / after.height).toBeCloseTo(before.width / before.height, 1);
    await page.keyboard.press('Control+z');
    expect(Math.round((await sel.boundingBox())!.width)).toBe(Math.round(before.width));
    await page.keyboard.press('Control+y');
    expect(Math.round((await sel.boundingBox())!.width)).toBe(Math.round(after.width));
    await shot(page, 'compose-placed');

    // erase part of the cut-out: a new picture file with more transparency; Ctrl+Z brings the old one back
    const srcOf = async () => {
      const r = await (await page.request.get(`/api/compositions/${compositionUrl.split('/').pop()}`)).json();
      return r.doc.layers.find((l: any) => l.name === '09_car').src as string;
    };
    const transparent = async (src: string) => {
      const { data, info } = await sharp(Buffer.from(await (await page.request.get(`/api/input?name=${encodeURIComponent(src)}`)).body())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 16) n++;
      return n / (info.width * info.height);
    };
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 });
    const src0 = await srcOf();
    await page.keyboard.press('e');
    await page.getByLabel('Brush size').fill('40');
    const car = (await page.locator('.compose-piece').last().boundingBox())!;
    await page.mouse.move(car.x + car.width * 0.1, car.y + car.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(car.x + car.width * 0.4, car.y + car.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await expect.poll(srcOf, { timeout: 20_000 }).not.toBe(src0);
    const src1 = await srcOf();
    expect(await transparent(src1)).toBeGreaterThan((await transparent(src0)) + 0.02);
    await shot(page, 'compose-erased');
    await page.keyboard.press('Control+z');
    await expect.poll(srcOf, { timeout: 10_000 }).toBe(src0);
    await page.keyboard.press('v');

    // photo pieces → Harmonise is suggested (Qwen)
    const modes = page.getByRole('group', { name: 'Render mode' });
    await expect(modes.getByRole('button', { name: /Harmonise/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(modes.getByRole('button', { name: /Harmonise/ })).toContainText('Suggested');
    await page.getByLabel('Scene description').fill('a red classic car parked on the stone quay of a fishing harbour, overcast day');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST' && r.postDataJSON().meta?.mode === 'compose');
    await page.getByRole('button', { name: /^Render/ }).click();
    const body = (await sent).postDataJSON();
    expect(body.workflow).toBe('qwen_edit');
    expect(body.params.mask).toBeUndefined();
    expect(body.params.prompt).toMatch(/The scene: a red classic car parked on the stone quay/);
    await expect(page.locator('.compose-view img')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByRole('list', { name: 'Renders' }).getByRole('listitem')).toHaveCount(1);
    const it = await firstItem(page, (i) => i.mode === 'compose');
    expect(it.ui.compositionId).toBe(compositionUrl.split('/').pop());
    expect(it.model).toMatch(/Qwen-Image 2.1 · Harmonise/);
    await shot(page, 'compose-harmonised');
  });

  test('Compose: Blend edges sends a seam mask; paint suggests Reimagine; saved, reopened, deleted with Undo', async () => {
    // Blend edges on the same canvas: a white band round the car on black
    await page.getByRole('button', { name: 'Back to canvas' }).click();
    await page.getByRole('group', { name: 'Render mode' }).getByRole('button', { name: /Blend edges/ }).click();
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST' && r.postDataJSON().meta?.mode === 'compose');
    await page.getByRole('button', { name: /^Render/ }).click();
    const body = (await sent).postDataJSON();
    expect(body.params.mask).toBeTruthy();
    expect(body.params.feather).toBe(12);
    const mask = await sharp(Buffer.from(await (await page.request.get(`/api/input?name=${encodeURIComponent(body.params.mask)}`)).body())).greyscale().raw().toBuffer({ resolveWithObject: true });
    const white = [...mask.data].filter((v) => v > 127).length / mask.data.length;
    expect(white).toBeGreaterThan(0.005);
    expect(white).toBeLessThan(0.1); // only the seams, never the whole picture
    await expect(page.getByRole('list', { name: 'Renders' }).getByRole('listitem')).toHaveCount(2, { timeout: 180_000 });

    // continue from a render: it becomes the background, the old layers are hidden (not removed)
    await page.getByRole('list', { name: 'Renders' }).getByRole('listitem').first().click();
    await page.getByRole('button', { name: 'Continue from this' }).click();
    await expect(page.getByRole('button', { name: 'Select Render' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show 09_car' })).toBeVisible();
    await expect(page.locator('.compose-layers li')).toHaveCount(3);

    // saved: reopening brings the layers and renders back
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.locator('.compose-layers li')).toHaveCount(3);
    await expect(page.getByRole('list', { name: 'Renders' }).getByRole('listitem')).toHaveCount(2);

    // a paint-only canvas → Reimagine is suggested
    await page.goto('/#/compose');
    await page.getByRole('button', { name: 'New composition' }).click();
    await expect(page).toHaveURL(/#\/compose\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Paint (B)' }).click();
    const c = (await page.getByRole('application', { name: 'Canvas' }).boundingBox())!;
    await page.getByLabel('Brush size').fill('300');
    for (const y of [0.15, 0.4, 0.65, 0.9]) {
      await page.mouse.move(c.x + 5, c.y + c.height * y);
      await page.mouse.down();
      await page.mouse.move(c.x + c.width - 5, c.y + c.height * y, { steps: 5 });
      await page.mouse.up();
    }
    await expect(page.locator('.compose-layers li')).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Render mode' }).getByRole('button', { name: /Reimagine/ })).toContainText('Suggested', { timeout: 5_000 });
    await page.getByRole('button', { name: 'Erase (E)' }).click();
    await page.mouse.move(c.x + c.width / 2, c.y + 10);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2, c.y + c.height - 10, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Control+z');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 });
    const name = await page.getByLabel('Composition name').inputValue();

    // the start page lists it with a thumbnail; delete with Undo
    await page.getByRole('button', { name: '← All compositions' }).click();
    const item = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Open ${name}`, exact: true }) });
    await expect(item.locator('img')).toBeVisible();
    await shot(page, 'compose-list');
    await item.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Open ${name}`, exact: true }) })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Open ${name}`, exact: true }) })).toHaveCount(1);
  });

  test('Compose: Describe reads the canvas again after you change the sketch (its own old text is not your idea)', async () => {
    await page.goto('/#/compose');
    await page.getByRole('button', { name: 'New composition' }).click();
    await expect(page).toHaveURL(/#\/compose\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Paint (B)' }).click();
    const c = (await page.getByRole('application', { name: 'Canvas' }).boundingBox())!;
    const band = async (colour: string, y0: number, y1: number, size = 200) => {
      await page.getByLabel(`Colour ${colour}`).click();
      await page.getByLabel('Brush size').fill(String(size));
      for (let y = y0; y <= y1; y += 0.12) {
        await page.mouse.move(c.x + 2, c.y + c.height * y);
        await page.mouse.down();
        await page.mouse.move(c.x + c.width - 2, c.y + c.height * y, { steps: 4 });
        await page.mouse.up();
      }
    };
    const blob = async (colour: string, pts: number[][], size: number) => {
      await page.getByLabel(`Colour ${colour}`).click();
      await page.getByLabel('Brush size').fill(String(size));
      await page.mouse.move(c.x + pts[0][0] * c.width, c.y + pts[0][1] * c.height);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) await page.mouse.move(c.x + x * c.width, c.y + y * c.height, { steps: 4 });
      await page.mouse.up();
    };
    // 1: a house on a green hill
    await band('#7fb8e8', 0.05, 0.5);
    await band('#5fae4f', 0.6, 1.0);
    await blob('#b8352b', [[0.4, 0.45], [0.5, 0.33], [0.6, 0.45]], 50);
    await blob('#8a5a3b', [[0.42, 0.5], [0.58, 0.5], [0.58, 0.62], [0.42, 0.62], [0.42, 0.5]], 60);
    const scene = page.getByLabel('Scene description');
    await page.getByRole('button', { name: 'Describe' }).click();
    await expect(scene).not.toHaveValue('', { timeout: 120_000 });
    const first = await scene.inputValue();
    expect(first).toMatch(/house|cottage|home|cabin/i);

    // 2: hide that sketch and paint a sea with a sailing boat instead
    await page.getByRole('button', { name: 'Hide Paint 1' }).click();
    await page.getByRole('button', { name: 'Paint (B)' }).click();
    await band('#7fb8e8', 0.05, 0.45);
    await band('#2b5aa8', 0.55, 1.0);
    await blob('#ffffff', [[0.45, 0.58], [0.5, 0.3], [0.55, 0.58], [0.45, 0.58]], 30);
    await blob('#8a5a3b', [[0.38, 0.62], [0.62, 0.62], [0.58, 0.68], [0.42, 0.68], [0.38, 0.62]], 30);
    await expect(page.getByText(/The canvas changed since this was described/)).toBeVisible();
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Describe' }).click();
    expect((await sent).postDataJSON().text).toBe(''); // its own earlier text is not passed as your idea
    await expect.poll(() => scene.inputValue(), { timeout: 120_000 }).not.toBe(first);
    const second = await scene.inputValue();
    expect(second).toMatch(/sea|ocean|boat|sail|water/i);
    await expect(page.getByText(/The canvas changed since this was described/)).toHaveCount(0);

    // your own words are kept as the idea
    await scene.fill('a stormy evening');
    const sent2 = page.waitForRequest((r) => r.url().endsWith('/api/vlm') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Describe' }).click();
    expect((await sent2).postDataJSON().text).toBe('a stormy evening');
    await expect(scene).not.toHaveValue('a stormy evening', { timeout: 120_000 });
    await shot(page, 'compose-describe');
  });

  test('Library: version stacks — one tile per picture, every version in Details, Delete all versions with Undo', async () => {
    await page.goto('/#/library');
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('group', { name: 'Boards' }).getByRole('button', { name: 'All boards' }).click();
    const stacks = page.getByRole('button', { name: 'Stacks' });
    await expect(stacks).toHaveAttribute('aria-pressed', 'true');
    const stacked = (await (await page.request.get('/api/items?limit=60&stack=1')).json()).items as any[];
    const all = (await (await page.request.get('/api/items?limit=1')).json()).total as number;
    const pic = stacked.find((i) => (i.stack_count ?? 1) >= 2 && i.kind === 'image');
    test.skip(!pic, 'no picture with versions in the test library');
    expect(stacked.length).toBeLessThanOrEqual(all);
    // nothing selected: the grid has the whole width
    await page.evaluate(() => localStorage.removeItem('dr.library.selected'));
    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Details' })).toHaveCount(0);
    const tile = page.locator('.tile').filter({ has: page.getByLabel(`${pic.stack_count} versions`) }).first();
    await tile.click();
    const details = page.getByRole('complementary', { name: 'Details' });
    const strip = details.getByRole('list', { name: 'Versions' });
    await expect(strip.getByRole('listitem')).toHaveCount(pic.stack_count);
    await expect(strip.getByRole('listitem').last()).toHaveAttribute('aria-pressed', 'true');
    // an older version opens in Details although it is not on the grid
    await strip.getByRole('listitem').first().click();
    await expect(strip.getByRole('listitem').first()).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'library-stacks');
    // delete the whole picture, then Undo
    const ids = ((await (await page.request.get(`/api/items/${pic.id}`)).json()).lineage as any[]).map((v) => v.id);
    await details.getByRole('button', { name: `Delete all ${ids.length} versions` }).click();
    await expect(page.getByText(`${ids.length} items moved to Recently deleted.`).last()).toBeVisible();
    for (const id of ids) expect((await (await page.request.get(`/api/items/${id}`)).json()).item.deleted_at).toBeTruthy();
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect.poll(async () => ((await (await page.request.get(`/api/items/${ids[0]}`)).json()).item.deleted_at ?? null)).toBeNull();
    for (const id of ids) expect((await (await page.request.get(`/api/items/${id}`)).json()).item.deleted_at ?? null).toBeNull();
  });

  // Your own Klein 9B fine-tunes (DECISIONS 91)
  test('Klein version: your Klein 9B fine-tunes are offered, put on the graph, and anything else is refused', async () => {
    const cat = await (await page.request.get('/api/models/klein')).json();
    // files that are not Klein 9B never appear (Qwen, Klein 4B, the KV builds, BFL's own copies)
    for (const f of cat.finetunes) expect(f.name).not.toMatch(/qwen|klein-4b|kv|^flux-2-klein-9b(-fp8|-fp8mixed)?\.safetensors$/i);
    const refused = await page.request.post('/api/jobs', { data: { workflow: 'klein_t2i', params: { prompt: 'x', seed: 1, klein_weights: 'qwen_image_2.1_int8_convrot.safetensors' }, meta: { mode: 'generate', model: 'Klein' } } });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toMatch(/is not a Klein 9B model on this PC/);
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    test.skip(!cat.finetunes.length, 'no Klein 9B fine-tune on this machine');
    const pick = page.getByLabel('Klein version');
    await expect(pick).toBeVisible();
    const ft = cat.finetunes[0];
    await pick.selectOption(ft.name);
    await page.getByLabel('Prompt').fill('a red tulip in a glass vase on a wooden table, soft window light');
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
    const body = (await sent).postDataJSON();
    expect(body.params.klein_weights).toBe(ft.name);
    expect(body.meta.model).toBe(`Klein 9B · ${ft.label}`);
    let item: any;
    await expect
      .poll(async () => {
        item = ((await (await page.request.get('/api/items?limit=5&filter=generated')).json()).items as any[]).find((i) => i.params?.klein_weights === ft.name);
        return !!item;
      }, { timeout: 120_000 })
      .toBe(true);
    const graph = await (await page.request.get(`/api/items/${item.id}/graph`)).json();
    expect((Object.values(graph) as any[]).find((n) => n._meta?.title === 'DR_MODEL').inputs.unet_name).toBe(ft.name);
    // back to the official model for the tests that follow
    await pick.selectOption('');
  });

  test('Library: Upload adds your pictures to the Library', async () => {
    await page.goto('/#/library');
    const before = (await (await page.request.get('/api/items?limit=1')).json()).total;
    await page.getByLabel('Upload pictures to the Library').setInputFiles('tests/golden/03_text_scene.png');
    // wait for the count itself: an identical notice from an earlier test may still be on screen
    await expect.poll(async () => (await (await page.request.get('/api/items?limit=1')).json()).total, { timeout: 60_000 }).toBe(before + 1);
    await expect(page.getByText('1 picture added to your Library. Double-click to edit.').last()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('03_text_scene');
  });

  test('Library: delete with Undo, multi-select, Recently deleted and Restore', async () => {
    await page.goto('/#/library');
    const count = async (f = 'all') => (await (await page.request.get('/api/items?limit=1&filter=' + f)).json()).total as number;
    const before = await count();
    const deletedBefore = await count('deleted'); // a test interrupted elsewhere may have left something there
    const tiles = page.getByRole('list', { name: 'Library items' }).getByRole('listitem');
    // one item: click, press Delete, Undo
    const first = await tiles.nth(0).getAttribute('data-id');
    await tiles.nth(0).click();
    await page.keyboard.press('Delete');
    await expect(page.getByText('1 item moved to Recently deleted.').last()).toBeVisible();
    await expect.poll(count).toBe(before - 1);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(page.getByText('Restored.').last()).toBeVisible();
    await expect.poll(count).toBe(before);
    // the grid has reloaded with it back in place before the next clicks
    await expect(tiles.nth(0)).toHaveAttribute('data-id', first!);
    // a range with Shift-click, deleted from the selection bar
    await tiles.nth(1).click();
    await tiles.nth(3).click({ modifiers: ['Shift'] });
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    await expect(bar).toContainText('3 selected');
    await bar.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('3 items moved to Recently deleted.').last()).toBeVisible();
    expect(await count('deleted')).toBe(deletedBefore + 3);
    // they wait in Recently deleted and come back with Restore
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'Recently deleted' }).click();
    await expect(tiles).toHaveCount(deletedBefore + 3);
    await shot(page, 'library-recently-deleted');
    await page.keyboard.press('Control+a');
    await bar.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText(`${deletedBefore + 3} items restored to the Library.`)).toBeVisible();
    expect(await count()).toBe(before + deletedBefore);
    expect(await count('deleted')).toBe(0);
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'All' }).click();
  });

  test('Library: Select — tick boxes, a plain click and a dragged box pick several; favourite and delete them together', async () => {
    await page.goto('/#/library');
    const count = async (f = 'all') => (await (await page.request.get('/api/items?limit=1&filter=' + f)).json()).total as number;
    await page.waitForLoadState('networkidle');
    const before = await count();
    const grid = page.getByRole('list', { name: 'Library items' });
    const tiles = grid.getByRole('listitem');
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    // a tick box on a tile picks it without opening it
    await tiles.nth(0).hover();
    await tiles.nth(0).getByRole('checkbox').click();
    await expect(bar).toContainText('1 selected');
    await expect(page.getByRole('complementary', { name: 'Details' })).toHaveCount(0);
    // while selecting, a plain click ticks
    await tiles.nth(1).click();
    await expect(bar).toContainText('2 selected');
    await tiles.nth(1).click();
    await expect(bar).toContainText('1 selected');
    // a box dragged over tiles adds them
    const a = (await tiles.nth(2).boundingBox())!;
    const b = (await tiles.nth(3).boundingBox())!;
    await page.mouse.move(a.x + 30, a.y + 30);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 40, { steps: 6 });
    await expect(page.locator('.select-band')).toBeVisible();
    await page.mouse.up();
    await expect(bar).toContainText('3 selected');
    await expect(tiles.nth(2).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    // the next click still works (the drag does not swallow it)
    await tiles.nth(3).click();
    await expect(bar).toContainText('2 selected');
    await tiles.nth(3).click();
    // favourite all three, then delete them together, then Undo
    const ids = await grid.locator('.tile-wrap.picked').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
    expect(ids).toHaveLength(3);
    const favBefore = await Promise.all(ids.map(async (id) => (await (await page.request.get(`/api/items/${id}`)).json()).item.favourite));
    await bar.getByRole('button', { name: /Favourite|Unfavourite/ }).click();
    await expect.poll(async () => (await Promise.all(ids.map(async (id) => (await (await page.request.get(`/api/items/${id}`)).json()).item.favourite))).every((f) => f === !favBefore.every(Boolean))).toBe(true);
    await bar.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('3 items moved to Recently deleted.').last()).toBeVisible();
    await expect.poll(count).toBe(before - 3);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect.poll(count).toBe(before);
    // put the favourites back as they were; Esc leaves Select mode
    for (const [i, id] of ids.entries()) await page.request.patch(`/api/items/${id}`, { data: { favourite: favBefore[i] } });
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(bar).toContainText('Click pictures and videos to tick them');
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
  });

  test('Edit: a seed you type is used and kept; unlocked, each run takes a new one (P1)', async () => {
    const pic = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate');
    await page.goto(`/#/edit/${pic.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Klein 9B/ }).click();
    await openEditAdvanced(page);
    await page.getByLabel('Seed').fill('42');
    await page.getByLabel('Instruction').fill('Make it a rainy day.');
    const run = async () => {
      const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
      await page.getByRole('button', { name: 'Apply instruction Ctrl+Enter' }).click();
      const req = await sent;
      const job = await (await req.response())!.json();
      await page.request.post(`/api/jobs/${job.id}/cancel`);
      return req.postDataJSON().params.seed as number;
    };
    expect(await run()).toBe(42);
    expect(await run()).toBe(42); // locked: kept
    // a run that finishes moves Edit to the new version: the seed stays 42 and locked (test-suite finding 1)
    const from = page.url();
    await page.getByRole('button', { name: 'Apply instruction Ctrl+Enter' }).click();
    await expect(page).not.toHaveURL(from, { timeout: 180_000 });
    await expect(page.getByLabel('Seed')).toHaveValue('42');
    await expect(page.getByRole('button', { name: /^Seed locked/ })).toBeVisible();
    await page.getByLabel('Instruction').fill('Make it a rainy day.');
    await page.getByRole('button', { name: /^Seed locked/ }).click();
    const s = await run();
    expect(s).not.toBe(42);
    await expect(page.getByLabel('Seed')).toHaveValue(String(s)); // the seed used is shown, ready to lock
  });

  test('Library: your title and notes on an item, shown on its tile and found by search (P2)', async () => {
    await page.goto('/#/library');
    const tiles = page.getByRole('list', { name: 'Library items' }).getByRole('listitem');
    await tiles.first().click();
    const details = page.getByRole('complementary', { name: 'Details' });
    const title = `APP-IMG-01 · Klein · s42 · ${Date.now()}`;
    await details.getByLabel('Title').fill(title);
    await details.getByLabel('Notes').click(); // leaving the title saves it
    await details.getByLabel('Notes').fill('Resolved prompt: … | enhance off');
    await details.getByLabel('Title').click(); // leaving the notes saves them
    const id = await tiles.first().getAttribute('data-id');
    await expect.poll(async () => (await (await page.request.get(`/api/items/${id}`)).json()).item).toMatchObject({ title, notes: 'Resolved prompt: … | enhance off' });
    await page.getByPlaceholder(/Search prompt/).fill(title.slice(0, 24));
    await expect(tiles.first()).toHaveAttribute('data-id', id!);
    await expect(tiles.first()).toContainText('APP-IMG-01');
    await page.getByPlaceholder(/Search prompt/).fill('');
  });

  test('Library: compare two pictures side by side and on a slider, and save the comparison (P3)', async () => {
    await page.goto('/#/library');
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'Klein' }).click();
    const tiles = page.getByRole('list', { name: 'Library items' }).getByRole('listitem');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await tiles.nth(0).click();
    await tiles.nth(1).click();
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    await bar.getByRole('button', { name: 'Compare' }).click();
    const dlg = page.getByRole('dialog', { name: 'Compare' });
    await expect(dlg.locator('figure')).toHaveCount(2);
    await dlg.getByRole('button', { name: 'Slider' }).click();
    await expect(dlg.getByLabel('Compare split')).toBeVisible();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/items/compare'));
    await dlg.getByRole('button', { name: 'Save as picture' }).click();
    const item = await (await saved).json();
    expect(item).toMatchObject({ mode: 'compare', kind: 'image' });
    expect(item.title).toMatch(/^Compare · .+ vs .+/);
    expect(item.width).toBeGreaterThan(item.height); // two pictures next to each other
    await dlg.getByRole('button', { name: 'Close compare' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'All' }).click();
  });

  test('Library: Delete forever sends the files to the Recycle Bin (a fresh crop made for this test)', async () => {
    const src = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate');
    const inp = await (await page.request.post(`/api/items/${src.id}/as-input`, { data: { which: 'main' } })).json();
    const job = await (
      await page.request.post('/api/jobs', { data: { workflow: 'crop', params: { image_1: inp.name, x: 0, y: 0, width: 64, height: 64 }, meta: { mode: 'edit:crop', model: 'Crop', parentId: src.id, prompt: 'e2e delete-forever' } } })
    ).json();
    let ids: string[] = [];
    await expect
      .poll(async () => (ids = ((await (await page.request.get(`/api/jobs/${job.id}/items`)).json()) as any[]).map((i) => i.id)).length, { timeout: 120_000 })
      .toBe(1);
    const fileUrl = `/api/items/${ids[0]}/file`;
    expect((await page.request.get(fileUrl)).status()).toBe(200);
    await page.request.post('/api/items/delete', { data: { ids } });
    await page.goto('/#/library');
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'Recently deleted' }).click();
    await expect(page.getByRole('list', { name: 'Library items' }).getByRole('listitem')).toHaveCount(1);
    await page.getByRole('list', { name: 'Library items' }).getByRole('listitem').first().click();
    await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Delete forever' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete forever' }).click();
    await expect(page.getByText(/Deleted 1 item for good. The files are in the Windows Recycle Bin./)).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(`/api/items/${ids[0]}`)).status()).toBe(404);
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'All' }).click();
  });

  test('Edit: Qwen Instruct that returns its picture unchanged says so and offers another seed (DECISIONS 107)', async () => {
    // a Qwen render of a shoe; with seed 42 Qwen copies it instead of making the clay render (test suite, 2026-10-03)
    await page.goto('/#/library');
    await page.getByLabel('Upload pictures to the Library').setInputFiles('tests/fixtures/qwen-copy/shoe.png');
    await expect(page.getByText(/1 picture added to your Library/).last()).toBeVisible({ timeout: 60_000 });
    const src = (await (await page.request.get('/api/items?limit=1')).json()).items[0];
    await page.goto(`/#/edit/${src.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await openEditAdvanced(page);
    await page.getByLabel('Seed').fill('42');
    await page.getByLabel('Instruction').fill('Present this shoe as a grey clay render with no materials or colour. Keep its exact shape and proportions.');
    await page.getByRole('button', { name: /Apply instruction/ }).click();
    await expect(page.getByText(/Qwen returned almost the same picture/)).toBeVisible({ timeout: 300_000 });
    expect(page.url()).not.toContain(src.id); // the copy is still saved as a version
    await shot(page, 'edit-qwen-copied');
    await page.getByRole('button', { name: 'Try another seed' }).click();
    await expect(page).toHaveURL(new RegExp(`#/edit/${src.id}$`));
    await expect(page.getByLabel('Seed')).not.toHaveValue('42');
    await expect(page.getByLabel('Instruction')).toHaveValue(/grey clay render/);
  });

  test('Generate: a vehicle prompt suggests Car studio, lettering suggests Qwen; Transparent background is not remembered (DECISIONS 112)', async () => {
    await page.goto('/#/generate');
    await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Klein 9B/ }).click();
    await page.getByRole('group', { name: 'Style preset' }).getByRole('button', { name: 'None', exact: true }).click();
    await page.getByLabel('Prompt').fill('A rugged overlander vehicle, matte black, with "OVERLANDER" in chrome letters on the hood');
    await expect(page.getByText('A vehicle: the Car studio style keeps wheels and proportions right.')).toBeVisible();
    await page.getByRole('button', { name: 'Use Car studio' }).click();
    await expect(page.getByRole('group', { name: 'Style preset' }).getByRole('button', { name: 'Car studio' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/A vehicle: the Car studio style/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Switch to Qwen' }).click();
    await expect(page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Qwen-Image 2.1/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Switch to Qwen' })).toHaveCount(0);
    // a shoe gets no vehicle hint
    await page.getByLabel('Prompt').fill('A lightweight trail running shoe, side view');
    await expect(page.getByText(/A vehicle: the Car studio style/)).toHaveCount(0);
    // transparency lasts the session only: a new tab starts without it
    await page.getByLabel('Transparent background').check();
    const fresh = await page.context().newPage();
    await fresh.goto('/#/generate');
    await fresh.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await expect(fresh.getByLabel('Transparent background')).not.toBeChecked();
    await fresh.close();
    await page.getByLabel('Transparent background').uncheck();
    await page.getByRole('group', { name: 'Style preset' }).getByRole('button', { name: 'None', exact: true }).click();
    await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: /^Klein 9B/ }).click();
  });

  test('Edit: Turn it shows the object from another angle; Turnaround makes three views and one sheet (DECISIONS 114)', async () => {
    const cat = await (await page.request.get('/api/loras')).json();
    test.skip(!cat.qwen.some((l: any) => /viewpoint-orbit/i.test(l.name)), 'the viewpoint-orbit LoRA is not on this machine');
    // a shoe render with its white background: Turn it cuts it out first, then turns it
    await page.goto('/#/library');
    await page.getByLabel('Upload pictures to the Library').setInputFiles('tests/fixtures/qwen-copy/shoe.png');
    await expect(page.getByText(/1 picture added to your Library/).last()).toBeVisible({ timeout: 60_000 });
    const src = (await (await page.request.get('/api/items?limit=1')).json()).items[0];
    await page.request.patch(`/api/items/${src.id}`, { data: { title: 'e2e shoe' } });
    await page.goto(`/#/edit/${src.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Turn it' }).click();
    await page.getByRole('group', { name: 'Turn angle' }).getByRole('button', { name: '90°' }).click();
    await page.getByRole('group', { name: 'Turn direction' }).getByRole('button', { name: 'To the right' }).click();
    await expect(page.getByText(/^Turned 90° right\./)).toBeVisible();
    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/items/${src.id}/turn`));
    await page.getByRole('button', { name: /^Turn it Ctrl\+Enter/ }).click();
    expect((await sent).postDataJSON()).toMatchObject({ angle: 90, side: 'right', height: 'eye' });
    // the cut-out comes first, then the turned view: Edit waits for the turn
    await expect.poll(async () => ((await (await page.request.get(`/api/items/${page.url().split('/').pop()}`)).json()).item?.mode), { timeout: 300_000 }).toMatch(/edit:turn|edit:remove_bg/);
    await expect.poll(async () => (await (await page.request.get(`/api/items?q=${encodeURIComponent('e2e shoe · turned 90° right')}&limit=5`)).json()).items.length, { timeout: 300_000 }).toBeGreaterThan(0);
    const turned = (await (await page.request.get(`/api/items?q=${encodeURIComponent('e2e shoe · turned 90° right')}&limit=5`)).json()).items[0];
    expect(turned.prompt).toBe('Turned 90° right');
    expect(turned.params.prompt).toMatch(/^<orbit> rotate the camera 90 degrees to the right, eye level\./);
    expect(turned.params.loras).toMatch(/viewpoint-orbit/);
    await shot(page, 'edit-turn');
    // Turnaround from the turned view's source cut-out
    await page.goto(`/#/edit/${turned.parent_id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Turn it' }).click();
    await page.getByRole('button', { name: /Make a turnaround/ }).click();
    await expect(page.getByText(/Turnaround ready:/).last()).toBeVisible({ timeout: 600_000 });
    const sheet = (await (await page.request.get(`/api/items?q=${encodeURIComponent('e2e shoe · turnaround')}&limit=5`)).json()).items.find((i: any) => i.mode === 'sheet');
    expect(sheet).toBeTruthy();
    expect(sheet.params.views).toHaveLength(4);
    expect(sheet.width / sheet.height).toBeGreaterThan(3); // four views in a row
    // every view on the sheet is a clean cut-out (a view that came back on white was cut out again first)
    for (const v of sheet.params.views.slice(1)) {
      const it = (await (await page.request.get(`/api/items/${v}`)).json()).item;
      expect(['edit:turn', 'edit:remove_bg']).toContain(it.mode);
    }
    await shot(page, 'edit-turnaround');
    // the four views drive a turntable video (DECISIONS 115)
    await page.goto('/#/library');
    await page.getByPlaceholder(/Search/).first().fill('e2e shoe · turnaround');
    await page.locator(`.tile-wrap[data-id="${sheet.id}"] .tile`).click();
    const sentTT = page.waitForResponse((r) => r.url().endsWith(`/api/items/${sheet.id}/turntable`));
    await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Animate as a turntable' }).click();
    const job = await (await sentTT).json();
    expect(JSON.parse(job.params.key_moments)).toHaveLength(3);
    await expect.poll(async () => (await (await page.request.get(`/api/items?q=${encodeURIComponent('e2e shoe · turntable')}&limit=5`)).json()).items.find((i: any) => i.kind === 'video')?.duration ?? 0, { timeout: 600_000 }).toBeGreaterThan(4.5);
    await page.getByPlaceholder(/Search/).first().fill('');
  });

  test('Edit: Try both models runs Klein and Qwen on one instruction and keeps the one you pick (DECISIONS 116)', async () => {
    const pic = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate');
    await page.goto(`/#/edit/${pic.id}`);
    await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
    await page.getByLabel('Instruction').fill('Make it a snowy winter scene. Keep everything else unchanged.');
    const posts: any[] = [];
    page.on('request', (r) => r.url().endsWith('/api/jobs') && r.method() === 'POST' && posts.push(r.postDataJSON()));
    await page.getByRole('button', { name: 'Try both models' }).click();
    await expect(page.getByRole('status', { name: 'Both models' })).toBeVisible();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts.map((p) => p.workflow).sort()).toEqual(['klein_edit', 'qwen_edit']);
    expect(posts[0].params.seed).toBe(posts[1].params.seed);
    const pick = page.getByRole('dialog', { name: 'Both models' });
    await expect(pick).toBeVisible({ timeout: 300_000 });
    await expect(pick.getByRole('img')).toHaveCount(2);
    await shot(page, 'edit-try-both');
    await pick.getByRole('button', { name: 'Keep Qwen-Image 2.1' }).click();
    await expect(page.getByText(/1 version moved to Recently deleted/).last()).toBeVisible();
    const shown = (await (await page.request.get(`/api/items/${page.url().split('/').pop()}`)).json()).item;
    expect(shown.model).toMatch(/Qwen/);
  });

  test('Edit: Shape in Instruct redraws the picture in another shape, on both models (DECISIONS 117)', async () => {
    const pic = await firstItem(page, (i) => i.kind === 'image' && i.mode === 'generate' && (i.width ?? 0) <= (i.height ?? 0));
    test.skip(!pic, 'needs a square or portrait picture');
    for (const model of ['Klein 9B', 'Qwen-Image 2.1']) {
      await page.goto(`/#/edit/${pic.id}`);
      await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Instruct' }).click();
      await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: new RegExp(`^${model}`) }).click();
      await page.getByRole('group', { name: 'Result shape' }).getByRole('button', { name: '16:9' }).click();
      await page.getByLabel('Instruction').fill('Make it a cinematic widescreen frame of the same scene. Keep the subject and its look.');
      const sent = page.waitForRequest((r) => r.url().endsWith('/api/jobs') && r.method() === 'POST');
      await page.getByRole('button', { name: 'Apply instruction Ctrl+Enter' }).click();
      expect((await sent).postDataJSON().params.shape).toBe('16:9');
      await page.waitForURL((u) => !u.toString().endsWith(pic.id), { timeout: 300_000 });
      const it = (await (await page.request.get(`/api/items/${page.url().split('/').pop()}`)).json()).item;
      expect(it.width / it.height).toBeCloseTo(16 / 9, 1);
      await shot(page, `edit-shape-${model.startsWith('Klein') ? 'klein' : 'qwen'}`);
    }
    await page.getByRole('group', { name: 'Result shape' }).getByRole('button', { name: 'Keep' }).click();
  });
});
