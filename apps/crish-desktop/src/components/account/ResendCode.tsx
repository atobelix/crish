/**
 * 「重新发送 · 0:42」行：倒计时中为静态灰字，归零后变为可点的文字按钮。
 */
import { Button } from '../ui';
import { useI18n } from '../../i18n';
import { formatCountdown } from './accountRules';
import styles from './accountControls.module.css';

interface ResendCodeProps {
  left: number;
  onResend: () => void;
  disabled?: boolean;
  className?: string;
}

export function ResendCode({
  left,
  onResend,
  disabled = false,
  className,
}: ResendCodeProps) {
  const { t } = useI18n();
  if (left > 0) {
    return (
      <div
        className={`${styles.resend}${className ? ` ${className}` : ''}`}
        aria-live="polite"
      >
        {t('settings.account.code.resendIn', { time: formatCountdown(left) })}
      </div>
    );
  }
  return (
    <div className={className}>
      <Button
        variant="unstyled"
        type="button"
        className={styles.textButton}
        onClick={onResend}
        disabled={disabled}
      >
        {t('settings.account.code.resend')}
      </Button>
    </div>
  );
}
