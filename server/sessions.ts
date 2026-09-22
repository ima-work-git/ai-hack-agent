import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ResearchInputSchema, ResearchResultSchema } from '../src/shared/contracts.ts';

const SessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number(), revision: z.number().int().nonnegative(),
  running: z.boolean(), interrupted: z.boolean(),
  requestIds: z.array(z.string().uuid()).max(100).default([]),
  lastInput: ResearchInputSchema.optional(), result: ResearchResultSchema.optional(),
}).strict();
export type Session = z.infer<typeof SessionSchema>;
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
        if (session.id + '.enc' !== name || session.expiresAt <= this.now()) throw new Error('Expired');
        if (session.running) { session.running = false; session.interrupted = true; }
        this.sessions.set(session.id, session);
      } catch { unlinkSync(join(this.directory, name)); }
    }
  }
  login(previousId?: string): { session: Session; token: string } {
    this.sweep();
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (!session && this.sessions.size >= 20) throw new Error('Session capacity reached');
    const secret = randomBytes(32).toString('hex');
    if (!session) session = { id: randomBytes(16).toString('hex'), tokenHash: '', expiresAt: this.now() + 15 * 60_000, revision: 0, running: false, interrupted: false, requestIds: [] };
    // A new login revokes prior bearer credentials, including after a browser reload.
    session.tokenHash = createHash('sha256').update(secret).digest('hex');
    this.sessions.set(session.id, session); this.save(session);
    return { session, token: `${session.id}.${secret}` };
  }
  authenticate(token: string): Session | null {
    if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return null;
    const [id, secret] = token.split('.');
    const session = this.sessions.get(id!);
    if (!session) return null;
    if (session.expiresAt <= this.now()) { this.end(session.id); return null; }
    const hash = createHash('sha256').update(secret!).digest();
    return timingSafeEqual(hash, Buffer.from(session.tokenHash, 'hex')) ? session : null;
  }
  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session && session.expiresAt <= this.now()) { this.end(id); return undefined; }
    return session;
  }
  save(session: Session): void {
    if (!this.sessions.has(session.id) || session.expiresAt <= this.now()) return;
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
  sweep(): void { for (const s of this.sessions.values()) if (s.expiresAt <= this.now()) this.end(s.id); }
  close(): void { for (const id of this.controllers.keys()) this.cancel(id); }
}
