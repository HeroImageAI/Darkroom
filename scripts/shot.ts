// Quick screenshot helper: npx tsx scripts/shot.ts <hash-route> <out.png> [waitMs]
import { chromium } from '@playwright/test';
const [route = '#/generate', out = 'proof/shot.png', wait = '1500'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('response', (r) => r.status() >= 400 && console.log('HTTP', r.status(), r.url()));
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
await page.goto((process.env.DR_URL ?? 'http://127.0.0.1:5173') + '/#/' + route.replace(/^.*[#/]/, ''));
await page.waitForTimeout(Number(wait));
console.log('url', page.url());
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
