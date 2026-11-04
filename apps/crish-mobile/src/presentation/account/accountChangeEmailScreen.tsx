// 换绑邮箱（原型换绑邮箱页版式）：当前绑定邮箱只读盒 + 新邮箱地址 +
// 邮箱验证码（获取验证码胶囊）+ 底部主钮「确认换绑」。
//
// 账号服务没有换绑邮箱能力（2026-11-02 全仓审计：
// /api/auth/* 全部端点无 email change/rebind；EmailCodeScene 仅
// login/register/reset；桌面端 auth 场次同样只有登录/注册/重置）。
// 因此本页不发任何网络请求、不假发码、不假成功：点「获取验证码」或
// 「确认换绑」统一如实呈现「账号服务暂不支持换绑邮箱」；新邮箱格式错误
// 仍按字段级口径贴字段。后端补齐换绑端点后，在本页接线即可。
import { useState } from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { isValidEmail, normalizeEmail } from '@/adapters/account/accountFlow';
import { AppText } from '@/presentation/ui';
import { AuthBar, AuthButton, AuthField, AuthPage, CodeFieldRow } from './ui';

/** 换绑邮箱暂不支持的诚实提示（后端无此能力，见文件头审计结论） */
export const CHANGE_EMAIL_UNSUPPORTED_MESSAGE =
  '账号服务暂不支持换绑邮箱，暂时无法完成换绑';

export interface AccountChangeEmailScreenProps {
  onBack: () => void;
}

export function AccountChangeEmailScreen({
  onBack,
}: AccountChangeEmailScreenProps) {
  const theme = useTheme();
  const user = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const currentEmail = profile?.email ?? user?.email ?? '';

  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [unsupported, setUnsupported] = useState(false);

  const showUnsupported = () => setUnsupported(true);

  const submit = () => {
    const normalized = normalizeEmail(newEmail);
    if (!isValidEmail(normalized)) {
      setEmailError('请输入有效邮箱');
      return;
    }
    if (normalized === normalizeEmail(currentEmail)) {
      setEmailError('新邮箱与当前绑定邮箱相同');
      return;
    }
    setEmailError(null);
    showUnsupported();
  };

  return (
    <AuthPage testID="account-change-email-screen">
      <AuthBar title="换绑邮箱" onBack={onBack} />
      <KeyboardAwareScrollView
        bottomOffset={theme.space.md}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <AuthField
          label="当前绑定邮箱"
          value={currentEmail}
          editable={false}
          placeholder="当前邮箱"
          autoCapitalize="none"
          testID="change-email-current"
        />
        <AuthField
          label="新邮箱地址"
          value={newEmail}
          onChangeText={(text) => {
            setNewEmail(text);
            if (emailError) setEmailError(null);
          }}
          error={emailError}
          placeholder="输入新的邮箱地址…"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          testID="change-email-new"
        />
        <CodeFieldRow
          label="邮箱验证码"
          value={code}
          onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
          onRequestCode={showUnsupported}
          testID="change-email-code"
        />
        {unsupported ? (
          <AppText
            variant="footnote"
            color="danger"
            testID="change-email-notice"
          >
            {CHANGE_EMAIL_UNSUPPORTED_MESSAGE}
          </AppText>
        ) : null}
        <View style={{ paddingTop: theme.space.sm }}>
          <AuthButton
            label="确认换绑"
            testID="change-email-submit"
            onPress={submit}
          />
        </View>
      </KeyboardAwareScrollView>
    </AuthPage>
  );
}

export default AccountChangeEmailScreen;
