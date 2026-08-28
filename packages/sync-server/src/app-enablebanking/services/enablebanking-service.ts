import { createHash } from 'node:crypto';

import createDebug from 'debug';

import {
  EnableBankingError,
  handleEnableBankingError,
} from '#app-enablebanking/utils/errors';
import { getJWT } from '#app-enablebanking/utils/jwt';
import { SecretName, secretsService } from '#services/secrets-service';

const debug = createDebug('actual:enable-banking:service');

const BASE_URL = 'https://api.enablebanking.com';

// --- Type definitions ---

export type EnableBankingTransaction = {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: { currency: string; amount: string };
  creditor?: { name?: string };
  debtor?: { name?: string };
  credit_debit_indicator?: 'CRDT' | 'DBIT';
  status?: 'BOOK' | 'PDNG';
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  remittance_information?: string[];
};

type EnableBankingBalance = {
  balance_amount: { currency: string; amount: string };
  balance_type: string;
  reference_date?: string;
};

export type EnableBankingSessionAccount = {
  account_id?: { iban?: string };
  account_servicer?: { bic_fi?: string; name?: string };
  name?: string;
  currency?: string;
  cash_account_type?: string;
  uid: string;
};

export type EnableBankingAccountDetails = {
  uid?: string;
  cash_account_type?: string;
  product?: string;
  currency?: string;
  credit_limit?: { currency: string; amount: string } | null;
};

export type EnableBankingSession = {
  session_id: string;
  accounts: EnableBankingSessionAccount[];
  aspsp?: { name?: string; country?: string };
};

type EnableBankingAspsp = {
  name: string;
  country: string;
  [key: string]: unknown;
};

type EnableBankingAuthResponse = {
  url: string;
  authorization_id: string;
};

type PsuType = 'personal' | 'business';

type BankSyncTransaction = EnableBankingTransaction & {
  transactionId: string;
  date: string;
  bookingDate: string;
  valueDate?: string;
  transactionAmount: { amount: string; currency: string };
  payeeName: string;
  notes?: string;
  remittanceInformationUnstructured?: string;
  booked: boolean;
};

type BankSyncBalance = {
  balanceAmount: { amount: number; currency: string };
  balanceType: string;
  referenceDate?: string;
};

type NormalizedAccount = {
  account_id: string;
  name: string;
  institution: string;
  currency?: string;
  iban?: string;
};

// --- PSU headers ---

export type PsuHeaders = {
  'Psu-Ip-Address'?: string;
  'Psu-User-Agent'?: string;
};

// --- Helper functions ---

function getCredentials(): { applicationId: string; secretKey: string } {
  const applicationId = secretsService.get(
    SecretName.enablebanking_applicationId,
  );
  const secretKey = secretsService.get(SecretName.enablebanking_secretKey);

  if (!applicationId || !secretKey) {
    throw new EnableBankingError(
      'INVALID_INPUT',
      'NOT_CONFIGURED',
      'Enable Banking is not configured',
    );
  }

  return { applicationId, secretKey };
}

function getAuthorizationHeader(): string {
  const { applicationId, secretKey } = getCredentials();
  const token = getJWT(applicationId, secretKey);
  return `Bearer ${token}`;
}

