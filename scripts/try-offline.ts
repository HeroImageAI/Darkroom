import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
for (const r of ['generate', 'library', 'edit']) {
  await page.goto('http://127.0.0.1:5190/#/' + r);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `proof/X-offline-${r}.png` });
}
await browser.close();
