import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgExclamationOutline } from '@actual-app/components/icons/v1';
import { Input } from '@actual-app/components/input';
import { SpaceBetween } from '@actual-app/components/space-between';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { Tooltip } from '@actual-app/components/tooltip';
import { View } from '@actual-app/components/view';
import { currentDay, subDays } from '@actual-app/core/shared/months';
import type {
  AccountEntity,
  SyncServerAkahuAccount,
  SyncServerEnableBankingAccount,
  SyncServerGoCardlessAccount,
  SyncServerPluggyAiAccount,
  SyncServerSimpleFinAccount,
} from '@actual-app/core/types/models';
import { format as formatDate, parseISO } from 'date-fns';

import {
  useLinkAccountAkahuMutation,
  useLinkAccountEnableBankingMutation,
  useLinkAccountMutation,
  useLinkAccountPluggyAiMutation,
  useLinkAccountSimpleFinMutation,
  useUnlinkAccountMutation,
} from '#accounts';
import { Warning } from '#components/alerts';
import { Autocomplete } from '#components/autocomplete/Autocomplete';
import type { AutocompleteItem } from '#components/autocomplete/Autocomplete';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { Cell, Field, Row, Table, TableHeader } from '#components/table';
import { useAccounts } from '#hooks/useAccounts';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { closeModal } from '#modals/modalsSlice';
import { transactions } from '#queries';
import { liveQuery } from '#queries/liveQuery';
import { useDispatch } from '#redux';

import { LinkAccountStartingBalanceInput } from './LinkAccountStartingBalanceInput';

function useAddBudgetAccountOptions() {
  const { t } = useTranslation();

  const addOnBudgetAccountOption = {
    id: 'new-on',
    name: t('Create new account'),
  };
  const addOffBudgetAccountOption = {
    id: 'new-off',
    name: t('Create new account (off budget)'),
  };

  return { addOnBudgetAccountOption, addOffBudgetAccountOption };
}

type AddBudgetAccountOption = {
  id: string;
  name: string;
};

export function getSelectableAccountOptions({
  localAccounts,
  selectedLocalAccountIds,
  chosenAccount,
  syncSource,
  addOnBudgetAccountOption,
  addOffBudgetAccountOption,
}: {
  localAccounts: AccountEntity[];
  selectedLocalAccountIds: ReadonlySet<string>;
  chosenAccount: { id: string; name: string } | undefined;
  syncSource: NonNullable<AccountEntity['account_sync_source']>;
  addOnBudgetAccountOption: AddBudgetAccountOption;
  addOffBudgetAccountOption: AddBudgetAccountOption;
}): AutocompleteItem[] {
  const options: AutocompleteItem[] = localAccounts.filter(account => {
    const isCurrentSelection = account.id === chosenAccount?.id;

    // Keep the current row's selection visible. Otherwise, offer only accounts
    // that are unselected and either manual or linked to this provider.
    return (
      isCurrentSelection ||
      (!selectedLocalAccountIds.has(account.id) &&
        (account.account_sync_source == null ||
          account.account_sync_source === syncSource))
    );
  });

  options.push(addOnBudgetAccountOption, addOffBudgetAccountOption);
  return options;
}

/**
 * Helper to determine if the chosen account option represents creating a new account.
 */
function isNewAccountOption(
  chosenAccountId: string | undefined,
  addOnBudgetOptionId: string,
  addOffBudgetOptionId: string,
): boolean {
  return (
    chosenAccountId === addOnBudgetOptionId ||
    chosenAccountId === addOffBudgetOptionId
  );
}

/**
 * Starting options the user can set when an external account is linked as a
 * new Actual account. `amount` is `null` while the starting balance should be
 * calculated automatically (bank balance minus the imported transactions).
 */
export type StartingSettings = {
  date: string;
  amount: number | null;
};

/**
 * Translates the starting settings of a row into the link mutation params.
 * Anything not explicitly set by the user stays `undefined` so the sync logic
 * falls back to its defaults — in particular, changing only the starting date
 * must not turn the automatically calculated starting balance into 0.
 */
export function getStartingOptionsForLink(
  settings: StartingSettings | undefined,
): { startingDate: string | undefined; startingBalance: number | undefined } {
  const date = settings?.date?.trim();
  return {
    startingDate: date ? date : undefined,
    startingBalance: settings?.amount ?? undefined,
  };
}

/**
 * Whether linking `externalAccountId` to `localAccount` would replace an
 * existing link to a *different* bank account. Transactions of the local
 * account are kept in that case and the new feed is merged into them, which
 * is rarely what the user wants unless it really is the same bank account
 * (e.g. after re-authorizing a provider that rotates account IDs).
 */
