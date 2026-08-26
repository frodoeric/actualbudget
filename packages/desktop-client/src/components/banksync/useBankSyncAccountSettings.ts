import { useState } from 'react';

import {
  defaultMappings,
  mappingsFromString,
  mappingsToString,
} from '@actual-app/core/server/util/custom-sync-mapping';
import type { Mappings } from '@actual-app/core/server/util/custom-sync-mapping';
import { q } from '@actual-app/core/shared/query';

import { useSyncedPref } from '#hooks/useSyncedPref';
import { useTransactions } from '#hooks/useTransactions';

import { getFields } from './EditSyncAccount';
import type {
  MappableFieldWithExample,
  TransactionDirection,
} from './EditSyncAccount';

export function useBankSyncAccountSettings(accountId: string) {
  const [savedMappings = mappingsToString(defaultMappings), setSavedMappings] =
    useSyncedPref(`custom-sync-mappings-${accountId}`);
  const [savedImportNotes = true, setSavedImportNotes] = useSyncedPref(
    `sync-import-notes-${accountId}`,
  );
  const [savedImportPending = true, setSavedImportPending] = useSyncedPref(
    `sync-import-pending-${accountId}`,
  );
  const [savedReimportDeleted = true, setSavedReimportDeleted] = useSyncedPref(
    `sync-reimport-deleted-${accountId}`,
  );
  const [savedImportTransactions = true, setSavedImportTransactions] =
    useSyncedPref(`sync-import-transactions-${accountId}`);

  const [savedUpdateDates = false, setSavedUpdateDates] = useSyncedPref(
    `sync-update-dates-${accountId}`,
  );
  const [savedStatementMonth = false, setSavedStatementMonth] = useSyncedPref(
    `sync-statement-month-${accountId}`,
  );
  const [savedStatementClosingDay = '31', setSavedStatementClosingDay] =
    useSyncedPref(`sync-statement-closing-day-${accountId}`);

  const [transactionDirection, setTransactionDirection] =
    useState<TransactionDirection>('payment');
  const [importPending, setImportPending] = useState(
    String(savedImportPending) === 'true',
  );
  const [importNotes, setImportNotes] = useState(
    String(savedImportNotes) === 'true',
  );
  const [reimportDeleted, setReimportDeleted] = useState(
    String(savedReimportDeleted) === 'true',
  );
  const [mappings, setMappings] = useState<Mappings>(
    mappingsFromString(savedMappings),
  );
  const [importTransactions, setImportTransactions] = useState(
    String(savedImportTransactions) === 'true',
  );
  const [updateDates, setUpdateDates] = useState(
    String(savedUpdateDates) === 'true',
  );
  const [statementMonth, setStatementMonth] = useState(
    String(savedStatementMonth) === 'true',
  );
  const [statementClosingDay, setStatementClosingDay] = useState(
    String(savedStatementClosingDay),
  );

  const transactionQuery = q('transactions')
    .filter({
      account: accountId,
      amount: transactionDirection === 'payment' ? { $lte: 0 } : { $gt: 0 },
      raw_synced_data: { $ne: null },
    })
    .options({ splits: 'none' })
    .select('*');

  const { transactions } = useTransactions({
    query: transactionQuery,
  });

  const data = transactions?.[0]?.raw_synced_data;
  let exampleTransaction;
  if (data) {
    try {
      exampleTransaction = JSON.parse(data);
    } catch (error) {
      console.error('Failed to parse transaction data:', error);
    }
  }

  const fields: MappableFieldWithExample[] = exampleTransaction
    ? getFields(exampleTransaction)
    : [];

  const saveSettings = () => {
    const mappingsStr = mappingsToString(mappings);
    setSavedMappings(mappingsStr);
    setSavedImportPending(String(importPending));
    setSavedImportNotes(String(importNotes));
    setSavedReimportDeleted(String(reimportDeleted));
    setSavedImportTransactions(String(importTransactions));
    setSavedUpdateDates(String(updateDates));
    setSavedStatementMonth(String(statementMonth));

    // Clamp to a valid day of month; fall back to end-of-month close.
    const day = parseInt(statementClosingDay, 10);
    const clampedDay = Number.isFinite(day)
      ? Math.min(Math.max(day, 1), 31)
      : 31;
    setSavedStatementClosingDay(String(clampedDay));
  };

  const setMapping = (field: string, value: string) => {
    setMappings(prev => {
      const updated = new Map(prev);
      const directionMap = updated.get(transactionDirection);
      if (directionMap) {
        const newDirectionMap = new Map(directionMap);
        newDirectionMap.set(field, value);
        updated.set(transactionDirection, newDirectionMap);
      }
      return updated;
    });
  };

  return {
    transactionDirection,
    setTransactionDirection,
    importPending,
    setImportPending,
    importNotes,
    setImportNotes,
    reimportDeleted,
    setReimportDeleted,
    importTransactions,
    setImportTransactions,
    updateDates,
    setUpdateDates,
    statementMonth,
    setStatementMonth,
    statementClosingDay,
    setStatementClosingDay,
    mappings,
    setMapping,
    exampleTransaction,
    fields,
    saveSettings,
  };
}
