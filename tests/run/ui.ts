/**
 * Test-suite runner (darkroom-test-runner-brief.md): drives Darkroom's own UI in a visible Edge window, like a user.
 * No backend calls — every step is a click, a typed text, an upload or a drawn mask; results are read from the screen.
 * One action per call:  npx tsx tests/run/ui.ts <action> '<json>'   (actions below; each prints a JSON result line)
 * A persistent Edge profile (tests/results/.edge-profile) keeps view preferences between actions; the log is
 * tests/results/run-<date>.jsonl, screenshots tests/results/screenshots/<TEST_ID>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const URL = process.env.DR_URL ?? 'http://127.0.0.1:5178';
const DATE = process.env.TS_DATE ?? '2026-10-03';
const LOG = `tests/results/run-${DATE}.jsonl`;
const PROFILE = 'tests/results/.edge-profile';
const ENHANCE_STATE = 'enhance off; style none; darkroom template for the mode';
const TIMEOUT: Record<string, number> = { klein: 120_000, qwen: 240_000, video: 600_000, enhance: 420_000 };

type J = Record<string, any>;
const [action, raw] = process.argv.slice(2);
const a: J = raw ? JSON.parse(fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw) : {};

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'msedge', headless: false, slowMo: 120, viewport: { width: 1440, height: 900 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(30_000);

const shotDir = (id: string) => {
  const d = `tests/results/screenshots/${id}`;
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const shot = async (testId: string, name: string) => {
  const p = `${shotDir(testId)}/${name.replace(/[^\w.-]+/g, '_')}.png`;
  await page.screenshot({ path: p });
  return p;
};
const log = (entry: J) => fs.appendFileSync(LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
const idFromUrl = () => (/#\/edit\/([0-9a-f-]{36})/.exec(page.url()) ?? [])[1] ?? null;
const errorToast = () => page.locator('.toast.error').last();

async function setBoard(name: string) {
  await page.getByRole('combobox', { name: 'Working board' }).selectOption({ label: name });
}

/** The Library with Stacks off (every version is a tile, newest first), showing one board. */
async function library(board?: string) {
  await page.goto(URL + '/#/library');
  const stacks = page.getByRole('button', { name: 'Stacks' });
  if ((await stacks.getAttribute('aria-pressed')) === 'true') await stacks.click();
  if (board) await page.getByRole('group', { name: 'Boards' }).getByRole('button', { name: new RegExp(`^${board.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`) }).click();
  else await page.getByRole('group', { name: 'Boards' }).getByRole('button', { name: 'All boards' }).click(); // search everything
  const search = page.getByPlaceholder(/Search prompt/);
  if (await search.inputValue()) await search.fill('');
  await page.getByRole('list', { name: 'Library items' }).or(page.getByText(/Nothing matches|library is empty/)).first().waitFor();
  await page.waitForTimeout(600);
}

/** A Library item with exactly this title (searched in the Library), or null. */
async function findTitled(title: string, board?: string): Promise<string | null> {
  await library(board);
  await page.getByPlaceholder(/Search prompt/).fill(title);
  await page.waitForTimeout(900);
  const tiles = page.locator('.tile-wrap');
  for (let i = 0; i < (await tiles.count()); i++) {
    const t = tiles.nth(i);
    if ((await t.locator('.tile-title').textContent().catch(() => null))?.trim() === title) return t.getAttribute('data-id');
  }
  return null;
}

