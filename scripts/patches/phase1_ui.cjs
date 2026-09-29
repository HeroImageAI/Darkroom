// Phase 1 UI wiring: prompt composer, Qwen quality + transparency, fixed Klein guidance, reference tokens.
const fs = require('fs');
const rep = (s, a, b) => {
  if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80));
  return s.replace(a, b);
};

// prompts.json: transparent template
const pj = JSON.parse(fs.readFileSync('presets/prompts.json', 'utf8'));
pj.qwen.transparent = 'This is an RGBA image with transparency. {prompt} The image has alpha channel and the background is transparent.';
fs.writeFileSync('presets/prompts.json', JSON.stringify(pj, null, 2) + '\n');

// prompts.ts
let p = fs.readFileSync('src/shared/prompts.ts', 'utf8');
p = rep(p, `  caption?: string;
}`, `  caption?: string;
  /** Qwen only: native RGBA output wording (model card). */
  transparent?: string;
}`);
p = rep(p, `  caption?: string | null;
}`, `  caption?: string | null;
  /** Generate only, Qwen only: ask for a transparent background (real alpha). */
  transparent?: boolean;
}`);
p = rep(p, `    case 'generate':
      return fill(tpl.generate, { prompt: sentence(text), style: a.style ? a.style[a.model] : '' });`, `    case 'generate': {
      const body = fill(tpl.generate, { prompt: sentence(text), style: a.style ? a.style[a.model] : '' });
      return a.transparent && tpl.transparent ? fill(tpl.transparent, { prompt: sentence(body) }) : body;
    }`);
fs.writeFileSync('src/shared/prompts.ts', p);

// server: expose prompts
let i = fs.readFileSync('src/server/index.ts', 'utf8');
i = rep(i, `  camera: readJson(path.join(cfg.paths.presets, 'camera.json')),`, `  camera: readJson(path.join(cfg.paths.presets, 'camera.json')),
  prompts: readJson(path.join(cfg.paths.presets, 'prompts.json')),`);
fs.writeFileSync('src/server/index.ts', i);

// api types
let a = fs.readFileSync('src/web/api.ts', 'utf8');
a = rep(a, `export interface Style {
  id: string;
  label: string;
  suffix: string;
}
export interface Camera {
  id: string;
  label: string;
  phrase: string;
  exclusive?: boolean;
}`, `export type Style = StylePreset;
export type Camera = CameraPreset;`);
a = rep(a, `  camera: { camera: Camera[] };`, `  camera: { camera: Camera[] };
  prompts: PromptTemplates;`);
a = rep(a, `import type { Manifest } from '../shared/manifest';`, `import type { Manifest } from '../shared/manifest';
import type { CameraPreset, PromptTemplates, StylePreset } from '../shared/prompts';`);
fs.writeFileSync('src/web/api.ts', a);

// manifest type
let mt = fs.readFileSync('src/shared/manifest.ts', 'utf8');
mt = rep(mt, `  ranges: { steps: [number, number]; cfg: [number, number] };
}`, `  ranges: { steps: [number, number]; cfg: [number, number] };
  /** Optional quality presets (Qwen: Standard / High). */
  quality?: Record<string, { label: string; note: string; steps: number; aspects: Record<Aspect, [number, number]> }>;
}`);
fs.writeFileSync('src/shared/manifest.ts', mt);

// Generate.tsx
let g = fs.readFileSync('src/web/screens/Generate.tsx', 'utf8');
g = rep(g, `  cfg: number;
  refs: Ref[];
}`, `  cfg: number;
  refs: Ref[];
  /** Qwen: 'standard' | 'high' */
  quality?: string;
  /** Qwen: transparent background (real alpha) */
  transparent?: boolean;
}`);
g = rep(g, `  const [w, h] = model ? model.aspects[s.aspect] : [1024, 1024];`, `  const aspectsFor = (mm: typeof model, quality?: string) => mm?.quality?.[quality ?? 'standard']?.aspects ?? mm?.aspects;
  const [w, h] = model ? aspectsFor(model, s.quality)![s.aspect] : [1024, 1024];
  const T = boot?.prompts;`);
