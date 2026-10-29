/**
 * 退出登录确认：360 宽，焦点默认落在「退出登录」，Enter 确认、Esc 取消。
 * 退出后设置弹窗保持打开，「账户」分区回到未登录态。
 */
import { useRef, useState } from 'react';
import { Button, Dialog, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import controls from './accountControls.module.css';
import styles from './account.module.css';

interface SignOutConfirmDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SignOutConfirmDialog({
  open,
  onClose,
}: SignOutConfirmDialogProps) {
  const { t } = useI18n();
  const logout = useAuthField((state) => state.logout);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  const handleConfirm = () => {
    if (busy) return;
    setBusy(true);
    logout().finally(() => {
      setBusy(false);
      onClose();
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      ariaLabel={t('settings.account.signOutConfirm.title')}
      showCloseButton={false}
      initialFocusRef={confirmRef}
      classNames={{
        panel: cn(controls.dialogPanel, styles.confirmPanel),
        overlay: controls.scrim,
        body: styles.confirmBody,
      }}
    >
      <h2 className={styles.confirmTitle}>
        {t('settings.account.signOutConfirm.title')}
      </h2>
      <div className={styles.confirmActions}>
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.button, controls.secondary)}
          onClick={onClose}
        >
          {t('settings.account.cancel')}
        </Button>
        <Button
          ref={confirmRef}
          variant="unstyled"
          type="button"
          className={cn(controls.button, controls.primary)}
          disabled={busy}
          onClick={handleConfirm}
        >
          {t('settings.account.signOut')}
        </Button>
      </div>
    </Dialog>
  );
}
