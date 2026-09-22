import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReusableQrStore } from '../server/reusable-qr.ts';

const CODE = 'fixture-reusable-qr-access-code';
const HOUR = 60 * 60_000;
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-hack-reusable-qr-')); directories.push(directory);
  let now = Date.UTC(2026, 8, 22, 6);
  const createStore = (code = CODE) => new ReusableQrStore(directory, code, () => now);
  return { directory, file: join(directory, 'reusable-qr.json'), createStore, store: createStore(), get now() { return now; }, advance: (duration: number) => { now += duration; } };
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('fixed-expiry reusable QR login grants', () => {
  it('persists only signed hashes at 0600 and permits repeated use after restart without extending expiry', async () => {
    const f = await fixture(); const grant = f.store.issue(f.now + 32 * HOUR);
    expect(grant.ticket).toMatch(/^[a-f0-9]{64}$/);
    const raw = await readFile(f.file, 'utf8');
    expect(raw).not.toContain(grant.ticket); expect(raw).not.toContain(CODE);
    expect(JSON.parse(raw).grants).toEqual([{ tokenHash: createHash('sha256').update(grant.ticket).digest('hex'), expiresAt: grant.expiresAt }]);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600); expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(f.directory)).toEqual(['reusable-qr.json']);
    for (let use = 0; use < 4; use++) { expect(f.store.authenticate(grant.ticket)).toEqual({ expiresAt: grant.expiresAt }); f.advance(HOUR); }
    expect(f.createStore().authenticate(grant.ticket)).toEqual({ expiresAt: grant.expiresAt });
    f.advance(28 * HOUR - 1); expect(f.store.authenticate(grant.ticket)).not.toBeNull();
    f.advance(1); expect(f.createStore().authenticate(grant.ticket)).toBeNull();
    f.store.sweep(); expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
  });

  it('rejects invalid expiry or missing access codes before creating credentials', async () => {
    const f = await fixture();
    for (const expiry of [NaN, Infinity, -1, f.now, f.now - 1, f.now + 0.5, f.now + 48 * HOUR + 1]) expect(() => f.store.issue(expiry)).toThrow('INVALID_EXPIRY');
    for (const code of ['', 'short']) expect(() => f.createStore(code).issue(f.now + HOUR)).toThrow('NOT_CONFIGURED');
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.store.issue(f.now + 48 * HOUR).expiresAt).toBe(f.now + 48 * HOUR);
  });

  it('caps grants at five, revokes only a requested grant, and sweeps expired grants', async () => {
    const f = await fixture(); const grants = Array.from({ length: 5 }, () => f.store.issue(f.now + HOUR));
    expect(() => f.store.issue(f.now + HOUR)).toThrow('CAPACITY');
    f.store.revoke(); expect(f.store.authenticate(grants[0]!.ticket)).not.toBeNull();
    f.store.revoke(grants[0]!.ticket); expect(f.createStore().authenticate(grants[0]!.ticket)).toBeNull();
    const fresh = f.store.issue(f.now + 2 * HOUR);
    f.advance(HOUR); f.store.sweep();
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toHaveLength(1);
    expect(f.store.authenticate(fresh.ticket)).toEqual({ expiresAt: fresh.expiresAt });
  });

  it.each(['signature', 'expiry', 'hash', 'malformed', 'extra-field', 'code-change'] as const)('fails closed on %s without resetting or extending grants', async change => {
    const f = await fixture(); const grant = f.store.issue(f.now + HOUR); const data = JSON.parse(await readFile(f.file, 'utf8'));
    if (change === 'signature') data.mac = 'a'.repeat(64);
    if (change === 'expiry') data.grants[0].expiresAt += HOUR;
    if (change === 'hash') data.grants[0].tokenHash = createHash('sha256').update('b'.repeat(64)).digest('hex');
    if (change === 'extra-field') data.grants[0].sessionId = 'not-allowed';
    if (change !== 'code-change') await writeFile(f.file, change === 'malformed' ? '{' : JSON.stringify(data));
    const store = f.createStore(change === 'code-change' ? 'changed-reusable-qr-code' : CODE);
    expect(store.authenticate(grant.ticket)).toBeNull(); expect(store.authenticate('b'.repeat(64))).toBeNull();
    expect(() => store.issue(f.now + HOUR)).toThrow('INVALID_STORE');
    const before = await readFile(f.file, 'utf8'); store.revoke(); expect(await readFile(f.file, 'utf8')).toBe(before);
  });

  it('rejects malformed and modified tickets without affecting the valid grant', async () => {
    const f = await fixture(); const grant = f.store.issue(f.now + HOUR);
    for (const ticket of [undefined, '', 'bad', grant.ticket + '0', (grant.ticket[0] === 'a' ? 'b' : 'a') + grant.ticket.slice(1)]) expect(f.store.authenticate(ticket)).toBeNull();
    expect(f.store.authenticate(grant.ticket)).toEqual({ expiresAt: grant.expiresAt });
  });
});
