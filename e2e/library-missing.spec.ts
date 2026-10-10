/**
 * Library pictures whose file is gone from disk (a disk cleaner, or data/ restored on a new PC without the output
 * folder): the Library says so and moves them to Recently deleted, with Undo. Nothing on disk is touched.
 */
import { expect, test } from '@playwright/test';

test('Missing files: the Library names them and moves them to Recently deleted, with Undo', async ({ page }) => {
  const before = (await (await page.request.get('/api/library/missing')).json()) as { checked: boolean; count: number; ids: string[] };
  expect(before.checked, 'ComfyUI is running and its output folder is known').toBeTruthy();
  test.skip(before.count === 0, 'every picture in this library still has its file');

  await page.goto('/#/library');
  const banner = page.getByRole('status').filter({ hasText: 'lost' });
  await expect(banner).toContainText(`${before.count}`);
  await page.screenshot({ path: 'proof/lm-banner.png' });

  // move, undo, move again: the end state is a library where every picture opens
  await banner.getByRole('button', { name: 'Move to Recently deleted' }).click();
  await expect(banner).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/library/missing')).json()).count, { timeout: 30_000 }).toBe(before.count);
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Move to Recently deleted' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/library/missing')).json()).count).toBe(0);

  // they wait in Recently deleted, restorable
  const deleted = (await (await page.request.get('/api/items?filter=deleted&limit=5000')).json()).items as { id: string }[];
  expect(before.ids.every((id) => deleted.some((d) => d.id === id))).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'lost' })).toHaveCount(0);
});
