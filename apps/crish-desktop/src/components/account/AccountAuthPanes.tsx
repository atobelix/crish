/**
 * 登录弹窗右栏的各步骤内容（邮箱 / 验证码 / 密码 / 设置密码）。
 * 每个步骤是一整层（含左上返回、底部协议），由 AccountCenterDialog 叠放并交叉淡入。
 */
import type { FormEvent, ReactNode } from 'react';
import { AppIcon, Button, Tooltip, cn } from '../ui';
import { useI18n } from '../../i18n';
import { AccountField } from './AccountField';
import { CodeCells } from './CodeCells';
import { LegalLink } from './LegalLink';
import { PasswordStrengthHint } from './PasswordStrengthHint';
import { ResendCode } from './ResendCode';
import { isValidEmail, isValidPassword } from './accountRules';
import type { AccountAuthFlow } from './useAccountAuthFlow';
import controls from './accountControls.module.css';
import styles from './accountAuth.module.css';

interface StepProps {
  flow: AccountAuthFlow;
}

/** 表单外壳：阻止默认提交，Enter 即主操作 */
function StepForm({
  onSubmit,
  children,
}: {
  onSubmit: () => void;
  children: ReactNode;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {children}
    </form>
  );
}

function PrimaryButton({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="unstyled"
      type="submit"
      className={cn(
        controls.button,
        controls.primary,
        controls.block,
        styles.gapBlock
      )}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className={controls.errorText} role="alert">
      {children}
    </p>
  );
}

