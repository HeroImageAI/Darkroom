export {};
// Queue one example of each workflow through Darkroom's API so every workflow has a Library item.
const B = 'http://127.0.0.1:5178';
const j = async (u: string, body?: unknown) => {
  const r = await fetch(B + u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const t = await r.json();
  if (!r.ok) throw new Error(u + ' ' + JSON.stringify(t));
  return t;
};
const items = (await j('/api/items?limit=100')).items as any[];
const img = items.find((i) => i.mode === 'generate' && i.workflow === 'klein_t2i');
const vid = items.find((i) => i.kind === 'video' && i.mode === 'video');
const inImg = (await j(`/api/items/${img.id}/as-input`, {})).name;
const inVid = (await j(`/api/items/${vid.id}/as-input`, {})).name;
const jobs = [
  { workflow: 'klein_ref', params: { prompt: 'The same pocket watch from image 1 displayed on a velvet cushion in an antique shop window, soft daylight', image_1: inImg, seed: 11, width: 1024, height: 1024 }, meta: { mode: 'generate', model: 'Klein 9B + refs', prompt: 'Pocket watch on a velvet cushion (reference)' } },
  { workflow: 'outpaint', params: { image_1: inImg, prompt: 'weathered driftwood on a pebble beach at golden hour', pad_left: 128, pad_right: 128, pad_top: 128, pad_bottom: 128, seed: 12 }, meta: { mode: 'edit:outpaint', model: 'Klein 9B outpaint', prompt: 'Zoom out: driftwood on a pebble beach', parentId: img.id } },
  { workflow: 'upscale', params: { image_1: inImg, scale: 2, seed: 13 }, meta: { mode: 'upscale', model: 'SeedVR2 7B', prompt: img.prompt, parentId: img.id } },
  { workflow: 'crop', params: { image_1: inImg, width: 600, height: 600, x: 400, y: 150 }, meta: { mode: 'edit:crop', model: 'Crop', prompt: img.prompt, parentId: img.id } },
  { workflow: 'video_frame', params: { video: inVid, frame: 24 }, meta: { mode: 'frame', model: vid.model, prompt: vid.prompt, parentId: vid.id } },
  { workflow: 'import', params: { image_1: inImg }, meta: { mode: 'import', model: 'Imported', prompt: 'imported-example.png' } },
];
for (const b of jobs) console.log(b.workflow, (await j('/api/jobs', b)).id);
