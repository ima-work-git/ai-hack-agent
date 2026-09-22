import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface BudgetConfig {
  directory: string;
  currency: 'USD';
  runLimitUsd: number;
  dayLimitUsd: number;
  eventLimitUsd: number;
  limitSuspension?: { startsAt: number; endsAt: number };
  now?: () => number;
}

export class BudgetError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'BudgetError'; }
}

export interface BudgetReservation { id: string; }
interface Totals { spent: number; reserved: number; }
interface Reservation { runId: string; day: string; maximum: number; }
interface LedgerData {
  version: 1;
  currency: 'USD';
  event: Totals;
  days: Record<string, Totals>;
  runs: Record<string, Totals>;
  reservations: Record<string, Reservation>;
}
export interface BudgetSnapshot {
  currency: 'USD';
  costKnown: boolean;
  actualUsd: number;
  reservedUsd: number;
  dayUsedUsd: number;
  eventUsedUsd: number;
}

const SCALE = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const zero = (): Totals => ({ spent: 0, reserved: 0 });
const amount = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new BudgetError('INVALID_COST');
  return Math.ceil(value * SCALE);
};

/** Anonymous cost aggregates only. No transcripts, names, URLs, keys or session IDs. */
export class BudgetLedger {
  private readonly limits: { run: number; day: number; event: number };
  private readonly file: string;
  private readonly lock: string;
  private readonly now: () => number;
  private readonly config: BudgetConfig;
  private readonly limitSuspension?: { startsAt: number; endsAt: number };

