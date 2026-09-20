/**
 * Capture real store responses as test fixtures.
 * Run:  node recon/tools/capture-fixtures.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://demo.inelabteamdev.com';
const OUT = 'recon/fixtures';
fs.mkdirSync(OUT, { recursive: true });
const save = (name, content) => {
  fs.writeFileSync(path.join(OUT, name), content);
  console.log(`  saved ${name.padEnd(34)} ${String(content.length).padStart(7)} bytes`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n1. raw HTTP responses');
const shell = await fetch(`${BASE}/product/15`).then((r) => r.text());
save('served-shell.html', shell);
save('api-catalog.json', await fetch(`${BASE}/api/catalog?page=1&pageSize=8`).then((r) => r.text()));
await sleep(900);
save('api-product-15.json', await fetch(`${BASE}/api/product/15`).then((r) => r.text()));
await sleep(900);
save('api-layout.json', await fetch(`${BASE}/api/layout`).then((r) => r.text()));
await sleep(900);
save('api-challenge.json', await fetch(`${BASE}/api/challenge`).then((r) => r.text()));
await sleep(900);
const gone = await fetch(`${BASE}/api/product/99999`);
save('api-product-404.json', JSON.stringify({ status: gone.status, body: JSON.parse(await gone.text()) }, null, 2));
await sleep(900);
const unauth = await fetch(`${BASE}/api/products/15/price`);
save('api-price-401.json', JSON.stringify({ status: unauth.status, body: JSON.parse(await unauth.text()) }, null, 2));

console.log('\n2. rendered pages');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'en-IN' });

async function renderPage(label, { fail = 0, holdMs = 0, captureAt = 'settled' } = {}) {
  const page = await ctx.newPage();
  let served = 0;
  if (fail || holdMs) {
    await page.route('**/api/products/*/price', async (route) => {
      if (served < fail) { served++; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream_error"}' }); return; }
      if (holdMs) await sleep(holdMs);
      await route.continue();
    });
  }
  await page.goto(`${BASE}/product/15`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.price-block');

  if (captureAt === 'idle') {
    await page.waitForTimeout(400);
    save(`${label}.html`, await page.content());
    await page.close();
    return;
  }

  const box = await page.locator('.price-block').first().boundingBox();
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(box.x + 24 + i * 6, box.y + 18 + ((i * 11) % 22), { steps: 2 });
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /reveal price/i }).click({ timeout: 10000 }).catch(() => {});

  if (captureAt === 'loading') {
    await page.waitForFunction(() => {
      const el = document.querySelector('.price-block');
      return !!el && !el.classList.contains('price-idle');
    }, undefined, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(150);
    save(`${label}.html`, await page.content());
    await page.close();
    return;
  }

  await page.waitForFunction(() => {
    const el = document.querySelector('.price-block');
    return !!el && (el.classList.contains('price-success') || el.classList.contains('price-error'));
  }, undefined, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(250);
  save(`${label}.html`, await page.content());
  await page.close();
}

await renderPage('rendered-idle', { captureAt: 'idle' });
await renderPage('rendered-success', {});
await renderPage('rendered-loading', { holdMs: 6000, captureAt: 'loading' });
await renderPage('rendered-error-503', { fail: 8 });

// A second successful render: the store rotates its price formatting at random,
// so two captures on the same product are genuinely different documents.
await renderPage('rendered-success-2', {});

await browser.close();
console.log('\nfixtures written to recon/fixtures/');
