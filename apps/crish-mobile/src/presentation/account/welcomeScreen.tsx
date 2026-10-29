// 账号 v3 欢迎页：品牌标 + Crish，两种进入方式（邮箱账号 / 扫码直连电脑）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, BrandMark } from '@/presentation/ui';
import { AuthButton, AuthPage } from './ui';

const BRAND_MARK_SIZE = 64;

export interface WelcomeScreenProps {
  onContinueWithEmail: () => void;
  onScanToConnect: () => void;
}

export function WelcomeScreen({
  onContinueWithEmail,
  onScanToConnect,
}: WelcomeScreenProps) {
  const theme = useTheme();
  return (
    <AuthPage testID="welcome-screen">
      <View style={[styles.hero, { gap: theme.space.lg }]}>
        <BrandMark size={BRAND_MARK_SIZE} />
        <AppText variant="bigTitle" color="textPrimary">
          Crish
        </AppText>
      </View>
      <View
        style={{
          paddingHorizontal: theme.layout.accountPageX,
          paddingBottom: theme.space.lg,
          gap: theme.space.sm,
        }}
      >
        <AuthButton
          label="使用邮箱继续"
          testID="welcome-email"
          onPress={onContinueWithEmail}
        />
        <AuthButton
          label="扫码连接电脑"
          variant="secondary"
          testID="welcome-scan"
          onPress={onScanToConnect}
        />
        <AppText
          variant="caption"
          color="textTertiary"
          style={{ ...styles.center, marginTop: theme.space.md }}
        >
          继续即表示你同意《用户协议》与《隐私政策》
        </AppText>
      </View>
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
});

export default WelcomeScreen;
