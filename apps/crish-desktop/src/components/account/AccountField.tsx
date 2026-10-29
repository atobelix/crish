/**
 * 账号界面字段：无描边，静止 field 底色，聚焦只换底色（品牌色光标），出错浅红底。
 * revealable=true 时为密码字段，右侧眼睛按钮切换明文。
 */
import { useState } from 'react';
import { AppIcon, Button, Input, Tooltip, type InputProps } from '../ui';
import { useI18n } from '../../i18n';
import styles from './accountControls.module.css';

export interface AccountFieldProps extends Omit<
  InputProps,
  'bare' | 'variant' | 'size' | 'label' | 'hint' | 'error' | 'className'
> {
  /** 出错态：浅红底，并设置 aria-invalid */
  invalid?: boolean;
  /** 密码字段：显示明文切换按钮 */
  revealable?: boolean;
}

export function AccountField({
  invalid = false,
  revealable = false,
  type,
  ...rest
}: AccountFieldProps) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const inputType = revealable ? (revealed ? 'text' : 'password') : type;
  const revealLabel = revealed
    ? t('settings.account.field.hidePassword')
    : t('settings.account.field.showPassword');

  return (
    <div className={styles.field} data-invalid={invalid ? 'true' : undefined}>
      <Input
        bare
        {...rest}
        type={inputType}
        className={styles.fieldInput}
        aria-invalid={invalid || undefined}
      />
      {revealable ? (
        <Tooltip content={revealLabel}>
          <Button
            variant="unstyled"
            type="button"
            className={styles.reveal}
            aria-label={revealLabel}
            aria-pressed={revealed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRevealed((value) => !value)}
          >
            <AppIcon name={revealed ? 'eye-off' : 'eye'} size={16} />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}
