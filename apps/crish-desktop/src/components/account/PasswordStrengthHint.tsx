/**
 * 密码强度提示：三段刻度 + 强度 / 拒绝原因文案。
 * 规则与账号中心 `password-policy.ts` 同源（见 accountRules.evaluatePassword）。
 */
import { useI18n } from '../../i18n';
import {
  evaluatePassword,
  type AccountPasswordRejectReason,
} from './accountRules';
import controls from './accountControls.module.css';

const STRENGTH_KEYS = {
  weak: 'settings.account.strength.weak',
  medium: 'settings.account.strength.medium',
  strong: 'settings.account.strength.strong',
} as const;

const REASON_KEYS: Record<AccountPasswordRejectReason, string> = {
  too_short: 'settings.account.strength.tooShort',
  too_long: 'settings.account.strength.tooLong',
  too_weak: 'settings.account.strength.tooWeak',
};

/** 拒绝原因 → i18n 键的唯一映射：字段级错误文案与强度提示共用，不另立一份 */
export { REASON_KEYS as PASSWORD_REJECT_REASON_KEYS };

interface PasswordStrengthHintProps {
  password: string;
  email?: string | null;
}

export function PasswordStrengthHint({
  password,
  email,
}: PasswordStrengthHintProps) {
  const { t } = useI18n();
  if (!password) return null;
  const result = evaluatePassword(password, { email });
  const level = result.reason ? 'reject' : result.strength;
  const label = result.reason
    ? t(REASON_KEYS[result.reason])
    : t(STRENGTH_KEYS[result.strength]);
  return (
    <div className={controls.strength} data-strength={level} aria-live="polite">
      <span className={controls.strengthBars} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <p className={controls.strengthText}>{label}</p>
    </div>
  );
}
