import * as db from '#server/db';

import {
  findDuplicateTransactions,
  findMergeableDuplicateGroups,
} from './find-duplicates';

beforeEach(global.emptyDatabase());
afterEach(global.emptyDatabase());

async function prepareDatabase() {
  await db.insertAccount({ id: 'one', name: 'one' });
  await db.insertAccount({ id: 'two', name: 'two' });
}

describe('findDuplicateTransactions', () => {
  beforeEach(prepareDatabase);

  it('returns nothing when there are no transactions', async () => {
    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('flags same-account transactions with the same amount within 7 days', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-05',
      amount: -1500,
    });

    expect((await findDuplicateTransactions()).sort()).toEqual([t1, t2].sort());
  });

  it('flags transactions exactly 7 days apart', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-08',
      amount: -1500,
    });

    expect((await findDuplicateTransactions()).sort()).toEqual([t1, t2].sort());
  });

  it('does not flag transactions more than 7 days apart', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-09',
      amount: -1500,
    });

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('does not flag transactions with different amounts', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1501,
    });

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('does not flag transactions in different accounts', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    await db.insertTransaction({
      account: 'two',
      date: '2025-01-01',
      amount: -1500,
    });

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('flags a chain of transactions that each overlap the 7 day window', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-06',
      amount: -1500,
    });
    const t3 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-12',
      amount: -1500,
    });

    expect((await findDuplicateTransactions()).sort()).toEqual(
      [t1, t2, t3].sort(),
    );
  });

  it('flags transactions sharing an imported id regardless of date', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-03-01',
      amount: -1500,
      imported_id: 'bank-1',
    });

    expect((await findDuplicateTransactions()).sort()).toEqual([t1, t2].sort());
  });

  it('does not flag the same imported id across different accounts', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });
    await db.insertTransaction({
      account: 'two',
      date: '2025-03-01',
      amount: -1500,
      imported_id: 'bank-1',
    });

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('does not flag postings of the same schedule', async () => {
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

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('flags a scheduled transaction against a matching unscheduled one', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
      schedule: 'sched1',
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-02',
      amount: -1500,
    });

    expect((await findDuplicateTransactions()).sort()).toEqual([t1, t2].sort());
  });

  it('matches splits by their total and includes their children', async () => {
    const parent1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1000,
      is_parent: true,
    });
    const child1a = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -500,
      is_child: true,
      parent_id: parent1,
    });
    const child1b = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -500,
      is_child: true,
      parent_id: parent1,
    });
    const parent2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-02',
      amount: -1000,
      is_parent: true,
    });
    const child2a = await db.insertTransaction({
      account: 'one',
      date: '2025-01-02',
      amount: -500,
      is_child: true,
      parent_id: parent2,
    });
    const child2b = await db.insertTransaction({
      account: 'one',
      date: '2025-01-02',
      amount: -500,
      is_child: true,
      parent_id: parent2,
    });

    expect((await findDuplicateTransactions()).sort()).toEqual(
      [parent1, child1a, child1b, parent2, child2a, child2b].sort(),
    );
  });

  it('does not match split children against other transactions', async () => {
    const parent = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1000,
      is_parent: true,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -500,
      is_child: true,
      parent_id: parent,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -500,
      is_child: true,
      parent_id: parent,
    });
    // Same amount as the children, but children never participate in
    // matching, so nothing is flagged.
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-02',
      amount: -500,
    });

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('does not flag deleted transactions', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -1500,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-05',
      amount: -1500,
    });
    await db.deleteTransaction({ id: t2 });

    expect(await findDuplicateTransactions()).toEqual([]);
  });

  it('scopes results to the requested account', async () => {
    const t1 = await db.insertTransaction({
      account: 'two',
      date: '2025-01-01',
      amount: -1500,
    });
    const t2 = await db.insertTransaction({
      account: 'two',
      date: '2025-01-05',
      amount: -1500,
    });

    expect(await findDuplicateTransactions({ accountId: 'one' })).toEqual([]);
    expect(
      (await findDuplicateTransactions({ accountId: 'two' })).sort(),
    ).toEqual([t1, t2].sort());
  });
});

