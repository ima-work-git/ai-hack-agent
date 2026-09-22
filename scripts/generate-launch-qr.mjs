import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qr = require('qr-image');
const origin = process.env.APP_ORIGIN;
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin || '')) throw new Error('Expected the configured HTTPS development origin');
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
if (!args.includes('--expires') || !args.includes('--output')) throw new Error('Use --expires ISO-time --output private-file.png');
const expiry = Date.parse(arg('--expires'));
if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 48 * 60 * 60_000) throw new Error('Expiry must be within the next 48 hours');
const destination = resolve(arg('--output'));
if (!destination.endsWith('.png')) throw new Error('Output must be a local PNG');
const expiresAt = new Date(expiry).toISOString();
const headers = { 'Content-Type': 'application/json', Origin: origin };
async function post(path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`QR operation failed: HTTP ${response.status}`);
  return response.json();
}
const issuer = await post('/api/session', { accessCode: process.env.APP_ACCESS_CODE });
let grant;
try {
  headers.Authorization = `Bearer ${issuer.token}`;
  grant = await post('/api/session/qr/reusable', { accessCode: process.env.APP_ACCESS_CODE, expiresAt });
} finally {
  await fetch(origin + '/api/session', { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  delete headers.Authorization;
}
const entry = 'https://ima-work-git.github.io/ai-hack-agent/';
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await writeFile(destination, qr.imageSync(`${entry}#login=${grant.ticket}`, { type: 'png', size: 8, margin: 4, ec_level: 'M' }), { mode: 0o600 });
await chmod(destination, 0o600);
// Verify reusable exchange without starting the microphone or any paid research.
for (let index = 0; index < 2; index++) {
  const session = await post('/api/session/qr/redeem', { ticket: grant.ticket });
  const response = await fetch(origin + '/api/session', { method: 'DELETE', headers: { ...headers, Authorization: `Bearer ${session.token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('QR verification cleanup failed');
}
const metadata = { entry, expiresAt, path: destination, repeatedRedemptions: 2 };
await writeFile(destination.replace(/\.png$/, '.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
console.log(JSON.stringify(metadata));
