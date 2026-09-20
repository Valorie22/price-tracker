import crypto from 'node:crypto';
const BASE='https://demo.inelabteamdev.com', KEY='ine-mock-store-shared-k3y';
const sha=(s)=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const pow=(salt,d)=>{const t='0'.repeat(d);let n=0;while(sha(`${salt}:${n}`).slice(0,d)!==t)n++;return n;};
const seedFor=(s,h)=>parseInt(sha(`${KEY}|seed|${s}|${h}`).slice(0,8),16)|0;
const derive=(s,w,h)=>sha(`${KEY}|derive|${s}|${w|0}|${h}`);
async function runWasm(b64,i){const m=await WebAssembly.compile(Buffer.from(b64,'base64'));return (await WebAssembly.instantiate(m)).exports.f(i)|0;}
function mk(o={}){const now=Date.now();const nMoves=o.moves??14, dwell=o.dwellMs??2500, nFrames=o.frames??8;
  const moves=[];let t=now-dwell;for(let i=0;i<nMoves;i++){t+=60;moves.push([600+i*7,420+(i*13)%19,t]);}
  return JSON.stringify({env:{canvas:o.canvas??crypto.randomBytes(8).toString('hex'),gl:o.gl??crypto.randomBytes(8).toString('hex'),
    hc:o.hc??8,scr:o.scr??[1920,1080,1],frames:Array.from({length:nFrames},()=>16.67),at:now},
    ix:{hoverAt:dwell?now-dwell:0,dwellMs:dwell,moves,clickAt:now,trusted:o.trusted??true}});}
async function probe(label,attOpts){
  const ch=await (await fetch(`${BASE}/api/challenge`)).json();
  const att=mk(attOpts), h=sha(att);
  const w=await runWasm(ch.wasm,seedFor(ch.salt,h));
  const body={...ch,nonce:pow(ch.salt,ch.difficulty),derived:derive(ch.salt,w,h),wasmOut:w,att,productId:15};
  const r=await fetch(`${BASE}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  console.log(String(label).padEnd(28), r.status, r.ok?'OK':(await r.text()).slice(0,60));
}
const cases=[
 ['moves=0',{moves:0}],['moves=4',{moves:4}],['moves=7',{moves:7}],['moves=8',{moves:8}],['moves=40',{moves:40}],['moves=60',{moves:60}],
 ['dwell=0',{dwellMs:0}],['dwell=300',{dwellMs:300}],['dwell=599',{dwellMs:599}],['dwell=600',{dwellMs:600}],['dwell=60000',{dwellMs:60000}],
 ['frames=0',{frames:0}],['frames=3',{frames:3}],['frames=8',{frames:8}],
 ['canvas=""',{canvas:''}],['gl=""',{gl:''}],['hc=0',{hc:0}],['scr=[0,0,1]',{scr:[0,0,1]}],
 ['baseline',{}],
];
for(const [l,o] of cases) { try{ await probe(l,o);}catch(e){console.log(l,'ERR',e.message);} }
