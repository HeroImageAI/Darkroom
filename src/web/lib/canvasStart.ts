/**
 * Starting a scene in Edit (DECISIONS 125): a blank canvas, or an old Compose composition turned into an Edit layer
 * project. Compose now lives in Edit; its compositions stay on disk untouched — "Open in Edit" makes a copy.
 */
import { api, type Item } from '../api';
import { go } from '../router';
import { getState, toast } from '../store';
import type { Composition } from '../../shared/compose';
import type { DocJson, DocLayerMeta } from '../../shared/doc';
import { drawLayer, makeCanvas } from './composeCanvas';

/** Open a picture in Edit with layers on (and, for a fresh canvas, an empty layer to paint on). */
export function openWithLayers(itemId: string) {
  sessionStorage.setItem('dr.edit.startLayers', itemId);
  sessionStorage.setItem('dr.edit.panel', JSON.stringify('layers'));
  go('edit', itemId);
}

/** A blank picture in the Library, opened in Edit with layers on. */
export async function createCanvas(w: number, h: number, background: string, name?: string): Promise<Item | null> {
  try {
    const it = await api.post<Item>('/api/canvas', { width: w, height: h, background, name, boardId: getState().board });
    openWithLayers(it.id);
    return it;
  } catch (e) {
    toast((e as Error).message, 'error');
    return null;
  }
}

const rid = () => Math.random().toString(36).slice(2, 10);

const png = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw a layer'))), 'image/png'));

/**
 * A composition as an Edit project: a paper canvas of its size, then each of its pictures and paint as its own layer,
 * in the same places (flips and hidden layers kept). Returns the new picture's id.
 */
export async function compositionToEdit(comp: Composition): Promise<string> {
  const doc = comp.doc;
  const base = await api.post<Item>('/api/canvas', { width: doc.width, height: doc.height, background: 'paper', name: comp.name, boardId: getState().board });
  const layers: DocLayerMeta[] = [{ id: rid(), name: 'Paper', kind: 'picture', source: base.id, painted: false, visible: true, locked: false, alphaLock: false, opacity: 1, blend: 'normal', mask: false, maskOn: true, rev: 1 }];
  let rev = 2;
  for (const l of doc.layers) {
    const c = makeCanvas(doc.width, doc.height);
    await drawLayer(c.getContext('2d')!, l, doc, () => undefined);
    const id = rid();
    const r = await fetch(`/api/items/${base.id}/project/layers/${id}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: await png(c) });
    if (!r.ok) throw new Error('Could not save a layer of the composition');
    layers.push({ id, name: l.name || (l.kind === 'paint' ? 'Paint' : 'Picture'), kind: l.kind === 'paint' ? 'paint' : 'picture', painted: true, visible: !l.hidden, locked: false, alphaLock: false, opacity: 1, blend: 'normal', mask: false, maskOn: true, rev: rev++ });
  }
  const project: DocJson = { v: 1, itemId: base.id, width: doc.width, height: doc.height, layers, active: layers[layers.length - 1].id, updatedAt: Date.now() };
  const r = await fetch(`/api/items/${base.id}/project`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
  if (!r.ok) throw new Error('Could not save the layers');
  // the scene description travels along as the Compose prompt
  if (doc.description.trim()) sessionStorage.setItem('dr.edit.prompt', doc.description.trim());
  sessionStorage.setItem('dr.edit.mode', 'compose');
  // the render the composition was set to (or Auto)
  sessionStorage.setItem('dr.edit.composeMode', JSON.stringify(doc.mode));
  return base.id;
}
