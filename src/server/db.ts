import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  filter?: 'all' | 'favourites' | 'klein' | 'qwen' | 'edits' | 'videos';
  q?: string;
  limit?: number;
  offset?: number;
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
  }

  groupItems(groupId: string): Item[] {
    const rows = this.db.prepare('SELECT * FROM items WHERE group_id = ? ORDER BY created_at, id').all(groupId) as any[];
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

  updateItem(id: string, patch: Partial<Pick<Item, 'favourite' | 'tags' | 'input_name'>> & { caption?: string }): void {
    if (patch.caption !== undefined) {
      const it = this.getItem(id);
      if (it) this.db.prepare('UPDATE items SET ui = ? WHERE id = ?').run(JSON.stringify({ ...(it.ui ?? {}), caption: patch.caption }), id);
    }
    if (patch.favourite !== undefined) this.db.prepare('UPDATE items SET favourite = ? WHERE id = ?').run(patch.favourite ? 1 : 0, id);
    if (patch.tags !== undefined) this.db.prepare('UPDATE items SET tags = ? WHERE id = ?').run(JSON.stringify(patch.tags), id);
    if (patch.input_name !== undefined) this.db.prepare('UPDATE items SET input_name = ? WHERE id = ?').run(patch.input_name, id);
  }

  listItems(q: LibraryQuery = {}): { items: Item[]; total: number } {
    const where: string[] = [];
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
    }
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      if (/^\d+$/.test(term)) {
        where.push('(seed = ? OR prompt LIKE ? OR tags LIKE ?)');
        args.push(Number(term), `%${term}%`, `%${term}%`);
      } else {
        where.push('(prompt LIKE ? OR tags LIKE ? OR model LIKE ?)');
        args.push(`%${term}%`, `%${term}%`, `%${term}%`);
      }
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM items ${w}`).get(...args) as any).n as number;
    const rows = this.db
      .prepare(`SELECT * FROM items ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, q.limit ?? 60, q.offset ?? 0) as any[];
    return { items: rows.map((r) => decode<Item>(r, JSON_ITEM)!), total };
  }

  /** Versions in the same lineage as an item, oldest first. */
  lineage(rootId: string): Item[] {
    const rows = this.db.prepare('SELECT * FROM items WHERE id = ? OR root_id = ? ORDER BY version, created_at').all(rootId, rootId) as any[];
    return rows.map((r) => decode<Item>(r, JSON_ITEM)!);
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

  recentJobs(kind?: string, limit = 50): Job[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, limit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit)) as any[];
    return rows.map((r) => decode<Job>(r, JSON_JOB)!);
  }
}
