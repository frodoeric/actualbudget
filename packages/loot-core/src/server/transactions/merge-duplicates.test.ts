import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { undo } from '#server/undo';

import { mergeDuplicateTransactions } from './merge-duplicates';

beforeEach(global.emptyDatabase());
afterEach(global.emptyDatabase());

async function prepareDatabase() {
  await db.insertAccount({ id: 'one', name: 'one' });
  await db.insertAccount({ id: 'two', name: 'two' });
}

function getAliveTransactions() {
  return db.all<db.DbViewTransaction>(
    `SELECT * FROM v_transactions ORDER BY date, amount, id`,
  );
}

describe('mergeDuplicateTransactions', () => {
  beforeEach(prepareDatabase);

  it('does nothing when there are no duplicates', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });

    expect(await mergeDuplicateTransactions()).toEqual({
      mergedCount: 0,
      groupCount: 0,
      skippedCount: 0,
    });
  });

  it('merges a pair sharing an imported id', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
      cleared: true,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
      cleared: false,
      reconciled: false,
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 1, groupCount: 1, skippedCount: 0 });

    const remaining = await getAliveTransactions();
    expect(remaining.length).toBe(1);
    expect(remaining[0].imported_id).toBe('bank-1');
    // OR-merge should keep the fact that one of the two copies was cleared,
    // regardless of which one physically survives.
    expect(!!remaining[0].cleared).toBe(true);
    expect([t1, t2]).toContain(remaining[0].id);
  });

  it('collapses an imported-id group of 3 down to 1', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 2, groupCount: 1, skippedCount: 0 });

    const remaining = await getAliveTransactions();
    expect(remaining.length).toBe(1);
  });

  it('merges an isolated fuzzy pair with no imported id', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -750,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-05',
      amount: -750,
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 1, groupCount: 1, skippedCount: 0 });

    const remaining = await getAliveTransactions();
    expect(remaining.length).toBe(1);
  });

  it('does NOT auto-merge a fuzzy chain of 3+ (ambiguous, needs manual review)', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -5000,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-06',
      amount: -5000,
    });
    const t3 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-12',
      amount: -5000,
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 0, groupCount: 0, skippedCount: 1 });

    const remaining = await getAliveTransactions();
    expect(remaining.map(t => t.id).sort()).toEqual([t1, t2, t3].sort());
  });

  it('does not merge postings of the same schedule', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      schedule: 'sched1',
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-08',
      amount: -1500,
      schedule: 'sched1',
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 0, groupCount: 0, skippedCount: 0 });

    const remaining = await getAliveTransactions();
    expect(remaining.length).toBe(2);
  });

  it('handles a mix of a mergeable imported-id pair and a skipped fuzzy chain together', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-03-01',
      amount: -5000,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-03-06',
      amount: -5000,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-03-12',
      amount: -5000,
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 1, groupCount: 1, skippedCount: 1 });

    const remaining = await getAliveTransactions();
    expect(remaining.length).toBe(4); // 1 survivor + the untouched chain of 3
  });

  it('merges a duplicated split transaction (same imported id) down to one, keeping its children', async () => {
    const parent1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1000,
      imported_id: 'bank-split',
      is_parent: true,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -600,
      category: '1',
      is_child: true,
      parent_id: parent1,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -400,
      category: '2',
      is_child: true,
      parent_id: parent1,
    });

    const parent2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1000,
      imported_id: 'bank-split',
      is_parent: true,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -600,
      is_child: true,
      parent_id: parent2,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -400,
      is_child: true,
      parent_id: parent2,
    });

    const result = await mergeDuplicateTransactions();
    expect(result).toEqual({ mergedCount: 1, groupCount: 1, skippedCount: 0 });

    const remaining = await getAliveTransactions();
    const parents = remaining.filter(t => t.is_parent);
    const children = remaining.filter(t => t.is_child);
    expect(parents.length).toBe(1);
    expect(children.length).toBe(2);
    expect(children.every(c => c.parent_id === parents[0].id)).toBe(true);
    expect(children.map(c => c.amount).sort((a, b) => a - b)).toEqual(
      [-600, -400].sort((a, b) => a - b),
    );
  });

  it('scopes merging to the requested account', async () => {
    await db.insertTransaction({
      account: 'two',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    await db.insertTransaction({
      account: 'two',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });

    const scopedToOne = await mergeDuplicateTransactions({ accountId: 'one' });
    expect(scopedToOne).toEqual({
      mergedCount: 0,
      groupCount: 0,
      skippedCount: 0,
    });
    expect((await getAliveTransactions()).length).toBe(2);

    const scopedToTwo = await mergeDuplicateTransactions({ accountId: 'two' });
    expect(scopedToTwo).toEqual({
      mergedCount: 1,
      groupCount: 1,
      skippedCount: 0,
    });
    expect((await getAliveTransactions()).length).toBe(1);
  });
});

describe('mergeDuplicateTransactions undo', () => {
  beforeEach(global.emptyDatabase());
  beforeEach(prepareDatabase);
  afterEach(global.emptyDatabase());

  it('undoes an entire batch of merges in a single step', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    const t3 = await db.insertTransaction({
      account: 'one',
      date: '2025-02-01',
      amount: -2000,
    });
    const t4 = await db.insertTransaction({
      account: 'one',
      date: '2025-02-04',
      amount: -2000,
    });

    const result = await runHandler(
      handlers['transactions-merge-duplicates'],
      {},
    );
    expect(result.mergedCount).toBe(2);
    expect(result.groupCount).toBe(2);
    expect((await getAliveTransactions()).length).toBe(2);

    await undo();

    const restored = await getAliveTransactions();
    expect(restored.map(t => t.id).sort()).toEqual([t1, t2, t3, t4].sort());
  });
});
