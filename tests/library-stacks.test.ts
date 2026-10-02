import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type Item } from '../src/server/db';

let t = 1000;
const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  created_at: t++,
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
  file: { filename: `${id}.png`, subfolder: 'darkroom', type: 'output' },
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

describe('library version stacks', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-stack-'));
    store = new Store(dir);
    // picture A with three versions (an edit, then an upscale), and picture B on its own
    store.insertItem(item('a1'));
    store.insertItem(item('b1'));
    store.insertItem(item('a2', { root_id: 'a1', parent_id: 'a1', version: 2, mode: 'edit:instruct' }));
    store.insertItem(item('a3', { root_id: 'a1', parent_id: 'a2', version: 3, mode: 'upscale' }));
  });
  afterEach(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the newest version of each picture with its count; unstacked shows everything', () => {
    const s = store.listItems({ stack: true });
    expect(s.items.map((i) => [i.id, i.stack_count])).toEqual([
      ['a3', 3],
      ['b1', 1],
    ]);
    expect(s.total).toBe(2);
    expect(store.listItems({}).total).toBe(4);
  });
  it('a deleted version drops out of its stack; Recently deleted is never stacked', () => {
    store.softDelete(['a3']);
    expect(store.listItems({ stack: true }).items.map((i) => [i.id, i.stack_count])).toEqual([
      ['a2', 2],
      ['b1', 1],
    ]);
    store.softDelete(['a2']);
    expect(store.listItems({ filter: 'deleted', stack: true }).items.map((i) => i.id).sort()).toEqual(['a2', 'a3']);
  });
  it('stacks within a filter: Edits shows the newest edit of picture A', () => {
    expect(store.listItems({ filter: 'edits', stack: true }).items.map((i) => [i.id, i.stack_count])).toEqual([['a3', 2]]);
    expect(store.listItems({ filter: 'klein', stack: true }).items.map((i) => i.id)).toEqual(['a3', 'b1']); // upscales count as Klein (the filter's own rule)
  });
});
