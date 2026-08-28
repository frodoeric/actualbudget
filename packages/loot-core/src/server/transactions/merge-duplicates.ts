import { logger } from '#platform/server/log';
import type { AccountEntity, TransactionEntity } from '#types/models';

import { findMergeableDuplicateGroups } from './find-duplicates';
import { mergeTransactions } from './merge';

export type MergeDuplicatesResult = {
  /** Total number of transactions removed by merging. */
  mergedCount: number;
  /** Number of duplicate groups that were merged down to one transaction. */
  groupCount: number;
  /** Number of possible-duplicate groups left untouched because they need
   * manual review (see MergeableDuplicateGroups.skippedFuzzyGroups). */
  skippedCount: number;
};

export async function mergeDuplicateTransactions({
  accountId,
}: {
  accountId?: AccountEntity['id'];
} = {}): Promise<MergeDuplicatesResult> {
  const { importedIdGroups, fuzzyPairs, skippedFuzzyGroups } =
    await findMergeableDuplicateGroups({ accountId });

  let mergedCount = 0;
  let groupCount = 0;

  for (const group of importedIdGroups) {
    mergedCount += await mergeGroup(group);
    groupCount++;
  }

  for (const pair of fuzzyPairs) {
    mergedCount += await mergeGroup(pair);
    groupCount++;
  }

  return { mergedCount, groupCount, skippedCount: skippedFuzzyGroups };
}

// Sequentially collapses a group of transaction ids already known to be
// duplicates of each other down to one survivor, via the same primitive a
// user triggers by selecting two transactions and merging them manually.
// mergeTransactions picks which of each pair to keep (preferring
// bank-synced/imported data, then the earlier date) and OR-merges the
// cleared/reconciled flags, so the final survivor is correct no matter what
// order the group is reduced in.
async function mergeGroup(
  ids: Array<TransactionEntity['id']>,
): Promise<number> {
  let survivor = ids[0];
  let removed = 0;

  for (let i = 1; i < ids.length; i++) {
    try {
      survivor = await mergeTransactions([{ id: survivor }, { id: ids[i] }]);
      removed++;
    } catch (error) {
      // Can only happen if the data changed under us mid-batch (e.g. the
      // amount was edited, or another sync landed). Skip this transaction
      // rather than aborting the whole batch over one bad pair.
      logger.warn('Failed to merge duplicate transactions:', error);
    }
  }

  return removed;
}
