import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'https://demo.inelabteamdev.com';
const PRODUCT_ID = process.argv[2] ?? '15';
const events = [];

const browser = await chromium.launch({ headless: false, slowMo: 120 });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();

page.on('request', (r) => events.push({ t: Date.now(), kind: 'request', method: r.method(), url: r.url(), resourceType: r.resourceType(), postData: r.postData()?.slice(0, 400) ?? null }));
page.on('response', async (r) => {
  let bodyPreview = null;
  try { if ((r.headers()['content-type'] ?? '').includes('json')) bodyPreview = (await r.text()).slice(0, 600); } catch { /* body gone */ }
  events.push({ t: Date.now(), kind: 'response', status: r.status(), url: r.url(), contentType: r.headers()['content-type'] ?? null, bodyPreview });
});
page.on('console', (m) => events.push({ t: Date.now(), kind: 'console', type: m.type(), text: m.text().slice(0, 300) }));

async function capture(label) {
  const html = await page.content();
  fs.writeFileSync(`recon/fixtures/${label}.html`, html);
  console.log(`saved recon/fixtures/${label}.html  (${html.length} bytes)`);
}

console.log('→ home');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await capture('catalog-rendered');

console.log('→ product detail (direct nav; the tile CTA is deliberately flaky)');
await page.goto(`${BASE}/product/${PRODUCT_ID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await capture(`product-${PRODUCT_ID}-idle`);

console.log('→ hovering the price block to satisfy the interaction gate');
const wrap = page.locator('.price-block').first();
const box = await wrap.boundingBox();
if (box) {
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(box.x + 20 + i * 6, box.y + 18 + ((i * 11) % 23), { steps: 2 });
    await page.waitForTimeout(70);
  }
}
await page.waitForTimeout(700);
const gate = await page.locator('.price-substatus').first().textContent().catch(() => null);
console.log('  gate substatus:', JSON.stringify(gate));

console.log('→ clicking "Reveal price"');
await page.getByRole('button', { name: /reveal price/i }).click({ timeout: 10_000 }).catch((e) => console.log('  click failed:', e.message));
await page.waitForFunction(() => {
  const el = document.querySelector('.price-block');
  return !!el && (el.classList.contains('price-success') || el.classList.contains('price-error'));
}, undefined, { timeout: 45_000 }).catch(() => console.log('  never resolved'));
await page.waitForTimeout(400);
await capture(`product-${PRODUCT_ID}-revealed`);

const domFacts = await page.evaluate(() => {
  const block = document.querySelector('.price-block');
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).map((n) => ({
    sel, cls: n.className, tag: n.tagName, text: (n.textContent ?? '').slice(0, 60),
    hidden: getComputedStyle(n).display === 'none', attrs: Object.fromEntries(Array.from(n.attributes).map((a) => [a.name, a.value.slice(0, 40)])),
  }));
  return {
    blockClass: block?.className ?? null,
    priceMainHTML: document.querySelector('.price-main')?.outerHTML?.slice(0, 2000) ?? null,
    candidates: [...pick('.price-value'), ...pick('[data-price]'), ...pick('.amount'), ...pick('[class*="pv-"]'), ...pick('.stock-badge')],
    facetsHTML: document.querySelector('.price-facets')?.outerHTML?.slice(0, 1500) ?? null,
    metaText: document.querySelector('.price-meta')?.textContent ?? null,
  };
});
fs.writeFileSync('recon/dom-facts.json', JSON.stringify(domFacts, null, 2));
console.log('\n--- DOM facts ---');
console.log(JSON.stringify(domFacts, null, 2).slice(0, 3000));

fs.writeFileSync('recon/network.json', JSON.stringify(events, null, 1));
const apiCalls = events.filter((e) => e.url?.includes('/api/'));
console.log('\n--- API calls observed ---');
for (const e of apiCalls) {
  if (e.kind === 'request') console.log(`  REQ  ${e.method.padEnd(5)} ${e.url.replace(BASE, '')}${e.postData ? `  body:${e.postData.slice(0, 90)}…` : ''}`);
  else console.log(`  RES  ${String(e.status).padEnd(5)} ${e.url.replace(BASE, '')}  ${e.contentType}`);
}
await browser.close();
