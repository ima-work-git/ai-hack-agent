import { createDecipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../server/sessions.ts';

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-session-test-'));
  directories.push(directory);
  let now = 1_000_000;
  const clock = () => now;
  return {
    directory, store: new SessionStore(directory, clock), clock,
    advance: (milliseconds: number) => { now += milliseconds; },
    file: (id: string) => join(directory, 'sessions', `${id}.enc`),
  };
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('session retention and cancellation (REQ-005, REQ-006, REQ-008)', () => {
  it('persists authenticated AES-256-GCM ciphertext without storing the bearer secret or plaintext input', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    session.lastInput = {
      text: 'synthetic-session-payload-123', requestId: 'fixture-request', subjectRevision: 1,
      mode: 'demo', scenario: 'normal',
    };
    f.store.save(session);
    const bytes = readFileSync(f.file(session.id));
    const key = readFileSync(join(f.directory, '.session-key'));
    expect(key.byteLength).toBe(32);
    expect(bytes.includes(Buffer.from(session.lastInput.text))).toBe(false);
    expect(bytes.includes(Buffer.from(token.split('.')[1]!))).toBe(false);
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    expect(JSON.parse(plaintext)).toEqual(session);
    expect(plaintext).not.toContain(token.split('.')[1]!);
    const restored = new SessionStore(f.directory, f.clock);
    expect(restored.authenticate(token)?.lastInput).toEqual(session.lastInput);
  });

  it('uses a fresh nonce for each save and drops tampered ciphertext on restart', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    const first = readFileSync(f.file(session.id));
    f.store.save(session);
    const second = readFileSync(f.file(session.id));
    expect(second.subarray(0, 12)).not.toEqual(first.subarray(0, 12));
    second[second.length - 1] = second[second.length - 1]! ^ 1;
    writeFileSync(f.file(session.id), second);
    const restored = new SessionStore(f.directory, f.clock);
    expect(restored.authenticate(token)).toBeNull();
    expect(existsSync(f.file(session.id))).toBe(false);
  });

  it('expires at exactly 15 minutes, aborts work, and deletes its persisted session', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    const controller = f.store.start(session);
    expect(session.expiresAt - f.clock()).toBe(15 * 60_000);
    f.advance(15 * 60_000 - 1);
    expect(f.store.authenticate(token)?.id).toBe(session.id);
    f.advance(1);
    expect(f.store.authenticate(token)).toBeNull();
    expect(f.store.get(session.id)).toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
    expect(f.store.finish(session.id, controller)).toBe(false);
    expect(existsSync(f.file(session.id))).toBe(false);
  });

  it('removes expired files during restart before accepting any credentials', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    f.advance(15 * 60_000);
    const restored = new SessionStore(f.directory, f.clock);
    expect(restored.authenticate(token)).toBeNull();
    expect(existsSync(f.file(session.id))).toBe(false);
  });

  it('logout immediately revokes access, aborts work, and prevents a stale save from restoring the file', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    const controller = f.store.start(session);
    f.store.end(session.id);
    expect(controller.signal.aborted).toBe(true);
    expect(f.store.authenticate(token)).toBeNull();
    expect(f.store.finish(session.id, controller)).toBe(false);
    f.store.save(session);
    expect(existsSync(f.file(session.id))).toBe(false);
    expect(new SessionStore(f.directory, f.clock).authenticate(token)).toBeNull();
  });

  it('re-login revokes the previous bearer token without extending the original retention deadline', () => {
    const f = fixture();
    const first = f.store.login();
    const deadline = first.session.expiresAt;
    f.advance(60_000);
    const second = f.store.login(first.session.id);
    expect(second.session.id).toBe(first.session.id);
    expect(second.token).not.toBe(first.token);
    expect(second.session.expiresAt).toBe(deadline);
    expect(f.store.authenticate(first.token)).toBeNull();
    expect(f.store.authenticate(second.token)?.id).toBe(first.session.id);
    const restored = new SessionStore(f.directory, f.clock);
    expect(restored.authenticate(first.token)).toBeNull();
    expect(restored.authenticate(second.token)?.id).toBe(first.session.id);
  });

  it('marks interrupted work on restart without resuming it or accepting its old controller', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    const oldController = f.store.start(session);
    expect(session.running).toBe(true);
    const restored = new SessionStore(f.directory, f.clock);
    const recovered = restored.authenticate(token)!;
    expect(recovered.running).toBe(false);
    expect(recovered.interrupted).toBe(true);
    expect(restored.finish(session.id, oldController)).toBe(false);
    const retry = restored.start(recovered);
    expect(recovered.interrupted).toBe(false);
    expect(recovered.running).toBe(true);
    expect(retry.signal.aborted).toBe(false);
  });

  it('refuses late completion after cancellation and keeps the state cancelled after restart', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    const controller = f.store.start(session);
    f.store.cancel(session.id);
    expect(controller.signal.aborted).toBe(true);
    expect(f.store.finish(session.id, controller)).toBe(false);
    expect(session.running).toBe(false);
    const recovered = new SessionStore(f.directory, f.clock).authenticate(token)!;
    expect(recovered.running).toBe(false);
    expect(recovered.interrupted).toBe(false);
    expect(recovered.result).toBeUndefined();
  });

  it('allows only the current operation to finish, once, when a newer request supersedes work', () => {
    const f = fixture();
    const { session } = f.store.login();
    const previous = f.store.start(session);
    const current = f.store.start(session);
    expect(previous.signal.aborted).toBe(true);
    expect(f.store.finish(session.id, previous)).toBe(false);
    expect(f.store.finish(session.id, current)).toBe(true);
    expect(f.store.finish(session.id, current)).toBe(false);
  });

  it('rejects malformed or forged credentials without exceptions', () => {
    const f = fixture();
    const { session, token } = f.store.login();
    for (const invalid of ['', 'invalid', token + '.extra', `${session.id}.${'f'.repeat(64)}`, `${'0'.repeat(32)}.${'0'.repeat(64)}`]) {
      expect(f.store.authenticate(invalid)).toBeNull();
    }
  });
});
