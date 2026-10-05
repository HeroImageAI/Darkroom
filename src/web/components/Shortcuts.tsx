import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Dialog } from './common';
import { useRoute } from '../router';

type Group = { title: string; keys: [string, string][] };

/** Every shortcut Darkroom has, by screen (kept in step with the useHotkey calls on each screen). */
const SHEETS: Record<string, Group[]> = {
  edit: [
    {
      title: 'Tools',
      keys: [
        ['V', 'Move the view'],
        ['T', 'Transform the layer (Enter applies, Esc cancels)'],
        ['P', 'Paint on a layer'],
        ['G', 'Fill bucket'],
        ['U', 'Shapes'],
        ['B', 'Mask brush (select by painting)'],
        ['E', 'Eraser'],
        ['M', 'Marquee select'],
        ['L', 'Lasso'],
        ['W', 'Magic wand'],
        ['S', 'Smart select'],
        ['O', 'Outpaint frame'],
        ['C', 'Crop'],
      ],
    },
    {
      title: 'Painting',
      keys: [
        ['[  ]', 'Smaller / bigger brush'],
        ['X', 'Paint or erase (Paint tool)'],
        ['Alt + click', 'Pick a colour from the picture'],
        ['Alt + drag, middle drag', 'Move the view'],
        ['Scroll', 'Zoom at the pointer'],
      ],
    },
    {
      title: 'Selections',
      keys: [
        ['Shift + drag', 'Add to the selection'],
        ['Alt + drag', 'Take away from the selection'],
        ['Shift + Alt + drag', 'Keep only the overlap'],
        ['Ctrl + A', 'Select all'],
        ['Ctrl + D', 'Select none'],
        ['Ctrl + Shift + I', 'Invert the selection'],
      ],
    },
    {
      title: 'View and history',
      keys: [
        ['4  6', 'Turn the view 15°'],
        ['5', 'Straighten the view'],
        ['H', 'Mirror the view'],
        ['Ctrl + Z', 'Undo'],
        ['Ctrl + Y, Ctrl + Shift + Z', 'Redo'],
        ['Ctrl + Enter', 'Run the AI (Apply, Fill, Render…)'],
      ],
    },
  ],
  generate: [{ title: 'Generate', keys: [['Ctrl + Enter', 'Generate'], ['Delete', 'Remove the focused picture from History']] }],
  video: [
    {
      title: 'Video',
      keys: [
        ['Ctrl + Enter', 'Animate'],
        ['Space', 'Play / pause the take'],
        ['←  →', 'One frame back / forward'],
      ],
    },
  ],
  timeline: [
    {
      title: 'Timeline',
      keys: [
        ['Space', 'Play / pause'],
        ['S', 'Split at the playhead'],
        ['Delete', 'Remove the selected clip (Shift: and close the gap)'],
        ['←  →', 'One frame (Shift: one second)'],
        ['Home  End', 'To the start / end'],
        ['Ctrl + Z', 'Undo'],
      ],
    },
  ],
  library: [
    {
      title: 'Library',
      keys: [
        ['/', 'Search'],
        ['Delete', 'Delete the selected (they wait in Recently deleted)'],
        ['Esc', 'Clear the selection'],
        ['Ctrl / Shift + click', 'Pick several / a range'],
      ],
    },
  ],
};
const ANYWHERE: Group = { title: 'Anywhere', keys: [['?', 'This list'], ['Ctrl + V', 'Paste a picture (Edit, Generate references, Video frames, Home)']] };

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** "?" (or the keyboard button in the top bar) shows the shortcuts for the screen you are on, then the rest. */
export function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  const route = useRoute();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !typing()) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const here = SHEETS[route.screen] ?? [];
  const rest = Object.entries(SHEETS)
    .filter(([s]) => s !== route.screen)
    .flatMap(([, g]) => g);
  return (
    <>
      <button className="btn ghost sm icon" onClick={() => setOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <Keyboard size={16} />
      </button>
      {open && (
        <Dialog title="Keyboard shortcuts" onClose={() => setOpen(false)}>
          <div className="shortcuts">
            {[...here, ANYWHERE, ...rest].map((g) => (
              <section key={g.title}>
                <h3 className="section-label">{g.title}</h3>
                <dl>
                  {g.keys.map(([k, what]) => (
                    <div key={k + what}>
                      <dt>
                        {k.split(', ').map((alt) => (
                          <kbd key={alt}>{alt}</kbd>
                        ))}
                      </dt>
                      <dd>{what}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <button className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => setOpen(false)}>
            Close
          </button>
        </Dialog>
      )}
    </>
  );
}