describe('findMergeableDuplicateGroups', () => {
  beforeEach(prepareDatabase);

  it('returns nothing when there are no transactions', async () => {
    expect(await findMergeableDuplicateGroups()).toEqual({
      importedIdGroups: [],
      fuzzyPairs: [],
      skippedFuzzyGroups: 0,
    });
  });

  it('groups all transactions sharing an imported id, any size', async () => {
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
      date: '2025-01-01',
      amount: -1500,
      imported_id: 'bank-1',
    });

    const result = await findMergeableDuplicateGroups();
    expect(result.importedIdGroups.length).toBe(1);
    expect(result.importedIdGroups[0].sort()).toEqual([t1, t2, t3].sort());
    expect(result.fuzzyPairs).toEqual([]);
    expect(result.skippedFuzzyGroups).toBe(0);
  });

  it('returns an isolated fuzzy pair as mergeable', async () => {
    const t1 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -750,
    });
    const t2 = await db.insertTransaction({
      account: 'one',
      date: '2025-01-05',
      amount: -750,
    });

    const result = await findMergeableDuplicateGroups();
    expect(result.importedIdGroups).toEqual([]);
    expect(result.fuzzyPairs.length).toBe(1);
    expect(result.fuzzyPairs[0].sort()).toEqual([t1, t2].sort());
    expect(result.skippedFuzzyGroups).toBe(0);
  });

  it('leaves a fuzzy chain of 3+ out of fuzzyPairs and counts it as skipped', async () => {
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-01',
      amount: -5000,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-06',
      amount: -5000,
    });
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-12',
      amount: -5000,
    });

    const result = await findMergeableDuplicateGroups();
    expect(result.importedIdGroups).toEqual([]);
    expect(result.fuzzyPairs).toEqual([]);
    expect(result.skippedFuzzyGroups).toBe(1);
  });

  it('does not let a transaction already claimed by an imported-id group also pair up fuzzily', async () => {
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
    // Same amount, within the fuzzy window of t1/t2, but no imported id.
    // Should be left completely alone once t1/t2 are consumed by their
    // imported-id group, rather than pairing with either of them.
    await db.insertTransaction({
      account: 'one',
      date: '2025-01-02',
      amount: -1500,
    });

    const result = await findMergeableDuplicateGroups();
    expect(result.importedIdGroups.length).toBe(1);
    expect(result.importedIdGroups[0].sort()).toEqual([t1, t2].sort());
    expect(result.fuzzyPairs).toEqual([]);
    expect(result.skippedFuzzyGroups).toBe(0);
  });

  it('does not pair postings of the same schedule', async () => {
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

    const result = await findMergeableDuplicateGroups();
    expect(result.importedIdGroups).toEqual([]);
    expect(result.fuzzyPairs).toEqual([]);
    expect(result.skippedFuzzyGroups).toBe(0);
  });

  it('finds an unrelated imported-id pair and fuzzy pair independently', async () => {
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
      amount: -300,
    });
    const t4 = await db.insertTransaction({
      account: 'one',
      date: '2025-02-03',
      amount: -300,
    });

    const result = await findMergeableDuplicateGroups();
    expect(result.importedIdGroups.length).toBe(1);
    expect(result.importedIdGroups[0].sort()).toEqual([t1, t2].sort());
    expect(result.fuzzyPairs.length).toBe(1);
    expect(result.fuzzyPairs[0].sort()).toEqual([t3, t4].sort());
    expect(result.skippedFuzzyGroups).toBe(0);
  });

  it('scopes results to the requested account', async () => {
    const t1 = await db.insertTransaction({
      account: 'two',
      date: '2025-01-01',
      amount: -1500,
    });
    const t2 = await db.insertTransaction({
      account: 'two',
      date: '2025-01-05',
      amount: -1500,
    });

    expect(await findMergeableDuplicateGroups({ accountId: 'one' })).toEqual({
      importedIdGroups: [],
      fuzzyPairs: [],
      skippedFuzzyGroups: 0,
    });

    const result = await findMergeableDuplicateGroups({ accountId: 'two' });
    expect(result.fuzzyPairs.length).toBe(1);
    expect(result.fuzzyPairs[0].sort()).toEqual([t1, t2].sort());
  });
});
