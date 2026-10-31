// 账号 v3 密码登录：邮箱 + 密码；登录失败按结构化结果区分「凭据错误」与
// 「网络故障」（实现波总方案 A4：网络超时不再误报为「邮箱或密码不正确」），
// 附「忘记密码」。提交期间输入框锁定（editable=false），按钮保留动词 + Spinner。
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
  const [loginError, setLoginError] = useState<string | null>(null);
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
    setLoginError(null);
    const result = await loginAccountWithPassword(
      normalizeEmail(email),
      password
    );
    setBusy(false);
    if (result.ok) onSuccess();
    else setLoginError(result.message);
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
            setLoginError(null);
          }}
          error={loginError}
          editable={!busy}
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
            setLoginError(null);
          }}
          editable={!busy}
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
          loadingLabel="正在登录…"
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
          loadingLabel="正在发送验证码…"
          disabled={!isValidEmail(email) || busy}
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
