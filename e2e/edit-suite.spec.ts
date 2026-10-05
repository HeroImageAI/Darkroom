/**
 * Edit suite (DECISIONS 122+): the canvas with layers, painting with pen pressure, layer masks, blend modes, history,
 * saving with the picture, flatten to a version, and AI results that come back as layers.
 * Real UI -> real ComfyUI. Screenshots to proof/es-*.png.
 */
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `proof/es-${name}.png` });

/** A fresh copy of a picture (imported, so each run starts without layers): a generated one, or one `pick` finds. */
async function pickPicture(page: Page, pick?: (i: any) => boolean): Promise<{ id: string; width: number; height: number; version: number }> {
  const r = await page.request.get('/api/items?limit=2000');
  const src = ((await r.json()).items as any[]).find((i) => i.kind === 'image' && !i.deleted_at && (pick ? pick(i) : i.mode === 'generate' && i.width <= 1600 && i.height <= 1600));
  expect(src, 'a picture to copy').toBeTruthy();
  const buffer = Buffer.from(await (await page.request.get(`/api/items/${src.id}/file`)).body());
  const up = await (await page.request.post('/api/upload', { multipart: { file: { name: 'edit-suite.png', mimeType: 'image/png', buffer } } })).json();
  const job = await (await page.request.post('/api/jobs', { data: { workflow: 'import', params: { image_1: up.name }, meta: { mode: 'import', model: 'Imported', prompt: 'edit suite e2e' } } })).json();
  let it: any;
  await expect.poll(async () => (it = ((await (await page.request.get(`/api/jobs/${job.id}/items`)).json()) as any[])[0]) && it.width, { timeout: 60_000 }).toBeTruthy();
  return it;
}

/** Image-pixel point → page point on the Edit canvas. */
async function at(page: Page, x: number, y: number, W: number, H: number) {
  const b = (await page.getByAltText('Picture being edited').boundingBox())!;
  return { x: b.x + (x / W) * b.width, y: b.y + (y / H) * b.height };
}

async function stroke(page: Page, pts: [number, number][], W: number, H: number) {
  const first = await at(page, pts[0][0], pts[0][1], W, H);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) {
    const p = await at(page, x, y, W, H);
    await page.mouse.move(p.x, p.y, { steps: 12 });
  }
  await page.mouse.up();
}

/** A pen stroke with given pressure, as Wacom pointer events. */
async function penStroke(page: Page, from: [number, number], to: [number, number], pressure: number, W: number, H: number) {
  const a = await at(page, from[0], from[1], W, H);
  const b = await at(page, to[0], to[1], W, H);
  await page.evaluate(
    ({ a, b, pressure }) => {
      const el = document.querySelector('[data-testid="edit-canvas"]')!;
      const ev = (type: string, x: number, y: number, buttons: number) =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'pen', pressure, buttons, button: type === 'pointermove' ? -1 : 0, isPrimary: true }));
      ev('pointerdown', a.x, a.y, 1);
      for (let i = 1; i <= 24; i++) ev('pointermove', a.x + ((b.x - a.x) * i) / 24, a.y + ((b.y - a.y) * i) / 24, 1);
      ev('pointerup', b.x, b.y, 0);
    },
    { a, b, pressure },
  );
}

/** Opaque height of a horizontal line in a layer PNG at column x. */
async function lineThickness(png: Buffer, x: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let y = 0; y < info.height; y++) if (data[(y * info.width + x) * 4 + 3] > 128) n++;
  return n;
}

