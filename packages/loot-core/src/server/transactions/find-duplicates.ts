import * as db from '#server/db';
import * as monthUtils from '#shared/months';
import type { AccountEntity, TransactionEntity } from '#types/models';

// Potential duplicates follow the same semantics as the fuzzy matching used
// when reconciling imported transactions (see `matchTransactions` in
// `../accounts/sync.ts`): same account, same amount, and dates within 7 days
// of each other.
const DATE_WINDOW_DAYS = 7;

type CandidateRow = Pick<
  db.DbViewTransaction,
  | 'id'
  | 'account'
  | 'amount'
  | 'date'
  | 'imported_id'
  | 'schedule'
  | 'is_parent'
>;

function addToGroup(
  groups: Map<string, CandidateRow[]>,
  key: string,
  row: CandidateRow,
) {
  let group = groups.get(key);
  if (!group) {
    group = [];
    groups.set(key, group);
  }
  group.push(row);
}

export async function findDuplicateTransactions({
  accountId,
}: {
  accountId?: AccountEntity['id'];
} = {}): Promise<Array<TransactionEntity['id']>> {
  // Split children are excluded: subtransactions legitimately share dates
  // (and often amounts) with their siblings, and the parent transaction
  // already represents them.
  const rows = await db.all<CandidateRow>(
    `SELECT id, account, amount, date, imported_id, schedule, is_parent
     FROM v_transactions
     WHERE is_child = 0${accountId ? ' AND account = ?' : ''}`,
    accountId ? [accountId] : [],
  );

  const byImportedId = new Map<string, CandidateRow[]>();
  const byAmount = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (row.imported_id != null) {
      addToGroup(byImportedId, `${row.account}|${row.imported_id}`, row);
    }
    addToGroup(byAmount, `${row.account}|${row.amount}`, row);
  }

  const duplicateIds = new Set<TransactionEntity['id']>();

  // Transactions sharing a bank-provided import id are duplicates no matter
  // how far apart their dates are.
  for (const group of byImportedId.values()) {
    if (group.length > 1) {
      for (const row of group) {
        duplicateIds.add(row.id);
      }
    }
  }

  for (const group of byAmount.values()) {
    if (group.length < 2) {
      continue;
    }

    group.sort((a, b) => a.date - b.date);
    const dates = group.map(row => db.fromDateRepr(row.date));

    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (
          monthUtils.differenceInCalendarDays(dates[j], dates[i]) >
          DATE_WINDOW_DAYS
        ) {
          // The group is sorted by date, so every transaction after `j` is
          // outside the window too.
          break;
        }
        // Postings of the same schedule are expected to repeat with the same
        // amount, so they don't count as duplicates of each other.
        if (
          group[i].schedule != null &&
          group[i].schedule === group[j].schedule
        ) {
          continue;
        }
        duplicateIds.add(group[i].id);
        duplicateIds.add(group[j].id);
      }
    }
  }

  // Include the subtransactions of any flagged split transaction. The
  // returned ids feed an `id` filter on the register, and grouped-split
  // aggregates (like the filtered balance) only count child rows, so a
  // flagged parent without its children would be missing from the total.
  const flaggedParentIds = rows
    .filter(row => row.is_parent && duplicateIds.has(row.id))
    .map(row => row.id);
  for (const parentIds of chunk(flaggedParentIds, 500)) {
    const children = await db.all<Pick<db.DbViewTransaction, 'id'>>(
      `SELECT id FROM v_transactions
       WHERE is_child = 1 AND parent_id IN (${parentIds.map(() => '?').join(', ')})`,
      parentIds,
    );
    for (const child of children) {
      duplicateIds.add(child.id);
    }
  }

  return [...duplicateIds];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