export function isRelinkToDifferentBankAccount(
  localAccount: Pick<AccountEntity, 'account_id'> | undefined,
  externalAccountId: string,
): boolean {
  return (
    localAccount?.account_id != null &&
    localAccount.account_id !== '' &&
    localAccount.account_id !== externalAccountId
  );
}

/**
 * Computes which local accounts should be pre-linked to which external
 * accounts when the modal first opens. When `upgradingAccountId` is set and
 * there's exactly one external account that doesn't already match a known
 * local account, it's unambiguous which row it belongs to, so it's
 * preselected. If there's more than one unmatched external account, guessing
 * would risk claiming the wrong row (and hiding the account from every other
 * row's picker), so it's left for the user to pick manually.
 */
export function computeInitialLinkState(
  localAccounts: AccountEntity[],
  externalAccounts: ExternalAccount[],
  upgradingAccountId: string | undefined,
): {
  initialDraftLinkAccounts: Map<string, 'linking' | 'unlinking'>;
  initiallyChosenAccounts: Record<string, string>;
} {
  const externalAccountIds = new Set(externalAccounts.map(a => a.account_id));
  const initialDraftLinkAccounts = new Map<string, 'linking' | 'unlinking'>();
  for (const acc of localAccounts) {
    if (acc.account_id && externalAccountIds.has(acc.account_id)) {
      initialDraftLinkAccounts.set(acc.account_id, 'linking');
    }
  }

  const initiallyChosenAccounts: Record<string, string> = Object.fromEntries(
    localAccounts
      .filter(acc => acc.account_id)
      .map(acc => [acc.account_id, acc.id]),
  );

  const unmatchedExternalAccounts = externalAccounts.filter(
    account => initiallyChosenAccounts[account.account_id] == null,
  );

  if (
    upgradingAccountId &&
    unmatchedExternalAccounts.length === 1 &&
    !Object.values(initiallyChosenAccounts).includes(upgradingAccountId)
  ) {
    initiallyChosenAccounts[unmatchedExternalAccounts[0].account_id] =
      upgradingAccountId;
    initialDraftLinkAccounts.set(
      unmatchedExternalAccounts[0].account_id,
      'linking',
    );
  }

  return { initialDraftLinkAccounts, initiallyChosenAccounts };
}

export type SelectLinkedAccountsModalProps =
  | {
      requisitionId: string;
      externalAccounts: SyncServerGoCardlessAccount[];
      syncSource: 'goCardless';
      upgradingAccountId?: string;
    }
  | {
      requisitionId?: undefined;
      externalAccounts: SyncServerSimpleFinAccount[];
      syncSource: 'simpleFin';
      upgradingAccountId?: string;
    }
  | {
      requisitionId?: undefined;
      externalAccounts: SyncServerPluggyAiAccount[];
      syncSource: 'pluggyai';
      upgradingAccountId?: string;
    }
  | {
      requisitionId?: undefined;
      externalAccounts: SyncServerEnableBankingAccount[];
      syncSource: 'enableBanking';
      upgradingAccountId?: string;
    }
  | {
      requisitionId?: undefined;
      externalAccounts: SyncServerAkahuAccount[];
      syncSource: 'akahu';
      upgradingAccountId?: string;
    };