test.describe.serial('Edit suite · canvas and layers (v3.25)', () => {
  let page: Page;
  let pic: { id: string; width: number; height: number; version: number };
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => page.context().close());

  test('Paint on a new layer, blend it, mask it, undo and redo, and it is saved with the picture', async () => {
    pic = await pickPicture(page);
    const { width: W, height: H } = pic;
    await page.goto(`/#/edit/${pic.id}`);
    await page.getByRole('tab', { name: /Layers/ }).click();
    await page.getByRole('button', { name: 'Start layers' }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(2);
    await page.keyboard.press('p');
    await expect(page.getByRole('toolbar', { name: 'Paint' })).toBeVisible();
    await page.getByRole('button', { name: /^Colour/ }).click();
    await page.getByLabel('Hex colour').fill('#d02020');
    await page.keyboard.press('Escape');
    await page.getByLabel('Brush size').fill('40');
    await stroke(page, [[W * 0.2, H * 0.5], [W * 0.8, H * 0.5]], W, H);
    await saved(page);
    await shot(page, 'paint-stroke');

    // blend + opacity on the paint layer
    await page.getByLabel('Blend mode').selectOption('multiply');
    await page.getByLabel('Layer opacity').fill('60');
    await expect(page.locator('.layer-row.on')).toContainText('Multiply 60%');

    // a mask that hides the left half of the stroke
    await page.getByRole('button', { name: 'Add mask' }).click();
    await expect(page.getByRole('button', { name: 'Painting the mask' })).toBeVisible();
    await page.getByLabel('Brush size').fill('120');
    await stroke(page, [[W * 0.2, H * 0.5], [W * 0.45, H * 0.5]], W, H);

    // history: undo the mask stroke, redo it
    await page.locator('details.layer-history summary').click();
    await expect(page.locator('.history-list')).toContainText('Hide on mask');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.history-list li.future')).toContainText('Hide on mask');
    await page.keyboard.press('Control+y');
    await expect(page.locator('.history-list li.future')).toHaveCount(0);
    await saved(page);
    await shot(page, 'mask-blend');

    // the project is on disk: reload and it comes back
    const proj = await (await page.request.get(`/api/items/${pic.id}/project`)).json();
    expect(proj.layers).toHaveLength(2);
    expect(proj.layers[1]).toMatchObject({ kind: 'paint', blend: 'multiply', opacity: 0.6, mask: true });
    expect(proj.layers[0]).toMatchObject({ kind: 'picture', painted: false });
    await page.reload();
    await page.getByRole('tab', { name: /Layers/ }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(2);
    await expect(page.getByTestId('layers-canvas')).toBeVisible();
    const lib = await (await page.request.get(`/api/items/${pic.id}`)).json();
    expect(lib.item.layered).toBe(true);
  });

  test('Pen pressure: a light touch paints a thinner line than a firm one (Wacom)', async () => {
    const { width: W, height: H } = pic;
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await page.keyboard.press('p');
    await page.getByLabel('Brush size').fill('60');
    await page.getByLabel('Stabiliser').fill('0');
    await penStroke(page, [W * 0.2, H * 0.25], [W * 0.8, H * 0.25], 0.15, W, H);
    await penStroke(page, [W * 0.2, H * 0.75], [W * 0.8, H * 0.75], 1, W, H);
    await saved(page);
    const proj = await (await page.request.get(`/api/items/${pic.id}/project`)).json();
    const top = proj.layers[proj.layers.length - 1];
    const png = Buffer.from(await (await page.request.get(`/api/items/${pic.id}/project/layers/${top.id}.png?r=${top.rev}`)).body());
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const col = Math.round(W / 2);
    let light = 0;
    let firm = 0;
    for (let y = 0; y < info.height; y++) if (data[(y * info.width + col) * 4 + 3] > 128) (y < H / 2 ? light++ : firm++);
    expect(light).toBeGreaterThan(0);
    expect(firm).toBeGreaterThan(light * 2.5);
    expect(await lineThickness(png, col)).toBe(light + firm);
  });

  test('Flatten to new version merges the layers; the version leads back to them', async () => {
    const { width: W, height: H } = pic;
    await page.getByRole('button', { name: 'Flatten to new version' }).click();
    await expect(page.getByText('This version was flattened from layers.')).toBeVisible();
    const id = page.url().split('/').pop()!;
    const v = (await (await page.request.get(`/api/items/${id}`)).json()).item;
    expect(v).toMatchObject({ mode: 'edit:canvas', parent_id: pic.id, width: W, height: H });
    // the red stroke's right half shows in the merged picture, multiplied over the picture
    const { data, info } = await sharp(Buffer.from(await (await page.request.get(`/api/items/${id}/file`)).body())).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((Math.round(y) * info.width + Math.round(x)) * info.channels, (Math.round(y) * info.width + Math.round(x)) * info.channels + 3));
    // red multiplied at 60%: red keeps most of itself, green and blue drop to about half (whatever the picture)
    const orig = await sharp(Buffer.from(await (await page.request.get(`/api/items/${pic.id}/file`)).body())).raw().toBuffer({ resolveWithObject: true });
    const op = (x: number, y: number) => Array.from(orig.data.subarray((Math.round(y) * orig.info.width + Math.round(x)) * orig.info.channels, (Math.round(y) * orig.info.width + Math.round(x)) * orig.info.channels + 3));
    const [r, g, b] = px(W * 0.7, H * 0.5);
    const [r0, g0, b0] = op(W * 0.7, H * 0.5);
    expect(r).toBeGreaterThanOrEqual(r0 * 0.7 - 2);
    expect(g).toBeLessThanOrEqual(g0 * 0.65 + 2);
    expect(b).toBeLessThanOrEqual(b0 * 0.65 + 2);
    await shot(page, 'flattened');
    await page.getByRole('button', { name: 'Open the layers' }).click();
    await expect(page).toHaveURL(new RegExp(pic.id));
  });

  test('With layers on, an AI result comes back as a layer masked to the selection (and as a version)', async () => {
    const { width: W, height: H } = pic;
    await page.getByRole('tab', { name: /AI/ }).click();
    await page.getByRole('button', { name: 'Instruct', exact: true }).click();
    await page.getByRole('button', { name: /^Klein 9B/ }).click();
    await page.keyboard.press('b');
    await stroke(page, [[W * 0.3, H * 0.3], [W * 0.6, H * 0.6]], W, H);
    await page.getByLabel('Instruction').fill('Make it bright yellow.');
    const before = (await (await page.request.get(`/api/items/${pic.id}/project`)).json()).layers.length;
    await page.getByRole('button', { name: /Apply instruction/ }).click();
    await expect(page.getByText(/The result is on a new layer at the top, masked to your selection/)).toBeVisible({ timeout: 180_000 });
    await page.getByRole('tab', { name: /Layers/ }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(before + 1);
    await expect(page.locator('.layer-row.on')).toContainText('Instruct');
    await expect(page.locator('.layer-row.on .thumb-wrap.mask')).toBeVisible();
    await saved(page);
    const proj = await (await page.request.get(`/api/items/${pic.id}/project`)).json();
    const top = proj.layers[proj.layers.length - 1];
    expect(top).toMatchObject({ kind: 'result', mask: true, painted: false });
    expect(page.url()).toContain(pic.id); // stayed on the picture with the layers
    await shot(page, 'result-layer');
  });

  test('A Library picture comes in as a layer, and deleting a layer is undoable', async () => {
    const n = (await (await page.request.get(`/api/items/${pic.id}/project`)).json()).layers.length;
    await page.getByRole('button', { name: 'Picture…' }).click();
    await page.getByRole('dialog').getByRole('listitem').first().click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(n + 1);
    await page.getByRole('button', { name: 'Delete layer' }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(n);
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(n + 1);
    await page.getByRole('button', { name: 'Merge layer down' }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(n);
    await shot(page, 'library-layer');
  });
});

test.describe.serial('Edit suite · large photos', () => {
  test('A 9 MP photo paints smoothly on a layer (frame time while drawing)', async ({ page }) => {
    const r = await page.request.get('/api/items?limit=2000');
    test.skip(!((await r.json()).items as any[]).some((i) => i.kind === 'image' && i.width * i.height > 8e6 && i.width * i.height < 16e6), 'no large photo in this library');
    const it = await pickPicture(page, (i) => i.width * i.height > 8e6 && i.width * i.height < 16e6);
    const { width: W, height: H } = it;
    await page.goto(`/#/edit/${it.id}`);
    await expect(page.getByAltText('Picture being edited')).toBeVisible();
    await page.getByRole('button', { name: 'Paint on a layer (P)' }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(1, { timeout: 60_000 });
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await page.getByLabel('Brush size').fill('80');
    const b = (await page.getByAltText('Picture being edited').boundingBox())!;
    const ms = await page.evaluate(
      async ({ b }) => {
        const el = document.querySelector('[data-testid="edit-canvas"]')!;
        const ev = (type: string, x: number, y: number) =>
          el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 9, pointerType: 'pen', pressure: 0.7, buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0 }));
        const frames: number[] = [];
        let last = performance.now();
        ev('pointerdown', b.x + b.width * 0.1, b.y + b.height * 0.2);
        for (let i = 1; i <= 90; i++) {
          ev('pointermove', b.x + b.width * (0.1 + 0.8 * (i / 90)), b.y + b.height * (0.2 + 0.6 * Math.sin(i / 14) ** 2));
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          frames.push(now - last);
          last = now;
        }
        ev('pointerup', b.x + b.width * 0.9, b.y + b.height * 0.5);
        frames.sort((a, z) => a - z);
        return frames[Math.floor(frames.length * 0.9)];
      },
      { b },
    );
    console.log(`9 MP (${W}x${H}) paint frame p90: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(60);
    await saved(page);
    await page.screenshot({ path: 'proof/es-large-photo.png' });
  });
});

/** The PNG of layer `i` (0 = bottom, -1 = top) of a picture's saved layers, decoded. */
async function layerPixels(page: Page, itemId: string, i: number) {
  const proj = await (await page.request.get(`/api/items/${itemId}/project`)).json();
  const l = proj.layers[i < 0 ? proj.layers.length + i : i];
  const png = Buffer.from(await (await page.request.get(`/api/items/${itemId}/project/layers/${l.id}.png?r=${l.rev}`)).body());
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { layer: l, at: (x: number, y: number) => Array.from(data.subarray((Math.round(y) * info.width + Math.round(x)) * 4, (Math.round(y) * info.width + Math.round(x)) * 4 + 4)) };
}
/** Wait for the change just made to be saved: let the status leave "Saved" first, then wait for it to return. */
const saved = async (page: Page) => {
  await page.waitForTimeout(250);
  await expect(page.getByRole('status', { name: 'Layers saved' })).toHaveText('Saved', { timeout: 20_000 });
};

test.describe.serial('Edit suite · sketch and paint (v3.26)', () => {
  let page: Page;
  let pic: { id: string; width: number; height: number; version: number };
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => page.context().close());

  const pickBrush = async (name: string) => {
    await page.getByRole('button', { name: 'Brush', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await page.keyboard.press('Escape');
  };
  const pickColour = async (hex: string) => {
    await page.getByRole('button', { name: /^Colour/ }).click();
    await page.getByLabel('Hex colour').fill(hex);
    await page.keyboard.press('Escape');
  };

  test('Brushes keep their own settings; the colour picker takes a hex colour', async () => {
    pic = await pickPicture(page);
    const { width: W, height: H } = pic;
    await page.goto(`/#/edit/${pic.id}`);
    await expect(page.getByAltText('Picture being edited')).toBeVisible();
    await page.getByRole('button', { name: 'Paint on a layer (P)' }).click();
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await pickBrush('Ink pen');
    await page.getByLabel('Brush size').fill('14');
    await pickBrush('Marker');
    await expect(page.getByLabel('Brush size')).toHaveValue('28');
    await pickBrush('Ink pen');
    await expect(page.getByLabel('Brush size')).toHaveValue('14');
    await pickColour('#2050d0');
    await stroke(page, [[W * 0.3, H * 0.3], [W * 0.7, H * 0.3]], W, H);
    await saved(page);
    const px = (await layerPixels(page, pic.id, -1)).at(W * 0.5, H * 0.3);
    expect(px[2]).toBeGreaterThan(150);
    expect(px[0]).toBeLessThan(80);
    expect(px[3]).toBeGreaterThan(200);
    await shot(page, 'brush-ink-blue');
  });

  test('Shapes draw an outline; the fill bucket fills inside it and nowhere else', async () => {
    const { width: W, height: H } = pic;
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await page.getByRole('button', { name: 'Shapes (U)' }).click();
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.getByRole('button', { name: 'Outline' }).click();
    await page.getByLabel('Line width').fill('10');
    await stroke(page, [[W * 0.2, H * 0.45], [W * 0.5, H * 0.85]], W, H);
    await page.getByRole('button', { name: 'Fill bucket (G)' }).click();
    await pickColour('#d02020');
    const inside = await at(page, W * 0.35, H * 0.65, W, H);
    await page.mouse.click(inside.x, inside.y);
    await saved(page);
    const l = await layerPixels(page, pic.id, -1);
    expect(l.at(W * 0.35, H * 0.65)).toEqual([208, 32, 32, 255]); // filled
    expect(l.at(W * 0.2, H * 0.6)[2]).toBeGreaterThan(150); // the blue outline stays
    expect(l.at(W * 0.7, H * 0.65)[3]).toBe(0); // outside: untouched
    await shot(page, 'shape-fill');
  });

  test('Symmetry mirrors a stroke across the middle', async () => {
    const { width: W, height: H } = pic;
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await page.getByRole('button', { name: 'Paint on a layer (P)' }).click();
    await page.getByRole('button', { name: 'Mirror left and right' }).click();
    await stroke(page, [[W * 0.1, H * 0.15], [W * 0.2, H * 0.15]], W, H);
    await saved(page);
    const l = await layerPixels(page, pic.id, -1);
    expect(l.at(W * 0.15, H * 0.15)[3]).toBeGreaterThan(200);
    expect(l.at(W * 0.85, H * 0.15)[3]).toBeGreaterThan(200);
    await page.getByRole('button', { name: 'Mirror left and right' }).click();
  });

  test('Dodge lightens the picture layer where you paint; smudge is one undo step', async () => {
    const { width: W, height: H } = pic;
    await page.locator('.layer-row', { hasText: 'Picture' }).click();
    await pickBrush('Dodge');
    await page.getByLabel('Brush opacity').fill('100');
    await stroke(page, [[W * 0.6, H * 0.6], [W * 0.9, H * 0.6]], W, H);
    await saved(page);
    const orig = await sharp(Buffer.from(await (await page.request.get(`/api/items/${pic.id}/file`)).body())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const o = (x: number, y: number) => Array.from(orig.data.subarray((Math.round(y) * orig.info.width + Math.round(x)) * 4, (Math.round(y) * orig.info.width + Math.round(x)) * 4 + 3));
    const base = await layerPixels(page, pic.id, 0);
    const sum = (a: number[]) => a[0] + a[1] + a[2];
    expect(base.layer.painted).toBe(true);
    expect(sum(base.at(W * 0.75, H * 0.6))).toBeGreaterThan(sum(o(W * 0.75, H * 0.6)) + 20);
    expect(Math.abs(sum(base.at(W * 0.75, H * 0.1)) - sum(o(W * 0.75, H * 0.1)))).toBeLessThan(6); // untouched elsewhere
    await pickBrush('Smudge');
    await stroke(page, [[W * 0.4, H * 0.3], [W * 0.6, H * 0.35]], W, H);
    await page.locator('details.layer-history summary').click();
    await expect(page.locator('.history-list li').last()).toContainText('Smudge');
    await shot(page, 'dodge-smudge');
  });

  test('The view turns and mirrors, and painting still lands under the pen; Ctrl-click picks a layer', async () => {
    const { width: W, height: H } = pic;
    await page.locator('.layer-row', { hasText: 'Layer 1' }).click();
    await pickBrush('Round');
    for (let i = 0; i < 6; i++) await page.keyboard.press('6'); // 90°
    await page.keyboard.press('h');
    await expect(page.getByRole('button', { name: 'Straighten' })).toBeVisible();
    // where image point (x, y) is on screen now: mirrored, then turned 90°, about the picture's centre
    const b = (await page.getByAltText('Picture being edited').boundingBox())!;
    const s = b.width / H;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const screen = (x: number, y: number) => {
      const fx = -(x - W / 2) * s;
      const fy = (y - H / 2) * s;
      return { x: cx - fy, y: cy + fx };
    };
    const p = screen(W * 0.65, H * 0.6);
    await page.mouse.click(p.x, p.y);
    await saved(page);
    const l1 = await layerPixels(page, pic.id, 1);
    expect(l1.at(W * 0.65, H * 0.6)[3]).toBeGreaterThan(200);
    expect(l1.at(W * 0.35, H * 0.6)[3]).toBe(0); // not where an unmirrored view would put it
    await shot(page, 'view-turned');
    await page.keyboard.press('5');
    await expect(page.getByRole('button', { name: 'Straighten' })).toHaveCount(0);
    // Ctrl-click the blue ink line picks its layer
    await page.locator('.layer-row', { hasText: 'Picture' }).click();
    const q = await at(page, W * 0.5, H * 0.3, W, H);
    await page.keyboard.down('Control');
    await page.mouse.click(q.x, q.y);
    await page.keyboard.up('Control');
    await expect(page.locator('.layer-row.on')).toContainText('Layer 1');
  });
});

/** A pixel of what the Edit canvas shows now (the merged layers). */
async function shownPixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ({ x, y }) => {
      const c = document.querySelector('[data-testid="layers-canvas"]') as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data);
    },
    { x, y },
  );
}
const spread = (p: number[]) => Math.max(Math.abs(p[0] - p[1]), Math.abs(p[1] - p[2]), Math.abs(p[0] - p[2]));