/** Open an item's Details in the Library (by its tile) and set title / notes / favourite. */
async function annotate(id: string, o: { title?: string; notes?: string; appendNotes?: string; favourite?: boolean; board?: string }) {
  await library(o.board);
  await page.getByPlaceholder(/Search prompt/).fill('');
  const tile = page.locator(`.tile-wrap[data-id="${id}"]`);
  for (let i = 0; i < 20 && !(await tile.count()); i++) {
    const more = page.getByRole('button', { name: 'Load more' });
    if (!(await more.count())) break;
    await more.click();
  }
  await tile.locator('.tile').click();
  const d = page.getByRole('complementary', { name: 'Details' });
  if (o.title !== undefined) {
    await d.getByLabel('Title').fill(o.title);
    await d.getByLabel('Title').press('Enter');
  }
  if (o.appendNotes) o.notes = `${(await d.getByLabel('Notes').inputValue()).trim()}
${o.appendNotes}`.trim();
  if (o.notes !== undefined) {
    await d.getByLabel('Notes').fill(o.notes);
    await d.getByLabel('Title').click(); // leaving Notes saves them
  }
  if (o.favourite !== undefined) {
    const fav = d.getByRole('button', { name: 'Favourite' });
    if (((await fav.getAttribute('aria-pressed')) === 'true') !== o.favourite) await fav.click();
  }
  await page.waitForTimeout(700);
}

/** Wait for an Edit run: the screen moves to the new version (its id in the address), or an error shows. */
async function waitEditResult(from: string, timeout: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const id = idFromUrl();
    if (id && id !== from) return id;
    if (await errorToast().count()) throw new Error((await errorToast().textContent())?.trim() || 'error');
    if (Date.now() - t0 > timeout) throw new Error(`no result after ${timeout / 1000} s`);
    await page.waitForTimeout(1500);
  }
}

async function openEdit(id: string, mode: string, model?: string, seed?: number) {
  await page.goto(URL + `/#/edit/${id}`);
  await page.getByRole('group', { name: 'Edit mode' }).getByRole('button', { name: mode, exact: true }).click();
  if (model) await page.getByRole('group', { name: 'Edit model' }).getByRole('button', { name: model === 'klein' ? /^Klein 9B/ : /^Qwen-Image 2\.1/ }).click();
  if (seed !== undefined) await page.getByLabel('Seed').fill(String(seed));
}

const modelName = (m: string) => (m === 'klein' ? 'Klein' : m === 'qwen' ? 'Qwen' : m);
const notesFor = (o: J) => [`test ${o.testId}`, `model ${modelName(o.model ?? '')}`, `seed ${o.seed ?? '-'}`, o.variable ? `variable: ${o.variable}` : '', `prompt-enhance: ${ENHANCE_STATE}`, `prompt: ${o.prompt ?? ''}`, `run: ${new Date().toISOString()}`].filter(Boolean).join('\n');

