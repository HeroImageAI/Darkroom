/**
 * Edit canvas projects on disk (DECISIONS 122): data/projects/<item id>/project.json plus layers/<layer id>.png and
 * masks/<layer id>.png. Only adds and overwrites its own files; a layer taken off the stack keeps its PNG (it can come
 * back with Undo after a reload, and nothing is ever deleted here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { LAYER_ID, parseDoc, type DocJson } from '../shared/doc.js';

const ITEM_ID = /^[0-9a-f-]{8,40}$/i;
export type LayerPart = 'layers' | 'masks';

export class ProjectStore {
  constructor(private root: string) {}

  private dir(itemId: string): string {
    if (!ITEM_ID.test(itemId)) throw new Error('Bad item id');
    return path.join(this.root, itemId);
  }

  get(itemId: string): DocJson | null {
    try {
      return parseDoc(JSON.parse(fs.readFileSync(path.join(this.dir(itemId), 'project.json'), 'utf8')), itemId);
    } catch {
      return null;
    }
  }

  has(itemId: string): boolean {
    return ITEM_ID.test(itemId) && fs.existsSync(path.join(this.dir(itemId), 'project.json'));
  }

  save(itemId: string, raw: unknown): DocJson | null {
    const doc = parseDoc(raw, itemId);
    if (!doc) return null;
    const d = this.dir(itemId);
    fs.mkdirSync(d, { recursive: true });
    const tmp = path.join(d, `project.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
    fs.renameSync(tmp, path.join(d, 'project.json'));
    return doc;
  }

  partPath(itemId: string, part: LayerPart, layerId: string): string {
    if (!LAYER_ID.test(layerId) || (part !== 'layers' && part !== 'masks')) throw new Error('Bad layer');
    return path.join(this.dir(itemId), part, `${layerId}.png`);
  }

  putPart(itemId: string, part: LayerPart, layerId: string, png: Buffer): void {
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
    const p = this.partPath(itemId, part, layerId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, p);
  }
}