export function SelectLinkedAccountsModal({
  requisitionId,
  externalAccounts,
  syncSource,
  upgradingAccountId,
}: SelectLinkedAccountsModalProps) {
  const propsWithSortedExternalAccounts =
    useMemo<SelectLinkedAccountsModalProps>(() => {
      const toSort = externalAccounts ? [...externalAccounts] : [];
      toSort.sort(
        (a, b) =>
          getInstitutionName(a)?.localeCompare(getInstitutionName(b)) ||
          a.name.localeCompare(b.name),
      );
      switch (syncSource) {
        case 'simpleFin':
          return {
            syncSource: 'simpleFin',
            externalAccounts: toSort as SyncServerSimpleFinAccount[],
            upgradingAccountId,
          };
        case 'pluggyai':
          return {
            syncSource: 'pluggyai',
            externalAccounts: toSort as SyncServerPluggyAiAccount[],
            upgradingAccountId,
          };
        case 'akahu':
          return {
            syncSource: 'akahu',
            externalAccounts: toSort as SyncServerAkahuAccount[],
            upgradingAccountId,
          };
        case 'goCardless':
          return {
            syncSource: 'goCardless',
            requisitionId: requisitionId!,
            externalAccounts: toSort as SyncServerGoCardlessAccount[],
            upgradingAccountId,
          };
        case 'enableBanking':
          return {
            syncSource: 'enableBanking',
            externalAccounts: toSort as SyncServerEnableBankingAccount[],
            upgradingAccountId,
          };
        default:
          throw new Error(`Unrecognized sync source: ${String(syncSource)}`);
      }
    }, [externalAccounts, syncSource, requisitionId, upgradingAccountId]);

  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const dispatch = useDispatch();
  const { data: allAccounts = [] } = useAccounts();
  const localAccounts = allAccounts.filter(a => a.closed === 0);
  const { initialDraftLinkAccounts, initiallyChosenAccounts } = useMemo(
    () =>
      computeInitialLinkState(
        localAccounts,
        propsWithSortedExternalAccounts.externalAccounts,
        upgradingAccountId,
      ),
    [
      localAccounts,
      propsWithSortedExternalAccounts.externalAccounts,
      upgradingAccountId,
    ],
  );

  const [draftLinkAccounts, setDraftLinkAccounts] = useState<
    Map<string, 'linking' | 'unlinking'>
  >(initialDraftLinkAccounts);
  const [chosenAccounts, setChosenAccounts] = useState<Record<string, string>>(
    initiallyChosenAccounts,
  );
  const [customStartingDates, setCustomStartingDates] = useState<
    Record<string, StartingSettings>
  >({});
  const { addOnBudgetAccountOption, addOffBudgetAccountOption } =
    useAddBudgetAccountOptions();

  const linkAccount = useLinkAccountMutation();
  const unlinkAccount = useUnlinkAccountMutation();
  const linkAccountSimpleFin = useLinkAccountSimpleFinMutation();
  const linkAccountPluggyAi = useLinkAccountPluggyAiMutation();
  const linkAccountAkahu = useLinkAccountAkahuMutation();
  const linkAccountEnableBanking = useLinkAccountEnableBankingMutation();

  async function onNext() {
    const chosenLocalAccountIds = Object.values(chosenAccounts);

    // Unlink accounts that were previously linked, but the user
    // chose to remove the bank-sync
    localAccounts
      .filter(acc => acc.account_id)
      .filter(acc => !chosenLocalAccountIds.includes(acc.id))
      .forEach(acc => unlinkAccount.mutate({ id: acc.id }));

    // Link new accounts
    Object.entries(chosenAccounts).forEach(
      ([chosenExternalAccountId, chosenLocalAccountId]) => {
        const externalAccountIndex =
          propsWithSortedExternalAccounts.externalAccounts.findIndex(
            account => account.account_id === chosenExternalAccountId,
          );
        const offBudget = chosenLocalAccountId === addOffBudgetAccountOption.id;

        // Skip linking accounts that were previously linked with
        // a different bank.
        if (externalAccountIndex === -1) {
          return;
        }

        // Finally link the matched account
        const { startingDate, startingBalance } = getStartingOptionsForLink(
          customStartingDates[chosenExternalAccountId],
        );

        if (propsWithSortedExternalAccounts.syncSource === 'simpleFin') {
          linkAccountSimpleFin.mutate({
            externalAccount:
              propsWithSortedExternalAccounts.externalAccounts[
                externalAccountIndex
              ],
            upgradingId:
              chosenLocalAccountId !== addOnBudgetAccountOption.id &&
              chosenLocalAccountId !== addOffBudgetAccountOption.id
                ? chosenLocalAccountId
                : undefined,
            offBudget,
            startingDate,
            startingBalance,
          });
        } else if (propsWithSortedExternalAccounts.syncSource === 'pluggyai') {
          linkAccountPluggyAi.mutate({
            externalAccount:
              propsWithSortedExternalAccounts.externalAccounts[
                externalAccountIndex
              ],
            upgradingId:
              chosenLocalAccountId !== addOnBudgetAccountOption.id &&
              chosenLocalAccountId !== addOffBudgetAccountOption.id
                ? chosenLocalAccountId
                : undefined,
            offBudget,
            startingDate,
            startingBalance,
          });
        } else if (propsWithSortedExternalAccounts.syncSource === 'akahu') {
          linkAccountAkahu.mutate({
            externalAccount:
              propsWithSortedExternalAccounts.externalAccounts[
                externalAccountIndex
              ],
            upgradingId:
              chosenLocalAccountId !== addOnBudgetAccountOption.id &&
              chosenLocalAccountId !== addOffBudgetAccountOption.id
                ? chosenLocalAccountId
                : undefined,
            offBudget,
            startingDate,
            startingBalance,
          });
        } else if (
          propsWithSortedExternalAccounts.syncSource === 'enableBanking'
        ) {
          linkAccountEnableBanking.mutate({
            externalAccount:
              propsWithSortedExternalAccounts.externalAccounts[
                externalAccountIndex
              ],
            upgradingId:
              chosenLocalAccountId !== addOnBudgetAccountOption.id &&
              chosenLocalAccountId !== addOffBudgetAccountOption.id
                ? chosenLocalAccountId
                : undefined,
            offBudget,
            startingDate,
            startingBalance,
          });
        } else {
          linkAccount.mutate({
            requisitionId: propsWithSortedExternalAccounts.requisitionId,
            account:
              propsWithSortedExternalAccounts.externalAccounts[
                externalAccountIndex
              ],
            upgradingId:
              chosenLocalAccountId !== addOnBudgetAccountOption.id &&
              chosenLocalAccountId !== addOffBudgetAccountOption.id
                ? chosenLocalAccountId
                : undefined,
            offBudget,
            startingDate,
            startingBalance,
          });
        }
      },
    );

    dispatch(closeModal());
  }

  // Only reserve accounts chosen by visible rows; stale provider links should
  // stay selectable so users can relink them after reconnecting.
  const currentExternalAccountIds = new Set(
    propsWithSortedExternalAccounts.externalAccounts.map(
      account => account.account_id,
    ),
  );

  const selectedLocalAccountIds = new Set(
    Object.entries(chosenAccounts)
      .filter(([externalAccountId]) =>
        currentExternalAccountIds.has(externalAccountId),
      )
      .map(([, localAccountId]) => localAccountId),
  );

  function onSetLinkedAccount(
    externalAccount:
      | SyncServerGoCardlessAccount
      | SyncServerSimpleFinAccount
      | SyncServerPluggyAiAccount
      | SyncServerAkahuAccount,
    localAccountId: string | null | undefined,
  ) {
    setChosenAccounts(accounts => {
      const updatedAccounts = { ...accounts };

      if (localAccountId) {
        updatedAccounts[externalAccount.account_id] = localAccountId;
        setDraftLinkAccounts(prev =>
          new Map(prev).set(externalAccount.account_id, 'linking'),
        );
      } else {
        delete updatedAccounts[externalAccount.account_id];
        setDraftLinkAccounts(prev =>
          new Map(prev).set(externalAccount.account_id, 'unlinking'),
        );
      }

      return updatedAccounts;
    });
  }

  const getChosenAccount = (accountId: string) => {
    const chosenId = chosenAccounts[accountId];
    if (!chosenId) return undefined;

    if (chosenId === addOnBudgetAccountOption.id) {
      return addOnBudgetAccountOption;
    }
    if (chosenId === addOffBudgetAccountOption.id) {
      return addOffBudgetAccountOption;
    }

    return localAccounts.find(acc => acc.id === chosenId);
  };

  // Memoize default starting settings to avoid repeated calculations
  const defaultStartingSettings = useMemo<StartingSettings>(
    () => ({
      date: subDays(currentDay(), 89),
      // Calculated automatically unless the user enters a balance
      amount: null,
    }),
    [],
  );

  const getCustomStartingDate = (accountId: string) => {
    if (customStartingDates[accountId]) {
      return customStartingDates[accountId];
    }
    // Default to 89 days ago (90 days inclusive, matches server default)
    return defaultStartingSettings;
  };

  const setCustomStartingDate = (
    accountId: string,
    settings: StartingSettings,
  ) => {
    setCustomStartingDates(prev => ({
      ...prev,
      [accountId]: settings,
    }));
  };

  const label = useMemo(() => {
    const s = new Set(draftLinkAccounts.values());
    if (s.has('linking') && s.has('unlinking')) {
      return t('Link and unlink accounts');
    } else if (s.has('linking')) {
      return t('Link accounts');
    } else if (s.has('unlinking')) {
      return t('Unlink accounts');
    }

    return t('Link or unlink accounts');
  }, [draftLinkAccounts, t]);

  return (
    <Modal
      name="select-linked-accounts"
      containerProps={{
        style: isNarrowWidth
          ? {
              width: '100vw',
              maxWidth: '100vw',
              height: '100vh',
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
            }
          : { width: 1000 },
      }}
    >
      {({ state }) => (
        <View
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <ModalHeader
            title={t('Link Accounts')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          <View
            style={{
              padding: isNarrowWidth ? '0 16px' : '0 20px',
              flexShrink: 0,
            }}
          >
            <Text style={{ marginBottom: 20 }}>
              <Trans>
                We found the following accounts. Select which ones you want to
                add:
              </Trans>
            </Text>
          </View>

          {isNarrowWidth ? (
            <View
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {propsWithSortedExternalAccounts.externalAccounts.map(account => (
                <AccountCard
                  key={account.account_id}
                  externalAccount={account}
                  chosenAccount={getChosenAccount(account.account_id)}
                  localAccounts={localAccounts}
                  selectedLocalAccountIds={selectedLocalAccountIds}
                  syncSource={syncSource}
                  onSetLinkedAccount={onSetLinkedAccount}
                  customStartingDate={getCustomStartingDate(account.account_id)}
                  onSetCustomStartingDate={setCustomStartingDate}
                />
              ))}
            </View>
          ) : (
            <View
              style={{ ...styles.tableContainer, height: 300, flex: 'unset' }}
            >
              <TableHeader>
                <Cell value={t('Institution to Sync')} width={150} />
                <Cell value={t('Bank Account To Sync')} width={150} />
                <Cell value={t('Current Balance')} width={120} />
                <Cell value={t('Account in Actual')} width="flex" />
                <Cell value={t('Starting Date')} width={120} />
                <Cell value={t('Starting Balance')} width={120} />
                <Cell value={t('Actions')} width={150} textAlign="center" />
              </TableHeader>

              <Table<ExternalAccount & { id: string }>
                items={propsWithSortedExternalAccounts.externalAccounts.map(
                  acc => ({ ...acc, id: acc.account_id }),
                )}
                style={{ backgroundColor: theme.tableHeaderBackground }}
                renderItem={({ item }) => {
                  const chosenAccount = getChosenAccount(item.account_id);
                  // Only show starting options for new accounts being created
                  const shouldShowStartingOptions = isNewAccountOption(
                    chosenAccount?.id,
                    addOnBudgetAccountOption.id,
                    addOffBudgetAccountOption.id,
                  );

                  return (
                    <TableRow
                      key={item.id}
                      externalAccount={item}
                      chosenAccount={chosenAccount}
                      localAccounts={localAccounts}
                      selectedLocalAccountIds={selectedLocalAccountIds}
                      syncSource={syncSource}
                      onSetLinkedAccount={onSetLinkedAccount}
                      customStartingDate={getCustomStartingDate(
                        item.account_id,
                      )}
                      onSetCustomStartingDate={setCustomStartingDate}
                      showStartingOptions={shouldShowStartingOptions}
                    />
                  );
                }}
              />
            </View>
          )}

          <View
            style={{
              flexDirection: 'row',
              justifyContent: isNarrowWidth ? 'center' : 'flex-end',
              ...(isNarrowWidth
                ? {
                    padding: '16px',
                    flexShrink: 0,
                    borderTop: `1px solid ${theme.tableBorder}`,
                  }
                : { marginTop: 10 }),
            }}
          >
            <Button
              variant="primary"
              onPress={onNext}
              isDisabled={draftLinkAccounts.size === 0}
              style={
                isNarrowWidth
                  ? {
                      width: '100%',
                      height: '44px',
                      fontSize: '1em',
                    }
                  : undefined
              }
            >
              {label}
            </Button>
          </View>
        </View>
      )}
    </Modal>
  );
}

type ExternalAccount =
  | SyncServerGoCardlessAccount
  | SyncServerSimpleFinAccount
  | SyncServerPluggyAiAccount
  | SyncServerAkahuAccount
  | SyncServerEnableBankingAccount;

type StartingBalanceInfo = {
  date: string;
  amount: number;
};

type SharedAccountRowProps = {
  externalAccount: ExternalAccount;
  chosenAccount: { id: string; name: string } | undefined;
  localAccounts: AccountEntity[];
  selectedLocalAccountIds: ReadonlySet<string>;
  syncSource: SelectLinkedAccountsModalProps['syncSource'];
  onSetLinkedAccount: (
    externalAccount: ExternalAccount,
    localAccountId: string | null | undefined,
  ) => void;
};

type TableRowProps = SharedAccountRowProps & {
  customStartingDate: StartingSettings;
  onSetCustomStartingDate: (
    accountId: string,
    settings: StartingSettings,
  ) => void;
  showStartingOptions: boolean;
};

/**
 * Warning shown when the chosen Actual account is already linked to a
 * different bank account, which would merge the new feed into its existing
 * transactions.
 */
function useRelinkWarning(
  externalAccount: ExternalAccount,
  chosenAccount: { id: string; name: string } | undefined,
  localAccounts: AccountEntity[],
) {
  const { t } = useTranslation();

  const chosenLocalAccount = localAccounts.find(
    account => account.id === chosenAccount?.id,
  );
  if (
    !isRelinkToDifferentBankAccount(
      chosenLocalAccount,
      externalAccount.account_id,
    )
  ) {
    return null;
  }

  return t(
    '{{account}} is currently linked to a different bank account. Its existing transactions will be kept and the transactions of this bank account will be added to them. Make sure this is the same bank account.',
    { account: chosenLocalAccount?.name },
  );
}

function useStartingBalanceInfo(accountId: string | undefined) {
  const [info, setInfo] = useState<StartingBalanceInfo | null>(null);

  useEffect(() => {
    if (!accountId) {
      setInfo(null);
      return;
    }

    const query = transactions(accountId)
      .filter({ starting_balance_flag: true })
      .select(['date', 'amount'])
      .limit(1);

    const live = liveQuery<StartingBalanceInfo>(query, {
      onData: data => {
        setInfo(data?.[0] ?? null);
      },
      onError: () => {
        setInfo(null);
      },
    });

    return () => {
      live?.unsubscribe();
    };
  }, [accountId]);

  return info;
}

function TableRow({
  externalAccount,
  chosenAccount,
  localAccounts,
  selectedLocalAccountIds,
  syncSource,
  onSetLinkedAccount,
  customStartingDate,
  onSetCustomStartingDate,
  showStartingOptions,
}: TableRowProps) {
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const { addOnBudgetAccountOption, addOffBudgetAccountOption } =
    useAddBudgetAccountOptions();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const { t } = useTranslation();
  const startingBalanceInfo = useStartingBalanceInfo(
    showStartingOptions ? undefined : chosenAccount?.id,
  );
  const relinkWarning = useRelinkWarning(
    externalAccount,
    chosenAccount,
    localAccounts,
  );

  const availableAccountOptions = getSelectableAccountOptions({
    localAccounts,
    selectedLocalAccountIds,
    chosenAccount,
    syncSource,
    addOnBudgetAccountOption,
    addOffBudgetAccountOption,
  });

  return (
    <Row style={{ backgroundColor: theme.tableBackground }}>
      {/* Institution to Sync */}
      <Field width={150}>
        <Tooltip content={getInstitutionName(externalAccount)}>
          <View
            style={{
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              display: 'block',
            }}
          >
            {getInstitutionName(externalAccount)}
          </View>
        </Tooltip>
      </Field>
      {/* Bank Account To Sync */}
      <Field width={150}>
        <Tooltip content={externalAccount.name}>
          <View
            style={{
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              display: 'block',
            }}
          >
            {externalAccount.name}
          </View>
        </Tooltip>
      </Field>
      {/* Balance */}
      <Field width={120} style={{ textAlign: 'right' }}>
        <PrivacyFilter>
          {externalAccount.balance != null ? (
            <FinancialText>
              {format(externalAccount.balance.toString(), 'financial')}
            </FinancialText>
          ) : (
            t('Unknown')
          )}
        </PrivacyFilter>
      </Field>
      {/* Account in Actual */}
      <Field
        width="flex"
        truncate={focusedField !== 'account' && !relinkWarning}
        onClick={() => setFocusedField('account')}
      >
        {focusedField === 'account' ? (
          <Autocomplete
            focused
            strict
            highlightFirst
            suggestions={availableAccountOptions}
            onSelect={value => {
              onSetLinkedAccount(externalAccount, value);
            }}
            inputProps={{
              onBlur: () => setFocusedField(null),
            }}
            value={chosenAccount?.id}
          />
        ) : relinkWarning ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              overflow: 'hidden',
            }}
          >
            <Text
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {chosenAccount?.name}
            </Text>
            <Tooltip content={relinkWarning}>
              <SvgExclamationOutline
                width={13}
                height={13}
                style={{ color: theme.warningText, flexShrink: 0 }}
              />
            </Tooltip>
          </View>
        ) : (
          chosenAccount?.name
        )}
      </Field>
      {showStartingOptions ? (
        <StartingOptionsFields
          accountId={externalAccount.account_id}
          externalBalance={externalAccount.balance}
          customStartingDate={customStartingDate}
          onSetCustomStartingDate={onSetCustomStartingDate}
          layout="inline"
        />
      ) : (
        <>
          {/* Starting Date */}
          <Field width={120} truncate={false} style={{ textAlign: 'right' }}>
            {startingBalanceInfo ? (
              <Text
                style={{
                  color: theme.pageTextSubdued,
                  fontStyle: 'italic',
                }}
              >
                {formatDate(parseISO(startingBalanceInfo.date), dateFormat)}
              </Text>
            ) : null}
          </Field>
          {/* Starting Balance */}
          <Field width={120} truncate={false} style={{ textAlign: 'right' }}>
            {startingBalanceInfo ? (
              <PrivacyFilter>
                <FinancialText
                  style={{
                    color: theme.pageTextSubdued,
                    fontStyle: 'italic',
                  }}
                >
                  {format(startingBalanceInfo.amount, 'financial')}
                </FinancialText>
              </PrivacyFilter>
            ) : null}
          </Field>
        </>
      )}
      {/* Actions */}
      <Field width={150}>
        {chosenAccount ? (
          <Button
            onPress={() => {
              onSetLinkedAccount(externalAccount, null);
            }}
            style={{ float: 'right' }}
          >
            <Trans>Remove bank sync</Trans>
          </Button>
        ) : (
          <Button
            variant="primary"
            onPress={() => {
              setFocusedField('account');
            }}
            style={{ float: 'right' }}
          >
            <Trans>Set up bank sync</Trans>
          </Button>
        )}
      </Field>
    </Row>
  );
}

