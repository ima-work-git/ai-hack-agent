import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../server/budget.ts';

const directories: string[] = [];
async function config() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-hack-budget-'));
  directories.push(directory);
  return { directory, currency: 'USD' as const, runLimitUsd: 0.5, dayLimitUsd: 1, eventLimitUsd: 2 };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('persistent spending limits', () => {
  it('rejects missing budgets and unknown estimates before spending', async () => {
    const settings = await config();
    expect(() => new BudgetLedger({ ...settings, dayLimitUsd: NaN })).toThrow('BUDGET_NOT_CONFIGURED');
    const ledger = new BudgetLedger(settings);
    await expect(ledger.reserve(randomUUID(), NaN)).rejects.toThrow('INVALID_COST');
    await expect(ledger.reserve('a-person-name', 0.1)).rejects.toThrow('INVALID_BUDGET_RUN_ID');
  });
  it('retains unknown reservations across restart and settles only known charges', async () => {
    const settings = await config();
    const run = randomUUID();
    const ledger = new BudgetLedger(settings);
    const held = await ledger.reserve(run, 0.4);
    await ledger.settle(held, null);
    const restarted = new BudgetLedger(settings);
    expect(await restarted.snapshot(run)).toMatchObject({ costKnown: false, reservedUsd: 0.4, actualUsd: 0 });
    await expect(restarted.reserve(run, 0.2)).rejects.toThrow('BUDGET_EXHAUSTED');
    await restarted.settle(held, 0.1);
    expect(await restarted.snapshot(run)).toMatchObject({ costKnown: true, reservedUsd: 0, actualUsd: 0.1 });
    await expect(restarted.settle(held, 0.1)).rejects.toThrow('RESERVATION_NOT_FOUND');
  });
  it('serializes competing processes/instances so the day cap cannot be overspent', async () => {
    const settings = { ...await config(), runLimitUsd: 1, dayLimitUsd: 1 };
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => new BudgetLedger(settings).reserve(randomUUID(), 0.4)));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect((await new BudgetLedger(settings).snapshot(randomUUID())).dayUsedUsd).toBe(0.8);
  });
  it('keeps event costs after day rollover and records an estimate overrun', async () => {
    const settings = { ...await config(), runLimitUsd: 1, dayLimitUsd: 1, eventLimitUsd: 1 };
    let clock = Date.parse('2026-09-22T00:00:00Z');
    const ledger = new BudgetLedger({ ...settings, now: () => clock });
    const held = await ledger.reserve(randomUUID(), 0.5);
    await ledger.settle(held, 1.1);
    clock += 86_400_000;
    expect(await ledger.snapshot(randomUUID())).toMatchObject({ dayUsedUsd: 0, eventUsedUsd: 1.1 });
    await expect(ledger.reserve(randomUUID(), 0)).rejects.toThrow('BUDGET_EXHAUSTED');
  });
  it('does not treat corrupt persistence as an empty budget', async () => {
    const settings = await config();
    await writeFile(join(settings.directory, 'budget.json'), '{broken');
    await expect(new BudgetLedger(settings).reserve(randomUUID(), 0.1)).rejects.toThrow('BUDGET_LEDGER_INVALID');
  });
  it('suspends only amount stops inside the fixed window while retaining accounting across restarts', async () => {
    const startsAt = Date.parse('2026-09-22T00:00:00+09:00');
    const endsAt = Date.parse('2026-09-24T00:00:00+09:00');
    let clock = startsAt - 1;
    const settings = { ...await config(), now: () => clock, limitSuspension: { startsAt, endsAt } };
    const run = randomUUID(); const ledger = new BudgetLedger(settings);
    await expect(ledger.reserve(run, 3)).rejects.toThrow('BUDGET_EXHAUSTED');
    clock = startsAt;
    const held = await ledger.reserve(run, 3); await ledger.settle(held, null);
    const restarted = new BudgetLedger(settings);
    expect(await restarted.snapshot(run)).toMatchObject({ costKnown: false, reservedUsd: 3, dayUsedUsd: 3, eventUsedUsd: 3 });
    await expect(restarted.reserve(run, NaN)).rejects.toThrow('INVALID_COST');
    await expect(restarted.reserve('not-a-run', 0.1)).rejects.toThrow('INVALID_BUDGET_RUN_ID');
    clock = endsAt - 1;
    const last = await restarted.reserve(run, 4); await restarted.settle(last, 2);
    clock = endsAt;
    expect(await restarted.snapshot(run)).toMatchObject({ costKnown: false, actualUsd: 2, reservedUsd: 3, eventUsedUsd: 5 });
    await expect(restarted.reserve(run, 0.1)).rejects.toThrow('BUDGET_EXHAUSTED');
    await expect(new BudgetLedger(settings).reserve(randomUUID(), 0.1)).rejects.toThrow('BUDGET_EXHAUSTED');
    await restarted.settle(held, 1);
    expect(await restarted.snapshot(run)).toMatchObject({ costKnown: true, actualUsd: 3, reservedUsd: 0, eventUsedUsd: 3 });
  });
  it('rejects invalid suspension windows and still fails closed on a corrupt ledger during suspension', async () => {
    const settings = await config(); const startsAt = Date.parse('2026-09-22T00:00:00Z');
    for (const endsAt of [NaN, Infinity, startsAt, startsAt - 1, startsAt + 48 * 60 * 60_000 + 1]) {
      expect(() => new BudgetLedger({ ...settings, limitSuspension: { startsAt, endsAt } })).toThrow('INVALID_BUDGET_SUSPENSION');
    }
    await writeFile(join(settings.directory, 'budget.json'), '{broken');
    await expect(new BudgetLedger({ ...settings, now: () => startsAt, limitSuspension: { startsAt, endsAt: startsAt + 1000 } }).reserve(randomUUID(), 3)).rejects.toThrow('BUDGET_LEDGER_INVALID');
  });
  it('stores only opaque accounting IDs and amount totals', async () => {
    const settings = await config();
    await new BudgetLedger(settings).reserve(randomUUID(), 0);
    const persisted = JSON.parse(await readFile(join(settings.directory, 'budget.json'), 'utf8'));
    expect(Object.keys(persisted)).toEqual(['version', 'currency', 'event', 'days', 'runs', 'reservations']);
    expect(Object.values(persisted.reservations)[0]).toEqual(expect.objectContaining({ maximum: 0 }));
  });
});