  constructor(config: BudgetConfig) {
    this.config = config;
    if (config.currency !== 'USD' || !config.directory ||
        ![config.runLimitUsd, config.dayLimitUsd, config.eventLimitUsd].every(v => Number.isFinite(v) && v > 0)) {
      throw new BudgetError('BUDGET_NOT_CONFIGURED');
    }
    this.limits = { run: amount(config.runLimitUsd), day: amount(config.dayLimitUsd), event: amount(config.eventLimitUsd) };
    if (config.limitSuspension) {
      const { startsAt, endsAt } = config.limitSuspension;
      if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= startsAt || endsAt - startsAt > 48 * 60 * 60_000) throw new BudgetError('INVALID_BUDGET_SUSPENSION');
      this.limitSuspension = { startsAt, endsAt };
    }
    this.file = join(config.directory, 'budget.json');
    this.lock = join(config.directory, 'budget.lock');
    this.now = config.now ?? Date.now;
  }

  async reserve(runId: string, maximumUsd: number): Promise<BudgetReservation> {
    if (!UUID.test(runId)) throw new BudgetError('INVALID_BUDGET_RUN_ID');
    const maximum = amount(maximumUsd);
    return this.transaction(data => {
      const currentTime = this.now();
      const day = new Date(currentTime).toISOString().slice(0, 10); // UTC accounting day.
      const run = data.runs[runId] ?? zero();
      const daily = data.days[day] ?? zero();
      const checks: [Totals, number][] = [[run, this.limits.run], [daily, this.limits.day], [data.event, this.limits.event]];
      const limitsSuspended = this.limitSuspension && currentTime >= this.limitSuspension.startsAt && currentTime < this.limitSuspension.endsAt;
      if (!limitsSuspended && checks.some(([total, limit]) => total.spent + total.reserved + maximum > limit)) throw new BudgetError('BUDGET_EXHAUSTED');
      const id = randomUUID();
      data.runs[runId] = run;
      data.days[day] = daily;
      for (const [total] of checks) total.reserved += maximum;
      data.reservations[id] = { runId, day, maximum };
      return { id };
    });
  }

  /** Unknown/failed requests retain the full reservation, including across restarts. */
  async settle(reservation: BudgetReservation, actualUsd: number | null): Promise<void> {
    if (actualUsd === null) return;
    const actual = amount(actualUsd);
    await this.transaction(data => {
      const held = data.reservations[reservation.id];
      if (!held) throw new BudgetError('RESERVATION_NOT_FOUND');
      for (const total of [data.runs[held.runId], data.days[held.day], data.event]) {
        if (!total || total.reserved < held.maximum) throw new BudgetError('BUDGET_LEDGER_INVALID');
        total.reserved -= held.maximum;
        total.spent += actual;
      }
      delete data.reservations[reservation.id];
      // If an upstream exceeds its estimate, record the real charge and block later spending.
    });
  }

  async snapshot(runId: string): Promise<BudgetSnapshot> {
    return this.transaction(data => {
      const run = data.runs[runId] ?? zero();
      const daily = data.days[new Date(this.now()).toISOString().slice(0, 10)] ?? zero();
      return {
        currency: 'USD', costKnown: !Object.values(data.reservations).some(r => r.runId === runId),
        actualUsd: run.spent / SCALE, reservedUsd: run.reserved / SCALE,
        dayUsedUsd: (daily.spent + daily.reserved) / SCALE,
        eventUsedUsd: (data.event.spent + data.event.reserved) / SCALE,
      };
    }, false);
  }

  private async transaction<T>(change: (data: LedgerData) => T, save = true): Promise<T> {
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    const started = Date.now();
    for (;;) {
      try { await mkdir(this.lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Never steal a stale lock: a crashed writer requires explicit recovery.
        if (Date.now() - started > 2_000) throw new BudgetError('BUDGET_LOCKED');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      const data = await this.read();
      const result = change(data);
      if (save) await this.write(data);
      return result;
    } finally { await rmdir(this.lock); }
  }

  private async read(): Promise<LedgerData> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, currency: 'USD', event: zero(), days: {}, runs: {}, reservations: {} };
      throw error;
    }
    let data: LedgerData;
    try { data = JSON.parse(raw) as LedgerData; } catch { throw new BudgetError('BUDGET_LEDGER_INVALID'); }
    const validTotals = (v: unknown): v is Totals => !!v && typeof v === 'object' &&
      ['spent', 'reserved'].every(k => Number.isSafeInteger((v as Record<string, number>)[k]) && (v as Record<string, number>)[k]! >= 0);
    if (!data || data.version !== 1 || data.currency !== 'USD' || !validTotals(data.event) ||
        !data.days || !data.runs || !data.reservations ||
        !Object.values(data.days).every(validTotals) || !Object.values(data.runs).every(validTotals)) throw new BudgetError('BUDGET_LEDGER_INVALID');
    for (const [id, r] of Object.entries(data.reservations)) {
      if (!UUID.test(id) || !r || !UUID.test(r.runId) || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) ||
          !Number.isSafeInteger(r.maximum) || r.maximum < 0 || !data.runs[r.runId] || !data.days[r.day]) throw new BudgetError('BUDGET_LEDGER_INVALID');
    }
    // A corrupt or truncated ledger must not silently reset the account's budget.
    for (const collection of [data.days, data.runs]) {
      if (Object.values(collection).reduce((sum, t) => sum + t.spent, 0) !== data.event.spent ||
          Object.values(collection).reduce((sum, t) => sum + t.reserved, 0) !== data.event.reserved) throw new BudgetError('BUDGET_LEDGER_INVALID');
    }
    if (Object.values(data.reservations).reduce((sum, r) => sum + r.maximum, 0) !== data.event.reserved) throw new BudgetError('BUDGET_LEDGER_INVALID');
    for (const [runId, total] of Object.entries(data.runs)) {
      if (!UUID.test(runId) || Object.values(data.reservations).filter(r => r.runId === runId).reduce((sum, r) => sum + r.maximum, 0) !== total.reserved) throw new BudgetError('BUDGET_LEDGER_INVALID');
    }
    for (const [day, total] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Object.values(data.reservations).filter(r => r.day === day).reduce((sum, r) => sum + r.maximum, 0) !== total.reserved) throw new BudgetError('BUDGET_LEDGER_INVALID');
    }
    return data;
  }

  private async write(data: LedgerData): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await rename(temporary, this.file);
      const directory = await open(this.config.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
}
