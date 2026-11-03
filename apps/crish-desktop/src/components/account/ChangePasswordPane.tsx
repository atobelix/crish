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
import { Button, FieldError, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AccountField } from './AccountField';
import { CodeCells } from './CodeCells';
import {
  PASSWORD_REJECT_REASON_KEYS,
  PasswordStrengthHint,
} from './PasswordStrengthHint';
import { ResendCode } from './ResendCode';
import { authErrorText, isRejectedAuthError } from './authErrorText';
import {
  ACCOUNT_CODE_LENGTH,
  ACCOUNT_RESEND_SECONDS,
  evaluatePassword,
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
  // 字段级错误（F7 样板口径）：错误挂在各自字段下方，只随「该字段被修正」
  // 而变化，改动另一个字段不波及；formError 只承载无法归因到字段的
  // 环境性失败（网络 / 未开放 / 登录失效），保留到下一次操作为止。
  const [fieldErrors, setFieldErrors] = useState<{
    code?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const codeWrapRef = useRef<HTMLDivElement | null>(null);
  const passwordWrapRef = useRef<HTMLDivElement | null>(null);
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

  const run = (
    kind: 'send' | 'save',
    task: () => Promise<void>,
    onError: (err: unknown) => void
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (kind === 'send') setSending(true);
    else setSaving(true);
    // 新一次操作只清表单级错误；字段级错误归各字段自己的修正路径管理
    setFormError(null);
    task()
      .catch(onError)
      .finally(() => {
        busyRef.current = false;
        if (kind === 'send') setSending(false);
        else setSaving(false);
      });
  };

  const sendCode = () => {
    if (!email) return;
    run(
      'send',
      async () => {
        await authRequestPasswordCode({ scene: 'reset', email });
        setSent(true);
        setCode('');
        // 新码已发出：针对旧码的服务端裁决（如「验证码错误」）随之作废
        setFieldErrors((prev) => {
          if (!prev.code) return prev;
          const next = { ...prev };
          delete next.code;
          return next;
        });
        restart();
      },
      (err) => setFormError(authErrorText(err, t))
    );
  };

  // 挂载时自动发送一次；经 ref 取最新的 sendCode，避免把它列入依赖导致重复发送
  const sendCodeRef = useRef(sendCode);
  sendCodeRef.current = sendCode;
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    sendCodeRef.current();
  }, []);

  const handleSaveError = (err: unknown) => {
    // 归因口径：保存前密码已由本地同源规则把关（canSave），服务端仍业务拒绝时，
    // 唯一无法在本地验证的输入是验证码——拒绝文案归因到验证码字段（服务端原文）；
    // 其余失败不归因字段，进表单级错误行。
    if (isRejectedAuthError(err)) {
      setFieldErrors((prev) => ({ ...prev, code: authErrorText(err, t) }));
    } else {
      setFormError(authErrorText(err, t));
    }
  };

  const save = () => {
    if (!canSave) return;
    run(
      'save',
      async () => {
        const nextUser = await authSetPasswordWithCode({
          scene: 'reset',
          email,
          code,
          password,
        });
        await completeLogin(nextUser);
        setView('overview');
      },
      handleSaveError
    );
  };

  /** 提交时全量本地校验（验证码在密码之前），有错误返回错误集 */
  const validateFields = (): { code?: string; password?: string } | null => {
    const errs: { code?: string; password?: string } = {};
    if (code.length !== ACCOUNT_CODE_LENGTH) {
      errs.code = t('settings.account.changePassword.codeIncomplete');
    }
    const pw = evaluatePassword(password, { email });
    if (!pw.acceptable && pw.reason) {
      errs.password = t(PASSWORD_REJECT_REASON_KEYS[pw.reason]);
    }
    return Object.keys(errs).length > 0 ? errs : null;
  };

  const focusFirstErrorField = (errs: { code?: string; password?: string }) => {
    const wrap = errs.code
      ? codeWrapRef.current
      : errs.password
        ? passwordWrapRef.current
        : null;
    wrap?.querySelector('input')?.focus();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs = validateFields();
    if (errs) {
      // 校验不过不发请求：错误落到各自字段下方，焦点送到首个错误字段
      setFieldErrors(errs);
      focusFirstErrorField(errs);
      return;
    }
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
          <div className={pane.codeUnit} ref={codeWrapRef}>
            {/* 只有保存（互斥提交）才禁用验证码框；自动发码/重发不禁用——
                禁用已聚焦的 input 会让浏览器把焦点丢回 body，进页自动聚焦
                因此被发码时序绑架（发码慢则焦点迟到、甚至被误判为失效）。
                发码期间保持可输入：用户可直接键入或等待系统自动填充。 */}
            <CodeCells
              autoFocus
              value={code}
              onChange={(next) => {
                setCode(next);
                // 验证码一经改动，针对旧值的裁决即作废——只清本字段的错误
                setFieldErrors((prev) => {
                  if (!prev.code) return prev;
                  const nextErrs = { ...prev };
                  delete nextErrs.code;
                  return nextErrs;
                });
              }}
              ariaLabel={t('settings.account.code.ariaLabel')}
              invalid={fieldErrors.code != null}
              disabled={saving}
            />
          </div>
          <div className={pane.fieldErrorSlot}>
            {fieldErrors.code ? (
              <FieldError>{fieldErrors.code}</FieldError>
            ) : null}
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
          <div className={styles.formWidth} ref={passwordWrapRef}>
            <AccountField
              revealable
              invalid={fieldErrors.password != null}
              value={password}
              onChange={(event) => {
                const next = event.target.value;
                setPassword(next);
                // 只动密码字段自己的错误：按当前值重评——修正即清，
                // 仍不合规时换成当前原因；不波及验证码字段与表单级错误
                setFieldErrors((prev) => {
                  if (!prev.password) return prev;
                  const pw = evaluatePassword(next, { email });
                  if (pw.acceptable) {
                    const nextErrs = { ...prev };
                    delete nextErrs.password;
                    return nextErrs;
                  }
                  const reason = pw.reason;
                  return reason
                    ? {
                        ...prev,
                        password: t(PASSWORD_REJECT_REASON_KEYS[reason]),
                      }
                    : prev;
                });
              }}
              onBlur={() => {
                // 失焦校验：已输入但不合规的密码就地落字段错误
                if (!password) return;
                const pw = evaluatePassword(password, { email });
                if (!pw.acceptable && pw.reason) {
                  const reason = pw.reason;
                  setFieldErrors((prev) => ({
                    ...prev,
                    password: t(PASSWORD_REJECT_REASON_KEYS[reason]),
                  }));
                }
              }}
              onFocus={() => {
                // 焦点离开验证码且验证码未填满：等价于验证码字段的失焦校验
                if (code.length > 0 && code.length !== ACCOUNT_CODE_LENGTH) {
                  setFieldErrors((prev) =>
                    prev.code
                      ? prev
                      : {
                          ...prev,
                          code: t(
                            'settings.account.changePassword.codeIncomplete'
                          ),
                        }
                  );
                }
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
            <div className={pane.fieldErrorSlot}>
              {fieldErrors.password ? (
                <FieldError>{fieldErrors.password}</FieldError>
              ) : null}
            </div>
          </div>
        </div>

        <div className={pane.errorSlot}>
          {formError ? (
            <p className={controls.errorText} role="alert">
              {formError}
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
