import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const MAX_LIFETIME_MS = 48 * 60 * 60_000;
const TOKEN = /^[a-f0-9]{64}$/;
const GrantSchema = z.object({ tokenHash: z.string().regex(TOKEN), expiresAt: z.number().int().safe().positive() }).strict();
const DataSchema = z.object({ version: z.literal(1), grants: z.array(GrantSchema).max(5) }).strict();
const FileSchema = DataSchema.extend({ mac: z.string().regex(TOKEN) }).strict();
type Data = z.infer<typeof DataSchema>;
type ErrorCode = 'NOT_CONFIGURED' | 'INVALID_EXPIRY' | 'CAPACITY' | 'INVALID_STORE';

export class ReusableQrError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.name = 'ReusableQrError'; this.code = code; }
}

/** Fixed-expiry login grants only. No raw tickets, session identifiers or conversations. */
export class ReusableQrStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly accessCode: string;
  private readonly now: () => number;

  constructor(directory: string, accessCode: string, now = Date.now) {
    this.directory = directory; this.accessCode = accessCode; this.now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'reusable-qr.json');
  }

  issue(expiresAt: number): { ticket: string; expiresAt: number } {
    if (this.accessCode.length < 16) throw new ReusableQrError('NOT_CONFIGURED');
    const now = this.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS) throw new ReusableQrError('INVALID_EXPIRY');
    const data = this.read();
    if (!data) throw new ReusableQrError('INVALID_STORE');
    data.grants = data.grants.filter(grant => grant.expiresAt > now);
    if (data.grants.length >= 5) throw new ReusableQrError('CAPACITY');
    const ticket = randomBytes(32).toString('hex');
    data.grants.push({ tokenHash: this.hash(ticket), expiresAt });
    this.write(data);
    return { ticket, expiresAt };
  }

  authenticate(ticket?: string): { expiresAt: number } | null {
    if (this.accessCode.length < 16 || !ticket || !TOKEN.test(ticket)) return null;
    const data = this.read(); if (!data) return null;
    const hash = Buffer.from(this.hash(ticket), 'hex');
    const grant = data.grants.find(item => timingSafeEqual(hash, Buffer.from(item.tokenHash, 'hex')));
    // Repeated scans and process restart never extend this fixed deadline.
    return grant && grant.expiresAt > this.now() ? { expiresAt: grant.expiresAt } : null;
  }

  revoke(ticket?: string): void {
    const data = this.read(); if (!data) return;
    const hash = ticket && TOKEN.test(ticket) ? this.hash(ticket) : undefined;
    const remaining = data.grants.filter(grant => grant.expiresAt > this.now() && grant.tokenHash !== hash);
    if (remaining.length !== data.grants.length) this.write({ version: 1, grants: remaining });
  }

  sweep(): void { this.revoke(); }

  private hash(ticket: string): string { return createHash('sha256').update(ticket).digest('hex'); }
  private signature(data: Data): string {
    return createHmac('sha256', this.accessCode).update('reusable-qr-v1\0').update(JSON.stringify(data)).digest('hex');
  }
  private read(): Data | null {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, grants: [] }; throw error; }
    if (raw.length > 10_000) return null;
    try {
      const { mac, ...data } = FileSchema.parse(JSON.parse(raw));
      if (new Set(data.grants.map(grant => grant.tokenHash)).size !== data.grants.length) return null;
      if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.signature(data), 'hex'))) return null;
      return data;
    } catch { return null; }
  }
  private write(data: Data): void {
    DataSchema.parse(data);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ ...data, mac: this.signature(data) })); fsyncSync(fd);
      closeSync(fd); fd = undefined; renameSync(temporary, this.file);
      const directoryFd = openSync(this.directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* Preserve the original write failure. */ }
      throw error;
    }
  }
}
