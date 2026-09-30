# UX / UI review — 2026-09-30

Every screen captured at 1280×720, 1440×900 and 1920×1080 (Edge, the real app), plus an automated check for controls
that overflow their panel. Findings are ordered by impact; each says what changed.

## Fixed

| # | Where | Problem | Change |
|---|---|---|---|
| 1 | Generate | The prompt tools (Undo, From picture, Restore, **Enhance**) sat beside the "Prompt" label and ran past the 380 px panel: Enhance was cut off at every window size. | Tools on their own wrapping row under the label; e2e checks every tool fits the panel. |
| 2 | Everywhere | Darkroom always opened on Generate, wherever you left off. | The last screen (and the picture open in Edit, or the take in Video) is remembered and reopened when Darkroom starts without a screen in the address. One-off handoffs (e.g. "Use as…") are not replayed. |
| 3 | Library | No way to delete anything. | **Delete** (button, right-click menu, Delete key) moves items to **Recently deleted** with an Undo in the notice. There: **Restore**, or **Delete forever** / **Empty** behind a confirmation. Delete forever removes the entry and sends the files to the **Windows Recycle Bin** (never a hard delete; a file another item still uses is left alone). |
| 4 | Library | One item at a time. | Multi-select: Ctrl-click toggles, Shift-click selects a range, Ctrl+A selects all, Esc clears; a selection bar shows the count and the actions. |
| 5 | Library | Fixed 5-column grid: huge tiles on a wide screen, cramped on a small one; the details column took 420 px even when empty. | Grid fills the width (tiles ≥ 168 px); details column 340–420 px with a short how-to when nothing is selected. |
| 6 | Library details | Eleven equal buttons in one wrapping row, no hierarchy. | Primary row: Send to Edit (or Open in Video), Animate, Download, Favourite, Delete. The rest under **More**: Reuse settings, Enhance, Upscale 2×, Settings (JSON), Open graph in ComfyUI. |
| 7 | Library details | With ComfyUI offline the preview showed broken-image alt text (the prompt). | Falls back to Darkroom's cached thumbnail. |
| 8 | Edit | A link to a deleted picture stayed on "Opening…" forever. | "Picture not found" with a way back to the Library; a picture in Recently deleted opens with a banner and a Restore button. |
| 9 | Side panels | Content scrolling under the sticky Generate / Apply / Animate footer had no visual edge (the Batch row looked cut off). | Soft shadow on panel footers. |

## Checked, no change needed

- Focus is visible everywhere (2 px accent outline); tiles, pills and tool buttons are real buttons with labels.
- Text contrast (WCAG AA needs 4.5:1): body text 13.3–15.7:1, muted text 5.8–6.9:1, the new red Delete 5.5–6.4:1 on every background.
- Edit and Video panels fit at 1280×720; their footers stay reachable.
- Destructive actions: only Delete forever / Empty are irreversible in Darkroom, and both confirm first and still go
  through the Recycle Bin.

## Not changed (noted for later)

- Videos have no right-click menu (the "Use as…" targets are picture-only); Delete is in the details panel and on the
  Delete key.
- Recently deleted is never emptied automatically; nothing disappears without you asking.
