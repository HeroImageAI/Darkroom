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

  test('Home: Darkroom opens on Home, with the four screens and "Continue where you left off"', async () => {
    await page.goto('/#/library');
    await expect(page.getByRole('region', { name: 'Library' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
    const start = page.getByRole('navigation', { name: 'Start' });
    for (const name of ['Generate', 'Edit', 'Video', 'Library']) await expect(start.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
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
    await expect(page.getByText(/Large picture \(5 MP\).*the full 3000×1714/)).toBeVisible();
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

  test('Library: Upload adds your pictures to the Library', async () => {
    await page.goto('/#/library');
    const before = (await (await page.request.get('/api/items?limit=1')).json()).total;
    await page.getByLabel('Upload pictures to the Library').setInputFiles('tests/golden/03_text_scene.png');
    await expect(page.getByText('1 picture added to your Library. Double-click to edit.')).toBeVisible({ timeout: 60_000 });
    expect((await (await page.request.get('/api/items?limit=1')).json()).total).toBe(before + 1);
    await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('03_text_scene');
  });

  test('Library: delete with Undo, multi-select, Recently deleted and Restore', async () => {
    await page.goto('/#/library');
    const count = async (f = 'all') => (await (await page.request.get('/api/items?limit=1&filter=' + f)).json()).total as number;
    const before = await count();
    const tiles = page.getByRole('list').getByRole('listitem');
    // one item: click, press Delete, Undo
    await tiles.nth(0).click();
    await page.keyboard.press('Delete');
    await expect(page.getByText('1 item moved to Recently deleted.')).toBeVisible();
    expect(await count()).toBe(before - 1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Restored.')).toBeVisible();
    expect(await count()).toBe(before);
    // a range with Shift-click, deleted from the selection bar
    await tiles.nth(1).click();
    await tiles.nth(3).click({ modifiers: ['Shift'] });
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    await expect(bar).toContainText('3 selected');
    await bar.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('3 items moved to Recently deleted.')).toBeVisible();
    expect(await count('deleted')).toBe(3);
    // they wait in Recently deleted and come back with Restore
    await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'Recently deleted' }).click();
    await expect(tiles).toHaveCount(3);
    await shot(page, 'library-recently-deleted');
    await page.keyboard.press('Control+a');
    await bar.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('3 items restored to the Library.')).toBeVisible();
    expect(await count()).toBe(before);
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
