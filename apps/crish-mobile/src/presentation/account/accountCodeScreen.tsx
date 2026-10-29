// 账号 v3 验证码页：6 格自动提交；失败整排抖动后清空；重新发送带倒计时。
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  confirmAccountCode,
  getAccountFlowDraft,
  resendAccountCode,
} from '@/adapters/account/accountFlow';
import { AppText } from '@/presentation/ui';
import { AuthBar, AuthButton, AuthPage, BigTitle, CodeCells } from './ui';

/** 秒数 → m:ss */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

export interface AccountCodeScreenProps {
  onBack: () => void;
  /** 登录成功或改密完成 */
  onSuccess: () => void;
  /** 新账号 / 重置需要设置密码 */
  onSetPassword: (mode: 'register' | 'reset') => void;
}

export function AccountCodeScreen({
  onBack,
  onSuccess,
  onSetPassword,
}: AccountCodeScreenProps) {
  const theme = useTheme();
  const [draft, setDraft] = useState(getAccountFlowDraft);
  const [code, setCode] = useState('');
  const [errorKey, setErrorKey] = useState(0);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const remaining = draft ? (draft.resendAt - now) / 1000 : 0;
  const counting = remaining > 0;

  useEffect(() => {
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setFailedMessage(null);
    const result = await confirmAccountCode(value);
    setBusy(false);
    if (result.kind === 'signed_in' || result.kind === 'changed') {
      onSuccess();
      return;
    }
    if (result.kind === 'set_password') {
      onSetPassword(result.mode);
      return;
    }
    setFailedMessage(result.message);
    if (result.retryAfter !== undefined && draft) {
      setDraft({
        ...draft,
        resendAt: Date.now() + result.retryAfter * 1000,
      });
      setNow(Date.now());
    }
    setErrorKey((key) => key + 1);
  };

  const resend = async () => {
    setNotice(null);
    const result = await resendAccountCode();
    const latest = getAccountFlowDraft();
    if (result.kind === 'error' && result.retryAfter !== undefined && latest) {
      setDraft({
        ...latest,
        resendAt: Date.now() + result.retryAfter * 1000,
      });
    } else {
      setDraft(latest);
    }
    setNow(Date.now());
    if (result.kind === 'error') setNotice(result.message);
  };

  if (!draft) {
    return (
      <AuthPage testID="account-code-screen">
        <AuthBar onBack={onBack} />
        <BigTitle title="输入验证码" subtitle="请返回重新输入邮箱" />
      </AuthPage>
    );
  }

  const errorText = failedMessage ?? notice;

  return (
    <AuthPage testID="account-code-screen">
      <AuthBar onBack={onBack} />
      <BigTitle title="输入验证码" subtitle={`已发送至 ${draft.email}`} />
      <View style={{ padding: theme.layout.accountPageX, gap: theme.space.md }}>
        <CodeCells
          value={code}
          onChange={setCode}
          onComplete={(value) => void submit(value)}
          errorKey={errorKey}
          disabled={busy}
        />
        {errorText ? (
          <AppText
            variant="footnote"
            color="danger"
            testID="account-code-error"
          >
            {errorText}
          </AppText>
        ) : null}
        {__DEV__ && draft.devCode ? (
          <AppText variant="caption" color="textTertiary">
            开发验证码 {draft.devCode}
          </AppText>
        ) : null}
        <AuthButton
          label={
            remaining > 0
              ? `重新发送 · ${formatCountdown(remaining)}`
              : '重新发送'
          }
          variant="ghost"
          testID="account-code-resend"
          disabled={remaining > 0}
          onPress={() => void resend()}
        />
      </View>
    </AuthPage>
  );
}

export default AccountCodeScreen;