const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  authHeaderOverride?: string,
  psuHeaders?: PsuHeaders,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  debug('%s %s', method, url);

  const headers: Record<string, string> = {
    Authorization: authHeaderOverride ?? getAuthorizationHeader(),
    'Content-Type': 'application/json',
  };

  // Forward PSU headers to signal the end-user is online.
  // This exempts the request from background data-fetch rate limits
  // that many ASPSPs enforce (e.g. 4 requests/day).
  if (psuHeaders) {
    for (const [key, value] of Object.entries(psuHeaders)) {
      if (value) {
        headers[key] = value;
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const options: RequestInit = { method, headers, signal: controller.signal };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new EnableBankingError(
        'TIMED_OUT',
        'TIMED_OUT',
        'Request timed out',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = await response.text().catch(() => 'unknown');
    }
    throw handleEnableBankingError(response.status, responseBody);
  }

  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generic API wrapper, type is validated by caller
  return (await response.json()) as T;
}

// --- Normalization functions ---

// SEPA / ISO 20022 structured remittance prefixes (e.g. `EREF+invoice-42`).
// They are metadata for clearing systems, not user-facing text, so we strip
// them from the front of each remittance line. The list is an allowlist of
// known prefixes rather than a catch-all `[A-Z]{3,}\+` so we don't accidentally
// strip merchant tokens like `BMW+` or `USB+` that legitimately start a
// description.
const SEPA_PREFIX_RE =
  /^(?:EREF|KREF|MREF|CRED|DBTR|CDTR|SVWZ|SVCL|PURP|RTRN|REJT|REFE|SDVA|INDA|NTAV|ULTC|ULTD|ULTB|ABWA|ABWE|IBAN|BIC|COAM|OAMT|REMI|SQTP|ROC)\+/;

function stripSepaPrefix(s: string): string {
  return s.replace(SEPA_PREFIX_RE, '').trim();
}

function cleanRemittanceArray(arr: string[]): string[] {
  return arr.map(stripSepaPrefix).filter(Boolean);
}

export function normalizeTransaction(
  tx: EnableBankingTransaction,
  opts?: { preferTransactionDate?: boolean },
): BankSyncTransaction {
  const transactionId = tx.entry_reference || tx.transaction_id || '';
  const bookingDate =
    tx.booking_date || tx.value_date || tx.transaction_date || '';
  const valueDate = tx.value_date;

  // Card accounts often report booking_date as the statement/processing date
  // (every entry stamped with the day it hit the statement) while the actual
  // purchase date is only in transaction_date, so prefer it there.
  const date =
    opts?.preferTransactionDate && tx.transaction_date
      ? tx.transaction_date
      : bookingDate;

  let payeeName = '';
  if (tx.credit_debit_indicator === 'CRDT' && tx.debtor?.name) {
    payeeName = tx.debtor.name;
  } else if (tx.credit_debit_indicator === 'DBIT' && tx.creditor?.name) {
    payeeName = tx.creditor.name;
  } else if (tx.creditor?.name) {
    payeeName = tx.creditor.name;
  } else if (tx.debtor?.name) {
    payeeName = tx.debtor.name;
  } else if (
    tx.remittance_information &&
    tx.remittance_information.length > 0
  ) {
    const cleanedFallback = cleanRemittanceArray(tx.remittance_information);
    if (cleanedFallback.length > 0) {
      payeeName = cleanedFallback[0];
    }
  }

  const cleanedAll = tx.remittance_information
    ? cleanRemittanceArray(tx.remittance_information)
    : [];
  const remittanceInformationUnstructured =
    cleanedAll.length > 0 ? cleanedAll.join(' ') : undefined;

  // Normalize amount based on credit/debit indicator.
  // When indicator is present, strip existing sign and apply the correct one.
  // When absent, preserve the original sign from the bank.
  const trimmedAmount = tx.transaction_amount.amount.trim();
  let signedAmount: string;
  if (tx.credit_debit_indicator === 'DBIT') {
    signedAmount = '-' + trimmedAmount.replace(/^[+-]/, '');
  } else if (tx.credit_debit_indicator === 'CRDT') {
    signedAmount = trimmedAmount.replace(/^[+-]/, '');
  } else {
    signedAmount = trimmedAmount;
  }

  return {
    ...tx,
    transactionId,
    date,
    bookingDate,
    valueDate,
    transactionAmount: {
      amount: signedAmount,
      currency: tx.transaction_amount.currency,
    },
    payeeName,
    notes: remittanceInformationUnstructured,
    remittanceInformationUnstructured,
    booked: tx.status !== 'PDNG',
  };
}

const IMPORTABLE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Actual's client imports a transaction by inserting it into a local SQLite
// database: the `date` column is a required integer derived from an ISO date,
// and the amount must be numeric. A record with an empty / non-ISO date or a
// non-numeric amount makes that insert throw, which aborts the whole account
// sync. Enable Banking occasionally returns such records — e.g. a pending
// transaction with no booking/value/transaction date — so callers skip them
// instead of failing the entire import.
export function isImportableTransaction(tx: BankSyncTransaction): boolean {
  // Trim and reject empty amounts explicitly: Number('') is 0 (finite), so an
  // empty/whitespace amount would otherwise slip through as a zero transaction.
  const amount = tx.transactionAmount.amount.trim();
  return (
    IMPORTABLE_DATE_REGEX.test(tx.date) &&
    amount !== '' &&
    Number.isFinite(Number(amount))
  );
}

export function normalizeBalance(bal: EnableBankingBalance): BankSyncBalance {
  const amount = Math.round(parseFloat(bal.balance_amount.amount) * 100);
  return {
    balanceAmount: {
      amount,
      currency: bal.balance_amount.currency,
    },
    balanceType: bal.balance_type,
    referenceDate: bal.reference_date,
  };
}

export function isCardAccountType(cashAccountType?: string): boolean {
  return cashAccountType === 'CARD';
}

// Booked-ish balance types that can legitimately carry a card's debt.
const CARD_DEBT_BALANCE_TYPES = ['CLBD', 'XPCD', 'ITBD'];

/**
 * Picks the balance the client should anchor the account's starting balance
 * on.
 *
 * Regular accounts keep the historical behavior: prefer CLAV, fall back to
 * the first reported balance.
 *
 * Card accounts can't trust positive balances: banks report the *available
 * credit* there (e.g. some banks send ITAV = remaining limit and OTHR = the
 * credit limit itself; others repeat the available amount in every type).
 * Treating that as money inflates the budget with funds the user doesn't
 * have. For cards, in order:
 *
 * 1. a *negative* booked-type balance — a real, unambiguous debt figure;
 * 2. the debt derived from available credit minus the limit (ITAV − OTHR)
 *    when the bank exposes both and the limit is the larger one;
 * 3. otherwise anchor at 0 so the account's balance is just the sum of
 *    imported transactions.
 */
export function pickStartingBalance(
  balances: BankSyncBalance[],
  isCard: boolean,
): number {
  if (!isCard) {
    const preferred =
      balances.find(b => b.balanceType === 'CLAV') ?? balances[0];
    return preferred ? preferred.balanceAmount.amount : 0;
  }

  for (const type of CARD_DEBT_BALANCE_TYPES) {
    const candidate = balances.find(
      b => b.balanceType === type && b.balanceAmount.amount < 0,
    );
    if (candidate) {
      return candidate.balanceAmount.amount;
    }
  }

  const available = balances.find(b => b.balanceType === 'ITAV');
  const limit = balances.find(b => b.balanceType === 'OTHR');
  if (
    available &&
    limit &&
    limit.balanceAmount.amount > available.balanceAmount.amount
  ) {
    return available.balanceAmount.amount - limit.balanceAmount.amount;
  }

  return 0;
}

/**
 * Some banks' card transactions come back with neither entry_reference nor
 * transaction_id. Without an import id, Actual's client
 * falls back to fuzzy matching (±7 days), which breaks date updates and
 * re-imports as duplicates. Derive a deterministic id from the transaction's
 * stable fields so the same bank record always maps to the same import id.
 * Only booked transactions get one — pending records still change shape (and
 * would change hash) when they settle.
 */
export function assignFallbackTransactionIds(
  transactions: BankSyncTransaction[],
  accountUid: string,
): void {
  const occurrences = new Map<string, number>();

  for (const tx of transactions) {
    if (tx.transactionId || !tx.booked) {
      continue;
    }

    const hash = createHash('sha256')
      .update(
        [
          accountUid,
          tx.booking_date ?? '',
          tx.transaction_date ?? '',
          tx.value_date ?? '',
          tx.transactionAmount.amount,
          tx.transactionAmount.currency,
          tx.credit_debit_indicator ?? '',
          (tx.remittance_information ?? []).join('~'),
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 32);

    // Disambiguate identical same-day purchases (same amount and
    // description) with a stable occurrence counter.
    const n = occurrences.get(hash) ?? 0;
    occurrences.set(hash, n + 1);

    tx.transactionId = `eb-${hash}-${n}`;
  }
}

export function normalizeAccount(
  account: EnableBankingSessionAccount,
  aspsp?: { name?: string },
): NormalizedAccount {
  return {
    account_id: account.uid,
    name: account.name || account.account_id?.iban || account.uid,
    institution: aspsp?.name || account.account_servicer?.name || 'Unknown',
    currency: account.currency,
    iban: account.account_id?.iban,
  };
}

// --- Service ---

export const enableBankingService = {
  isConfigured(): boolean {
    const applicationId = secretsService.get(
      SecretName.enablebanking_applicationId,
    );
    const secretKey = secretsService.get(SecretName.enablebanking_secretKey);
    return !!(applicationId && secretKey);
  },

  async validateCredentials(
    applicationId: string,
    secretKey: string,
  ): Promise<unknown> {
    const token = getJWT(applicationId, secretKey);
    return request<unknown>(
      'GET',
      '/application',
      undefined,
      `Bearer ${token}`,
    );
  },

  async getApplication(): Promise<unknown> {
    return request<unknown>('GET', '/application');
  },

  async getAspsps(country?: string): Promise<EnableBankingAspsp[]> {
    const query = country ? `?country=${encodeURIComponent(country)}` : '';
    return request<EnableBankingAspsp[]>('GET', `/aspsps${query}`);
  },

  async startAuth(
    aspsp: { name: string; country: string },
    redirectUrl: string,
    state: string,
    maxConsentValidity?: number,
    psuType: PsuType = 'personal',
  ): Promise<EnableBankingAuthResponse> {
    const DEFAULT_CONSENT_DAYS = 90;
    const defaultMs = DEFAULT_CONSENT_DAYS * 24 * 60 * 60 * 1000;

    // Respect the ASPSP's maximum_consent_validity (in seconds) if provided,
    // capping at our default of 90 days.
    const consentMs =
      maxConsentValidity != null && maxConsentValidity > 0
        ? Math.min(maxConsentValidity * 1000, defaultMs)
        : defaultMs;

    const validUntil = new Date(Date.now() + consentMs);

    return request<EnableBankingAuthResponse>('POST', '/auth', {
      aspsp: { name: aspsp.name, country: aspsp.country },
      redirect_url: redirectUrl,
      state,
      access: {
        valid_until: validUntil.toISOString(),
      },
      psu_type: psuType,
    });
  },

  async createSession(code: string): Promise<EnableBankingSession> {
    return request<EnableBankingSession>('POST', '/sessions', { code });
  },

  async getSession(sessionId: string): Promise<EnableBankingSession> {
    return request<EnableBankingSession>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  async getAccountDetails(
    accountUid: string,
    psuHeaders?: PsuHeaders,
  ): Promise<EnableBankingAccountDetails> {
    return request<EnableBankingAccountDetails>(
      'GET',
      `/accounts/${encodeURIComponent(accountUid)}/details`,
      undefined,
      undefined,
      psuHeaders,
    );
  },

  async getBalances(
    accountUid: string,
    psuHeaders?: PsuHeaders,
  ): Promise<{ balances: EnableBankingBalance[] }> {
    return request<{ balances: EnableBankingBalance[] }>(
      'GET',
      `/accounts/${encodeURIComponent(accountUid)}/balances`,
      undefined,
      undefined,
      psuHeaders,
    );
  },

  async getTransactions(
    accountUid: string,
    dateFrom: string,
    dateTo: string,
    continuationKey?: string,
    psuHeaders?: PsuHeaders,
  ): Promise<{
    transactions: EnableBankingTransaction[];
    continuation_key?: string;
  }> {
    let path = `/accounts/${encodeURIComponent(accountUid)}/transactions?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`;
    if (continuationKey) {
      path += `&continuation_key=${encodeURIComponent(continuationKey)}`;
    }
    return request<{
      transactions: EnableBankingTransaction[];
      continuation_key?: string;
    }>('GET', path, undefined, undefined, psuHeaders);
  },

  async getAllTransactions(
    accountUid: string,
    dateFrom: string,
    dateTo: string,
    psuHeaders?: PsuHeaders,
  ): Promise<EnableBankingTransaction[]> {
    const allTransactions: EnableBankingTransaction[] = [];
    let continuationKey: string | undefined;
    const maxIterations = 100;
    let iteration = 0;

    do {
      const result = await enableBankingService.getTransactions(
        accountUid,
        dateFrom,
        dateTo,
        continuationKey,
        psuHeaders,
      );
      allTransactions.push(...result.transactions);

      if (
        result.continuation_key &&
        result.continuation_key === continuationKey
      ) {
        break;
      }

      continuationKey = result.continuation_key;
      iteration++;
    } while (continuationKey && iteration < maxIterations);

    return allTransactions;
  },
};