g = rep(g, "    const fullPrompt = style?.suffix ? `${cur.prompt.trim()}, ${style.suffix}` : cur.prompt.trim();\n    const mm = m.models[cur.model];\n    const wf = cur.refs.length ? mm.ref : mm.t2i;\n    const [ww, hh] = mm.aspects[cur.aspect];",
`    const mm = m.models[cur.model];
    const fullPrompt = composeImagePrompt(boot!.prompts, {
      model: cur.model as ImageModelKey,
      mode: 'generate',
      text: cur.prompt,
      style: style ?? null,
      transparent: cur.model === 'qwen' && !!cur.transparent,
    });
    const wf = cur.refs.length ? mm.ref : mm.t2i;
    const q = mm.quality?.[cur.quality ?? 'standard'];
    const [ww, hh] = aspectsFor(mm, cur.quality)![cur.aspect];`);
g = rep(g, `      steps: cur.steps,
      cfg: cur.cfg,`, `      steps: q ? q.steps : cur.steps,
      cfg: mm.ranges.cfg[0] === mm.ranges.cfg[1] ? mm.ranges.cfg[0] : cur.cfg,`);
g = rep(g, `            <Pills label="Style preset" options={styles.map((x) => ({ value: x.id, label: x.label, title: x.suffix }))} value={s.style} onChange={(style) => update({ style })} />
          </div>`, `            <Pills
              label="Style preset"
              options={styles.map((x) => ({ value: x.id, label: x.label, title: x[s.model as ImageModelKey] || 'No style added' }))}
              value={s.style}
              onChange={(style) => update({ style })}
            />
          </div>

          {model.quality && (
            <div>
              <p className="section-label">
                Quality <span className="mono">{model.quality[s.quality ?? 'standard']?.note}</span>
              </p>
              <Segmented
                label="Quality"
                options={Object.entries(model.quality).map(([k, v]) => ({ value: k, label: v.label, title: v.note }))}
                value={s.quality ?? 'standard'}
                onChange={(quality) => update({ quality })}
              />
              <label className="check" title="Qwen-Image 2.1 can paint a real transparent background (saved as PNG with alpha)">
                <input type="checkbox" checked={!!s.transparent} onChange={(e) => update({ transparent: e.target.checked })} />
                Transparent background
              </label>
            </div>
          )}`);
g = rep(g, `            onScreen={async () => {`, `            hint={T ? T[s.model as ImageModelKey]?.ref_hint : undefined}
            token={(n) => (T ? refToken(T, s.model as ImageModelKey, n) : '')}
            onInsert={(tok) => {
              update({ prompt: (s.prompt.trim() ? s.prompt.trimEnd() + ' ' : '') + tok + ' ' });
              promptRef.current?.focus();
            }}
            onScreen={async () => {`);
g = rep(g, `              <label className="field">
                <span>
                  Guidance <b className="mono">{s.cfg.toFixed(1)}</b>
                </span>
                <input type="range" min={model.ranges.cfg[0]} max={model.ranges.cfg[1]} step={0.5} value={s.cfg} onChange={(e) => update({ cfg: Number(e.target.value) })} />
              </label>`, `              {model.ranges.cfg[0] !== model.ranges.cfg[1] ? (
                <label className="field">
                  <span>
                    Guidance <b className="mono">{s.cfg.toFixed(1)}</b>
                  </span>
                  <input type="range" min={model.ranges.cfg[0]} max={model.ranges.cfg[1]} step={0.5} value={s.cfg} onChange={(e) => update({ cfg: Number(e.target.value) })} />
                </label>
              ) : (
                <div className="field" title="This model is distilled to run at guidance 1; higher values only make results worse.">
                  <span>Guidance</span>
                  <span className="mono" style={{ color: 'var(--text)' }}>
                    1.0 (fixed)
                  </span>
                </div>
              )}`);
g = rep(g, `import { ASPECTS, type Aspect } from '../../shared/manifest';`, `import { ASPECTS, type Aspect } from '../../shared/manifest';
import { composeImagePrompt, refToken, type ImageModelKey } from '../../shared/prompts';`);
fs.writeFileSync('src/web/screens/Generate.tsx', g);
console.log('phase1 ui patched');
