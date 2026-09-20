const BASE='https://demo.inelabteamdev.com';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function sample(label,url,n,gap){
  const sc={}; const lat=[];
  for(let i=0;i<n;i++){
    const t0=Date.now(); let s;
    try{ const r=await fetch(url); s=r.status; if(r.status===429){ const b=await r.text(); sc['429:'+b.slice(0,60)]=(sc['429:'+b.slice(0,60)]||0)+1; } }
    catch(e){ s='ERR'; }
    lat.push(Date.now()-t0);
    if(s!==429) sc[s]=(sc[s]||0)+1;
    if(gap) await sleep(gap);
  }
  const s=[...lat].sort((a,b)=>a-b);
  console.log(`${label.padEnd(30)} n=${n} p50=${s[Math.floor(n*.5)]}ms p95=${s[Math.floor(n*.95)]}ms max=${Math.max(...lat)}ms  ${JSON.stringify(sc)}`);
}
await sample('product/15 x80 @150ms', `${BASE}/api/product/15`, 80, 150);
await sleep(3000);
await sample('catalog x40 @200ms', `${BASE}/api/catalog?page=1&pageSize=60`, 40, 200);
await sleep(3000);
await sample('layout x60 @120ms', `${BASE}/api/layout`, 60, 120);
await sleep(3000);
await sample('challenge x40 @250ms', `${BASE}/api/challenge`, 40, 250);
