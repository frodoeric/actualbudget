# Merging Duplicate Transactions

To merge two duplicate transactions, select two transactions with the same amount (e.g. two payments of 2 USD), then either use the shortcut key "G" or select the transaction menu dropdown in the top right and click merge. This option will only appear when exactly two matching transactions are selected.

![Merge Transactions](/img/merge-transactions/merge-g.webp)

When two transactions are merged, one is determined to be the 'kept' transaction and the other is the 'dropped' transaction. Any empty fields in the 'kept' transactions are copied over from the 'dropped' transaction and the 'dropped' transaction will be deleted. So, if the 'kept' transaction is uncategorized or has no payee, the payee and/or category will be copied over from the 'dropped' transaction before it is deleted.

The following logic is used to determine which transaction is kept:

1. If one transaction is imported through [bank sync](../advanced/bank-sync.md) and the other is not, the synced transaction is kept. Otherwise, continue to the next step.
2. If one transaction is imported through a [file import](./importing.md) and the other is not, the imported transaction is kept. Otherwise, continue to the final step.
3. The transaction with the earlier date is kept.

## Finding Duplicate Transactions

Actual can filter the transaction list down to transactions that look like duplicates of each other, so you can review them and merge the real duplicates.

1. Open the account you want to check, or select **All Accounts** to check every account at once.
2. Open the menu in the top right corner of the transactions table (the three vertical dots) and select **Filter duplicate transactions**.
3. The list now only shows transactions that have a possible duplicate, and a **Possible duplicates** filter appears above the table. Remove the filter to go back to the full list.
4. Review the results. When you spot a real duplicate, select the two matching transactions and merge them as described above.

A transaction counts as a possible duplicate when another transaction in the same account has the same amount and a date within 7 days of it. This is the same rule [importing](./importing.md#avoiding-duplicate-transactions) uses to avoid creating duplicates. Two transactions imported with the same bank-provided **id** are also flagged, no matter how far apart their dates are. Split transactions are matched by their total amount.

If no possible duplicates are found, Actual shows a notification instead of applying the filter.

:::note
Recurring transactions posted from the same [schedule](../schedules.md) repeat the same amount on purpose, so they are not treated as duplicates of each other.
:::