test.describe.serial('Edit suite · photo: adjustments, selections, transform (v3.27)', () => {
  let page: Page;
  let pic: { id: string; width: number; height: number; version: number };
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => page.context().close());

  test('An adjustment layer changes everything below it, is saved, and can be changed again', async () => {
    pic = await pickPicture(page);
    const { width: W, height: H } = pic;
    await page.goto(`/#/edit/${pic.id}`);
    await expect(page.getByAltText('Picture being edited')).toBeVisible();
    await page.getByRole('tab', { name: /Adjust/ }).click();
    await page.getByRole('group', { name: 'Start from a look' }).getByRole('button', { name: 'Silver gelatin' }).click();
    await expect(page.getByText('adjustment', { exact: true })).toBeVisible();
    // black & white: what you see is grey
    await expect.poll(async () => spread(await shownPixel(page, W * 0.5, H * 0.5))).toBeLessThan(28);
    await page.locator('details.adj-sec', { hasText: 'Levels' }).locator('summary').click();
    await expect(page.locator('.levels-hist')).toBeVisible();
    await page.locator('details.adj-sec', { hasText: 'Black & white and split tone' }).locator('summary').click();
    await page.getByLabel('Black & white', { exact: true }).fill('0');
    await page.getByLabel('Exposure').fill('1');
    await saved(page);
    const proj = await (await page.request.get(`/api/items/${pic.id}/project`)).json();
    const adj = proj.layers.find((l: any) => l.kind === 'adjust');
    expect(adj).toMatchObject({ kind: 'adjust', painted: false, adjust: { bw: 0, exposure: 1, grain: 0.3 } });
    await shot(page, 'adjust-layer');
    // it survives a reload
    await page.reload();
    await page.getByRole('tab', { name: /Layers/ }).click();
    await expect(page.locator('.layer-row', { hasText: 'Silver gelatin' })).toBeVisible();
    await expect(page.locator('.adj-thumb')).toBeVisible();
  });

  /** Selected (alpha of the selection overlay) at a picture point. */
  const sel = (x: number, y: number) =>
    page.evaluate(
      ({ x, y }) => (document.querySelector('[data-testid="mask-overlay"]') as HTMLCanvasElement).getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data[3],
      { x, y },
    );

  test('Marquee selects a rectangle; painting stays inside it; Shrink, Invert and Deselect change it', async () => {
    const { width: W, height: H } = pic;
    await page.getByRole('button', { name: 'Marquee select (M)' }).click();
    await page.getByRole('group', { name: 'Selection mode' }).getByRole('button', { name: 'New' }).click();
    await stroke(page, [[W * 0.2, H * 0.2], [W * 0.5, H * 0.6]], W, H);
    await expect.poll(() => sel(W * 0.35, H * 0.4)).toBeGreaterThan(0);
    expect(await sel(W * 0.7, H * 0.4)).toBe(0);
    // paint a stroke right across it: only the part inside lands
    await page.getByRole('button', { name: 'Paint on a layer (P)' }).click();
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await expect(page.locator('.clip-note')).toBeVisible();
    await page.getByLabel('Brush size').fill('30');
    await stroke(page, [[W * 0.1, H * 0.4], [W * 0.8, H * 0.4]], W, H);
    await saved(page);
    const l = await layerPixels(page, pic.id, -1);
    expect(l.at(W * 0.35, H * 0.4)[3]).toBeGreaterThan(200);
    expect(l.at(W * 0.7, H * 0.4)[3]).toBe(0);
    expect(l.at(W * 0.12, H * 0.4)[3]).toBe(0);
    await shot(page, 'select-paint-inside');
    // shrink by 20 px: the edge is no longer selected, the middle still is
    await page.getByRole('button', { name: 'Marquee select (M)' }).click();
    await page.getByLabel('Selection pixels').fill('20');
    await page.getByRole('button', { name: 'Shrink' }).click();
    await expect.poll(() => sel(W * 0.2 + 8, H * 0.4)).toBe(0);
    expect(await sel(W * 0.35, H * 0.4)).toBeGreaterThan(0);
    await page.keyboard.press('Control+Shift+I');
    await expect.poll(() => sel(W * 0.7, H * 0.4)).toBeGreaterThan(0);
    await page.keyboard.press('Control+d');
    await expect.poll(() => sel(W * 0.7, H * 0.4)).toBe(0);
  });

  test('Magic wand selects an area of similar colour; Alt-click takes it away again', async () => {
    const { width: W, height: H } = pic;
    // the stroke painted in the last test is one flat colour: the wand finds exactly it
    await page.getByRole('button', { name: 'Magic wand (W)' }).click();
    await page.getByLabel('Wand tolerance').fill('10');
    const p = await at(page, W * 0.35, H * 0.4, W, H);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => sel(W * 0.35, H * 0.4)).toBeGreaterThan(0);
    await page.keyboard.down('Alt');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Alt');
    await expect.poll(() => sel(W * 0.35, H * 0.4)).toBe(0);
  });

  /** Drag an element of the page by (dx, dy) screen pixels. */
  const dragBy = async (el: ReturnType<Page['locator']>, dx: number, dy: number) => {
    const b = (await el.boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 10 });
    await page.mouse.up();
  };

  test('Transform moves and scales a layer; Esc cancels; perspective and warp bend it (one undo step each)', async () => {
    const { width: W, height: H } = pic;
    // a filled square on a new layer
    await page.getByRole('button', { name: 'Paint on a layer (P)' }).click();
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await page.getByRole('button', { name: 'Shapes (U)' }).click();
    await page.getByRole('button', { name: 'Rectangle' }).click();
    await page.getByRole('button', { name: 'Filled' }).click();
    await stroke(page, [[W * 0.1, H * 0.1], [W * 0.3, H * 0.3]], W, H);
    await saved(page);
    let l = await layerPixels(page, pic.id, -1);
    expect(l.at(W * 0.2, H * 0.2)[3]).toBe(255);
    // move it right by about a third of the picture
    await page.keyboard.press('t');
    const body = page.getByRole('img', { name: 'Transform handles' }).locator('polygon');
    await expect(body).toBeVisible();
    const b = (await page.getByAltText('Picture being edited').boundingBox())!;
    const k = b.width / W;
    await dragBy(body, W * 0.35 * k, 0);
    await page.getByRole('button', { name: 'Apply' }).click();
    await saved(page);
    l = await layerPixels(page, pic.id, -1);
    expect(l.at(W * 0.2, H * 0.2)[3]).toBe(0);
    expect(l.at(W * 0.55, H * 0.2)[3]).toBe(255);
    await shot(page, 'transform-moved');
    // Esc puts it back as it was
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.92);
    await dragBy(page.getByRole('img', { name: 'Transform handles' }).locator('polygon'), 0, H * 0.3 * k);
    await page.keyboard.press('Escape');
    await saved(page);
    expect((await layerPixels(page, pic.id, -1)).at(W * 0.55, H * 0.2)[3]).toBe(255);
    // scale from the bottom right: the top left stays, the square grows
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.92);
    await dragBy(page.getByLabel('Scale from the bottom right'), W * 0.1 * k, H * 0.1 * k);
    await page.getByRole('button', { name: 'Apply' }).click();
    await saved(page);
    l = await layerPixels(page, pic.id, -1);
    expect(l.at(W * 0.47, H * 0.12)[3]).toBe(255); // top left corner area kept
    expect(l.at(W * 0.72, H * 0.36)[3]).toBe(255); // grown past the old bottom right (0.65, 0.3)
    // perspective: pull one corner out
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.92);
    await page.getByRole('group', { name: 'Transform mode' }).getByRole('button', { name: 'Perspective' }).click();
    await dragBy(page.getByLabel('Corner 3'), W * 0.1 * k, H * 0.15 * k);
    await page.getByRole('button', { name: 'Apply' }).click();
    // warp: bend one inner point
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.92);
    await page.getByRole('group', { name: 'Transform mode' }).getByRole('button', { name: 'Warp' }).click();
    await dragBy(page.getByLabel('Warp point 6'), W * 0.05 * k, H * 0.05 * k);
    await page.getByRole('button', { name: 'Apply' }).click();
    await saved(page);
    await shot(page, 'transform-warped');
    await page.locator('details.layer-history summary').click();
    const hist = await page.locator('.history-list').innerText();
    expect(hist).toContain('Perspective');
    expect(hist).toContain('Warp');
    // one Ctrl+Z takes the warp away
    const before = (await layerPixels(page, pic.id, -1)).layer.rev;
    await page.keyboard.press('Control+z');
    await saved(page);
    expect((await layerPixels(page, pic.id, -1)).layer.rev).not.toBe(before);
  });

  test('Clone copies one part of the picture onto another (Alt-click the source, then paint)', async () => {
    const { width: W, height: H } = pic;
    await page.keyboard.press('p');
    await page.getByRole('button', { name: 'New layer', exact: true }).click();
    await page.getByRole('button', { name: 'Brush', exact: true }).click();
    await page.getByRole('option', { name: 'Clone', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Alt-click where to copy from')).toBeVisible();
    // the average of a small patch: a single pixel of a detailed picture moves too much with sub-pixel offsets
    const patch = async (get: (x: number, y: number) => Promise<number[]> | number[], cx: number, cy: number) => {
      const s = [0, 0, 0];
      for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) (await get(cx + dx, cy + dy)).slice(0, 3).forEach((v, k) => (s[k] += v / 25));
      return s;
    };
    const want = await patch((x, y) => shownPixel(page, x, y), W * 0.8, H * 0.85);
    const under = await patch((x, y) => shownPixel(page, x, y), W * 0.2, H * 0.85);
    const src = await at(page, W * 0.8, H * 0.85, W, H);
    await page.keyboard.down('Alt');
    await page.mouse.click(src.x, src.y);
    await page.keyboard.up('Alt');
    await expect(page.getByText('Alt-click to copy from somewhere else')).toBeVisible();
    // paint a dab at (0.2, 0.85): it should show what is at (0.8, 0.85)
    const dst = await at(page, W * 0.2, H * 0.85, W, H);
    await page.mouse.click(dst.x, dst.y);
    await saved(page);
    const lp = await layerPixels(page, pic.id, -1);
    expect(lp.at(W * 0.2, H * 0.85)[3]).toBe(255);
    const got = await patch((x, y) => lp.at(x, y), W * 0.2, H * 0.85);
    // much closer to the source than to what was under the brush (grain and soft detail make exact colours vary)
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(got, want)).toBeLessThan(30);
    if (dist(want, under) > 40) expect(dist(got, want)).toBeLessThan(dist(got, under) / 2);
    await shot(page, 'clone');
  });
});