async function runEdit(kind: 'instruct' | 'inpaint' | 'enhance' | 'outpaint') {
  const title = a.title as string;
  const existing = await findTitled(title);
  if (existing) return { skipped: true, id: existing };
  const sd = shotDir(a.testId);
  await openEdit(a.source, { instruct: 'Instruct', inpaint: 'Inpaint', enhance: 'Enhance', outpaint: 'Outpaint' }[kind], a.model, a.seed);
  let maskShot: string | null = null;
  if (kind === 'instruct') {
    await page.getByLabel('Instruction').fill(a.prompt);
    if (a.refFile) {
      const slot = page.locator('xpath=//p[normalize-space()="Reference (optional)"]/following-sibling::*[1]');
      await slot.locator('input[type=file]').setInputFiles(a.refFile);
      await page.getByRole('img', { name: 'Reference' }).waitFor({ timeout: 60_000 });
    }
  } else if (kind === 'inpaint') {
    // the mask: Smart select (SAM 3.1) — by the region's name when given, else clicks on its place in the picture
    await page.getByRole('button', { name: 'Smart select (S)' }).click();
    if (a.selectText) {
      await page.getByLabel('Select by text').fill(a.selectText);
      await page.getByLabel('Select by text').press('Enter');
    } else {
      const box = (await page.getByLabel('Canvas').locator('img').first().boundingBox())!;
      for (const [fx, fy] of a.points as [number, number][]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await page.getByRole('button', { name: 'Select', exact: true }).click();
    }
    await page.getByText('working…').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    await page.getByText('working…').waitFor({ state: 'hidden', timeout: 120_000 });
    await page.waitForTimeout(1200);
    maskShot = await shot(a.testId, `${title} · mask`);
    await page.getByLabel('What should fill the masked area?').fill(a.prompt);
  } else if (kind === 'enhance') {
    await page.getByRole('group', { name: 'Enhance strength' }).getByRole('button', { name: a.strength ?? 'Restore', exact: true }).click();
  } else if (kind === 'outpaint') {
    // padding as a share of the picture's width (read from the version line, e.g. "v3 1024×768 made with…")
    if (a.padFrac) {
      // the "New size" line shows the picture's own size while every pad is 0
      const body = await page.locator('body').innerText();
      const m = /new size\s*(\d+)\s*×\s*(\d+)/i.exec(body) ?? /(\d+)×(\d+) made with/.exec(body);
      const w = m ? Number(m[1]) : 0;
      if (!w) throw new Error('outpaint: picture width not found');
      a.pad = Object.fromEntries(Object.entries(a.padFrac as Record<string, number>).map(([k, f]) => [k, Math.round(w * f)]));
    }
    for (const side of ['left', 'top', 'right', 'bottom'] as const) if (a.pad?.[side] !== undefined) await page.getByRole('spinbutton', { name: side }).fill(String(a.pad[side]));
    if (a.prompt) await page.getByLabel('Describe the surroundings (optional)').fill(a.prompt);
  }
  const before = await shot(a.testId, `${title} · settings`);
  const t0 = Date.now();
  const button = { instruct: 'Apply instruction Ctrl+Enter', inpaint: 'Fill masked area Ctrl+Enter', enhance: 'Enhance Ctrl+Enter', outpaint: 'Extend canvas Ctrl+Enter' }[kind];
  let id: string;
  try {
    await page.getByRole('button', { name: button }).click();
    id = await waitEditResult(a.source, kind === 'enhance' ? TIMEOUT.enhance : TIMEOUT[a.model] ?? 240_000);
  } catch (e) {
    const fail = await shot(a.testId, `${title} · FAILED`);
    log({ test_id: a.testId, model: modelName(a.model), seed: a.seed, variable: a.variable ?? null, prompt_resolved: a.prompt, prompt_enhance_state: ENHANCE_STATE, input_files: a.inputFiles ?? [], source_test_id: a.sourceTest ?? null, source_library_item: a.source, library_item_name: title, status: 'FAILED', notes: (e as Error).message, screenshot_paths: [before, fail] });
    return { failed: (e as Error).message };
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  await page.waitForTimeout(1500);
  const after = await shot(a.testId, `${title} · result`);
  await annotate(id, { title, notes: notesFor(a) });
  log({ test_id: a.testId, model: modelName(a.model), seed: a.seed ?? null, variable: a.variable ?? null, prompt_resolved: a.prompt ?? `(${kind} ${a.strength ?? ''})`, prompt_enhance_state: ENHANCE_STATE, input_files: a.inputFiles ?? [], source_test_id: a.sourceTest ?? null, source_library_item: a.source, library_item_name: title, library_item_id: id, resolution: null, status: a.adapted ? 'ADAPTED' : 'OK', score: null, provisional_best: false, notes: `${seconds} s${a.note ? '; ' + a.note : ''}`, screenshot_paths: [before, ...(maskShot ? [maskShot] : []), after] });
  void sd;
  return { id, seconds };
}

/** Generate: model, aspect, style None, seed (Advanced), prompt → the new picture at the top of the History rail. */
async function generate() {
  const title = a.title as string;
  const existing = await findTitled(title);
  if (existing) return { skipped: true, id: existing };
  if (a.board) {
    await library(a.board);
    await setBoard(a.board);
  }
  await page.goto(URL + '/#/generate');
  await page.getByRole('group', { name: 'Model' }).getByRole('button', { name: a.model === 'klein' ? /^Klein 9B/ : /^Qwen-Image 2\.1/ }).click();
  await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: a.aspect ?? '16:9', exact: true }).click();
  await page.getByRole('group', { name: 'Style preset' }).getByRole('button', { name: 'None', exact: true }).click();
  const seed = page.getByLabel('Seed');
  if (!(await seed.isVisible())) await page.getByText('Advanced').click();
  await seed.fill(String(a.seed));
  await page.getByLabel('Prompt').fill(a.prompt);
  const rail = page.getByRole('complementary', { name: 'History' }).locator('.rail-item img').first();
  const topId = async () => (/\/api\/items\/([0-9a-f-]{36})\/thumb/.exec((await rail.getAttribute('src').catch(() => null)) ?? '') ?? [])[1] ?? null;
  const before = await topId();
  const settings = await shot(a.testId, `${title} · settings`);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Generate Ctrl+Enter' }).click();
  let id: string | null = null;
  for (;;) {
    const now = await topId();
    if (now && now !== before) {
      id = now;
      break;
    }
    if (await errorToast().count()) break;
    if (Date.now() - t0 > (TIMEOUT[a.model] ?? 240_000)) break;
    await page.waitForTimeout(1500);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  await page.waitForTimeout(1200);
  const after = await shot(a.testId, `${title} · result`);
  if (!id) {
    log({ test_id: a.testId, model: modelName(a.model), seed: a.seed, prompt_resolved: a.prompt, library_item_name: title, status: 'FAILED', notes: (await errorToast().textContent().catch(() => null)) ?? `no result after ${seconds} s`, screenshot_paths: [settings, after] });
    return { failed: true };
  }
  await annotate(id, { title, notes: notesFor(a) + `
aspect ${a.aspect ?? '16:9'}, default quality`, board: a.board });
  log({ test_id: a.testId, model: modelName(a.model), seed: a.seed, variable: a.variable ?? null, prompt_resolved: a.prompt, prompt_enhance_state: 'enhance off; style none (Generate sends the prompt as written)', input_files: [], library_item_name: title, library_item_id: id, resolution: a.aspect ?? '16:9', status: 'OK', score: null, provisional_best: false, notes: `${seconds} s`, screenshot_paths: [settings, after] });
  return { id, seconds };
}

/** Timeline: a new film of the given clips (found in the bin by title, added to the end in order), exported to MP4. */
async function timeline() {
  const title = a.title as string;
  const existing = await findTitled(title);
  if (existing) return { skipped: true, id: existing };
  if (a.board) {
    await library(a.board);
    await setBoard(a.board);
  }
  await page.goto(URL + '/#/timeline');
  await page.getByRole('button', { name: 'New film' }).click();
  await page.waitForURL(/#\/timeline\/[0-9a-f-]{36}$/);
  await page.getByLabel('Film name').fill(title);
  const bin = page.getByRole('list', { name: 'Videos to add' });
  for (const clip of a.clips as string[]) {
    await page.getByLabel('Search videos').fill(clip);
    await page.waitForTimeout(1200);
    await bin.getByRole('button', { name: /^Add .* to the end$/ }).first().click();
  }
  await page.getByLabel('Search videos').fill('');
  await page.waitForTimeout(1500); // autosave
  const before = await shot(a.testId, `${title} · timeline`);
  const exported = page.waitForResponse((r) => /\/api\/timelines\/[^/]+\/export$/.test(r.url()), { timeout: 600_000 });
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const item = await (await exported).json(); // the film the UI's export made
  await page.waitForTimeout(1500);
  const after = await shot(a.testId, `${title} · exported`);
  await annotate(item.id, { title, notes: `test ${a.testId}
clips in order: ${(a.clips as string[]).join(' | ')}
assembled on the Timeline, exported MP4
run: ${new Date().toISOString()}`, board: a.board });
  log({ test_id: a.testId, model: 'LTX + Timeline', library_item_name: title, library_item_id: item.id, duration: item.duration, resolution: `${item.width}x${item.height}`, status: 'ADAPTED', notes: 'three clips cut together on the Timeline', screenshot_paths: [before, after] });
  return { id: item.id };
}

/** Edit · Crop: drag a box on the picture (fractions of it), Apply crop → a new version stacked on the source. */
async function crop() {
  const title = a.title as string;
  const existing = await findTitled(title);
  if (existing) return { skipped: true, id: existing };
  await page.goto(URL + `/#/edit/${a.source}`);
  await page.getByRole('button', { name: 'Crop (C)' }).click();
  const box = (await page.getByLabel('Canvas').locator('img').first().boundingBox())!;
  const [x0, y0, x1, y1] = a.rect as [number, number, number, number];
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 8 });
  await page.mouse.up();
  const before = await shot(a.testId, `${title} · crop box`);
  await page.getByRole('button', { name: /^Apply crop/ }).click();
  const id = await waitEditResult(a.source, 120_000);
  await page.waitForTimeout(1200);
  const after = await shot(a.testId, `${title} · result`);
  await annotate(id, { title, notes: `test ${a.testId}
crop of ${a.sourceTitle} (${a.rect.join(', ')})
run: ${new Date().toISOString()}` });
  log({ test_id: a.testId, model: null, seed: null, library_item_name: title, library_item_id: id, source_library_item: a.source, status: 'ADAPTED', notes: 'helper crop for the video source', screenshot_paths: [before, after] });
  return { id };
}

