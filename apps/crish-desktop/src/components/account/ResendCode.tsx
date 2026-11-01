/**
 * 「重新发送」行：左侧静态提示「没收到验证码？」，右侧倒计时灰字，归零后变为品牌色文字按钮。
 * 登录验证码步与修改密码子页共用。
 */
import { Button, cn } from '../ui';
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
  return (
    <div className={cn(styles.resendRow, className)}>
      <span className={styles.hintText}>
        {t('settings.account.code.notReceived')}
      </span>
      {left > 0 ? (
        <span className={styles.resend} aria-live="polite">
          {t('settings.account.code.countdown', {
            time: formatCountdown(left),
          })}
        </span>
      ) : (
        <Button
          variant="unstyled"
          type="button"
          className={cn(styles.textButton, styles.textBrand)}
          onClick={onResend}
          disabled={disabled}
        >
          {t('settings.account.code.resend')}
        </Button>
      )}
    </div>
  );
}
