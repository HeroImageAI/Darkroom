import fs from 'node:fs';
import type { TimelineDoc } from '../shared/timeline.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ComposeDoc, Composition } from '../shared/compose.js';

export interface FileRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface Item {
  id: string;
  created_at: number;
  kind: 'image' | 'video';
  mode: string; // generate | edit:instruct | edit:inpaint | edit:outpaint | edit:remove_bg | upscale | video | smooth | extend
  workflow: string;
  model: string;
  family: string;
  prompt: string;
  negative: string;
  seed: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  fps: number | null;
  frames: number | null;
  params: Record<string, unknown>;
  ui: Record<string, unknown>;
  api_prompt: Record<string, unknown> | null;
  file: FileRef;
  poster: FileRef | null;
  last_frame: FileRef | null;
  render_ms: number | null;
  parent_id: string | null;
  root_id: string | null;
  version: number;
  favourite: boolean;
  tags: string[];
  job_id: string | null;
  input_name: string | null;
  /** Layers from one decomposition share a group id. */
  group_id?: string | null;
  /** Set while the item is in the Library's "Recently deleted"; null for live items. */
  deleted_at?: number | null;
  /** Board (collection) the item belongs to; null = no board. */
  board_id?: string | null;
  /** Your own name for it (P2, 2026-10-03); the prompt stands in when empty. */
  title?: string | null;
  /** Your notes on it. */
  notes?: string | null;
  /** Library version stacks: how many versions of this picture match the view (listItems with `stack`). */
  stack_count?: number;
}

