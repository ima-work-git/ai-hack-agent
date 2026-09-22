import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceLoginStore } from '../server/device-logins.ts';

const CODE = 'fixture-access-code-only';
const LIFETIME = 12 * 60 * 60_000;
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-hack-device-login-')); directories.push(directory);
  let now = Date.UTC(2026, 8, 22);
  const createStore = (code = CODE) => new DeviceLoginStore(directory, code, () => now);
  return { directory, file: join(directory, 'device-logins.json'), createStore, store: createStore(), advance: (time: number) => { now += time; } };
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('independent remembered-device credentials', () => {
  it('persists only hashes and authenticated expiry metadata with restricted permissions', async () => {
    const f = await fixture();
    const device = f.store.issue();
    expect(device.token).toMatch(/^[a-f0-9]{64}$/);
    const raw = await readFile(f.file, 'utf8');
    expect(raw).not.toContain(device.token);
    expect(raw).not.toContain(CODE);
    const data = JSON.parse(raw);
    expect(Object.keys(data).sort()).toEqual(['devices', 'mac', 'version']);
    expect(data.devices).toEqual([{ tokenHash: createHash('sha256').update(device.token).digest('hex'), expiresAt: device.expiresAt }]);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(f.createStore().authenticate(device.token)?.expiresAt).toBe(device.expiresAt);
  });

  it('expires at twelve hours even after repeated restores and process restart', async () => {
    const f = await fixture(); const device = f.store.issue();
    f.advance(LIFETIME - 1);
    expect(f.store.authenticate(device.token)?.expiresAt).toBe(device.expiresAt);
    const restarted = f.createStore();
    expect(restarted.authenticate(device.token)?.expiresAt).toBe(device.expiresAt);
    f.advance(1);
    expect(restarted.authenticate(device.token)).toBeNull();
    restarted.sweep();
    expect(JSON.parse(await readFile(f.file, 'utf8')).devices).toEqual([]);
  });

  it('never keeps a remembered device beyond the reusable QR deadline', async () => {
    const f = await fixture(); const expiry = Date.UTC(2026, 8, 22) + 60_000;
    const device = f.store.issue(undefined, expiry);
    expect(device.expiresAt).toBe(expiry);
    f.advance(60_000);
    expect(f.createStore().authenticate(device.token)).toBeNull();
    expect(() => f.store.issue(undefined, expiry)).toThrow('INVALID_EXPIRY');
  });

  it('invalidates all remembered logins on access-code change and permits a fresh code-authenticated issuance', async () => {
    const f = await fixture(); const old = f.store.issue();
    const changed = f.createStore('another-fixture-access-code');
    expect(changed.authenticate(old.token)).toBeNull();
    const fresh = changed.issue();
    expect(changed.authenticate(fresh.token)).not.toBeNull();
    expect(f.createStore().authenticate(old.token)).toBeNull();
    expect(f.createStore().authenticate(fresh.token)).toBeNull();
  });

  it.each(['malformed', 'expiry', 'hash', 'extra-field'] as const)('fails closed on %s record tampering', async change => {
    const f = await fixture(); const device = f.store.issue();
    const data = JSON.parse(await readFile(f.file, 'utf8'));
    if (change === 'expiry') data.devices[0].expiresAt += LIFETIME;
    if (change === 'hash') data.devices[0].tokenHash = createHash('sha256').update('a'.repeat(64)).digest('hex');
    if (change === 'extra-field') data.devices[0].sessionId = 'untrusted-extra-field';
    await writeFile(f.file, change === 'malformed' ? '{' : JSON.stringify(data));
    expect(f.store.authenticate(device.token)).toBeNull();
    expect(f.createStore().authenticate('a'.repeat(64))).toBeNull();
  });

  it('rejects altered and malformed cookies without authenticating another device', async () => {
    const f = await fixture(); const device = f.store.issue();
    const altered = (device.token[0] === 'a' ? 'b' : 'a') + device.token.slice(1);
    for (const token of [undefined, '', 'not-a-token', device.token + 'a', altered]) expect(f.store.authenticate(token)).toBeNull();
    expect(f.store.authenticate(device.token)).not.toBeNull();
  });

  it('caps remembered devices at twenty and supports rotation, revocation and expiry without raising the cap', async () => {
    const f = await fixture(); const devices = Array.from({ length: 20 }, () => f.store.issue());
    expect(() => f.store.issue()).toThrow('CAPACITY');
    const rotated = f.store.issue(devices[0]!.token);
    expect(f.store.authenticate(devices[0]!.token)).toBeNull();
    expect(f.store.authenticate(rotated.token)).not.toBeNull();
    f.store.revoke(devices[1]!.token);
    const replacement = f.store.issue();
    expect(f.createStore().authenticate(devices[1]!.token)).toBeNull();
    expect(f.createStore().authenticate(replacement.token)).not.toBeNull();
    expect(JSON.parse(await readFile(f.file, 'utf8')).devices).toHaveLength(20);
    f.advance(LIFETIME); f.store.issue();
    expect(JSON.parse(await readFile(f.file, 'utf8')).devices).toHaveLength(1);
  });

  it('does not issue remembered credentials for a missing or short access code', async () => {
    const f = await fixture();
    for (const code of ['', 'short']) expect(() => f.createStore(code).issue()).toThrow('NOT_CONFIGURED');
  });
});