function getInstitutionName(
  externalAccount:
    | SyncServerGoCardlessAccount
    | SyncServerSimpleFinAccount
    | SyncServerPluggyAiAccount
    | SyncServerEnableBankingAccount,
) {
  if (typeof externalAccount?.institution === 'string') {
    return externalAccount?.institution ?? '';
  } else if (typeof externalAccount.institution?.name === 'string') {
    return externalAccount?.institution?.name ?? '';
  }
  return '';
}

type StartingOptionsFieldsProps = {
  accountId: string;
  externalBalance: number | null | undefined;
  customStartingDate: StartingSettings;
  onSetCustomStartingDate: (
    accountId: string,
    settings: StartingSettings,
  ) => void;
  layout: 'inline' | 'stacked';
};

function StartingOptionsFields({
  accountId,
  externalBalance,
  customStartingDate,
  onSetCustomStartingDate,
  layout,
}: StartingOptionsFieldsProps) {
  const { t } = useTranslation();
  const zeroSign = externalBalance != null && externalBalance < 0 ? '-' : '+';
  const isAutomaticBalance = customStartingDate.amount == null;
  const startingBalanceHelp = isAutomaticBalance
    ? t(
        'Calculated automatically from the current bank balance minus the imported transactions. Click to enter the balance on the starting date yourself.',
      )
    : t(
        'The balance of the bank account on the starting date. Clear the field to calculate it automatically.',
      );

  const startingBalanceInput = (
    <LinkAccountStartingBalanceInput
      value={customStartingDate.amount}
      zeroSign={zeroSign}
      onChange={amount =>
        onSetCustomStartingDate(accountId, {
          ...customStartingDate,
          amount,
        })
      }
      style={{
        width: '100%',
        justifyContent: layout === 'inline' ? 'flex-end' : 'flex-start',
      }}
    />
  );

  if (layout === 'inline') {
    return (
      <>
        {/* Starting Date */}
        <Field width={120} truncate={false}>
          <Input
            type="date"
            value={customStartingDate.date}
            onChange={e =>
              onSetCustomStartingDate(accountId, {
                ...customStartingDate,
                date: e.target.value,
              })
            }
            style={{ width: '100%' }}
          />
        </Field>
        {/* Starting Balance */}
        <Field width={120} truncate={false} style={{ textAlign: 'right' }}>
          <Tooltip content={startingBalanceHelp}>
            {startingBalanceInput}
          </Tooltip>
        </Field>
      </>
    );
  }

  return (
    <View
      style={{
        marginTop: 8,
        padding: '12px',
        backgroundColor: theme.tableHeaderBackground,
        borderRadius: 4,
      }}
    >
      <View style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <View>
          <Text
            style={{
              marginBottom: 4,
              fontSize: 13,
              color: theme.pageTextSubdued,
            }}
          >
            <Trans>Starting date:</Trans>
          </Text>
          <Input
            type="date"
            value={customStartingDate.date}
            onChange={e =>
              onSetCustomStartingDate(accountId, {
                ...customStartingDate,
                date: e.target.value,
              })
            }
            style={{ width: '100%' }}
          />
        </View>
        <View>
          <Text
            style={{
              marginBottom: 4,
              fontSize: 13,
              color: theme.pageTextSubdued,
            }}
          >
            <Trans>Balance on that date:</Trans>
          </Text>
          {startingBalanceInput}
          <Text
            style={{
              marginTop: 4,
              fontSize: 12,
              color: theme.pageTextSubdued,
            }}
          >
            {startingBalanceHelp}
          </Text>
        </View>
      </View>
    </View>
  );
}

