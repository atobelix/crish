/**
 * 设置「账户」· 修改密码子页：验证码 + 新密码（至少 8 位，不设确认框）。
 * 按稿先码后密码：进入即向账号邮箱发送一次验证码（已登录走改密场景），填好验证码与新密码后保存。
 * 已登录时由 Rust 侧调用 /password/change/request|confirm，保留当前会话。
 * 返回 / 取消 / Esc（SettingsPanel 处理）回到账户概览；离开「账户」分区时由 SettingsProfileTab 复位。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  authRequestPasswordCode,
  authSetPasswordWithCode,
} from '../../api/authApi';
import { AppIcon, Button, Tooltip, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AccountField } from './AccountField';
import { CodeCells } from './CodeCells';
import { PasswordStrengthHint } from './PasswordStrengthHint';
import { ResendCode } from './ResendCode';
import { authErrorText } from './authErrorText';
import {
  ACCOUNT_CODE_LENGTH,
  ACCOUNT_RESEND_SECONDS,
  isValidPassword,
} from './accountRules';
import { useResendCountdown } from './useResendCountdown';
import controls from './accountControls.module.css';
import styles from './account.module.css';

export function ChangePasswordPane() {
  const { t } = useI18n();
  const user = useAuthField((state) => state.user);
  const profile = useAuthField((state) => state.profile);
  const completeLogin = useAuthField((state) => state.completeLogin);
  const setView = useAccountUiStore((state) => state.setView);
  const { left, restart } = useResendCountdown(ACCOUNT_RESEND_SECONDS);

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** 进入子页只自动发送一次（StrictMode 下 effect 会重复执行） */
  const autoSentRef = useRef(false);

  const email = profile?.email || user?.email || '';
  const canSave =
    code.length === ACCOUNT_CODE_LENGTH &&
    isValidPassword(password, email) &&
    !busy;

  const run = (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    task()
      .catch((err: unknown) => setError(authErrorText(err, t)))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  const sendCode = () => {
    if (!email) return;
    run(async () => {
      await authRequestPasswordCode({ scene: 'reset', email });
      setSent(true);
      setCode('');
      restart();
    });
  };

  // 挂载时自动发送一次；经 ref 取最新的 sendCode，避免把它列入依赖导致重复发送
  const sendCodeRef = useRef(sendCode);
  sendCodeRef.current = sendCode;
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    sendCodeRef.current();
  }, []);

  const save = () => {
    if (!canSave) return;
    run(async () => {
      const nextUser = await authSetPasswordWithCode({
        scene: 'reset',
        email,
        code,
        password,
      });
      await completeLogin(nextUser);
      setView('overview');
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save();
  };

  return (
    <div className={styles.subPage}>
      <form
        className={cn(styles.pane, styles.subPane)}
        onSubmit={handleSubmit}
        noValidate
      >
        <div className={styles.subHead}>
          <Tooltip content={t('settings.account.back')}>
            <Button
              variant="unstyled"
              type="button"
              className={controls.iconButton}
              aria-label={t('settings.account.back')}
              onClick={() => setView('overview')}
            >
              <AppIcon name="arrow-left" size={16} />
            </Button>
          </Tooltip>
          <h3 className={styles.subTitle}>
            {t('settings.account.changePassword')}
          </h3>
        </div>

        <div className={styles.subBlock}>
          <div className={controls.label}>
            {t('settings.account.code.sentTo', { email })}
          </div>
          <div className={styles.formWidth}>
            <CodeCells
              value={code}
              onChange={(next) => {
                setCode(next);
                setError(null);
              }}
              ariaLabel={t('settings.account.code.ariaLabel')}
              invalid={error !== null}
              disabled={busy}
            />
            <div className={styles.subRow}>
              {sent ? (
                <ResendCode left={left} onResend={sendCode} disabled={busy} />
              ) : (
                <Button
                  variant="unstyled"
                  type="button"
                  className={controls.textButton}
                  disabled={busy || !email}
                  onClick={sendCode}
                >
                  {t('settings.account.code.send')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className={styles.subBlock}>
          <div className={controls.label}>
            {t('settings.account.password.newLabel')}
          </div>
          <div className={styles.formWidth}>
            <AccountField
              revealable
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
              placeholder={t('settings.account.set.placeholder')}
              aria-label={t('settings.account.password.newLabel')}
              autoComplete="new-password"
            />
            <PasswordStrengthHint password={password} email={email} />
          </div>
        </div>

        {error ? (
          <div className={styles.subRow}>
            <p className={controls.errorText} role="alert">
              {error}
            </p>
          </div>
        ) : null}

        <div className={styles.subActions}>
          <Button
            variant="unstyled"
            type="button"
            className={cn(controls.button, controls.secondary)}
            onClick={() => setView('overview')}
          >
            {t('settings.account.cancel')}
          </Button>
          <Button
            variant="unstyled"
            type="submit"
            className={cn(controls.button, controls.primary)}
            disabled={!canSave}
          >
            {t('settings.account.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
