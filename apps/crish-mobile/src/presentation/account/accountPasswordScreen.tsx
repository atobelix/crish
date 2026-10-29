// 账号 v3 密码登录：邮箱 + 密码；失败时密码框染 dangerSoft 并提示，附「忘记密码」。
import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { loginAccountWithPassword } from '@/adapters/account/accountService';
import {
  isValidEmail,
  normalizeEmail,
  startPasswordReset,
} from '@/adapters/account/accountFlow';
import { AppText } from '@/presentation/ui';
import { AuthBar, AuthButton, AuthField, AuthPage, BigTitle } from './ui';

export interface AccountPasswordScreenProps {
  initialEmail?: string;
  onBack: () => void;
  onSuccess: () => void;
  onForgot: (email: string) => void;
}

export function AccountPasswordScreen({
  initialEmail = '',
  onBack,
  onSuccess,
  onForgot,
}: AccountPasswordScreenProps) {
  const theme = useTheme();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const ready = isValidEmail(email) && password.length > 0;

  /** 找回密码：先发重置验证码，成功后进入验证码页。 */
  const forgot = async () => {
    if (!isValidEmail(email) || resetBusy) return;
    setResetBusy(true);
    setResetError(null);
    const result = await startPasswordReset(email);
    setResetBusy(false);
    if (result.kind === 'sent') onForgot(normalizeEmail(email));
    else setResetError(result.message);
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setFailed(false);
    // runLoginFlow 只回传布尔值，网络错误与凭据错误暂无法区分（见交付报告）
    const ok = await loginAccountWithPassword(normalizeEmail(email), password);
    setBusy(false);
    if (ok) onSuccess();
    else setFailed(true);
  };

  return (
    <AuthPage testID="account-password-screen">
      <AuthBar onBack={onBack} />
      <BigTitle title="密码登录" />
      <View style={{ padding: theme.layout.accountPageX, gap: theme.space.md }}>
        <AuthField
          testID="account-password-email"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            setFailed(false);
          }}
          placeholder="邮箱"
          autoFocus={!initialEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
        />
        <AuthField
          testID="account-password-input"
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            setFailed(false);
          }}
          error={failed ? '邮箱或密码不正确' : null}
          placeholder="密码"
          secure
          autoFocus={Boolean(initialEmail)}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
        <AuthButton
          label="登录"
          testID="account-password-submit"
          disabled={!ready}
          loading={busy}
          onPress={() => void submit()}
        />
        <AuthButton
          label="忘记密码"
          variant="ghost"
          testID="account-password-forgot"
          loading={resetBusy}
          disabled={!isValidEmail(email)}
          onPress={() => void forgot()}
        />
        {resetError ? (
          <AppText variant="footnote" color="danger">
            {resetError}
          </AppText>
        ) : null}
      </View>
    </AuthPage>
  );
}

export default AccountPasswordScreen;