type AccountCardProps = SharedAccountRowProps & {
  customStartingDate: StartingSettings;
  onSetCustomStartingDate: (
    accountId: string,
    settings: StartingSettings,
  ) => void;
};

function AccountCard({
  externalAccount,
  chosenAccount,
  localAccounts,
  selectedLocalAccountIds,
  syncSource,
  onSetLinkedAccount,
  customStartingDate,
  onSetCustomStartingDate,
}: AccountCardProps) {
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const { addOnBudgetAccountOption, addOffBudgetAccountOption } =
    useAddBudgetAccountOptions();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const { t } = useTranslation();

  const availableAccountOptions = getSelectableAccountOptions({
    localAccounts,
    selectedLocalAccountIds,
    chosenAccount,
    syncSource,
    addOnBudgetAccountOption,
    addOffBudgetAccountOption,
  });

  // Only show starting date options for new accounts being created
  const shouldShowStartingOptions = isNewAccountOption(
    chosenAccount?.id,
    addOnBudgetAccountOption.id,
    addOffBudgetAccountOption.id,
  );
  const startingBalanceInfo = useStartingBalanceInfo(
    shouldShowStartingOptions ? undefined : chosenAccount?.id,
  );
  const relinkWarning = useRelinkWarning(
    externalAccount,
    chosenAccount,
    localAccounts,
  );

  return (
    <SpaceBetween
      direction="vertical"
      gap={10}
      style={{
        backgroundColor: theme.tableBackground,
        borderRadius: 8,
        padding: '12px 16px',
        border: `1px solid ${theme.tableBorder}`,
        minHeight: 'fit-content',
        alignItems: 'stretch',
      }}
    >
      <View
        style={{
          fontWeight: 600,
          fontSize: '1.1em',
          color: theme.pageText,
          wordWrap: 'break-word',
          overflowWrap: 'break-word',
        }}
      >
        {externalAccount.name}
      </View>

      <View
        style={{
          fontSize: '0.9em',
          color: theme.pageTextSubdued,
          wordWrap: 'break-word',
          overflowWrap: 'break-word',
        }}
      >
        {getInstitutionName(externalAccount)}
      </View>

      <View
        style={{
          fontSize: '0.9em',
          color: theme.pageTextSubdued,
        }}
      >
        <Trans>Current balance:</Trans>{' '}
        <PrivacyFilter>
          {externalAccount.balance != null ? (
            <FinancialText>
              {format(externalAccount.balance.toString(), 'financial')}
            </FinancialText>
          ) : (
            t('Unknown')
          )}
        </PrivacyFilter>
      </View>

      <SpaceBetween
        direction="horizontal"
        gap={5}
        style={{
          fontSize: '0.9em',
          color: theme.pageTextSubdued,
        }}
      >
        <Text>
          <Trans>Linked to:</Trans>
        </Text>
        {chosenAccount ? (
          <Text style={{ color: theme.noticeTextLight, fontWeight: 500 }}>
            {chosenAccount.name}
          </Text>
        ) : (
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>Not linked</Trans>
          </Text>
        )}
      </SpaceBetween>

      {relinkWarning && (
        <Warning style={{ padding: '8px 12px', fontSize: 12 }}>
          {relinkWarning}
        </Warning>
      )}

      {!shouldShowStartingOptions && startingBalanceInfo && (
        <View
          style={{
            fontSize: '0.9em',
            color: theme.pageTextSubdued,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <View style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>Starting date:</Trans>
            </Text>
            <Text
              style={{
                color: theme.pageTextSubdued,
                fontStyle: 'italic',
              }}
            >
              {formatDate(parseISO(startingBalanceInfo.date), dateFormat)}
            </Text>
          </View>
          <View style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
            <Text style={{ color: theme.pageTextSubdued }}>
              <Trans>Starting balance:</Trans>
            </Text>
            <PrivacyFilter>
              <FinancialText
                style={{
                  color: theme.pageTextSubdued,
                  fontStyle: 'italic',
                }}
              >
                {format(startingBalanceInfo.amount, 'financial')}
              </FinancialText>
            </PrivacyFilter>
          </View>
        </View>
      )}

      {focusedField === 'account' && (
        <View style={{ marginBottom: 12 }}>
          <Autocomplete
            focused
            strict
            highlightFirst
            suggestions={availableAccountOptions}
            onSelect={value => {
              onSetLinkedAccount(externalAccount, value);
              setFocusedField(null);
            }}
            inputProps={{
              onBlur: () => setFocusedField(null),
              placeholder: t('Select account...'),
            }}
            value={chosenAccount?.id}
          />
        </View>
      )}

      {shouldShowStartingOptions && (
        <StartingOptionsFields
          accountId={externalAccount.account_id}
          externalBalance={externalAccount.balance}
          customStartingDate={customStartingDate}
          onSetCustomStartingDate={onSetCustomStartingDate}
          layout="stacked"
        />
      )}

      {chosenAccount ? (
        <Button
          onPress={() => {
            onSetLinkedAccount(externalAccount, null);
          }}
          style={{
            padding: '8px 16px',
            fontSize: '0.9em',
            width: '100%',
          }}
        >
          <Trans>Remove bank sync</Trans>
        </Button>
      ) : (
        <Button
          variant="primary"
          onPress={() => {
            setFocusedField('account');
          }}
          style={{
            padding: '8px 16px',
            fontSize: '0.9em',
            width: '100%',
          }}
        >
          <Trans>Link account</Trans>
        </Button>
      )}
    </SpaceBetween>
  );
}