function EmailStep({ flow }: StepProps) {
  const { t } = useI18n();
  return (
    <>
      <StepForm onSubmit={flow.submitEmail}>
        <h2 className={styles.title}>
          {t('settings.account.auth.emailTitle')}
        </h2>
        <div className={styles.afterTitle}>
          <AccountField
            type="email"
            value={flow.email}
            onChange={(event) => flow.setEmail(event.target.value)}
            placeholder={t('settings.account.auth.emailPlaceholder')}
            aria-label={t('settings.account.auth.emailPlaceholder')}
            autoComplete="email"
            invalid={flow.error !== null}
            autoFocus
          />
        </div>
        {flow.error ? (
          <div className={styles.messageRow}>
            <ErrorText>{flow.error}</ErrorText>
            {flow.offerRegister ? (
              <Button
                variant="unstyled"
                type="button"
                className={controls.textButton}
                onClick={flow.startRegister}
              >
                {t('settings.account.auth.register')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <PrimaryButton disabled={!isValidEmail(flow.email) || flow.busy}>
          {flow.busy
            ? t('settings.account.auth.sending')
            : t('settings.account.auth.continue')}
        </PrimaryButton>
        <Button
          variant="unstyled"
          type="button"
          className={cn(
            controls.button,
            controls.linkButton,
            controls.block,
            styles.gapGroup
          )}
          onClick={flow.startPassword}
        >
          {t('settings.account.auth.usePassword')}
        </Button>
      </StepForm>
      <p className={styles.terms}>
        {t('settings.account.auth.termsPrefix')} <LegalLink kind="terms" />{' '}
        {t('settings.account.auth.termsAnd')} <LegalLink kind="privacy" />
      </p>
    </>
  );
}

function CodeStep({ flow }: StepProps) {
  const { t } = useI18n();
  return (
    <div className={styles.form}>
      <h2 className={styles.title}>{t('settings.account.code.title')}</h2>
      <p className={styles.subtitle}>{flow.email.trim()}</p>
      <div className={styles.afterTitle}>
        <CodeCells
          value={flow.code}
          onChange={flow.setCode}
          onComplete={flow.submitCode}
          ariaLabel={t('settings.account.code.ariaLabel')}
          invalid={flow.error !== null}
          disabled={flow.busy}
          autoFocus
        />
      </div>
      {flow.busy ? (
        <div className={styles.messageRow}>
          <p className={controls.hintText} role="status">
            {flow.code.length === 6
              ? t('settings.account.auth.verifying')
              : t('settings.account.auth.sending')}
          </p>
        </div>
      ) : flow.error ? (
        <div className={styles.messageRow}>
          <ErrorText>{flow.error}</ErrorText>
        </div>
      ) : null}
      <ResendCode
        className={styles.gapBlock}
        left={flow.resendLeft}
        onResend={flow.resend}
        disabled={flow.busy}
      />
    </div>
  );
}

function PasswordStep({ flow }: StepProps) {
  const { t } = useI18n();
  return (
    <StepForm onSubmit={flow.submitPassword}>
      <h2 className={styles.title}>{t('settings.account.password.title')}</h2>
      <div className={styles.afterTitle}>
        <AccountField
          type="email"
          value={flow.email}
          onChange={(event) => flow.setEmail(event.target.value)}
          placeholder={t('settings.account.auth.emailPlaceholder')}
          aria-label={t('settings.account.auth.emailPlaceholder')}
          autoComplete="email"
        />
      </div>
      <div className={styles.gapGroup}>
        <AccountField
          revealable
          value={flow.password}
          onChange={(event) => flow.setPassword(event.target.value)}
          placeholder={t('settings.account.password.placeholder')}
          aria-label={t('settings.account.password.placeholder')}
          autoComplete="current-password"
          invalid={flow.error !== null}
          autoFocus={isValidEmail(flow.email)}
        />
      </div>
      <div
        className={cn(styles.messageRow, !flow.error && styles.messageRowEnd)}
      >
        {flow.error ? <ErrorText>{flow.error}</ErrorText> : null}
        <Button
          variant="unstyled"
          type="button"
          className={controls.textButton}
          onClick={flow.startReset}
        >
          {t('settings.account.password.forgot')}
        </Button>
      </div>
      <PrimaryButton
        disabled={!isValidEmail(flow.email) || !flow.password || flow.busy}
      >
        {flow.busy
          ? t('settings.account.auth.loggingIn')
          : t('settings.account.password.submit')}
      </PrimaryButton>
    </StepForm>
  );
}

function SetPasswordStep({ flow }: StepProps) {
  const { t } = useI18n();
  const title =
    flow.scene === 'reset'
      ? t('settings.account.set.resetTitle')
      : t('settings.account.set.registerTitle');
  return (
    <StepForm onSubmit={flow.submitSet}>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.afterTitle}>
        <AccountField
          revealable
          value={flow.password}
          onChange={(event) => flow.setPassword(event.target.value)}
          placeholder={t('settings.account.set.placeholder')}
          aria-label={t('settings.account.set.placeholder')}
          autoComplete="new-password"
          invalid={flow.error !== null}
          autoFocus
        />
        <PasswordStrengthHint password={flow.password} email={flow.email} />
      </div>
      {flow.busy ? (
        <div className={styles.messageRow}>
          <p className={controls.hintText} role="status">
            {t('settings.account.auth.submitting')}
          </p>
        </div>
      ) : flow.error ? (
        <div className={styles.messageRow}>
          <ErrorText>{flow.error}</ErrorText>
        </div>
      ) : null}
      <PrimaryButton
        disabled={!isValidPassword(flow.password, flow.email) || flow.busy}
      >
        {flow.busy
          ? t('settings.account.auth.submitting')
          : t('settings.account.set.submit')}
      </PrimaryButton>
    </StepForm>
  );
}

/** 当前步骤整层：非邮箱步骤左上角带返回 */
export function AccountAuthStep({ flow }: StepProps) {
  const { t } = useI18n();
  return (
    <>
      {flow.step !== 'email' ? (
        <div className={cn(styles.corner, styles.cornerStart)}>
          <Tooltip content={t('settings.account.back')}>
            <Button
              variant="unstyled"
              type="button"
              className={controls.iconButton}
              aria-label={t('settings.account.back')}
              onClick={flow.back}
            >
              <AppIcon name="arrow-left" size={16} />
            </Button>
          </Tooltip>
        </div>
      ) : null}
      {flow.step === 'email' ? <EmailStep flow={flow} /> : null}
      {flow.step === 'code' ? <CodeStep flow={flow} /> : null}
      {flow.step === 'password' ? <PasswordStep flow={flow} /> : null}
      {flow.step === 'set' ? <SetPasswordStep flow={flow} /> : null}
    </>
  );
}
