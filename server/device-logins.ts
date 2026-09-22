import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const LIFETIME_MS = 12 * 60 * 60_000;
const TOKEN = /^[a-f0-9]{64}$/;
const DeviceSchema = z.object({ tokenHash: z.string().regex(TOKEN), expiresAt: z.number().int().safe().positive() }).strict();
const DataSchema = z.object({ version: z.literal(1), devices: z.array(DeviceSchema).max(20) }).strict();
const FileSchema = DataSchema.extend({ mac: z.string().regex(TOKEN) }).strict();
type Data = z.infer<typeof DataSchema>;
type Device = z.infer<typeof DeviceSchema>;

export class DeviceLoginError extends Error {
  readonly code: 'NOT_CONFIGURED' | 'CAPACITY' | 'INVALID_EXPIRY';
  constructor(code: 'NOT_CONFIGURED' | 'CAPACITY' | 'INVALID_EXPIRY') { super(code); this.code = code; }
}

/** Independent login credentials only: no bearer tokens, session IDs or conversation data. */
export class DeviceLoginStore {
  private readonly file: string;
  private readonly accessCode: string;
  private readonly now: () => number;
  constructor(directory: string, accessCode: string, now = Date.now) {
    this.accessCode = accessCode; this.now = now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'device-logins.json');
  }

  issue(previousToken?: string, maximumExpiresAt?: number): { token: string; expiresAt: number } {
    if (this.accessCode.length < 16) throw new DeviceLoginError('NOT_CONFIGURED');
    if (maximumExpiresAt !== undefined && (!Number.isSafeInteger(maximumExpiresAt) || maximumExpiresAt <= this.now())) throw new DeviceLoginError('INVALID_EXPIRY');
    // Called after access-code or valid QR authentication. The caller supplies
    // a fixed maximum expiry for reusable QR credentials.
    const data = this.read() ?? { version: 1, devices: [] };
    const previousHash = previousToken && TOKEN.test(previousToken) ? this.hash(previousToken) : undefined;
    data.devices = data.devices.filter(device => device.expiresAt > this.now() && device.tokenHash !== previousHash);
    if (data.devices.length >= 20) throw new DeviceLoginError('CAPACITY');
    const token = randomBytes(32).toString('hex');
    const expiresAt = Math.min(this.now() + LIFETIME_MS, maximumExpiresAt ?? Infinity);
    data.devices.push({ tokenHash: this.hash(token), expiresAt });
    this.write(data);
    return { token, expiresAt };
  }

  authenticate(token?: string): Device | null {
    if (this.accessCode.length < 16 || !token || !TOKEN.test(token)) return null;
    const data = this.read();
    if (!data) return null;
    const hash = Buffer.from(this.hash(token), 'hex');
    const device = data.devices.find(item => timingSafeEqual(hash, Buffer.from(item.tokenHash, 'hex')));
    // Authentication never extends the original 12-hour deadline.
    return device && device.expiresAt > this.now() ? { ...device } : null;
  }

  revoke(token?: string): void {
    const data = this.read();
    if (!data) { this.write({ version: 1, devices: [] }); return; }
    const hash = token && TOKEN.test(token) ? this.hash(token) : undefined;
    const remaining = data.devices.filter(device => device.expiresAt > this.now() && device.tokenHash !== hash);
    if (remaining.length !== data.devices.length) this.write({ version: 1, devices: remaining });
  }

  sweep(): void { this.revoke(); }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  private signature(data: Data): string {
    // The current code authenticates metadata as well as invalidating all device
    // logins after a code change, without storing the access code on disk.
    return createHmac('sha256', this.accessCode).update('remembered-device-v1\0').update(JSON.stringify(data)).digest('hex');
  }
  private read(): Data | null {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, devices: [] }; throw error; }
    if (raw.length > 10_000) return null;
    try {
      const { mac, ...data } = FileSchema.parse(JSON.parse(raw));
      if (new Set(data.devices.map(device => device.tokenHash)).size !== data.devices.length) return null;
      if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.signature(data), 'hex'))) return null;
      return data;
    } catch { return null; }
  }
  private write(data: Data): void {
    DataSchema.parse(data);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...data, mac: this.signature(data) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, this.file); }
    catch (error) { try { unlinkSync(temporary); } catch { /* Preserve original write failure. */ } throw error; }
  }
}
