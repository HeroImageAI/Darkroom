/**
 * End-to-end tests for the v2 features (prompt system, local VLM, smart select, compare, video frames).
 * Real UI -> real ComfyUI. Screenshots to proof/v2-*.png.
 */
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `proof/v2-${name}.png` });

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

  test('Generate: Enhance rewrites the prompt with the local VLM, Undo restores it', async () => {
    await page.goto('/#/generate');
    await page.getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    const box = page.getByLabel('Prompt');
    await box.fill('poster for a jazz night called "Blue Hour"');
    await page.getByRole('button', { name: /Enhance/ }).first().click();
    await expect(box).not.toHaveValue('poster for a jazz night called "Blue Hour"', { timeout: 240_000 });
    const enhanced = await box.inputValue();
    expect(enhanced.length).toBeGreaterThan(80);
    expect(enhanced).toMatch(/blue hour/i); // the enhancer may set a poster title in capitals
    await shot(page, 'generate-enhanced');
    await page.getByRole('button', { name: /^Undo/ }).click();
    await expect(box).toHaveValue('poster for a jazz night called "Blue Hour"');
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
    await expect(page.getByLabel(/Point at it with a red circle/)).toBeDisabled();
    await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: /^Qwen-Image 2.1/ }).click();
    await page.keyboard.press('s');
    await page.getByLabel('Select by text').fill('person');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText(/Selection added to the mask/).last()).toBeVisible({ timeout: 240_000 });
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
    await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
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
    const job = await (await page.request.post('/api/jobs', { data: { workflow: 'wan22_i2v', params: { start_image: inp.name, prompt: 'e2e cancelled take', seed: 1 }, meta: { mode: 'video', model: 'Wan 2.2', prompt: 'e2e' } } })).json();
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
    const cards = await takes.getByTestId('take').count();
    await takes.getByTestId('take').first().hover();
    await takes.getByRole('button', { name: 'Delete this take' }).first().click();
    await expect(page.getByText('1 video moved to Recently deleted.').last()).toBeVisible();
    await expect(takes.getByTestId('take')).toHaveCount(cards - 1);
    expect(await videos()).toBe(before - 1);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(takes.getByTestId('take')).toHaveCount(cards);
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
      await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(2);
      await shot(page, 'library-board');
      await row.getByRole('button', { name: 'All boards' }).click();
      const tiles = page.getByRole('list').getByRole('listitem');
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
    await expect(page.locator('button[title*="vintage car parked by the sea"]')).toHaveCount(2, { timeout: 240_000 });
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
    const item = page.getByRole('listitem').filter({ hasText: name });
    await expect(item.locator('img')).toBeVisible();
    await shot(page, 'compose-list');
    await item.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(1);
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
    const tiles = page.getByRole('list').getByRole('listitem');
    // one item: click, press Delete, Undo
    await tiles.nth(0).click();
    await page.keyboard.press('Delete');
    await expect(page.getByText('1 item moved to Recently deleted.').last()).toBeVisible();
    expect(await count()).toBe(before - 1);
    await page.getByRole('button', { name: 'Undo' }).last().click();
    await expect(page.getByText('Restored.').last()).toBeVisible();
    expect(await count()).toBe(before);
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
    await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(1);
    await page.getByRole('list').getByRole('listitem').first().click();
    await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Delete forever' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete forever' }).click();
    await expect(page.getByText(/Deleted 1 item for good. The files are in the Windows Recycle Bin./)).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(`/api/items/${ids[0]}`)).status()).toBe(404);
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'All' }).click();
  });
});
