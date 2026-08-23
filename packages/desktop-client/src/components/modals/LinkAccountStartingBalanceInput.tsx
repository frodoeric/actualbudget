import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Trans } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { theme } from '@actual-app/components/theme';
import type { IntegerAmount } from '@actual-app/core/shared/util';

import { AmountInput } from '#components/util/AmountInput';

type LinkAccountStartingBalanceInputProps = {
  /** The starting balance to use, or `null` to calculate it automatically. */
  value: IntegerAmount | null;
  /** Sign shown while the amount is zero (mirrors the bank balance sign). */
  zeroSign: '-' | '+';
  onChange: (value: IntegerAmount | null) => void;
  style?: CSSProperties;
};

/**
 * Starting balance field for a bank account that is being linked as a new
 * Actual account. By default the balance is calculated automatically from the
 * bank balance and the field just reads "Automatic"; clicking it reveals an
 * amount input. Clearing that input switches back to automatic.
 */
export function LinkAccountStartingBalanceInput({
  value,
  zeroSign,
  onChange,
  style,
}: LinkAccountStartingBalanceInputProps) {
  const [isEditing, setIsEditing] = useState(false);
  // Text typed since the input was last focused. `''` means it was cleared;
  // `undefined` means nothing was typed.
  const typedTextRef = useRef<string | undefined>(undefined);
  const isAutomatic = value == null;

  if (isAutomatic && !isEditing) {
    return (
      <Button
        variant="bare"
        onPress={() => setIsEditing(true)}
        style={{
          fontStyle: 'italic',
          color: theme.pageTextSubdued,
          ...style,
        }}
      >
        <Trans>Automatic</Trans>
      </Button>
    );
  }

  return (
    <AmountInput
      value={value ?? 0}
      zeroSign={zeroSign}
      focused={isEditing}
      onChangeValue={text => {
        typedTextRef.current = text;
      }}
      onUpdate={amount => {
        const typedText = typedTextRef.current;
        typedTextRef.current = undefined;
        setIsEditing(false);

        if (typedText === '') {
          // Cleared: go back to calculating the balance automatically.
          onChange(null);
        } else if (typedText !== undefined || !isAutomatic) {
          onChange(amount);
        }
        // Otherwise the field was left without typing anything, so the
        // balance stays automatic.
      }}
      style={{ width: '100%', ...style }}
    />
  );
}
