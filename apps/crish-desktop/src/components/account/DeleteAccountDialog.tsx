/**
 * 注销账号确认：400 宽，需输入与当前账号完全一致的邮箱才可确认。
 * 账号中心尚无注销接口：确认后如实展示「暂未开放」失败，绝不假装成功。
 */
import { useState } from 'react';
import { Button, Dialog, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { AccountField } from './AccountField';
import { authErrorText } from './authErrorText';
import controls from './accountControls.module.css';
import styles from './account.module.css';

interface DeleteAccountDialogProps {
  open: boolean;
  email: string;
  onClose: () => void;
}

export function DeleteAccountDialog({
  open,
  email,
  onClose,
}: DeleteAccountDialogProps) {
  const { t } = useI18n();
  const deleteAccount = useAuthField((state) => state.deleteAccount);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = email !== '' && value.trim() === email;

  const handleClose = () => {
    setValue('');
    setError(null);
    onClose();
  };

  const handleConfirm = () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    deleteAccount(value.trim())
      .then(handleClose)
      .catch((err: unknown) => setError(authErrorText(err, t)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      role="alertdialog"
      ariaLabel={t('settings.account.delete.title')}
      showCloseButton={false}
      classNames={{
        panel: cn(controls.dialogPanel, styles.confirmPanelWide),
        overlay: controls.scrim,
        body: styles.confirmBody,
      }}
    >
      <h2 className={styles.confirmTitle}>
        {t('settings.account.delete.title')}
      </h2>
      <p className={styles.confirmDesc}>{t('settings.account.delete.desc')}</p>
      <div className={styles.confirmField}>
        <AccountField
          type="email"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onEnter={handleConfirm}
          placeholder={email}
          aria-label={t('settings.account.delete.inputLabel')}
          invalid={error !== null}
          autoComplete="off"
          autoFocus
        />
      </div>
      {error ? (
        <div className={styles.confirmMessage}>
          <p className={controls.errorText} role="alert">
            {error}
          </p>
        </div>
      ) : null}
      <div className={styles.confirmActions}>
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.button, controls.secondary)}
          onClick={handleClose}
        >
          {t('settings.account.cancel')}
        </Button>
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.button, controls.danger)}
          disabled={!matches || busy}
          onClick={handleConfirm}
        >
          {t('settings.account.delete.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}
