// 账号 v3 设置密码：注册 / 重置 / 修改三用。
// 注册与重置在验证码通过后进入本页（先验证码、后设密码），凭 setupToken 落库并登录；
// 修改密码在本页收下新密码后发验证码，验证码页确认时提交。
import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import {
  completeAccountPassword,
  getAccountFlowDraft,
  isValidEmail,
  normalizeEmail,
  startPasswordChange,
} from '@/adapters/account/accountFlow';
import {
  evaluatePassword,
  type PasswordRejectReason,
  type PasswordStrength,
} from '@/adapters/account/passwordPolicy';
import { AppText } from '@/presentation/ui';
import { AuthBar, AuthButton, AuthField, AuthPage, BigTitle } from './ui';

export type SetPasswordMode = 'register' | 'reset' | 'change';

const TITLES: Record<SetPasswordMode, string> = {
  register: '设置密码',
  reset: '重置密码',
  change: '修改密码',
};

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

export function isSetPasswordMode(value: unknown): value is SetPasswordMode {
  return value === 'register' || value === 'reset' || value === 'change';
}

export interface AccountSetPasswordScreenProps {
  mode: SetPasswordMode;
  initialEmail?: string;
  onBack: () => void;
  /** register / reset 完成 */
  onDone: () => void;
  /** change 已发出验证码 */
  onCodeSent: () => void;
}

export function AccountSetPasswordScreen({
  mode,
  initialEmail = '',
  onBack,
  onDone,
  onCodeSent,
}: AccountSetPasswordScreenProps) {
  const theme = useTheme();
  const storeError = useAccountStore((s) => s.error);
  const draft = getAccountFlowDraft();
  const email = normalizeEmail(
    mode === 'change' ? initialEmail : (draft?.email ?? initialEmail)
  );
  const setupReady = mode === 'change' || Boolean(draft?.setupToken);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evaluation = password ? evaluatePassword(password, { email }) : null;
  const ready =
    isValidEmail(email) && setupReady && Boolean(evaluation?.acceptable);
  const strengthText = evaluation
    ? evaluation.reason
      ? REASON_TEXT[evaluation.reason]
      : STRENGTH_TEXT[evaluation.strength]
    : null;
  const strengthColor = evaluation?.reason
    ? theme.colors.danger
    : theme.colors.textTertiary;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    if (mode === 'change') {
      const result = await startPasswordChange(email, password);
      setBusy(false);
      if (result.kind === 'sent') onCodeSent();
      else setError(result.message);
      return;
    }
    const result = await completeAccountPassword(password);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.message || storeError || '设置密码失败，请稍后重试');
  };

  return (
    <AuthPage testID="account-set-password-screen">
      <AuthBar onBack={onBack} />
      <BigTitle title={TITLES[mode]} subtitle={email || undefined} />
      <View style={{ padding: theme.layout.accountPageX, gap: theme.space.md }}>
        {setupReady ? null : (
          <AppText variant="footnote" color="danger">
            请先返回完成邮箱验证
          </AppText>
        )}
        <View style={{ gap: theme.space.sm }}>
          <AuthField
            testID="set-password-input"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (error) setError(null);
            }}
            error={error}
            placeholder={mode === 'register' ? '密码' : '新密码'}
            secure
            autoFocus
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
          />
          {strengthText ? (
            <AppText
              variant="footnote"
              testID="set-password-strength"
              style={{
                color: strengthColor,
                paddingHorizontal: theme.space.xs,
              }}
            >
              {strengthText}
            </AppText>
          ) : null}
        </View>
        <AuthButton
          label={mode === 'change' ? '发送验证码' : '完成'}
          testID="set-password-submit"
          disabled={!ready}
          loading={busy}
          onPress={() => void submit()}
        />
      </View>
    </AuthPage>
  );
}

export default AccountSetPasswordScreen;
