/**
 * Compatibility check after a ComfyUI update: every workflow the manifest uses must only contain node classes,
 * input names and dropdown values that the running ComfyUI accepts. Run: npx tsx scripts/check-nodes.ts [comfyUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8188';
const info = (await (await fetch(`${url}/object_info`)).json()) as Record<string, { input: { required?: Record<string, any>; optional?: Record<string, any> } }>;
const manifest = JSON.parse(fs.readFileSync('workflows/manifest.json', 'utf8'));
const W = manifest.workflows ?? manifest;
const files = [...new Set(Object.values(W).map((w: any) => w.file as string))];
let problems = 0;
for (const f of files) {
  const g = JSON.parse(fs.readFileSync(path.join('workflows', f), 'utf8')) as Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;
  for (const [id, n] of Object.entries(g)) {
    const def = info[n.class_type];
    const where = `${f} #${id} ${n.class_type}${n._meta?.title ? ` [${n._meta.title}]` : ''}`;
    if (!def) {
      console.log(`MISSING NODE  ${where}`);
      problems++;
      continue;
    }
    const spec: Record<string, any> = { ...(def.input.required ?? {}), ...(def.input.optional ?? {}) };
    for (const [k, v] of Object.entries(n.inputs)) {
      const base = k.split('.')[0]; // dynamic combo children like "resize_type.multiplier", autogrow "images.image_1"
      const parent = spec[base];
      if (Array.isArray(parent) && parent[0] === 'COMFY_AUTOGROW_V3' && k.includes('.') && !parent[1]?.template?.names?.includes(k.split('.')[1])) {
        console.log(`UNKNOWN INPUT ${where}: ${k}`);
        problems++;
        continue;
      }
      if (!(k in spec) && !(base in spec)) {
        console.log(`UNKNOWN INPUT ${where}: ${k}`);
        problems++;
        continue;
      }
      const s = spec[k];
      if (!s || Array.isArray(v)) continue; // linked input or dynamic child
      const options = Array.isArray(s[0]) ? s[0] : s[0] === 'COMBO' ? s[1]?.options : null;
      // model files and placeholders are swapped in at run time by Darkroom; only check fixed choices
      if (options && typeof v === 'string' && !options.includes(v) && !/placeholder|\.safetensors$|\.pth$|\.gguf$/i.test(v)) {
        console.log(`BAD VALUE     ${where}: ${k}=${JSON.stringify(v)} (allowed: ${options.slice(0, 8).join(', ')}${options.length > 8 ? ', …' : ''})`);
        problems++;
      }
    }
    for (const [k, s] of Object.entries(def.input.required ?? {})) {
      const autogrow = Array.isArray(s) && s[0] === 'COMFY_AUTOGROW_V3';
      const filled = k in n.inputs || Object.keys(n.inputs).some((x) => x.startsWith(`${k}.`));
      // an autogrow input ("images" -> images.image_1..16) may be left empty when its template says min 0
      if (autogrow && (filled || (s[1]?.template?.min ?? 0) === 0)) continue;
      if (!filled && !(Array.isArray(s) && s[1]?.default !== undefined) && !(Array.isArray(s) && s[1]?.defaultInput)) {
        console.log(`MISSING INPUT ${where}: ${k}`);
        problems++;
      }
    }
  }
}
// model files referenced by the graphs must be installed
const models = new Set<string>();
for (const f of files) for (const n of Object.values(JSON.parse(fs.readFileSync(path.join('workflows', f), 'utf8'))) as any[]) for (const v of Object.values(n.inputs)) if (typeof v === 'string' && /\.(safetensors|pth|gguf|ckpt)$/i.test(v)) models.add(v);
const known = new Set<string>();
for (const d of Object.values(info)) for (const s of Object.values({ ...(d.input.required ?? {}), ...(d.input.optional ?? {}) }) as any[]) {
  const o = Array.isArray(s?.[0]) ? s[0] : s?.[0] === 'COMBO' ? s[1]?.options : null;
  if (o) for (const x of o) if (typeof x === 'string') known.add(x);
}
for (const m of models) if (!known.has(m)) {
  console.log(`MODEL MISSING ${m}`);
  problems++;
}
console.log(`${files.length} workflows, ${models.size} model files checked: ${problems ? `${problems} problem(s)` : 'all compatible'}`);
process.exit(problems ? 1 : 0);
