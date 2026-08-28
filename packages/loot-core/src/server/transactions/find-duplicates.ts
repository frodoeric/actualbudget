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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchCandidateRows(
  accountId?: AccountEntity['id'],
): Promise<CandidateRow[]> {
  // Split children are excluded: subtransactions legitimately share dates
  // (and often amounts) with their siblings, and the parent transaction
  // already represents them.
  return db.all<CandidateRow>(
    `SELECT id, account, amount, date, imported_id, schedule, is_parent
     FROM v_transactions
     WHERE is_child = 0${accountId ? ' AND account = ?' : ''}`,
    accountId ? [accountId] : [],
  );
}

// Transactions sharing a bank-provided import id are duplicates no matter
// how far apart their dates are. Returns only groups of 2+.
function groupByImportedId(rows: CandidateRow[]): CandidateRow[][] {
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (row.imported_id != null) {
      addToGroup(groups, `${row.account}|${row.imported_id}`, row);
    }
  }
  return [...groups.values()].filter(group => group.length > 1);
}

function find(parent: Map<string, string>, id: string): string {
  const p = parent.get(id)!;
  if (p === id) {
    return id;
  }
  const root = find(parent, p);
  parent.set(id, root);
  return root;
}

function union(parent: Map<string, string>, a: string, b: string) {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) {
    parent.set(ra, rb);
  }
}

// Connects transactions with the same amount and a date within
// DATE_WINDOW_DAYS of another transaction in the group (chained: A-B-C can
// each be within the window of their neighbor without A and C being within
// the window of each other). Postings of the same schedule are expected to
// repeat with the same amount, so they never connect to each other. Returns
// the connected components (groups of 2+) of that graph.
function groupByFuzzyMatch(rows: CandidateRow[]): CandidateRow[][] {
  const byAmount = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    addToGroup(byAmount, `${row.account}|${row.amount}`, row);
  }

  const parent = new Map<string, string>();
  for (const row of rows) {
    parent.set(row.id, row.id);
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
        if (
          group[i].schedule != null &&
          group[i].schedule === group[j].schedule
        ) {
          continue;
        }
        union(parent, group[i].id, group[j].id);
      }
    }
  }

  const byRoot = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    addToGroup(byRoot, find(parent, row.id), row);
  }
  return [...byRoot.values()].filter(group => group.length > 1);
}

// Include the subtransactions of any flagged split transaction. The
// returned ids feed an `id` filter on the register, and grouped-split
// aggregates (like the filtered balance) only count child rows, so a
// flagged parent without its children would be missing from the total.
async function includeChildrenOfFlaggedParents(
  rows: CandidateRow[],
  ids: Set<TransactionEntity['id']>,
): Promise<void> {
  const flaggedParentIds = rows
    .filter(row => row.is_parent && ids.has(row.id))
    .map(row => row.id);

  for (const parentIds of chunk(flaggedParentIds, 500)) {
    const children = await db.all<Pick<db.DbViewTransaction, 'id'>>(
      `SELECT id FROM v_transactions
       WHERE is_child = 1 AND parent_id IN (${parentIds.map(() => '?').join(', ')})`,
      parentIds,
    );
    for (const child of children) {
      ids.add(child.id);
    }
  }
}

export async function findDuplicateTransactions({
  accountId,
}: {
  accountId?: AccountEntity['id'];
} = {}): Promise<Array<TransactionEntity['id']>> {
  const rows = await fetchCandidateRows(accountId);

  const duplicateIds = new Set<TransactionEntity['id']>();
  for (const group of groupByImportedId(rows)) {
    for (const row of group) {
      duplicateIds.add(row.id);
    }
  }
  for (const group of groupByFuzzyMatch(rows)) {
    for (const row of group) {
      duplicateIds.add(row.id);
    }
  }

  await includeChildrenOfFlaggedParents(rows, duplicateIds);

  return [...duplicateIds];
}

export type MergeableDuplicateGroups = {
  /** Groups of 2+ transactions sharing the same bank-provided imported id
   * within an account. These are certainly duplicates of the same bank
   * transaction, regardless of how many share it. */
  importedIdGroups: Array<Array<TransactionEntity['id']>>;
  /** Isolated pairs matched only by amount and a date within 7 days of each
   * other, with no other transaction chained onto either one. */
  fuzzyPairs: Array<[TransactionEntity['id'], TransactionEntity['id']]>;
  /** Number of fuzzy-matched groups of 3+ that were left out of
   * `fuzzyPairs`. A run of same-amount transactions spanning overlapping
   * date windows is exactly what a recurring expense (weekly groceries,
   * say) looks like, so collapsing it automatically risks destroying real,
   * distinct transactions -- those groups are surfaced only as a count, for
   * the caller to prompt manual review rather than merge unattended. */
  skippedFuzzyGroups: number;
};

// Like findDuplicateTransactions, but structured for automated merging
// instead of display: only groups that are safe to collapse without human
// judgment are returned as mergeable. Transactions already claimed by an
// imported-id group are removed before fuzzy-matching the rest, so a
// transaction is never a candidate in more than one returned group.
export async function findMergeableDuplicateGroups({
  accountId,
}: {
  accountId?: AccountEntity['id'];
} = {}): Promise<MergeableDuplicateGroups> {
  const rows = await fetchCandidateRows(accountId);

  const importedIdGroups = groupByImportedId(rows);
  const consumedIds = new Set(
    importedIdGroups.flatMap(group => group.map(row => row.id)),
  );

  const remainingRows = rows.filter(row => !consumedIds.has(row.id));
  const fuzzyGroups = groupByFuzzyMatch(remainingRows);

  const fuzzyPairs: Array<[TransactionEntity['id'], TransactionEntity['id']]> =
    [];
  let skippedFuzzyGroups = 0;
  for (const group of fuzzyGroups) {
    if (group.length === 2) {
      fuzzyPairs.push([group[0].id, group[1].id]);
    } else {
      skippedFuzzyGroups++;
    }
  }

  return {
    importedIdGroups: importedIdGroups.map(group => group.map(row => row.id)),
    fuzzyPairs,
    skippedFuzzyGroups,
  };
}
