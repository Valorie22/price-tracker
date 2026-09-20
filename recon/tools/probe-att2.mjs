import crypto from 'node:crypto';
const BASE='https://demo.inelabteamdev.com', KEY='ine-mock-store-shared-k3y';
const sha=(s)=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const pow=(salt,d)=>{const t='0'.repeat(d);let n=0;while(sha(`${salt}:${n}`).slice(0,d)!==t)n++;return n;};
const seedFor=(s,h)=>parseInt(sha(`${KEY}|seed|${s}|${h}`).slice(0,8),16)|0;
const derive=(s,w,h)=>sha(`${KEY}|derive|${s}|${w|0}|${h}`);
async function runWasm(b64,i){const m=await WebAssembly.compile(Buffer.from(b64,'base64'));return (await WebAssembly.instantiate(m)).exports.f(i)|0;}
const rnd=(a,b)=>a+Math.random()*(b-a);
function mk(o={}){const now=Date.now();const nMoves=o.moves??14, dwell=o.dwellMs??2500, nFrames=o.frames??8;
  const moves=[];let t=now-dwell;
  for(let i=0;i<nMoves;i++){t+=Math.round(rnd(45,95));moves.push([Math.round(rnd(400,900)),Math.round(rnd(300,600)),t]);}
  const frames=Array.from({length:nFrames},()=>Math.round(rnd(15.5,18.4)*100)/100);
  return JSON.stringify({env:{canvas:o.canvas??crypto.randomBytes(8).toString('hex'),gl:o.gl??crypto.randomBytes(8).toString('hex'),
    hc:o.hc??8,scr:o.scr??[1920,1080,1],frames,at:now},
    ix:{hoverAt:dwell?now-dwell:0,dwellMs:dwell,moves,clickAt:now,trusted:o.trusted??true}});}
async function probe(label,attOpts){
  for(let tryN=0;tryN<6;tryN++){
    const cres=await fetch(`${BASE}/api/challenge`);
    if(!cres.ok){await sleep(2600);continue;}
    const ch=await cres.json();
    if(!ch.wasm){await sleep(2600);continue;}
    const att=mk(attOpts), h=sha(att);
    const w=await runWasm(ch.wasm,seedFor(ch.salt,h));
    const body={...ch,nonce:pow(ch.salt,ch.difficulty),derived:derive(ch.salt,w,h),wasmOut:w,att,productId:15};
    const r=await fetch(`${BASE}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const txt=r.ok?'OK':(await r.text()).slice(0,70);
    if(r.status===429){await sleep(2600);continue;}
    console.log(String(label).padEnd(22), r.status, txt);
    return;
  }
  console.log(String(label).padEnd(22),'GAVE-UP(rate-limited)');
}
const cases=[
 ['baseline',{}],['moves=0',{moves:0}],['moves=4',{moves:4}],['moves=7',{moves:7}],['moves=8',{moves:8}],['moves=12',{moves:12}],
 ['moves=41',{moves:41}],['dwell=0',{dwellMs:0}],['dwell=400',{dwellMs:400}],['dwell=600',{dwellMs:600}],['dwell=900',{dwellMs:900}],
 ['frames=0',{frames:0}],['frames=3',{frames:3}],['frames=7',{frames:7}],
 ['canvas=empty',{canvas:''}],['gl=empty',{gl:''}],['hc=0',{hc:0}],['scr=[0,0,0]',{scr:[0,0,0]}],['untrusted',{trusted:false}],
];
for(const [l,o] of cases){ try{await probe(l,o);}catch(e){console.log(l,'ERR',e.message);} await sleep(2400); }
