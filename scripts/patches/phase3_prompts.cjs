const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, b); };

const pj = JSON.parse(fs.readFileSync('presets/prompts.json', 'utf8'));
pj.klein.enhance_subtle = '{caption} Crisp focus, fine natural detail and clean texture, with the same composition, people, text and colours.';
pj.klein.enhance_strong = '{caption} Re-rendered in high quality with rich realistic detail, accurate lighting and crisp focus, keeping the same composition, people and text.';
pj.klein.enhance_default_caption = 'A high-quality version of this picture.';
pj.qwen.enhance_subtle = 'Enhance this image: sharpen fine detail and clarity, and clean up noise and compression artifacts. Keep the composition, identity, all text and colours unchanged.{caption}';
pj.qwen.enhance_strong = 'Re-render this image at higher quality with rich, realistic detail and texture and accurate lighting. Keep the composition, the identity of people and all text unchanged.{caption}';
fs.writeFileSync('presets/prompts.json', JSON.stringify(pj, null, 2) + '\n');

let p = fs.readFileSync('src/shared/prompts.ts', 'utf8');
p = rep(p, `export type ImageMode = 'generate' | 'instruct' | 'inpaint' | 'outpaint';`, `export type ImageMode = 'generate' | 'instruct' | 'inpaint' | 'outpaint' | 'enhance';`);
p = rep(p, `  /** Qwen only: native RGBA output wording (model card). */
  transparent?: string;
}`, `  /** Qwen only: native RGBA output wording (model card). */
  transparent?: string;
  enhance_subtle?: string;
  enhance_strong?: string;
  enhance_default_caption?: string;
}`);
p = rep(p, `  /** Generate only, Qwen only: ask for a transparent background (real alpha). */
  transparent?: boolean;
}`, `  /** Generate only, Qwen only: ask for a transparent background (real alpha). */
  transparent?: boolean;
  /** Enhance only. */
  strength?: 'subtle' | 'strong';
}`);
p = rep(p, `    case 'outpaint': {`, `    case 'enhance': {
      const tplText = a.strength === 'strong' ? tpl.enhance_strong : tpl.enhance_subtle;
      if (!tplText) throw new Error(\`No enhance template for \${a.model}\`);
      if (a.model === 'klein') {
        const cap = sentence(a.caption ?? '') || tpl.enhance_default_caption || '';
        return fill(tplText, { caption: cap });
      }
      const caption = a.caption && tpl.caption ? sub(tpl.caption, { text: sentence(a.caption) }) : '';
      return fill(tplText, { caption });
    }
    case 'outpaint': {`);
fs.writeFileSync('src/shared/prompts.ts', p);

let t = fs.readFileSync('tests/prompts.test.ts', 'utf8');
t = rep(t, `  const modes: ImageMode[] = ['generate', 'instruct', 'inpaint', 'outpaint'];`, `  const modes: ImageMode[] = ['generate', 'instruct', 'inpaint', 'outpaint', 'enhance'];`);
t = t.replace(/const KLEIN_ONLY = \[([^\]]*)\];/, (m0, inner) => `const KLEIN_ONLY = [${inner}, /Crisp focus, fine natural detail/, /Re-rendered in high quality/];`);
t += `
describe('enhance', () => {
  it('Klein describes the picture then asks for detail', () => {
    expect(composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', caption: 'A fisherman on a pier', strength: 'subtle' })).toBe(
      'A fisherman on a pier. Crisp focus, fine natural detail and clean texture, with the same composition, people, text and colours.',
    );
    expect(composeImagePrompt(T, { model: 'klein', mode: 'enhance', text: '', strength: 'strong' })).toMatch(/^A high-quality version of this picture\\. Re-rendered/);
  });
  it('Qwen gets an instruction with explicit preservation and the caption', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'enhance', text: '', caption: 'a red car', strength: 'subtle' })).toBe(
      'Enhance this image: sharpen fine detail and clarity, and clean up noise and compression artifacts. Keep the composition, identity, all text and colours unchanged. The original caption is: a red car.',
    );
  });
});
`;
fs.writeFileSync('tests/prompts.test.ts', t);

// server chain: enhance -> upscale
let j = fs.readFileSync('src/server/jobs.ts', 'utf8');
j = rep(j, `    const chain = job.meta.chain as { kind?: string; firstItemId?: string } | undefined;
    if (chain?.kind !== 'join' || !chain.firstItemId || !newIds[0]) return;`, `    const chain = job.meta.chain as { kind?: string; firstItemId?: string } | undefined;
    if (chain?.kind === 'upscale' && newIds[0]) {
      const it = this.store.getItem(newIds[0]);
      if (!it) return;
      try {
        await this.submit({
          workflow: 'upscale',
          params: { image_1: await this.asInput(it), scale: 2, seed: Math.floor(Math.random() * 2 ** 31) },
          meta: { mode: 'upscale', model: 'SeedVR2 7B', prompt: it.prompt, parentId: it.id, ui: it.ui },
        });
      } catch (e) {
        this.broadcast({ type: 'toast', kind: 'error', text: 'Could not start the upscale: ' + friendlyError((e as Error).message) });
      }
      return;
    }
    if (chain?.kind !== 'join' || !chain.firstItemId || !newIds[0]) return;`);
fs.writeFileSync('src/server/jobs.ts', j);
console.log('phase3 prompts + chain ok');
