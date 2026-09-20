import crypto from 'node:crypto';
import fs from 'node:fs';
const BASE='https://demo.inelabteamdev.com', KEY='ine-mock-store-shared-k3y';
const sha=(s)=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const shaB=(s)=>crypto.createHash('sha256').update(s,'utf8').digest();
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const rnd=(a,b)=>a+Math.random()*(b-a);
const pow=(salt,d)=>{const t='0'.repeat(d);let n=0;while(sha(`${salt}:${n}`).slice(0,d)!==t)n++;return n;};
const seedFor=(s,h)=>parseInt(sha(`${KEY}|seed|${s}|${h}`).slice(0,8),16)|0;
const derive=(s,w,h)=>sha(`${KEY}|derive|${s}|${w|0}|${h}`);
async function runWasm(b64,i){const m=await WebAssembly.compile(Buffer.from(b64,'base64'));return (await WebAssembly.instantiate(m)).exports.f(i)|0;}
function att(){const now=Date.now(),dwell=Math.round(rnd(900,2600));const moves=[];let t=now-dwell;
  for(let i=0;i<Math.round(rnd(10,20));i++){t+=Math.round(rnd(45,95));moves.push([Math.round(rnd(400,900)),Math.round(rnd(300,600)),t]);}
  return JSON.stringify({env:{canvas:crypto.randomBytes(8).toString('hex'),gl:crypto.randomBytes(8).toString('hex'),hc:8,
    scr:[1920,1080,1],frames:Array.from({length:8},()=>Math.round(rnd(15.5,18.4)*100)/100),at:now},
    ix:{hoverAt:now-dwell,dwellMs:dwell,moves,clickAt:now,trusted:true}});}
function dec(b64,token){const ks=shaB(`${KEY}|enc|${token}`);const d=Buffer.from(b64,'base64');const o=Buffer.alloc(d.length);
  for(let i=0;i<d.length;i++)o[i]=d[i]^ks[i%ks.length];return JSON.parse(o.toString('utf8'));}
const recs=[];
async function timed(label,fn){const t0=Date.now();try{const r=await fn();recs.push({label,ms:Date.now()-t0,...r});return r;}
  catch(e){recs.push({label,ms:Date.now()-t0,status:0,err:String(e.message||e)});return {status:0,err:String(e)};}}
const N=Number(process.argv[2]??35), PID=Number(process.argv[3]??15);
for(let i=0;i<N;i++){
  await timed('challenge',async()=>{const r=await fetch(`${BASE}/api/challenge`);const b=await r.text();
    return {status:r.status,len:b.length,body:r.ok?undefined:b.slice(0,120),_j:r.ok?JSON.parse(b):null};});
  const ch=recs[recs.length-1]._j; delete recs[recs.length-1]._j;
  if(!ch){await sleep(rnd(2400,3000));continue;}
  const a=att(),h=sha(a);
  const w=await runWasm(ch.wasm,seedFor(ch.salt,h));
  const nonceT0=Date.now(); const nonce=pow(ch.salt,ch.difficulty); const powMs=Date.now()-nonceT0;
  recs.push({label:'pow',ms:powMs,status:200,difficulty:ch.difficulty,nonce});
  let token=null;
  await timed('session',async()=>{const r=await fetch(`${BASE}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...ch,nonce,derived:derive(ch.salt,w,h),wasmOut:w,att:a,productId:PID})});
    const b=await r.text(); if(r.ok) token=JSON.parse(b).token;
    return {status:r.status,len:b.length,body:r.ok?undefined:b.slice(0,140)};});
  if(token){
    await timed('price',async()=>{const r=await fetch(`${BASE}/api/products/${PID}/price`,{headers:{Authorization:`Bearer ${token}`}});
      const b=await r.text(); let q=null; if(r.ok){try{q=dec(JSON.parse(b).e,token);}catch(e){}}
      return {status:r.status,len:b.length,body:r.ok?undefined:b.slice(0,140),price:q?.p,stock:q?.s,pending:q?.g,fmt:q?.f,variant:q?.v,currency:q?.c};});
  }
  await timed('product',async()=>{const r=await fetch(`${BASE}/api/product/${PID}`);const b=await r.text();return {status:r.status,len:b.length};});
  await timed('layout',async()=>{const r=await fetch(`${BASE}/api/layout`);const b=await r.text();
    return {status:r.status,len:b.length,rev:r.ok?JSON.parse(b).revision:undefined,variant:r.ok?JSON.parse(b).variant:undefined,
      carrier:r.ok?JSON.parse(b).priceCarrier:undefined,tag:r.ok?JSON.parse(b).priceTag:undefined};});
  await sleep(rnd(2300,3200));
  if(i%5===0) process.stderr.write(`.`);
}
fs.writeFileSync('recon/latency.json', JSON.stringify(recs,null,1));
const by={};
for(const r of recs){ (by[r.label] ??= []).push(r); }
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))];};
console.log('\nlabel      n   ok  p50    p95    max    statuses');
for(const [k,v] of Object.entries(by)){
  const ms=v.map(x=>x.ms); const sc={}; for(const x of v) sc[x.status]=(sc[x.status]||0)+1;
  console.log(k.padEnd(10), String(v.length).padStart(3), String(v.filter(x=>x.status>=200&&x.status<300).length).padStart(4),
    String(pct(ms,.5)).padStart(6), String(pct(ms,.95)).padStart(6), String(Math.max(...ms)).padStart(6), ' ', JSON.stringify(sc));
}
const prices=recs.filter(r=>r.label==='price'&&r.price!=null);
console.log('\nprices seen:', prices.map(p=>p.price).join(', '));
console.log('stock seen:', [...new Set(prices.map(p=>p.stock))].join(', '));
console.log('formats seen:', [...new Set(prices.map(p=>p.fmt))].join(', '));
console.log('variants seen:', [...new Set(prices.map(p=>p.variant))].join(', '));
console.log('pending seen:', [...new Set(prices.map(p=>p.pending))].join(', '));
console.log('layout revisions:', [...new Set(recs.filter(r=>r.label==='layout').map(r=>r.rev))].join(', '));
console.log('layout variants:', [...new Set(recs.filter(r=>r.label==='layout').map(r=>r.variant))].join(', '));
