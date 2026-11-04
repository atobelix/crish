// 账号 v3 欢迎页：大标题 + 两种进入方式（邮箱账号 / 扫码直连电脑）。
// N05/D7 裁定：品牌大图标删除（文字已足够，非必要不显示图标）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import { AuthButton, AuthPage } from './ui';

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
        <AppText variant="bigTitle" color="textPrimary">
          Crish
        </AppText>
      </View>
      <View
        style={{
          paddingHorizontal: theme.space.lg,
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
        {/* 法务正文缺口（D7 登记，2026-11-02）：用户协议 / 隐私政策正文尚未备妥，
            此行仅作普通说明文字呈现、不作可点链接；待法务文本就绪后在此接真实协议页 */}
        <AppText
          variant="caption"
          color="textTertiary"
          style={{ ...styles.center, marginTop: theme.space.md }}
        >
          继续即表示你同意用户协议与隐私政策
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
