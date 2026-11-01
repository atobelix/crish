/**
 * 设置「账户」· 修改密码子页：验证码 + 新密码（至少 8 位，不设确认框）。
 * 按稿先码后密码：进入即向账号邮箱发送一次验证码（已登录走改密场景），填好验证码与新密码后保存。
 * 已登录时由 Rust 侧调用 /password/change/request|confirm，保留当前会话。
 * 返回 / 取消 / Esc（SettingsPanel 处理）回到账户概览；离开「账户」分区时由 SettingsProfileTab 复位。
 * 版式（changePassword.module.css）：两组同构——组标题 + 内容 + 元信息行；
 * 验证码收窄为左对齐的 384 单元，密码强度与错误提示各有固定席位，出现/消失不推挤布局。
 */
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  authRequestPasswordCode,
  authSetPasswordWithCode,
} from '../../api/authApi';
import { Button, cn } from '../ui';
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
import pane from './changePassword.module.css';

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
  // 发码与保存分开记忙：二者共用 busyRef 防重入，但只有「保存」这种互斥提交
  // 才禁用验证码框（见下方 CodeCells 的 disabled 取值与注释）。
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const busy = sending || saving;
  /** 进入子页只自动发送一次（StrictMode 下 effect 会重复执行） */
  const autoSentRef = useRef(false);

  const email = profile?.email || user?.email || '';
  const canSave =
    code.length === ACCOUNT_CODE_LENGTH &&
    isValidPassword(password, email) &&
    !busy;

  const run = (kind: 'send' | 'save', task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (kind === 'send') setSending(true);
    else setSaving(true);
    setError(null);
    task()
      .catch((err: unknown) => setError(authErrorText(err, t)))
      .finally(() => {
        busyRef.current = false;
        if (kind === 'send') setSending(false);
        else setSaving(false);
      });
  };

  const sendCode = () => {
    if (!email) return;
    run('send', async () => {
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
    run('save', async () => {
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

  // 「发送到 {email} 的验证码」：邮箱本体单独提亮加字重，其余保持三级灰——关键信息靠层级强调，不靠彩色
  const sentToText = t('settings.account.code.sentTo', { email });
  const sentToParts = email ? sentToText.split(email) : [sentToText];

  return (
    <div className={styles.subPage}>
      <form
        className={cn(styles.pane, styles.subPane)}
        onSubmit={handleSubmit}
        noValidate
      >
        <p className={styles.subIntro}>
          {t('settings.account.changePassword.desc')}
        </p>

        <div className={styles.subBlock}>
          <div className={controls.label}>
            {t('settings.account.code.title')}
          </div>
          <p className={pane.sentTo}>
            {sentToParts.map((part, index) => (
              <Fragment key={index}>
                {part}
                {index < sentToParts.length - 1 ? (
                  <span className={pane.sentToEmail}>{email}</span>
                ) : null}
              </Fragment>
            ))}
          </p>
          <div className={pane.codeUnit}>
            {/* 只有保存（互斥提交）才禁用验证码框；自动发码/重发不禁用——
                禁用已聚焦的 input 会让浏览器把焦点丢回 body，进页自动聚焦
                因此被发码时序绑架（发码慢则焦点迟到、甚至被误判为失效）。
                发码期间保持可输入：用户可直接键入或等待系统自动填充。 */}
            <CodeCells
              autoFocus
              value={code}
              onChange={(next) => {
                setCode(next);
                setError(null);
              }}
              ariaLabel={t('settings.account.code.ariaLabel')}
              invalid={error !== null}
              disabled={saving}
            />
          </div>
          <div className={pane.resendRow}>
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
            <div className={pane.pwMeta}>
              <p className={controls.hintText}>
                {t('settings.account.password.ruleHint')}
              </p>
              <div className={pane.strengthSlot}>
                <PasswordStrengthHint password={password} email={email} />
              </div>
            </div>
          </div>
        </div>

        <div className={pane.errorSlot}>
          {error ? (
            <p className={controls.errorText} role="alert">
              {error}
            </p>
          ) : null}
        </div>

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
