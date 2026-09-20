const BASE='https://demo.inelabteamdev.com';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function burst(label, url, n, gapMs){
  const out=[];
  for(let i=0;i<n;i++){
    const t0=Date.now();
    const r=await fetch(url);
    let ra=r.headers.get('retry-after');
    out.push(`${r.status}${ra?`(RA:${ra})`:''}`);
    if(gapMs) await sleep(gapMs);
  }
  console.log(`${label.padEnd(34)} ${out.join(' ')}`);
}
console.log('--- cold start: wait 8s so the bucket refills ---'); await sleep(8000);
await burst('layout x12, no gap',  `${BASE}/api/layout`, 12, 0);
await sleep(8000);
await burst('layout x12, 250ms gap', `${BASE}/api/layout`, 12, 250);
await sleep(8000);
await burst('layout x12, 600ms gap', `${BASE}/api/layout`, 12, 600);
await sleep(8000);
await burst('layout x10, 1000ms gap', `${BASE}/api/layout`, 10, 1000);
await sleep(8000);
console.log('--- headers on a 429 ---');
for(let i=0;i<12;i++){ const r=await fetch(`${BASE}/api/layout`); if(r.status===429){ console.log('status 429; headers:', JSON.stringify(Object.fromEntries(r.headers))); console.log('body:', JSON.stringify((await r.text()).slice(0,200))); break; } }
