const BASE='https://demo.inelabteamdev.com';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function sustained(gap,n){
  let ok=0,rl=0,other={};
  const t0=Date.now();
  for(let i=0;i<n;i++){ const r=await fetch(`${BASE}/api/layout`);
    if(r.status===200)ok++; else if(r.status===429){rl++; await r.text();} else other[r.status]=(other[r.status]||0)+1;
    await sleep(gap); }
  const secs=(Date.now()-t0)/1000;
  console.log(`gap=${String(gap).padStart(5)}ms n=${n}  ok=${String(ok).padStart(3)} 429=${String(rl).padStart(3)}  ${JSON.stringify(other)}  → ${(ok/secs).toFixed(2)} ok/s over ${secs.toFixed(1)}s`);
}
for(const g of [2000,1400,1000,700,400]){ await sleep(10000); await sustained(g,25); }
