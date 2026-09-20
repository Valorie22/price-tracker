import crypto from 'node:crypto';

const BASE = 'https://demo.inelabteamdev.com';
const KEY = 'ine-mock-store-shared-k3y';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const shaBytes = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

function pow(salt, difficulty) {
  const target = '0'.repeat(difficulty);
  let n = 0;
  while (sha(`${salt}:${n}`).slice(0, difficulty) !== target) n++;
  return n;
}
const seedFor = (salt, attHash) => parseInt(sha(`${KEY}|seed|${salt}|${attHash}`).slice(0, 8), 16) | 0;
const derive = (salt, wasmOut, attHash) => sha(`${KEY}|derive|${salt}|${wasmOut | 0}|${attHash}`);

async function runWasm(b64, input) {
  const mod = await WebAssembly.compile(Buffer.from(b64, 'base64'));
  const inst = await WebAssembly.instantiate(mod);
  return inst.exports.f(input) | 0;
}

function decryptQuote(b64, token) {
  const ks = shaBytes(`${KEY}|enc|${token}`);
  const data = Buffer.from(b64, 'base64');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ ks[i % ks.length];
  return JSON.parse(out.toString('utf8'));
}

function syntheticAtt(variant) {
  const now = Date.now();
  const moves = [];
  let t = now - 2400;
  for (let i = 0; i < 14; i++) { t += 55 + Math.floor(Math.random() * 40); moves.push([600 + i * 7, 420 + ((i * 13) % 19), t]); }
  const frames = Array.from({ length: 8 }, () => Math.round((16.6 + Math.random() * 1.2) * 100) / 100);
  const base = {
    env: {
      canvas: crypto.randomBytes(8).toString('hex'),
      gl: crypto.randomBytes(8).toString('hex'),
      hc: 8, scr: [1920, 1080, 1], frames, at: now,
    },
    ix: { hoverAt: now - 2500, dwellMs: 2500, moves, clickAt: now, trusted: true },
  };
  if (variant === 'empty') return JSON.stringify({ env: { canvas: '', gl: '', hc: 1, scr: [0, 0, 1], frames: [], at: now }, ix: { hoverAt: 0, dwellMs: 0, moves: [], clickAt: now, trusted: false } });
  if (variant === 'untrusted') { base.ix.trusted = false; return JSON.stringify(base); }
  if (variant === 'nomoves') { base.ix.moves = []; base.ix.dwellMs = 0; return JSON.stringify(base); }
  return JSON.stringify(base);
}

async function attempt(productId, variant) {
  const t0 = Date.now();
  const cr = await fetch(`${BASE}/api/challenge`);
  if (!cr.ok) return { ok: false, stage: 'challenge', status: cr.status };
  const ch = await cr.json();
  const att = syntheticAtt(variant);
  const attHash = sha(att);
  const wasmOut = await runWasm(ch.wasm, seedFor(ch.salt, attHash));
  const nonce = pow(ch.salt, ch.difficulty);
  const body = { ...ch, nonce, derived: derive(ch.salt, wasmOut, attHash), wasmOut, att, productId };
  const sr = await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!sr.ok) return { ok: false, stage: 'session', status: sr.status, body: (await sr.text()).slice(0, 300), ms: Date.now() - t0 };
  const { token } = await sr.json();
  const pr = await fetch(`${BASE}/api/products/${productId}/price`, { headers: { Authorization: `Bearer ${token}` } });
  if (!pr.ok) return { ok: false, stage: 'price', status: pr.status, body: (await pr.text()).slice(0, 300), ms: Date.now() - t0 };
  const payload = await pr.json();
  return { ok: true, ms: Date.now() - t0, keys: Object.keys(payload), quote: decryptQuote(payload.e, token) };
}

const variant = process.argv[2] ?? 'normal';
const id = Number(process.argv[3] ?? 15);
console.log(JSON.stringify(await attempt(id, variant), null, 2));