test.describe.serial('Edit suite · AI on the canvas and Compose in Edit (v3.28)', () => {
  let page: Page;
  let canvasId = '';
  const posted: any[] = [];
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: process.env.DR_E2E_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    page.on('request', (r) => r.url().endsWith('/api/jobs') && r.method() === 'POST' && posted.push(r.postDataJSON()));
  });
  test.afterAll(async () => page.context().close());
  /** the job a click sends, then cancelled (we only check what was asked) */
  const jobFrom = async (click: () => Promise<void>) => {
    posted.length = 0;
    await click();
    await expect.poll(() => posted.length).toBeGreaterThan(0);
    const body = posted.pop();
    posted.length = 0;
    const active = (await (await page.request.get('/api/jobs/active')).json()) as any[];
    for (const j of active) await page.request.post(`/api/jobs/${j.id}/cancel`);
    return body;
  };
  const mode = (name: string) => page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name, exact: true }).click();

  test('New canvas: a blank 4:5 picture opens in Edit with layers on and a layer to paint', async () => {
    await page.goto('/#/edit');
    await page.getByRole('button', { name: 'Start from a blank canvas' }).click();
    await page.getByRole('button', { name: 'Paper White' }).click();
    await page.getByRole('button', { name: 'Canvas 4:5' }).click();
    await expect(page).toHaveURL(/#\/edit\/[0-9a-f-]+$/);
    canvasId = page.url().split('/').pop()!;
    await expect(page.getByText('896×1120')).toBeVisible();
    const rows = page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option');
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toContainText('Paper');
    const it = (await (await page.request.get(`/api/items/${canvasId}`)).json()).item;
    expect(it).toMatchObject({ mode: 'canvas', width: 896, height: 1120 });
    await shot(page, 'new-canvas');
  });

  test('A scene: a Library picture lands smaller and centred, the scissors cut it out, Compose suggests Harmonise and Blend edges sends a seam mask', async () => {
    // a generated picture of another shape than the canvas (a piece for the scene)
    const items = ((await (await page.request.get('/api/items?limit=300')).json()).items as any[]).filter((i) => i.kind === 'image' && i.mode === 'generate' && Math.abs(i.width / i.height - 0.8) > 0.1);
    const piece = items.find((i) => i.seed != null)!;
    await page.getByRole('button', { name: 'Picture…' }).click();
    await page.getByRole('dialog').getByLabel('Search library').fill(String(piece.seed));
    await page.getByRole('dialog').getByRole('listitem').first().click();
    await saved(page);
    let top = await layerPixels(page, canvasId, -1);
    expect(top.at(5, 5)[3]).toBe(0); // the corner stays empty: the piece is at 60%, centred
    expect(top.at(448, 560)[3]).toBe(255);
    await page.getByRole('button', { name: 'Cut out the layer' }).click();
    await page.locator('details.layer-history summary').click();
    await expect(page.locator('.history-list')).toContainText('Cut out', { timeout: 120_000 });
    await saved(page);
    top = await layerPixels(page, canvasId, -1);
    expect(top.layer.painted).toBe(true);
    await page.getByRole('tab', { name: /AI/ }).click();
    await mode('Compose');
    const renders = page.getByRole('group', { name: 'Render mode' });
    await expect(renders.getByRole('button', { name: /Harmonise/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(renders.getByRole('button', { name: /Harmonise/ })).toContainText('Suggested');
    await renders.getByRole('button', { name: /Blend edges/ }).click();
    await page.getByLabel('Scene (optional)').fill('on a wet city street at dawn');
    const job = await jobFrom(() => page.getByRole('button', { name: /Render · Blend edges/ }).click());
    expect(job.workflow).toBe('qwen_edit');
    expect(job.params.mask).toBeTruthy();
    expect(job.params.prompt).toMatch(/Blend the pasted elements.*wet city street at dawn/);
    expect(job.meta.mode).toBe('compose');
    await shot(page, 'compose-in-edit');
  });

  test('Fill: Remove needs no words, Background without a selection asks Qwen to swap it; Refine sends its strength', async () => {
    await mode('Fill');
    const fill = page.getByRole('group', { name: 'Fill' });
    // Background with no selection: an instruction that keeps the subject
    await fill.getByRole('button', { name: 'Background' }).click();
    await page.getByLabel('The new background').fill('a concrete loading dock at dusk');
    let job = await jobFrom(() => page.getByRole('button', { name: /Replace the background/ }).click());
    expect(job.params.prompt).toMatch(/Replace the background with a concrete loading dock at dusk/);
    // a selection, then Remove: the remove template, full strength
    await page.getByRole('button', { name: 'Marquee select (M)' }).click();
    const img = (await page.getByAltText('Picture being edited').boundingBox())!;
    await page.mouse.move(img.x + img.width * 0.3, img.y + img.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(img.x + img.width * 0.6, img.y + img.height * 0.6, { steps: 5 });
    await page.mouse.up();
    await fill.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByLabel(/What should fill/)).toHaveCount(0);
    job = await jobFrom(() => page.getByRole('button', { name: /Remove the selection/ }).click());
    expect(job.params.mask).toBeTruthy();
    expect(job.params.denoise).toBe(1);
    expect(job.meta.model).toMatch(/remove$/);
    // Refine inside the selection: inpaint at the strength
    await mode('Refine');
    await page.getByLabel('Refine strength').fill('40');
    job = await jobFrom(() => page.getByRole('button', { name: /Refine at 40%/ }).click());
    expect(job.params.denoise).toBeCloseTo(0.4);
    expect(job.params.mask).toBeTruthy();
    // no selection: the whole picture, with the touch-up graph
    await page.keyboard.press('Control+d');
    job = await jobFrom(() => page.getByRole('button', { name: /Refine at 40%/ }).click());
    expect(job.params.mask).toBeUndefined();
    expect(job.params.denoise).toBeCloseTo(0.4);
    expect(job.meta.mode).toBe('edit:enhance');
  });

  test('One door: Compose is gone from Home and the top bar; an old Compose link opens Edit, where old compositions open as layers', async () => {
    await page.goto('/#/home');
    await expect(page.getByRole('button', { name: /^Compose/ })).toHaveCount(0);
    await expect(page.getByRole('navigation').getByText('Compose', { exact: true })).toHaveCount(0);
    await page.goto('/#/compose');
    await expect(page).toHaveURL(/#\/edit$/);
    await expect(page.getByText(/To build a scene: a canvas/)).toBeVisible();
    const comps = (await (await page.request.get('/api/compositions')).json()) as any[];
    test.skip(!comps.length, 'no compositions in this library');
    const comp = (await (await page.request.get(`/api/compositions/${comps[0].id}`)).json()) as any;
    await page.getByRole('button', { name: `Open ${comps[0].name} in Edit` }).click();
    await expect(page).toHaveURL(/#\/edit\/[0-9a-f-]+$/, { timeout: 60_000 });
    const id = page.url().split('/').pop()!;
    const proj = await (await page.request.get(`/api/items/${id}/project`)).json();
    expect(proj.layers).toHaveLength(comp.doc.layers.length + 1);
    expect(proj.layers[0].name).toBe('Paper');
    await expect(page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: 'Compose', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'composition-in-edit');
  });
});
