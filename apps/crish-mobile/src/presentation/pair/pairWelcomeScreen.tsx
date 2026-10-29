// 配对欢迎：扫码为主，手动输入为辅。
import { StyleSheet, View } from 'react-native';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { AppText, BrandMark, Button, Card, Screen } from '@/presentation/ui';

export interface PairWelcomeScreenProps {
  onLogin: () => void;
  onOpenManual: () => void;
  onOpenScan: () => void;
  onEnterApp: () => void;
}

export default function PairWelcomeScreen({
  onLogin,
  onOpenManual,
  onOpenScan,
  onEnterApp,
}: PairWelcomeScreenProps) {
  const hydrated = useAuthStore((s) => s.hydrated);
  const pairState = useAuthStore((s) => s.pairState);
  const host = useAuthStore((s) => s.host);
  const accountStatus = useAccountStore((s) => s.status);
  const accountUser = useAccountStore((s) => s.user);
  const paired = hydrated && pairState === 'paired';
  const loggedIn = accountStatus === 'loggedIn';

  return (
    <Screen topInset bottomInset>
      <View style={styles.container}>
        <View style={styles.hero}>
          <BrandMark size={72} />
          <AppText variant="largeTitle" style={styles.title}>
            {loggedIn ? '我的电脑' : '连接桌面'}
          </AppText>
          <AppText
            variant="body"
            color="textSecondary"
            style={styles.description}
          >
            {loggedIn
              ? '登录同一账号后自动发现你的电脑。'
              : '登录账号后自动发现你的电脑；同一网络也可扫码直连。'}
          </AppText>
        </View>

        <View style={styles.actions}>
          {loggedIn ? (
            <Button
              label="进入应用"
              onPress={onEnterApp}
              testID="pair-welcome-enter"
            />
          ) : (
            <Button
              label={
                accountStatus === 'loggingIn' ? '登录中…' : '登录 Crish 账号'
              }
              onPress={onLogin}
              testID="pair-welcome-login"
            />
          )}
          <Button
            label="扫描二维码"
            variant="secondary"
            icon="qr-code"
            onPress={onOpenScan}
            testID="pair-welcome-scan"
          />
          <Button
            label="手动输入"
            variant="ghost"
            onPress={onOpenManual}
            testID="pair-welcome-manual"
          />
        </View>

        {paired ? (
          <Card style={styles.pairedCard}>
            <AppText variant="bodyStrong">已连接</AppText>
            <AppText variant="footnote" color="textSecondary">
              {host ?? '桌面设备'}
            </AppText>
          </Card>
        ) : null}

        {loggedIn && accountUser ? (
          <AppText variant="caption" color="textTertiary" style={styles.footer}>
            当前账号：{accountUser.email}
          </AppText>
        ) : (
          <AppText variant="caption" color="textTertiary" style={styles.footer}>
            手机与电脑需在同一网络，或登录同一 Crish 账号远程连接
          </AppText>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 28,
    justifyContent: 'center',
    gap: 32,
  },
  hero: {
    alignItems: 'center',
    gap: 12,
  },
  title: {
    marginTop: 4,
  },
  description: {
    textAlign: 'center',
  },
  actions: {
    gap: 12,
  },
  pairedCard: {
    gap: 8,
    alignItems: 'stretch',
  },
  footer: {
    textAlign: 'center',
  },
});
