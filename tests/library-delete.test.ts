import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type Item } from '../src/server/db';
import { outputDirFromArgv, outputPath } from '../src/server/trash';

const item = (id: string, filename: string, extra: Partial<Item> = {}): Item => ({
  id,
  created_at: Date.now(),
  kind: 'image',
  mode: 'generate',
  workflow: 'klein_t2i',
  model: 'Klein 9B',
  family: 'klein',
  prompt: `picture ${id}`,
  negative: '',
  seed: 1,
  width: 64,
  height: 64,
  duration: null,
  fps: null,
  frames: null,
  params: {},
  ui: {},
  api_prompt: null,
  file: { filename, subfolder: 'darkroom', type: 'output' },
  poster: null,
  last_frame: null,
  render_ms: null,
  parent_id: null,
  root_id: null,
  version: 1,
  favourite: false,
  tags: [],
  job_id: null,
  input_name: null,
  ...extra,
});

describe('library delete', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-lib-'));
    store = new Store(dir);
    store.insertItem(item('a', 'a.png'));
    store.insertItem(item('b', 'b.png'));
    store.insertItem(item('c', 'shared.png'));
    store.insertItem(item('d', 'shared.png'));
  });
  afterEach(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Delete hides items from every view and lists them under Recently deleted', () => {
    expect(store.softDelete(['a', 'missing'])).toEqual(['a']);
    expect(store.listItems({ filter: 'all' }).items.map((i) => i.id)).not.toContain('a');
    expect(store.listItems({ filter: 'deleted' }).items.map((i) => i.id)).toEqual(['a']);
    expect(store.lineage('a')).toEqual([]);
    expect(store.softDelete(['a'])).toEqual([]); // already deleted
  });

  it('Restore brings items back', () => {
    store.softDelete(['a', 'b']);
    expect(store.restoreItems(['b'])).toEqual(['b']);
    expect(store.listItems({ filter: 'all' }).total).toBe(3);
    expect(store.deletedIds()).toEqual(['a']);
  });

  it('Delete forever only removes items that are already in Recently deleted', () => {
    expect(store.purgeItems(['a'])).toEqual([]);
    store.softDelete(['a']);
    expect(store.purgeItems(['a']).map((i) => i.id)).toEqual(['a']);
    expect(store.getItem('a')).toBeNull();
  });

  it('a file another item still uses is reported as in use', () => {
    store.softDelete(['c']);
    store.purgeItems(['c']);
    expect(store.fileInUse({ filename: 'shared.png', subfolder: 'darkroom', type: 'output' })).toBe(true);
    expect(store.fileInUse({ filename: 'a.png', subfolder: 'darkroom', type: 'output' })).toBe(true);
    store.softDelete(['a']);
    store.purgeItems(['a']);
    expect(store.fileInUse({ filename: 'a.png', subfolder: 'darkroom', type: 'output' })).toBe(false);
  });
});

describe('output paths for the Recycle Bin', () => {
  it('reads the output folder from ComfyUI launch arguments', () => {
    expect(outputDirFromArgv(['main.py', '--output-directory', 'E:\\Comfy\\output'])).toBe(path.resolve('E:\\Comfy\\output'));
    expect(outputDirFromArgv(['main.py'])).toBeNull();
    expect(outputDirFromArgv(undefined)).toBeNull();
  });
  it('never resolves a path outside the output folder or for inputs', () => {
    const out = path.resolve('E:\\Comfy\\output');
    expect(outputPath(out, { filename: 'x.png', subfolder: 'darkroom', type: 'output' })).toBe(path.join(out, 'darkroom', 'x.png'));
    expect(outputPath(out, { filename: 'x.png', subfolder: '..\\..\\Windows', type: 'output' })).toBeNull();
    expect(outputPath(out, { filename: 'x.png', subfolder: 'darkroom', type: 'input' })).toBeNull();
  });
});