export interface Board {
  id: string;
  name: string;
  created_at: number;
  /** Live (not deleted) items in the board. */
  count: number;
  /** Newest live item, for the board's thumbnail. */
  cover: string | null;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'lost';

export interface Job {
  id: string;
  prompt_id: string | null;
  workflow: string;
  kind: 'image' | 'video' | 'text' | 'mask';
  family: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  progress: number;
  stage: string;
  error: string | null;
  meta: Record<string, any>;
  params: Record<string, unknown>;
  api_prompt: Record<string, unknown>;
  estimate_sec: number | null;
  result_ids: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  workflow TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  negative TEXT NOT NULL DEFAULT '',
  seed INTEGER,
  width INTEGER,
  height INTEGER,
  duration REAL,
  fps REAL,
  frames INTEGER,
  params TEXT NOT NULL DEFAULT '{}',
  ui TEXT NOT NULL DEFAULT '{}',
  api_prompt TEXT,
  file TEXT NOT NULL,
  poster TEXT,
  last_frame TEXT,
  render_ms INTEGER,
  parent_id TEXT,
  root_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  favourite INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  job_id TEXT,
  input_name TEXT
);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at DESC);
CREATE INDEX IF NOT EXISTS items_root ON items(root_id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  prompt_id TEXT,
  workflow TEXT NOT NULL,
  kind TEXT NOT NULL,
  family TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  error TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  params TEXT NOT NULL DEFAULT '{}',
  api_prompt TEXT NOT NULL DEFAULT '{}',
  estimate_sec INTEGER,
  result_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
`;

const JSON_ITEM = ['params', 'ui', 'api_prompt', 'file', 'poster', 'last_frame', 'tags'] as const;
const JSON_JOB = ['meta', 'params', 'api_prompt', 'result_ids'] as const;

function decode<T>(row: Record<string, any> | undefined, jsonCols: readonly string[]): T | null {
  if (!row) return null;
  const out: Record<string, any> = { ...row };
  for (const c of jsonCols) out[c] = out[c] == null ? null : JSON.parse(out[c]);
  if ('favourite' in out) out.favourite = !!out.favourite;
  return out as T;
}

export interface LibraryQuery {
  filter?: 'all' | 'favourites' | 'klein' | 'qwen' | 'edits' | 'composed' | 'videos' | 'deleted' | 'generated';
  q?: string;
  limit?: number;
  offset?: number;
  /** A board id, or 'none' for items without a board; unset = every board. */
  board?: string;
  /** Version stacks: one item per picture (its newest matching version), with `stack_count`. Never in Recently deleted. */
  stack?: boolean;
  sort?: 'newest' | 'oldest' | 'name' | 'largest';
}

export class Store {
  db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'darkroom.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    // additive migrations
    const cols = (this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('group_id')) this.db.exec('ALTER TABLE items ADD COLUMN group_id TEXT');
    // Library delete: items first go to "Recently deleted" (deleted_at set) and can be restored from there
    if (!cols.includes('deleted_at')) this.db.exec('ALTER TABLE items ADD COLUMN deleted_at INTEGER');
    // Video Takes panel: failed / cancelled / lost renders can be dismissed (they have no file to keep)
    const jobCols = (this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
    if (!jobCols.includes('dismissed')) this.db.exec('ALTER TABLE jobs ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0');
    // Boards (collections): additive, items keep working without one
    this.db.exec('CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
    if (!cols.includes('board_id')) this.db.exec('ALTER TABLE items ADD COLUMN board_id TEXT');
    if (!cols.includes('title')) this.db.exec('ALTER TABLE items ADD COLUMN title TEXT');
    if (!cols.includes('notes')) this.db.exec('ALTER TABLE items ADD COLUMN notes TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS items_board ON items(board_id)');
    // Compose: saved compositions (the layout is JSON; deleting only hides it, like the Library)
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS compositions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, doc TEXT NOT NULL, thumb TEXT, deleted_at INTEGER)',
    );
    // Timeline (DECISIONS 103): saved films-in-progress, stored like compositions
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS timelines (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, doc TEXT NOT NULL, deleted_at INTEGER)',
    );
  }

  /** Saved compositions, newest first, without their layouts. */
  compositions(): Omit<Composition, 'doc'>[] {
    return (this.db.prepare('SELECT id, name, created_at, updated_at, thumb FROM compositions WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as any[]).map((r) => ({ ...r }));
  }

  composition(id: string): Composition | null {
    const r = this.db.prepare('SELECT * FROM compositions WHERE id = ? AND deleted_at IS NULL').get(id) as any;
    return r ? { id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at, thumb: r.thumb ?? null, doc: JSON.parse(r.doc) } : null;
  }

  /** Create or update a composition. */
  saveComposition(id: string, name: string, doc: ComposeDoc, thumb: string | null, now = Date.now()): Composition {
    this.db
      .prepare(
        `INSERT INTO compositions (id, name, created_at, updated_at, doc, thumb) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, doc = excluded.doc, thumb = COALESCE(excluded.thumb, thumb), deleted_at = NULL`,
      )
      .run(id, name, now, now, JSON.stringify(doc), thumb);
    return this.composition(id)!;
  }

  /** Hide a composition (restorable); its pictures stay where they are. */
  deleteComposition(id: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE compositions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id).changes > 0;
  }

  restoreComposition(id: string): boolean {
    return this.db.prepare('UPDATE compositions SET deleted_at = NULL WHERE id = ?').run(id).changes > 0;
  }

  /** Saved timelines, newest first, without their documents. */
  /** Saved films, newest first, each with a summary for the list: clips, length and the first clip as a poster. */
  timelines(): { id: string; name: string; created_at: number; updated_at: number; clips: number; seconds: number; poster: string | null }[] {
    return (this.db.prepare('SELECT id, name, created_at, updated_at, doc FROM timelines WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as any[]).map((r) => {
      let clips: TimelineDoc['clips'] = [];
      try {
        clips = (JSON.parse(r.doc) as TimelineDoc).clips ?? [];
      } catch {
        /* an unreadable film still lists */
      }
      const first = [...clips].sort((a, b) => a.start - b.start)[0];
      const seconds = clips.reduce((m, c) => Math.max(m, c.start + (c.out - c.in)), 0);
      return { id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at, clips: clips.length, seconds: Math.round(seconds * 10) / 10, poster: first?.itemId ?? null };
    });
  }

  timeline(id: string): { id: string; name: string; created_at: number; updated_at: number; doc: TimelineDoc } | null {
    const r = this.db.prepare('SELECT * FROM timelines WHERE id = ? AND deleted_at IS NULL').get(id) as any;
    return r ? { id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at, doc: JSON.parse(r.doc) } : null;
  }

  saveTimeline(id: string, name: string, doc: TimelineDoc, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO timelines (id, name, created_at, updated_at, doc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, doc = excluded.doc, deleted_at = NULL`,
      )
      .run(id, name, now, now, JSON.stringify(doc));
    return this.timeline(id)!;
  }

  /** Hide a timeline (restorable); its clips stay in the Library. */
  deleteTimeline(id: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE timelines SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id).changes > 0;
  }

  restoreTimeline(id: string): boolean {
    return this.db.prepare('UPDATE timelines SET deleted_at = NULL WHERE id = ?').run(id).changes > 0;
  }

  /** The views of one Turnaround (and its sheet), by the id kept in their ui (DECISIONS 114). */
  itemsByTurnaround(id: string): Item[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE json_extract(ui, '$.turnaround') = ? AND deleted_at IS NULL ORDER BY created_at, id").all(id) as any[];
    return rows.map((r) => decode<Item>(r, JSON_ITEM)!);
  }

  /** The pictures of one Sheet maker run (and its sheet), by the id kept in their ui (DECISIONS 118). */
  itemsBySheet(id: string): Item[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE json_extract(ui, '$.sheet') = ? AND deleted_at IS NULL ORDER BY created_at, id").all(id) as any[];
    return rows.map((r) => decode<Item>(r, JSON_ITEM)!);
  }

  /** Merge keys into an item's ui. */
  setItemUi(id: string, patch: Record<string, unknown>): void {
    const it = this.getItem(id);
    if (!it) return;
    this.db.prepare('UPDATE items SET ui = ? WHERE id = ?').run(JSON.stringify({ ...(it.ui ?? {}), ...patch }), id);
  }

  groupItems(groupId: string): Item[] {
    const rows = this.db.prepare('SELECT * FROM items WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(groupId) as any[];
    return rows.map((r) => decode<Item>(r, JSON_ITEM)!);
  }

  insertItem(it: Item): void {
    const cols = Object.keys(it) as (keyof Item)[];
    const vals = cols.map((c) => {
      const v = it[c] as unknown;
      if ((JSON_ITEM as readonly string[]).includes(c)) return v == null ? null : JSON.stringify(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as any;
    });
    this.db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  }

  getItem(id: string): Item | null {
    return decode<Item>(this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as any, JSON_ITEM);
  }

  updateItem(id: string, patch: Partial<Pick<Item, 'favourite' | 'tags' | 'input_name' | 'title' | 'notes'>> & { caption?: string }): void {
    if (patch.title !== undefined) this.db.prepare('UPDATE items SET title = ? WHERE id = ?').run(patch.title || null, id);
    if (patch.notes !== undefined) this.db.prepare('UPDATE items SET notes = ? WHERE id = ?').run(patch.notes || null, id);
    if (patch.caption !== undefined) {
      const it = this.getItem(id);
      if (it) this.db.prepare('UPDATE items SET ui = ? WHERE id = ?').run(JSON.stringify({ ...(it.ui ?? {}), caption: patch.caption }), id);
    }
    if (patch.favourite !== undefined) this.db.prepare('UPDATE items SET favourite = ? WHERE id = ?').run(patch.favourite ? 1 : 0, id);
    if (patch.tags !== undefined) this.db.prepare('UPDATE items SET tags = ? WHERE id = ?').run(JSON.stringify(patch.tags), id);
    if (patch.input_name !== undefined) this.db.prepare('UPDATE items SET input_name = ? WHERE id = ?').run(patch.input_name, id);
  }

  listItems(q: LibraryQuery = {}): { items: Item[]; total: number } {
    // restored parts are never shown: hidden while the clip is made, then put away (Delete forever still removes them)
    const where: string[] = [q.filter === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL', "mode != 'restore_part'"];
    const args: any[] = [];
    switch (q.filter) {
      case 'favourites':
        where.push('favourite = 1');
        break;
      case 'klein':
        where.push("family = 'klein' AND mode NOT LIKE 'edit:%'");
        break;
      case 'qwen':
        where.push("family LIKE 'qwen%' AND mode NOT LIKE 'edit:%'");
        break;
      case 'edits':
        where.push("(mode LIKE 'edit:%' OR mode = 'upscale')");
        break;
      case 'videos':
        where.push("kind = 'video'");
        break;
      case 'composed':
        where.push("mode = 'compose'");
        break;
      case 'generated':
        // Generate's History panel: pictures made on the Generate screen
        where.push("mode = 'generate'");
        break;
    }
    if (q.board === 'none') where.push('board_id IS NULL');
    else if (q.board) {
      where.push('board_id = ?');
      args.push(q.board);
    }
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      if (/^\d+$/.test(term)) {
        where.push('(seed = ? OR prompt LIKE ? OR tags LIKE ? OR title LIKE ? OR notes LIKE ?)');
        args.push(Number(term), `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
      } else {
        where.push('(prompt LIKE ? OR tags LIKE ? OR model LIKE ? OR title LIKE ? OR notes LIKE ?)');
        args.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
      }
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // Whitelist expressions: no query text is interpolated into SQL.
    const order = q.sort === 'oldest' ? 'created_at ASC, id ASC'
      : q.sort === 'name' ? "COALESCE(NULLIF(title, ''), prompt) COLLATE NOCASE ASC, created_at DESC, id DESC"
      : q.sort === 'largest' ? 'COALESCE(width, 0) * COALESCE(height, 0) DESC, created_at DESC, id DESC'
      : `${q.filter === 'deleted' ? 'deleted_at DESC, ' : ''}created_at DESC, id DESC`;
    if (q.stack && q.filter !== 'deleted') {
      // a picture and its versions share COALESCE(root_id, id); show the newest one that matches, with the count
      const grouped = `SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(root_id, id) ORDER BY created_at DESC, id DESC) AS stack_rank,
          COUNT(*) OVER (PARTITION BY COALESCE(root_id, id)) AS stack_count FROM items ${w}`;
      const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM (${grouped}) WHERE stack_rank = 1`).get(...args) as any).n as number;
      const rows = this.db.prepare(`SELECT * FROM (${grouped}) WHERE stack_rank = 1 ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, q.limit ?? 60, q.offset ?? 0) as any[];
      return { items: rows.map(({ stack_rank: _r, ...r }) => decode<Item>(r, JSON_ITEM)!), total };
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM items ${w}`).get(...args) as any).n as number;
    const rows = this.db
      .prepare(`SELECT * FROM items ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, q.limit ?? 60, q.offset ?? 0) as any[];
    return { items: rows.map((r) => decode<Item>(r, JSON_ITEM)!), total };
  }

  /** Versions in the same lineage as an item, oldest first. */
  lineage(rootId: string): Item[] {
    const rows = this.db.prepare('SELECT * FROM items WHERE (id = ? OR root_id = ?) AND deleted_at IS NULL ORDER BY version, created_at').all(rootId, rootId) as any[];
    return rows.map((r) => decode<Item>(r, JSON_ITEM)!);
  }

  // ---- Boards
  boards(): Board[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.name, b.created_at,
           (SELECT COUNT(*) FROM items i WHERE i.board_id = b.id AND i.deleted_at IS NULL) AS count,
           (SELECT i.id FROM items i WHERE i.board_id = b.id AND i.deleted_at IS NULL ORDER BY i.created_at DESC LIMIT 1) AS cover
         FROM boards b ORDER BY b.name COLLATE NOCASE`,
      )
      .all() as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at, count: r.count, cover: r.cover ?? null }));
  }

  board(id: string): Board | null {
    return this.boards().find((b) => b.id === id) ?? null;
  }

  createBoard(name: string, id: string, now = Date.now()): Board {
    this.db.prepare('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
    return this.board(id)!;
  }

  renameBoard(id: string, name: string): boolean {
    return this.db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }

  /** Remove a board. Its items are never deleted: they simply have no board any more. */
  deleteBoard(id: string): boolean {
    this.db.prepare('UPDATE items SET board_id = NULL WHERE board_id = ?').run(id);
    return this.db.prepare('DELETE FROM boards WHERE id = ?').run(id).changes > 0;
  }

  /** Put items in a board (null = no board). Returns the ids moved. */
  moveToBoard(ids: string[], boardId: string | null): string[] {
    const done: string[] = [];
    for (const id of ids) if (this.db.prepare('UPDATE items SET board_id = ? WHERE id = ?').run(boardId, id).changes) done.push(id);
    return done;
  }

  /** Move items to "Recently deleted". Returns the ids that were live. */
  softDelete(ids: string[], now = Date.now()): string[] {
    const done: string[] = [];
    for (const id of ids) if (this.db.prepare('UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id).changes) done.push(id);
    return done;
  }

  restoreItems(ids: string[]): string[] {
    const done: string[] = [];
    for (const id of ids) if (this.db.prepare('UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes) done.push(id);
    return done;
  }

  deletedIds(): string[] {
    return (this.db.prepare('SELECT id FROM items WHERE deleted_at IS NOT NULL').all() as { id: string }[]).map((r) => r.id);
  }

  /** Every live item's main file, for the missing-files check. */
  liveFiles(): { id: string; file: FileRef | null }[] {
    return (this.db.prepare("SELECT id, file FROM items WHERE deleted_at IS NULL AND mode != 'restore_part'").all() as { id: string; file: string | null }[]).map((r) => ({
      id: r.id,
      file: r.file ? (JSON.parse(r.file) as FileRef) : null,
    }));
  }

  /** Remove rows for good (only items already in "Recently deleted"). Returns the removed items. */
  purgeItems(ids: string[]): Item[] {
    const out: Item[] = [];
    for (const id of ids) {
      const it = this.getItem(id);
      if (!it?.deleted_at) continue;
      this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
      out.push(it);
    }
    return out;
  }

  /** True when a remaining item still points at this output file (a shared file is never recycled). */
  fileInUse(f: FileRef): boolean {
    const like = `%${JSON.stringify(f.filename).slice(1, -1)}%`;
    const rows = this.db.prepare('SELECT file, poster, last_frame FROM items WHERE file LIKE ? OR poster LIKE ? OR last_frame LIKE ?').all(like, like, like) as Record<string, string | null>[];
    return rows.some((r) =>
      [r.file, r.poster, r.last_frame].some((c) => {
        if (!c) return false;
        const g = JSON.parse(c) as FileRef;
        return g.filename === f.filename && (g.subfolder ?? '') === (f.subfolder ?? '') && (g.type ?? 'output') === (f.type ?? 'output');
      }),
    );
  }

  maxVersion(rootId: string): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM items WHERE id = ? OR root_id = ?').get(rootId, rootId) as any;
    return (r?.v as number) ?? 0;
  }

  insertJob(j: Job): void {
    const cols = Object.keys(j) as (keyof Job)[];
    const vals = cols.map((c) => ((JSON_JOB as readonly string[]).includes(c) ? JSON.stringify(j[c]) : (j[c] as any)));
    this.db.prepare(`INSERT INTO jobs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  }

  updateJob(id: string, patch: Partial<Job>): void {
    const cols = Object.keys(patch) as (keyof Job)[];
    if (!cols.length) return;
    const vals = cols.map((c) => ((JSON_JOB as readonly string[]).includes(c) ? JSON.stringify(patch[c]) : (patch[c] as any)));
    this.db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  }

  getJob(id: string): Job | null {
    return decode<Job>(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any, JSON_JOB);
  }

  jobByPrompt(promptId: string): Job | null {
    return decode<Job>(this.db.prepare('SELECT * FROM jobs WHERE prompt_id = ?').get(promptId) as any, JSON_JOB);
  }

  activeJobs(): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at").all() as any[];
    return rows.map((r) => decode<Job>(r, JSON_JOB)!);
  }

  /**
   * The Video "Takes" panel as a view of the Library: running and failed renders, plus finished ones whose video is
   * still in the Library (deleting the video there removes the take; restoring brings it back). Dismissed failures
   * are left out.
   */
  liveTakes(kind: string, limit = 30): Job[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE kind = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT 400').all(kind) as any[];
    const live = (id: string) => {
      const r = this.db.prepare('SELECT deleted_at FROM items WHERE id = ?').get(id) as { deleted_at: number | null } | undefined;
      return !!r && r.deleted_at == null;
    };
    return rows
      .map((r) => decode<Job>(r, JSON_JOB)!)
      .filter((j) => j.status !== 'done' || j.result_ids.some(live))
      .slice(0, limit);
  }

  /** Hide finished-without-a-file renders (error, cancelled, lost) from the Takes panel. Returns the ids hidden. */
  dismissJobs(ids: string[]): string[] {
    const done: string[] = [];
    for (const id of ids) if (this.db.prepare("UPDATE jobs SET dismissed = 1 WHERE id = ? AND status IN ('error','cancelled','lost')").run(id).changes) done.push(id);
    return done;
  }

  failedJobIds(kind: string): string[] {
    return (this.db.prepare("SELECT id FROM jobs WHERE kind = ? AND dismissed = 0 AND status IN ('error','cancelled','lost')").all(kind) as { id: string }[]).map((r) => r.id);
  }

  recentJobs(kind?: string, limit = 50): Job[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, limit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit)) as any[];
    return rows.map((r) => decode<Job>(r, JSON_JOB)!);
  }
}
