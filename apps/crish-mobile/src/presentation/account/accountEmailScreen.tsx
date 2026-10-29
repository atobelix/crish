// 账号 v3 邮箱入口：只填邮箱，「继续」后由服务端决定走登录验证码还是注册验证码。
import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  continueWithEmail,
  isValidEmail,
} from '@/adapters/account/accountFlow';
import { AuthBar, AuthButton, AuthField, AuthPage, BigTitle } from './ui';

export interface AccountEmailScreenProps {
  onBack: () => void;
  /** 验证码已发出（登录 / 注册由服务端在验证码确认时决定） */
  onCodeSent: () => void;
  onUsePassword: (email: string) => void;
}

export function AccountEmailScreen({
  onBack,
  onCodeSent,
  onUsePassword,
}: AccountEmailScreenProps) {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = isValidEmail(email);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const result = await continueWithEmail(email);
    setBusy(false);
    if (result.kind === 'sent') onCodeSent();
    else setError(result.message);
  };

  return (
    <AuthPage testID="account-email-screen">
      <AuthBar onBack={onBack} />
      <BigTitle title="登录或注册" subtitle="输入邮箱，我们会发送验证码" />
      <View
        style={{
          padding: theme.layout.accountPageX,
          gap: theme.space.md,
        }}
      >
        <AuthField
          testID="account-email-input"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            if (error) setError(null);
          }}
          error={error}
          placeholder="邮箱"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
        <AuthButton
          label="继续"
          testID="account-email-continue"
          disabled={!valid}
          loading={busy}
          onPress={() => void submit()}
        />
        <AuthButton
          label="使用密码登录"
          variant="ghost"
          testID="account-email-use-password"
          onPress={() => onUsePassword(email.trim())}
        />
      </View>
    </AuthPage>
  );
}

export default AccountEmailScreen;
