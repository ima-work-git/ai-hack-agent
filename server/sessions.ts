import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ResearchInputSchema, ResearchResultSchema } from '../src/shared/contracts.ts';

const SessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number(), hardExpiresAt: z.number().int().optional(), dataExpiresAt: z.number().int().optional(),
  revision: z.number().int().nonnegative(),
  running: z.boolean(), interrupted: z.boolean(),
  requestIds: z.array(z.string().uuid()).max(100).default([]),
  lastInput: ResearchInputSchema.optional(), result: ResearchResultSchema.optional(),
}).strict();
export type Session = z.infer<typeof SessionSchema>;
const IDLE_TTL = 15 * 60_000;
const HARD_TTL = 12 * 60 * 60_000;
export class SessionStore {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly sessions = new Map<string, Session>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;
  constructor(directory: string, now = Date.now) {
    this.directory = join(directory, 'sessions'); this.now = now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyFile = join(directory, '.session-key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Invalid local session encryption key');
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{32}\.enc$/.test(name)) continue;
      try {
        const bytes = readFileSync(join(this.directory, name));
        const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const session = SessionSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()));
        // Legacy sessions have no creation time; never infer a new twelve-hour grant.
        session.hardExpiresAt ??= session.expiresAt;
        session.dataExpiresAt ??= session.expiresAt;
        if (session.id + '.enc' !== name || this.isExpired(session)) throw new Error('Expired');
        if (session.running) { session.running = false; session.interrupted = true; }
        this.sessions.set(session.id, session);
        this.save(session);
      } catch { unlinkSync(join(this.directory, name)); }
    }
  }
  login(previousId?: string): { session: Session; token: string } {
    this.sweep();
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (!session && this.sessions.size >= 20) throw new Error('Session capacity reached');
    const secret = randomBytes(32).toString('hex');
    if (!session) {
      const currentTime = this.now();
      session = { id: randomBytes(16).toString('hex'), tokenHash: '', expiresAt: currentTime + IDLE_TTL,
        hardExpiresAt: currentTime + HARD_TTL, dataExpiresAt: currentTime + IDLE_TTL,
        revision: 0, running: false, interrupted: false, requestIds: [] };
    }
    // A new login revokes prior bearer credentials, including after a browser reload.
    session.tokenHash = createHash('sha256').update(secret).digest('hex');
    this.sessions.set(session.id, session); this.save(session);
    return { session, token: `${session.id}.${secret}` };
  }
  authenticate(token: string): Session | null {
    if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return null;
    const [id, secret] = token.split('.');
    const session = this.get(id!);
    if (!session) return null;
    const hash = createHash('sha256').update(secret!).digest();
    return timingSafeEqual(hash, Buffer.from(session.tokenHash, 'hex')) ? session : null;
  }
  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session && this.isExpired(session)) { this.end(id); return undefined; }
    if (session && this.expirePayload(session)) this.save(session);
    return session;
  }
  /** Refresh idle authentication only; never resurrect or extend a hard grant. */
  touch(id: string, maximumExpiresAt?: number): Session | undefined {
    const session = this.get(id); const currentTime = this.now();
    if (!session || maximumExpiresAt !== undefined && (!Number.isSafeInteger(maximumExpiresAt) || maximumExpiresAt <= currentTime)) return undefined;
    const hardExpiresAt = session.hardExpiresAt ?? session.expiresAt;
    if (session.expiresAt <= currentTime || hardExpiresAt <= currentTime) { this.end(id); return undefined; }
    session.hardExpiresAt = Math.min(hardExpiresAt, maximumExpiresAt ?? hardExpiresAt);
    session.expiresAt = Math.min(currentTime + IDLE_TTL, session.hardExpiresAt);
    this.save(session); return session;
  }
  private isExpired(session: Session): boolean {
    const currentTime = this.now();
    return session.expiresAt <= currentTime || (session.hardExpiresAt ?? session.expiresAt) <= currentTime;
  }
  private expirePayload(session: Session): boolean {
    const currentTime = this.now();
    if (session.dataExpiresAt !== undefined && session.dataExpiresAt > currentTime) return false;
    // All writes share a fixed retention window. Newer results do not slide it.
    if (session.dataExpiresAt !== undefined) { delete session.lastInput; delete session.result; }
    session.dataExpiresAt = Math.min(currentTime + IDLE_TTL, session.hardExpiresAt ?? session.expiresAt);
    return true;
  }
  save(session: Session): void {
    if (!this.sessions.has(session.id) || this.isExpired(session)) return;
    this.expirePayload(session);
    SessionSchema.parse(session);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
    const bytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    const file = join(this.directory, session.id + '.enc'), temp = file + '.tmp';
    writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, file);
  }
  start(session: Session): AbortController {
    this.cancel(session.id);
    const controller = new AbortController();
    this.controllers.set(session.id, controller); session.running = true; session.interrupted = false; this.save(session);
    return controller;
  }
  cancel(id: string): void {
    this.controllers.get(id)?.abort(); this.controllers.delete(id);
    const session = this.sessions.get(id);
    if (session) { session.running = false; this.save(session); }
  }
  finish(id: string, controller: AbortController): boolean {
    if (this.controllers.get(id) !== controller || controller.signal.aborted || !this.get(id)) return false;
    this.controllers.delete(id); return true;
  }
  end(id: string): void {
    this.controllers.get(id)?.abort(); this.controllers.delete(id); this.sessions.delete(id);
    const file = join(this.directory, id + '.enc');
    if (/^[a-f0-9]{32}$/.test(id) && existsSync(file)) unlinkSync(file);
  }
  sweep(): void { for (const session of this.sessions.values()) this.get(session.id); }
  close(): void { for (const id of this.controllers.keys()) this.cancel(id); }
}
