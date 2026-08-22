import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Paragraph } from '@actual-app/components/paragraph';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { Checkbox } from '#components/forms';
import type { Modal as ModalType } from '#modals/modalsSlice';

type ConfirmBulkCategorizeModalProps = Extract<
  ModalType,
  { name: 'confirm-bulk-categorize-rule' }
>['options'];

export function ConfirmBulkCategorizeModal({
  title,
  message,
  note,
  confirmLabel,
  showApplyToAll = false,
  applyToAllLabel,
  onConfirm,
  onCancel,
}: ConfirmBulkCategorizeModalProps) {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const [applyToAll, setApplyToAll] = useState(false);
  const narrowButtonStyle = isNarrowWidth
    ? {
        height: styles.mobileMinHeight,
      }
    : {};

  return (
    <Modal name="confirm-bulk-categorize-rule">
      {({ state }) => (
        <>
          <ModalHeader
            title={title ?? t('Create rule?')}
            rightContent={
              <ModalCloseButton
                onPress={() => {
                  onCancel?.();
                  state.close();
                }}
              />
            }
          />
          <View style={{ lineHeight: 1.5 }}>
            <Paragraph>{message}</Paragraph>
            {showApplyToAll && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Checkbox
                  checked={applyToAll}
                  onChange={() => setApplyToAll(!applyToAll)}
                />
                {applyToAllLabel}
              </label>
            )}
            {note && (
              <Text
                style={{
                  display: 'block',
                  marginTop: 10,
                  color: theme.warningText,
                }}
              >
                {note}
              </Text>
            )}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'flex-end',
                marginTop: 10,
              }}
            >
              <Button
                style={{
                  marginRight: 10,
                  ...narrowButtonStyle,
                }}
                onPress={() => {
                  onCancel?.();
                  state.close();
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <InitialFocus>
                <Button
                  variant="primary"
                  style={narrowButtonStyle}
                  onPress={() => {
                    onConfirm(applyToAll);
                    state.close();
                  }}
                >
                  {confirmLabel ?? t('Create rule')}
                </Button>
              </InitialFocus>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
