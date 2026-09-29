const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 70)); return s.replace(a, b); };
const pj = JSON.parse(fs.readFileSync('presets/prompts.json', 'utf8'));
pj.qwen.inpaint = '{fill}.';
pj.qwen.inpaint_remove = 'Perform inpainting on this image. Fill the marked area with {fill}.{caption}';
fs.writeFileSync('presets/prompts.json', JSON.stringify(pj, null, 2) + '\n');
const st = JSON.parse(fs.readFileSync('presets/styles.json', 'utf8'));
const prod = st.styles.find((s) => s.id === 'product');
prod.klein = 'Styled as a clean commercial product photograph with soft, even studio light, a seamless light backdrop, crisp controlled reflections and a centred composition.';
prod.qwen = 'Style: clean commercial product photography - seamless light-grey backdrop, soft even studio light, crisp controlled reflections, centred composition, catalogue sharpness. Ultra HD, 4K.';
fs.writeFileSync('presets/styles.json', JSON.stringify(st, null, 2) + '\n');
let p = fs.readFileSync('src/shared/prompts.ts', 'utf8');
p = rep(p, `  enhance_subtle?: string;`, `  /** Qwen: official restoration wording, used when removing something (background plate). */
  inpaint_remove?: string;
  enhance_subtle?: string;`);
p = rep(p, `  /** Enhance only. */
  strength?: 'subtle' | 'strong';`, `  /** Enhance only. */
  strength?: 'subtle' | 'strong';
  /** Inpaint only: the fill removes something (background plate) rather than adding content. */
  remove?: boolean;`);
p = rep(p, `      return fill(tpl.inpaint, { fill: fragment(text), caption });`, `      return fill(a.remove && tpl.inpaint_remove ? tpl.inpaint_remove : tpl.inpaint, { fill: a.remove ? fragment(text) : sentence(text).replace(/\.$/, ''), caption });`);
fs.writeFileSync('src/shared/prompts.ts', p);
let e = fs.readFileSync('src/web/screens/Edit.tsx', 'utf8');
e = e.split(`mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: plateCaption })`).join(`mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: plateCaption, remove: true })`);
e = e.split(`mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: caption ?? null })`).join(`mode: 'inpaint', text: 'the background, continuing the surrounding scene naturally with nothing in the way', caption: caption ?? null, remove: true })`);
fs.writeFileSync('src/web/screens/Edit.tsx', e);
let t = fs.readFileSync('tests/prompts.test.ts', 'utf8');
t = rep(t, `  it('qwen inpaint uses the official template with the caption', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'A stack of old books', caption: 'a fisherman on a pier' })).toBe(
      'Perform inpainting on this image. Fill the marked area with a stack of old books. The original caption is: a fisherman on a pier.',
    );
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'books' })).toBe('Perform inpainting on this image. Fill the marked area with books.');
  });`, `  it('qwen inpaint keeps the user text for adding content (A/B: the official template left remnants)', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'A stack of old books', caption: 'a fisherman on a pier' })).toBe('A stack of old books.');
  });
  it('qwen removal (background plate) uses the official template with the caption', () => {
    expect(composeImagePrompt(T, { model: 'qwen', mode: 'inpaint', text: 'the background', caption: 'a fisherman on a pier', remove: true })).toBe(
      'Perform inpainting on this image. Fill the marked area with the background. The original caption is: a fisherman on a pier.',
    );
  });`);
t = t.replace("const QWEN_ONLY = [/<image\d>/, /\bStyle:/, /Ultra HD/, /Perform inpainting/, /using outpainting/, /original caption is/];", "const QWEN_ONLY = [/<image\d>/, /\bStyle:/, /Ultra HD/, /using outpainting/, /original caption is/];");
fs.writeFileSync('tests/prompts.test.ts', t);
console.log('ab fixes ok');
