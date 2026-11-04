// 修改密码（单页式）：验证码 + 新密码 + 确认新密码同页完成——不再是旧版
// 「先在改密页填密码 → 跳验证码页 → 再回填确认」的两段式（先密后码正是
// 用户指出的「有点迷」）。底层调用与校验规则不变：发码 =
// requestAccountPasswordChangeCode（POST /api/auth/password/change/request）；
// 确认 = confirmAccountPasswordChange（POST /api/auth/password/change/confirm，
// 服务端硬编码 revokeOtherSessions: true，成功后其它设备登录自动失效，页脚
// 如实注明）。不经 accountFlow 草稿（新密码不再暂存内存跨页）。字段级错误
// 口径（F7 式）：本地校验贴对应字段并粘住、改字段才清除；服务端拒绝按
// 错误码/文案归因到验证码 / 新密码字段，归因不了的进按钮下通用错误行。
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { AccountApiError } from '@/adapters/account/accountApi';
import {
  confirmAccountPasswordChange,
  requestAccountPasswordChangeCode,
} from '@/adapters/account/accountService';
import { RESEND_COOLDOWN_SECONDS } from '@/adapters/account/accountFlow';
import {
  evaluatePassword,
  type PasswordRejectReason,
  type PasswordStrength,
} from '@/adapters/account/passwordPolicy';
import { AppText, useToast } from '@/presentation/ui';
import { AuthBar, AuthButton, AuthField, AuthPage, CodeFieldRow } from './ui';

const CODE_LENGTH = 6;

// 与设置密码页（accountSetPasswordScreen）同一套强度 / 拒绝文案口径。
const STRENGTH_TEXT: Record<PasswordStrength, string> = {
  weak: '强度：弱',
  medium: '强度：中',
  strong: '强度：强',
};
const REASON_TEXT: Record<PasswordRejectReason, string> = {
  too_short: '密码至少 8 位',
  too_long: '密码最多 128 位',
  too_weak: '密码过于简单，请避免连续、重复字符或常见密码',
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 服务端改密拒绝归因：验证码类落验证码字段，密码类落新密码字段，其余通用 */
export function attributeChangePasswordError(
  error: unknown
): 'code' | 'password' | 'general' {
  if (error instanceof AccountApiError) {
    const code = error.code.toLowerCase();
    if (code.includes('code') || error.message.includes('验证码'))
      return 'code';
    if (code.includes('password') || error.message.includes('密码')) {
      return 'password';
    }
    return 'general';
  }
  if (error instanceof Error && error.message.includes('验证码')) return 'code';
  if (error instanceof Error && error.message.includes('密码'))
    return 'password';
  return 'general';
}

export interface AccountChangePasswordScreenProps {
  onBack: () => void;
  /** 改密成功（路由层回账号页） */
  onDone: () => void;
}

export function AccountChangePasswordScreen({
  onBack,
  onDone,
}: AccountChangePasswordScreenProps) {
  const theme = useTheme();
  const { showToast } = useToast();
  const user = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const email = profile?.email ?? user?.email ?? '';

  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [devCode, setDevCode] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(
      () => setCooldown((s) => Math.max(0, s - 1)),
      1000
    );
    return () => clearInterval(timer);
  }, [cooldown]);

  const requestCode = async () => {
    if (sending || cooldown > 0 || submitting) return;
    setSending(true);
    setCodeError(null);
    try {
      const ticket = await requestAccountPasswordChangeCode();
      setCooldown(ticket.resendAfter ?? RESEND_COOLDOWN_SECONDS);
      setDevCode(ticket.devCode ?? null);
    } catch (error) {
      if (error instanceof AccountApiError && error.retryAfter) {
        setCooldown(error.retryAfter);
      }
      setCodeError(messageOf(error, '验证码发送失败，请稍后再试'));
    } finally {
      setSending(false);
    }
  };

  const evaluation = password ? evaluatePassword(password, { email }) : null;

  const submit = async () => {
    if (submitting) return;
    // 本地校验贴字段（F7 式：错误粘住，改对应字段才清除）。密码策略不达标
    // 不另设字段错误——新密码框下的强度行已红字写明拒绝原因（同字段口径）。
    const nextCodeError =
      code.length !== CODE_LENGTH ? '请输入 6 位验证码' : null;
    const nextConfirmError =
      confirm && confirm !== password ? '两次输入的密码不一致' : null;
    setCodeError(nextCodeError);
    setConfirmError(nextConfirmError);
    if (nextCodeError || nextConfirmError) return;
    if (!evaluation?.acceptable) return;

    setSubmitting(true);
    setGeneralError(null);
    try {
      await confirmAccountPasswordChange(code, password);
      showToast('密码已修改', 'success');
      onDone();
    } catch (error) {
      const target = attributeChangePasswordError(error);
      const message = messageOf(error, '修改失败，请稍后再试');
      if (target === 'code') {
        if (error instanceof AccountApiError && error.retryAfter) {
          setCooldown(error.retryAfter);
        }
        setCodeError(message);
      } else if (target === 'password') {
        setPasswordError(message);
      } else {
        setGeneralError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthPage testID="account-change-password-screen">
      <AuthBar title="修改密码" onBack={onBack} />
      <KeyboardAwareScrollView
        bottomOffset={theme.space.md}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        {email ? (
          <AppText variant="footnote" color="textTertiary">
            {`验证码将发送至 ${email}，修改密码后其他设备上的登录将自动退出`}
          </AppText>
        ) : null}
        <CodeFieldRow
          label="邮箱验证码"
          value={code}
          onChangeText={(text) => {
            setCode(text.replace(/\D/g, '').slice(0, CODE_LENGTH));
            if (codeError) setCodeError(null);
          }}
          error={codeError}
          onRequestCode={() => void requestCode()}
          requesting={sending}
          cooldown={cooldown}
          testID="change-password-code"
        />
        {__DEV__ && devCode ? (
          <AppText variant="caption" color="textTertiary">
            {`开发验证码 ${devCode}`}
          </AppText>
        ) : null}
        <View>
          <AuthField
            label="新密码"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (passwordError) setPasswordError(null);
            }}
            error={passwordError}
            placeholder="至少 8 位"
            secure
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            testID="change-password-new"
          />
          {evaluation ? (
            <AppText
              variant="footnote"
              color={evaluation.reason ? 'danger' : 'textTertiary'}
              testID="change-password-strength"
              style={{
                marginTop: theme.space.sm,
                paddingHorizontal: theme.space.xs,
              }}
            >
              {evaluation.reason
                ? REASON_TEXT[evaluation.reason]
                : STRENGTH_TEXT[evaluation.strength]}
            </AppText>
          ) : null}
        </View>
        <AuthField
          label="确认新密码"
          value={confirm}
          onChangeText={(text) => {
            setConfirm(text);
            if (confirmError) setConfirmError(null);
          }}
          error={confirmError}
          placeholder="再输入一次新密码"
          secure
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          testID="change-password-confirm"
        />
        {generalError ? (
          <AppText variant="footnote" color="danger">
            {generalError}
          </AppText>
        ) : null}
        <View style={{ paddingTop: theme.space.sm }}>
          <AuthButton
            label="确认修改"
            loadingLabel="正在修改…"
            loading={submitting}
            disabled={submitting || !code || !password || !confirm}
            testID="change-password-submit"
            onPress={() => void submit()}
          />
        </View>
      </KeyboardAwareScrollView>
    </AuthPage>
  );
}

export default AccountChangePasswordScreen;
