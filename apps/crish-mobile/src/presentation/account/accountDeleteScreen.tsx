// 账号 v3 注销账号：输入与当前账号一致的邮箱后才可提交。
// 服务端校验确认邮箱；法务保全 / 仍有余额等拒绝按中文文案展示。
import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { deleteAccount } from '@/adapters/account/accountDeletion';
import { normalizeEmail } from '@/adapters/account/accountFlow';
import { AuthBar, AuthButton, AuthField, AuthPage, BigTitle } from './ui';

export interface AccountDeleteScreenProps {
  email: string;
  onBack: () => void;
  onDeleted: () => void;
}

export function AccountDeleteScreen({
  email,
  onBack,
  onDeleted,
}: AccountDeleteScreenProps) {
  const theme = useTheme();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matches =
    email.length > 0 && normalizeEmail(typed) === normalizeEmail(email);

  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    const result = await deleteAccount(typed);
    setBusy(false);
    if (result.ok) onDeleted();
    else setError(result.message);
  };

  return (
    <AuthPage testID="account-delete-screen">
      <AuthBar onBack={onBack} />
      <BigTitle
        title="注销账号"
        subtitle={`注销后账号数据将被永久删除且无法恢复。请输入 ${email} 以确认。`}
      />
      <View style={{ padding: theme.layout.accountPageX, gap: theme.space.md }}>
        <AuthField
          testID="account-delete-input"
          value={typed}
          onChangeText={(text) => {
            setTyped(text);
            if (error) setError(null);
          }}
          error={error}
          placeholder="邮箱"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        <AuthButton
          label="注销账号"
          variant="secondary"
          danger
          testID="account-delete-submit"
          disabled={!matches}
          loading={busy}
          onPress={() => void submit()}
        />
      </View>
    </AuthPage>
  );
}

export default AccountDeleteScreen;
