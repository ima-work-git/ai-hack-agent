import type { IncomingMessage } from 'node:http';
import { z } from 'zod';

export const GlassesMirrorSchema = z.object({
  view: z.object({
    header: z.string().max(1000), content: z.string().max(8000), footer: z.string().max(2000),
    textSize: z.literal('small').optional(),
  }).strict().nullable(),
  state: z.string().max(100),
  reason: z.string().max(1000).optional(),
}).strict();
export type GlassesMirrorFrame = z.infer<typeof GlassesMirrorSchema> & { updatedAt: number };

/** The unauthenticated monitor is accessible only directly on this computer. */
export function isLocalMirrorReader(req: IncomingMessage, port: number): boolean {
  const address = req.socket.remoteAddress;
  if (!address || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const host = req.headers.host?.toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return false;
  if (req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

/** Ephemeral display state only: neither frames nor session IDs are written to disk. */
export class GlassesMirrorStore {
  private readonly frames = new Map<string, GlassesMirrorFrame>();
  private readonly validSession: (id: string) => boolean;
  private readonly now: () => number;
  constructor(validSession: (id: string) => boolean, now = Date.now) { this.validSession = validSession; this.now = now; }
  publish(sessionId: string, payload: z.infer<typeof GlassesMirrorSchema>): void {
    this.sweep();
    this.frames.delete(sessionId);
    while (this.frames.size >= 20) this.frames.delete(this.frames.keys().next().value!);
    this.frames.set(sessionId, { ...payload, updatedAt: this.now() });
  }
  latest(): GlassesMirrorFrame | null {
    this.sweep();
    return [...this.frames.values()].at(-1) ?? null;
  }
  sweep(): void {
    for (const [id, frame] of this.frames) if (!this.validSession(id) || this.now() - frame.updatedAt >= 120_000) this.frames.delete(id);
  }
  delete(sessionId: string): void { this.frames.delete(sessionId); }
  clear(): void { this.frames.clear(); }
}
