import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE='https://demo.inelabteamdev.com';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport:{width:1440,height:940}, locale:'en-IN' })).newPage();
await page.route('**/api/products/*/price', async (route) => { await sleep(9000); await route.continue(); });
await page.goto(`${BASE}/product/15`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.price-block');
const box = await page.locator('.price-block').first().boundingBox();
for (let i=0;i<14;i++){ await page.mouse.move(box.x+24+i*6, box.y+18+((i*11)%22), {steps:2}); await page.waitForTimeout(70); }
await page.waitForTimeout(700);
for (let c=0;c<4;c++){
  await page.getByRole('button',{name:/reveal price/i}).click({timeout:8000}).catch(()=>{});
  const left = await page.waitForFunction(()=>{const el=document.querySelector('.price-block');return !!el && !el.classList.contains('price-idle');},undefined,{timeout:2500}).then(()=>true).catch(()=>false);
  if (left) break;
  console.log('  click swallowed by the store; re-issuing');
}
await page.waitForTimeout(300);
const html = await page.content();
fs.writeFileSync('recon/fixtures/rendered-loading.html', html);
const cls = await page.locator('.price-block').first().getAttribute('class');
const status = await page.locator('.price-status').first().textContent().catch(()=>null);
console.log('captured phase:', cls, '|', JSON.stringify(status), '|', html.length, 'bytes');
await browser.close();