async function upload() {
  const existing = await findTitled(a.title);
  if (existing) return { skipped: true, id: existing };
  await library(a.board);
  if (a.board) await setBoard(a.board);
  // an earlier try that uploaded but did not get its title: the untitled tile named after the file
  const stem = path.basename(a.file).replace(/\.[^.]+$/, '');
  const untitled = page.locator('.tile-wrap').filter({ has: page.locator(`[aria-label="image ${stem}"]`) });
  let id = (await untitled.count()) ? await untitled.first().getAttribute('data-id') : null;
  if (!id) {
    await page.getByLabel('Upload pictures to the Library').setInputFiles(a.file);
    await page.getByText(/picture added to your Library|pictures added to your Library/).last().waitFor({ timeout: 120_000 });
    await library(a.board);
    id = await untitled.first().getAttribute('data-id');
  }
  if (!id) throw new Error('uploaded, but its tile was not found');
  await annotate(id, { title: a.title, notes: `test ${a.testId}\ninput file: ${path.basename(a.file)}\nrun: ${new Date().toISOString()}`, board: a.board });
  const s = await shot(a.testId, `${a.title} · uploaded`);
  log({ test_id: a.testId, model: null, seed: null, variable: null, prompt_resolved: null, prompt_enhance_state: null, input_files: [a.file], library_item_name: a.title, library_item_id: id, status: 'OK', notes: 'input uploaded', screenshot_paths: [s] });
  return { id };
}

