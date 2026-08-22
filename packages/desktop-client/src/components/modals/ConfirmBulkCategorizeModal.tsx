import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Paragraph } from '@actual-app/components/paragraph';
import { styles } from '@actual-app/components/styles';
import { View } from '@actual-app/components/view';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import type { Modal as ModalType } from '#modals/modalsSlice';

type ConfirmBulkCategorizeModalProps = Extract<
  ModalType,
  { name: 'confirm-bulk-categorize-rule' }
>['options'];

export function ConfirmBulkCategorizeModal({
  message,
  onConfirm,
  onCancel,
}: ConfirmBulkCategorizeModalProps) {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
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
            title={t('Create rule?')}
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
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'flex-end',
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
                    onConfirm();
                    state.close();
                  }}
                >
                  <Trans>Create rule</Trans>
                </Button>
              </InitialFocus>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
