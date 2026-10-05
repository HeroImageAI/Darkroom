/**
 * The polish tour: open Darkroom like a creative and capture every screen, Edit mode, tool and panel as a screenshot,
 * at a large and a laptop window. Read-only: it never presses Generate, Apply, Animate or Delete.
 *   npx tsx tests/tour.ts [url] [out dir]
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? 'tests/results/tour';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });

const tour = async (page: Page, tag: string) => {
  const snap = async (name: string) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${tag}-${name}.png` });
    console.log(tag, name);
  };
  const tryClick = async (l: ReturnType<Page['getByRole']>) => {
    if (await l.count()) await l.first().click().catch(() => {});
  };
  await page.goto(url + '/#/');
  await snap('00-home');
  await page.goto(url + '/#/generate');
  await page.waitForTimeout(1500);
  await snap('10-generate');
  await page.getByLabel('Prompt').fill('A white leather sneaker with a gum sole on a concrete plinth, soft studio light');
  await tryClick(page.getByText('Advanced'));
  await snap('11-generate-typed-advanced');
  await tryClick(page.getByRole('complementary', { name: 'History' }).locator('.rail-item').first());
  await snap('12-generate-history-picked');

  await page.goto(url + '/#/edit');
  await snap('20-edit-empty');
  const pic = (await (await page.request.get(url + '/api/items?filter=generated&limit=1')).json()).items[0];
  await page.goto(url + `/#/edit/${pic.id}`);
  await page.waitForTimeout(2000);
  await snap('21-edit-picture');
  const modes = page.getByRole('group', { name: 'Edit mode' });
  for (const m of ['Fill', 'Expand', 'Refine', 'Sketch', 'Compose', 'Turn it', 'Enhance', 'Separate', 'Cut-out', 'Upscale', 'Instruct']) {
    await tryClick(modes.getByRole('button', { name: m, exact: true }));
    await snap(`22-mode-${m.toLowerCase().replace(/\W+/g, '-')}`);
  }
  const tools = page.getByRole('navigation', { name: 'Tools' });
  for (const t of ['Transform the layer', 'Paint on a layer', 'Fill bucket', 'Shapes', 'Mask brush', 'Marquee select', 'Lasso', 'Magic wand', 'Smart select', 'Outpaint frame', 'Crop', 'Move']) {
    await tryClick(tools.getByRole('button', { name: new RegExp(`^${t}`) }));
    await snap(`23-tool-${t.toLowerCase().replace(/\W+/g, '-')}`);
  }
  await tryClick(page.getByRole('tab', { name: /Layers/ }));
  await snap('24-layers');
  await tryClick(page.getByRole('tab', { name: /Adjust/ }));
  await snap('25-adjust');
  await tryClick(page.getByRole('button', { name: /New canvas/ }));
  await snap('26-new-canvas');
  await page.keyboard.press('Escape');

  await page.goto(url + '/#/video');
  await snap('30-video-empty');
  await page.goto(url + `/#/video?start=${pic.id}`);
  await page.waitForTimeout(1500);
  await snap('31-video-frame');

  await page.goto(url + '/#/timeline');
  await snap('40-timeline');
  await tryClick(page.getByRole('button', { name: /^Open / }));
  await page.waitForTimeout(2000);
  await snap('41-timeline-film');

  await page.goto(url + '/#/library');
  await page.waitForTimeout(2500);
  await snap('50-library');
  await tryClick(page.getByRole('button', { name: 'Videos', exact: true }));
  await snap('51-library-videos');
  await tryClick(page.getByRole('button', { name: 'Recently deleted', exact: true }));
  await snap('52-library-deleted');
};

for (const [tag, w, h] of [['L', 1600, 1000], ['S', 1280, 800]] as const) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  try {
    await tour(page, tag);
  } catch (e) {
    console.log('tour stopped:', (e as Error).message.split('\n')[0]);
    await page.screenshot({ path: `${out}/${tag}-zz-error.png` });
  }
  await page.context().close();
}
await browser.close();