async function compare() {
  const title = a.title as string;
  const existing = await findTitled(title);
  if (existing) return { skipped: true, id: existing };
  await library(a.board);
  if (a.board) await setBoard(a.board); // a saved compare goes to the working board
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const id of [a.a, a.b]) await page.locator(`.tile-wrap[data-id="${id}"]`).getByRole('checkbox').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Compare' }).click();
  const dlg = page.getByRole('dialog', { name: 'Compare' });
  await dlg.locator('figure').nth(1).waitFor();
  await page.waitForTimeout(1500);
  const s = await shot(a.testId, `${title}`);
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/items/compare'));
  await dlg.getByRole('button', { name: 'Save as picture' }).click();
  const item = await (await saved).json(); // read back the saved item the UI made (no request of our own)
  await dlg.getByRole('button', { name: 'Close compare' }).click();
  await page.keyboard.press('Escape');
  await annotate(item.id, { title, notes: `test ${a.testId}\ncompare: ${a.labelA} vs ${a.labelB}`, board: a.board });
  log({ test_id: a.testId, model: 'Klein vs Qwen', library_item_name: title, library_item_id: item.id, status: 'OK', notes: 'compare saved', screenshot_paths: [s] });
  return { id: item.id };
}

async function video() {
  const title = a.title as string;
  const existing = await findTitled(title);
  if (existing) return { skipped: true, id: existing };
  if (a.board) {
    await library(a.board);
    await setBoard(a.board);
  }
  await page.goto(URL + `/#/video?start=${a.start}`); // what Library → Animate opens
  await page.getByLabel('Motion prompt').waitFor();
  if (a.end) {
    await page.getByRole('button', { name: 'End from library' }).click();
    const picker = page.getByRole('dialog');
    await picker.getByPlaceholder(/Search/).fill(a.endTitle);
    await page.waitForTimeout(1200);
    // the exact item (a compare sheet's name can contain the same title, so never "the first hit")
    await picker.locator(`[role=listitem]:has(img[src*="${a.end}"])`).first().click();
  }
  await page.getByRole('group', { name: 'Length' }).getByRole('button', { name: `${a.seconds ?? 5} s` }).click();
  await page.getByRole('group', { name: 'Quality' }).getByRole('button', { name: /^Final/ }).click();
  if (a.camera) await page.getByRole('group', { name: 'Camera' }).getByRole('button', { name: a.camera }).click();
  if (a.fit) await page.getByRole('button', { name: 'Fit with bars' }).click().catch(() => undefined);
  await page.getByLabel('Motion prompt').fill(a.prompt);
  const before = await shot(a.testId, `${title} · settings`);
  const t0 = Date.now();
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Animate Ctrl+Enter' }).click();
  const job = await (await sent).json();
  // the take in the Takes panel: done when it plays, failed when it shows its error
  const take = page.locator(`[data-job="${job.id}"]`);
  let id: string | null = null;
  for (;;) {
    const status = await take.getAttribute('data-status').catch(() => null);
    if (status === 'done') {
      const src = await take.locator('img').first().getAttribute('src');
      id = (/\/api\/items\/([0-9a-f-]{36})\/thumb/.exec(src ?? '') ?? [])[1] ?? null;
      break;
    }
    if (status && ['error', 'failed', 'cancelled', 'lost'].includes(status)) break;
    if (Date.now() - t0 > TIMEOUT.video) break;
    await page.waitForTimeout(3000);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const after = await shot(a.testId, `${title} · result`);
  if (!id) {
    log({ test_id: a.testId, model: 'LTX', seed: null, prompt_resolved: a.prompt, library_item_name: title, status: 'FAILED', notes: `no finished take after ${seconds} s`, screenshot_paths: [before, after] });
    return { failed: true };
  }
  await annotate(id, { title, notes: notesFor({ ...a, model: 'LTX', seed: 'random (Video has no seed control)' }) + `\nsource: ${a.sourceTitle}${a.end ? ` → ${a.endTitle}` : ''}\n${a.seconds ?? 5} s · 24 fps · Final 720p`, board: a.board });
  log({ test_id: a.testId, model: 'LTX', seed: null, variable: null, prompt_resolved: a.prompt, prompt_enhance_state: 'motion prompt as written', input_files: [], source_test_id: a.sourceTest, source_library_item: a.start, library_item_name: title, library_item_id: id, duration: a.seconds ?? 5, fps: 24, resolution: 'Final 720p', status: a.adapted ? 'ADAPTED' : 'OK', notes: `${seconds} s`, screenshot_paths: [before, after] });
  return { id, seconds };
}

let result: unknown;
try {
  // sources may be named by their Library title instead of an id (sourceTitle / startTitle / endTitle)
  for (const k of ['source', 'start', 'end'] as const) {
    const t = a[`${k}Title`];
    if (!a[k] && t && (k !== 'source' || action !== 'video')) {
      const id = await findTitled(t);
      if (!id) throw new Error(`no Library item titled "${t}"`);
      a[k] = id;
    }
  }
  if (action === 'board') {
    await library();
    await setBoard(a.board);
    result = { ok: true };
  } else if (action === 'upload') result = await upload();
  else if (action === 'instruct' || action === 'inpaint' || action === 'enhance' || action === 'outpaint') result = await runEdit(action);
  else if (action === 'compare') result = await compare();
  else if (action === 'list') {
    // every tile matching a search, across all boards: id and title as the Library shows them
    await library();
    await page.getByPlaceholder(/Search prompt/).fill(a.q);
    await page.waitForTimeout(1500);
    const tiles = page.locator('.tile-wrap');
    const out: { id: string | null; title: string | null }[] = [];
    for (let i = 0; i < (await tiles.count()); i++) out.push({ id: await tiles.nth(i).getAttribute('data-id'), title: (await tiles.nth(i).locator('.tile-title').textContent().catch(() => null))?.trim() ?? null });
    result = { items: out };
  }
  else if (action === 'move') {
    // Library: tick the items in one board and Move to board (the selection bar)
    await library(a.fromBoard);
    if (a.q) { await page.getByPlaceholder(/Search prompt/).fill(a.q); await page.waitForTimeout(1500); }
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    for (const id of a.ids as string[]) await page.locator(`.tile-wrap[data-id="${id}"]`).getByRole('checkbox').click();
    await page.getByRole('toolbar', { name: 'Selection' }).getByLabel('Move to board').selectOption({ label: a.toBoard });
    await page.waitForTimeout(1200);
    if (a.q) await page.getByPlaceholder(/Search prompt/).fill('');
    result = { moved: (a.ids as string[]).length };
  }
  else if (action === 'crop') result = await crop();
  else if (action === 'generate') result = await generate();
  else if (action === 'timeline') result = await timeline();
  else if (action === 'video') result = await video();
  else if (action === 'annotate') {
    await annotate(a.id, a);
    if (a.log) log(a.log);
    result = { ok: true };
  } else if (action === 'find') result = { id: await findTitled(a.title, a.board) };
  else if (action === 'frames') {
    // a video's frames as the Library's own player shows them, at a few moments
    await annotate(a.id, { board: a.board });
    const v = page.getByRole('complementary', { name: 'Details' }).locator('video').first();
    await v.evaluate((el: HTMLVideoElement) => new Promise((r) => (el.readyState >= 2 ? r(null) : el.addEventListener('loadeddata', () => r(null), { once: true }))));
    const paths: string[] = [];
    for (const t of a.times as number[]) {
      await v.evaluate((el: HTMLVideoElement, tt: number) => new Promise((r) => { el.pause(); el.currentTime = tt; el.addEventListener('seeked', () => r(null), { once: true }); }), t);
      await page.waitForTimeout(250);
      const p = `${shotDir(a.testId)}/${a.name}_t${t}.png`;
      await v.screenshot({ path: p });
      paths.push(p);
    }
    result = { paths };
  }
  else if (action === 'show') {
    await annotate(a.id, { board: a.board });
    const d = page.getByRole('complementary', { name: 'Details' });
    await d.evaluate((el) => el.querySelector('.panel-scroll')?.scrollTo(0, 10000));
    await page.waitForTimeout(500);
    result = { shot: await shot(a.testId ?? 'misc', a.name ?? `details-${a.id}`), text: (await d.innerText()).slice(0, 3000) };
  }
  else throw new Error('unknown action ' + action);
} catch (e) {
  await page.screenshot({ path: `tests/results/screenshots/error-${Date.now()}.png` }).catch(() => undefined);
  result = { error: (e as Error).message };
}
console.log('RESULT ' + JSON.stringify(result));
await ctx.close();
