const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 70)); return s.replace(a, b); };

// ---- Edit: model-specific templates + caption from lineage (never from an instruction)
let e = fs.readFileSync('src/web/screens/Edit.tsx', 'utf8');
e = rep(e, `    if (mode === 'instruct') {
      if (!prompt.trim()) return toast('Type an instruction first, e.g. “make it night time”.', 'info');
      const params: Record<string, string | number> = { prompt: prompt.trim() };
      if (ref) params.image_2 = ref.name;
      if (onlyMasked && !maskEmpty) params.mask = await uploadMask();`, `    const T = boot!.prompts;
    const em = editModel as ImageModelKey;
    const caption = captionFromLineage(lineage as unknown as CaptionSource[], item.id);
    if (mode === 'instruct') {
      if (!prompt.trim()) return toast('Type an instruction first, e.g. “make it night time”.', 'info');
      const masked = onlyMasked && !maskEmpty;
      const params: Record<string, string | number> = { prompt: composeImagePrompt(T, { model: em, mode: 'instruct', text: prompt, masked }) };
      if (ref) params.image_2 = ref.name;
      if (masked) params.mask = await uploadMask();`);
e = rep(e, `      const params: Record<string, string | number> = { prompt: prompt.trim(), mask: await uploadMask(), feather: Math.round(feather) };`,
`      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'inpaint', text: prompt, caption }),
        mask: await uploadMask(),
        feather: Math.round(feather),
      };`);
e = rep(e, `      const text = prompt.trim() || item.prompt || 'continue the scene naturally';
      const params: Record<string, string | number> = { prompt: text, pad_left: pad.left, pad_top: pad.top, pad_right: pad.right, pad_bottom: pad.bottom };
      if (ref) params.image_2 = ref.name;
      return submit(wfFor('outpaint'), params, 'edit:outpaint', \`\${modelLabel} outpaint\`, text);`,
`      const text = prompt.trim();
      const params: Record<string, string | number> = {
        prompt: composeImagePrompt(T, { model: em, mode: 'outpaint', text, caption }),
        pad_left: pad.left,
        pad_top: pad.top,
        pad_right: pad.right,
        pad_bottom: pad.bottom,
      };
      if (ref) params.image_2 = ref.name;
      return submit(wfFor('outpaint'), params, 'edit:outpaint', \`\${modelLabel} outpaint\`, text || 'Outpaint');`);
e = rep(e, `import { go } from '../router';`, `import { go } from '../router';
import { captionFromLineage, composeImagePrompt, type CaptionSource, type ImageModelKey } from '../../shared/prompts';`);
fs.writeFileSync('src/web/screens/Edit.tsx', e);

// ---- Video: per-model motion composition, hint, word count
let v = fs.readFileSync('src/web/screens/Video.tsx', 'utf8');
v = rep(v, `  const motionPrompt = (motion: string, camera: string[]) => {
    const phrases = camera.map((c) => cams.find((x) => x.id === c)?.phrase).filter(Boolean);
    return [motion.trim(), ...phrases].filter(Boolean).join(' ');
  };`, `  const T = boot!.prompts;
  const vKey = (s.model === 'ltx' ? 'ltx' : 'wan') as VideoModelKey;
  const words = wordCount(s.motion);`);
v = rep(v, `    const prompt = motionPrompt(cur.motion, cur.camera) || 'Natural, subtle motion.';`,
`    const prompt = composeMotionPrompt(T, cams, { model: (cur.model === 'ltx' ? 'ltx' : 'wan') as VideoModelKey, motion: cur.motion, camera: cur.camera });`);
v = rep(v, `              placeholder="e.g. She turns her head towards the window and smiles; curtains sway in the breeze."
            />`, `              placeholder="e.g. She turns her head towards the window and smiles; curtains sway in the breeze."
            />
            <p className={\`note \${words > T[vKey].max_words ? 'warn' : ''}\`} style={{ margin: '4px 0 0' }}>
              {T[vKey].hint} <span className="mono">{words} words</span>
            </p>`);
v = rep(v, `title={c.phrase} onClick={() => toggleCam(c.id)}>`, `title={c[vKey]} onClick={() => toggleCam(c.id)}>`);
v = rep(v, `import { planVideo, type VideoQuality } from '../../shared/manifest';`, `import { planVideo, type VideoQuality } from '../../shared/manifest';
import { composeMotionPrompt, wordCount, type VideoModelKey } from '../../shared/prompts';`);
fs.writeFileSync('src/web/screens/Video.tsx', v);
console.log('edit + video patched');
