import type { ResearchResult, Target } from './shared/contracts.ts';

export interface PersonHistoryEntry {
  id: string;
  target: Target;
  recognizedAt: number;
  expiresAt: number;
  result?: ResearchResult;
  status: 'researching' | 'ready' | 'partial' | 'unconfirmed' | 'failed' | 'empty';
}

const RETENTION_MS = 15 * 60_000;
const MAX_PEOPLE = 30;
// Spelling normalization only: no honorific removal, company alias inference,
// homophone correction, or assumption that an absent company matches one.
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '')
  .replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60)).toLowerCase();
const targetKey = (target: Target) => JSON.stringify([normalize(target.personName), normalize(target.companyName)]);

interface StoredEntry { entry: PersonHistoryEntry; timer: ReturnType<typeof setTimeout> }

/** Session-memory snapshots only. Reading or recognizing someone again cannot
 * extend the original retention deadline or a source card's own deadline. */
export class PersonHistory {
  private readonly people = new Map<string, StoredEntry>();

  rememberTarget(target: Target, now = Date.now()): string {
    this.prune(now);
    const key = targetKey(target);
    const existing = this.people.get(key);
    if (existing) return existing.entry.id;
    while (this.people.size >= MAX_PEOPLE) this.remove(this.people.keys().next().value!);
    const entry: PersonHistoryEntry = { id: crypto.randomUUID(), target: structuredClone(target),
      recognizedAt: now, expiresAt: now + RETENTION_MS, status: 'researching' };
    const timer = setTimeout(() => {
      if (this.people.get(key)?.entry.id === entry.id) this.remove(key);
    }, RETENTION_MS);
    // Node tests/tooling must not stay alive just to retain browser memory.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.people.set(key, { entry, timer });
    return entry.id;
  }

  rememberResult(result: ResearchResult, now = Date.now()): string | null {
    this.prune(now);
    if (!result.target) return null;
    const id = this.rememberTarget(result.target, now);
    const entry = this.people.get(targetKey(result.target))!.entry;
    const snapshot = structuredClone(result);
    this.trimResult(snapshot, now);
    if (snapshot.status === 'awaiting_confirmation') {
      // A later identity conflict revokes old cards, even for an equal name.
      snapshot.cards = []; snapshot.sources = [];
      entry.result = snapshot; entry.status = 'unconfirmed';
    } else if (snapshot.cards.length) {
      // Progressive results are complete snapshots, never unions of facts from
      // different research requests (whose IDs or evidence may differ).
      entry.result = snapshot;
      entry.status = snapshot.status === 'ready' ? 'ready' : 'partial';
      if (entry.status === 'partial') snapshot.status = 'partial';
    } else if (entry.result?.cards.length) {
      entry.result.status = 'partial'; entry.status = 'partial';
    } else {
      entry.result = snapshot;
      entry.status = snapshot.status === 'failed' ? 'failed' : 'empty';
    }
    return id;
  }

  entries(now = Date.now()): PersonHistoryEntry[] {
    this.prune(now);
    return [...this.people.values()].map(({ entry }) => structuredClone(entry));
  }

  get(id: string, now = Date.now()): PersonHistoryEntry | undefined {
    this.prune(now);
    const found = [...this.people.values()].find(({ entry }) => entry.id === id);
    return found ? structuredClone(found.entry) : undefined;
  }

  clear(): void { for (const key of this.people.keys()) this.remove(key); }

  private remove(key: string): void {
    const stored = this.people.get(key);
    if (stored) clearTimeout(stored.timer);
    this.people.delete(key);
  }

  private trimResult(result: ResearchResult, now: number): void {
    const sources = new Set(result.sources.map(source => source.sourceId));
    result.cards = result.cards.filter(card => Date.parse(card.expiresAt) > now &&
      card.requestId === result.requestId && card.subjectRevision === result.subjectRevision && sources.has(card.sourceId));
    const referenced = new Set(result.cards.map(card => card.sourceId));
    result.sources = result.sources.filter(source => referenced.has(source.sourceId));
  }

  private prune(now: number): void {
    for (const [key, { entry }] of this.people) {
      if (entry.expiresAt <= now) { this.remove(key); continue; }
      if (!entry.result) continue;
      const count = entry.result.cards.length;
      this.trimResult(entry.result, now);
      if (count && !entry.result.cards.length) entry.status = 'empty';
      else if (count > entry.result.cards.length) { entry.status = 'partial'; entry.result.status = 'partial'; }
    }
  }
}
