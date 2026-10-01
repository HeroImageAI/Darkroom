/**
 * Prompt variations (Invoke's "dynamic prompts", DECISIONS 85): \`a {red|green|blue} car at {dawn|night}\` expands to every
 * combination. Only braces that contain a | are variation groups, so other braces are left alone. Combinations are
 * listed in order (first group changes slowest) and cut off at \`max\`.
 */
export interface Variations {
  /** The prompts to render (at most \`max\`). */
  prompts: string[];
  /** How many combinations the prompt describes in total. */
  total: number;
}

const GROUP = /\{([^{}]*\|[^{}]*)\}/g;

export function expandVariations(prompt: string, max = 16): Variations {
  const groups: string[][] = [];
  const parts: string[] = [];
  let last = 0;
  for (const m of prompt.matchAll(GROUP)) {
    parts.push(prompt.slice(last, m.index));
    groups.push(m[1].split('|')); // kept as typed: a leading space can be deliberate ('a cat{| wearing a crown}')
    last = m.index! + m[0].length;
  }
  parts.push(prompt.slice(last));
  if (!groups.length) return { prompts: [prompt], total: 1 };
  const total = groups.reduce((n, g) => n * g.length, 1);
  const prompts: string[] = [];
  const pick = new Array(groups.length).fill(0);
  for (let i = 0; i < Math.min(total, max); i++) {
    let out = parts[0];
    groups.forEach((g, k) => (out += g[pick[k]] + parts[k + 1]));
    // tidy the joins: doubled spaces, and a space left before punctuation ('{red | blue}, shiny')
    prompts.push(out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim());
    // advance like an odometer: the last group changes fastest
    for (let k = groups.length - 1; k >= 0; k--) {
      if (++pick[k] < groups[k].length) break;
      pick[k] = 0;
    }
  }
  return { prompts, total };
}
