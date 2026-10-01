import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type Item, type Job } from '../src/server/db';
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

describe('Video Takes follow the Library', () => {
  let dir: string;
  let store: Store;
  const job = (id: string, status: Job['status'], result_ids: string[], created_at: number): Job => ({
    id, prompt_id: null, workflow: 'wan_i2v', kind: 'video', family: 'wan', status, created_at, started_at: created_at, finished_at: created_at + 1,
    progress: 1, stage: '', error: status === 'error' ? 'boom' : null, meta: {}, params: {}, api_prompt: {}, estimate_sec: null, result_ids,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-takes-'));
    store = new Store(dir);
    store.insertItem(item('v1', 'v1.mp4', { kind: 'video' }));
    store.insertItem(item('v2', 'v2.mp4', { kind: 'video' }));
    store.insertJob(job('j1', 'done', ['v1'], 1));
    store.insertJob(job('j2', 'done', ['v2'], 2));
    store.insertJob(job('j3', 'error', [], 3));
    store.insertJob(job('j4', 'running', [], 4));
  });
  afterEach(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a deleted video drops its take; restoring brings it back', () => {
    expect(store.liveTakes('video').map((j) => j.id)).toEqual(['j4', 'j3', 'j2', 'j1']);
    store.softDelete(['v1']);
    expect(store.liveTakes('video').map((j) => j.id)).toEqual(['j4', 'j3', 'j2']);
    store.restoreItems(['v1']);
    expect(store.liveTakes('video').map((j) => j.id)).toContain('j1');
  });

  it('only failed renders can be dismissed, and Clear failed finds them', () => {
    expect(store.failedJobIds('video')).toEqual(['j3']);
    expect(store.dismissJobs(['j1', 'j3', 'j4'])).toEqual(['j3']);
    expect(store.liveTakes('video').map((j) => j.id)).toEqual(['j4', 'j2', 'j1']);
    expect(store.failedJobIds('video')).toEqual([]);
  });
});

describe('Generate History is the Library', () => {
  it('lists only pictures made on the Generate screen, without deleted ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-hist-'));
    const store = new Store(dir);
    store.insertItem(item('g1', 'g1.png'));
    store.insertItem(item('e1', 'e1.png', { mode: 'edit:instruct' }));
    store.insertItem(item('g2', 'g2.png'));
    store.softDelete(['g2']);
    expect(store.listItems({ filter: 'generated' }).items.map((i) => i.id)).toEqual(['g1']);
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Boards', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-boards-'));
    store = new Store(dir);
    for (const id of ['a', 'b', 'c']) store.insertItem(item(id, `${id}.png`));
  });
  afterEach(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('moves items into a board and lists by board, with counts and a cover', () => {
    store.createBoard('Client X', 'bx');
    expect(store.moveToBoard(['a', 'b'], 'bx')).toEqual(['a', 'b']);
    expect(store.listItems({ board: 'bx' }).items.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(store.listItems({ board: 'none' }).items.map((i) => i.id)).toEqual(['c']);
    expect(store.listItems({}).total).toBe(3);
    const bx = store.board('bx')!;
    expect(bx.count).toBe(2);
    expect(['a', 'b']).toContain(bx.cover);
  });

  it('counts only live items', () => {
    store.createBoard('X', 'bx');
    store.moveToBoard(['a', 'b'], 'bx');
    store.softDelete(['a']);
    expect(store.board('bx')!.count).toBe(1);
  });

  it('deleting a board never deletes its pictures', () => {
    store.createBoard('X', 'bx');
    store.moveToBoard(['a'], 'bx');
    expect(store.deleteBoard('bx')).toBe(true);
    expect(store.getItem('a')).not.toBeNull();
    expect(store.getItem('a')!.board_id).toBeNull();
    expect(store.boards()).toEqual([]);
  });

  it('renames and moves back to no board', () => {
    store.createBoard('X', 'bx');
    store.renameBoard('bx', 'Logos');
    expect(store.board('bx')!.name).toBe('Logos');
    store.moveToBoard(['a'], 'bx');
    store.moveToBoard(['a'], null);
    expect(store.listItems({ board: 'none' }).total).toBe(3);
  });
});
