/**
 * Edit suite (DECISIONS 122+): the canvas with layers, painting with pen pressure, layer masks, blend modes, history,
 * saving with the picture, flatten to a version, and AI results that come back as layers.
 * Real UI -> real ComfyUI. Screenshots to proof/es-*.png.
 */
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `proof/es-${name}.png` });

async function pickPicture(page: Page): Promise<{ id: string; width: number; height: number; version: number }> {
  const r = await page.request.get('/api/items?limit=300');
  const it = ((await r.json()).items as any[]).find((i) => i.kind === 'image' && !i.layered && i.mode === 'generate' && i.width <= 1600 && i.height <= 1600 && !i.deleted_at);
  expect(it, 'a generated picture without layers').toBeTruthy();
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
    await page.getByRole('button', { name: 'New layer' }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(2);
    await page.keyboard.press('p');
    await expect(page.getByRole('toolbar', { name: 'Paint' })).toBeVisible();
    await page.getByLabel('Paint colour').fill('#d02020');
    await page.getByLabel('Brush size').fill('40');
    await stroke(page, [[W * 0.2, H * 0.5], [W * 0.8, H * 0.5]], W, H);
    await expect(page.getByRole('status', { name: 'Layers saved' })).toHaveText('Saved', { timeout: 15_000 });
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
    await expect(page.getByRole('status', { name: 'Layers saved' })).toHaveText('Saved', { timeout: 15_000 });
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
    await page.getByRole('button', { name: 'New layer' }).click();
    await page.keyboard.press('p');
    await page.getByLabel('Brush size').fill('60');
    await page.getByLabel('Stabiliser').fill('0');
    await penStroke(page, [W * 0.2, H * 0.25], [W * 0.8, H * 0.25], 0.15, W, H);
    await penStroke(page, [W * 0.2, H * 0.75], [W * 0.8, H * 0.75], 1, W, H);
    await expect(page.getByRole('status', { name: 'Layers saved' })).toHaveText('Saved', { timeout: 15_000 });
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
    const [r, g, b] = px(W * 0.7, H * 0.5);
    expect(r).toBeGreaterThan(g + 25);
    expect(r).toBeGreaterThan(b + 25);
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
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(before + 1);
    await expect(page.locator('.layer-row.on')).toContainText('Instruct');
    await expect(page.locator('.layer-row.on .thumb-wrap.mask')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Layers saved' })).toHaveText('Saved', { timeout: 15_000 });
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
    const it = ((await r.json()).items as any[]).find((i) => i.kind === 'image' && !i.layered && i.width * i.height > 8e6 && i.width * i.height < 16e6);
    test.skip(!it, 'no large photo in this library');
    const { width: W, height: H } = it;
    await page.goto(`/#/edit/${it.id}`);
    await expect(page.getByAltText('Picture being edited')).toBeVisible();
    await page.getByRole('button', { name: 'Paint on a layer (P)' }).click();
    await expect(page.getByRole('listbox', { name: 'Layer stack' }).getByRole('option')).toHaveCount(1, { timeout: 60_000 });
    await page.getByRole('button', { name: 'New layer' }).click();
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
    await expect(page.getByRole('status', { name: 'Layers saved' })).toHaveText('Saved', { timeout: 30_000 });
    await page.screenshot({ path: 'proof/es-large-photo.png' });
  });
});
