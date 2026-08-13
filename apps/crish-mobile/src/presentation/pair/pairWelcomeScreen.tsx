// 配对引导首页（F6 首次启动引导 / M5 §2.1 pair/welcome.tsx，R2-03 部分 3 接线）：
// - 引导文案 + 「手动输入配对信息」（→ manual）+ 「扫码配对」（→ scan 占位页；
//   G-10 注记：扫码为 P2，v1 手动输入先行，D4 §12.4-3）；
// - 已配对态兜底：authStore hydrated 且 paired → 展示已配对设备信息
//   （host / desktopId / deviceId）+「进入应用」（冷启动恢复水合后直接放行；
//   pair/_layout 已配对自动重定向 (tabs)，本兜底覆盖直接导航边缘路径）；
// - 路由注入 onOpenManual / onOpenScan / onEnterApp（页面不依赖 expo-router，
//   组件测试可直接挂载，对齐 approvalListScreen 路由注入范式）。
import { StyleSheet, Text, View } from 'react-native';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAppTheme } from '@/adapters/settings/themeProjection';
import Button from '@/presentation/components/ui/Button';

export interface PairWelcomeScreenProps {
  /** 手动输入入口（→ /pair/manual） */
  onOpenManual: () => void;
  /** 扫码配对入口（→ /pair/scan 占位页，P2） */
  onOpenScan: () => void;
  /** 已配对态「进入应用」（→ (tabs)） */
  onEnterApp: () => void;
}

export default function PairWelcomeScreen({
  onOpenManual,
  onOpenScan,
  onEnterApp,
}: PairWelcomeScreenProps) {
  const theme = useAppTheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const pairState = useAuthStore((s) => s.pairState);
  const host = useAuthStore((s) => s.host);
  const desktopId = useAuthStore((s) => s.desktopId);
  const deviceId = useAuthStore((s) => s.deviceId);
  const paired = hydrated && pairState === 'paired';

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={styles.hero}>
        <Text style={[styles.title, { color: theme.textPrimary }]}>
          配对桌面主机
        </Text>
        <Text style={[styles.description, { color: theme.textSecondary }]}>
          在桌面端开启配对模式，然后在手机上输入主机 IP 与配对码即可完成配对。
        </Text>
      </View>

      <View style={styles.actions}>
        <Button
          label="手动输入配对信息"
          testID="pair-welcome-manual"
          onPress={onOpenManual}
          style={styles.actionBtn}
        />
        <Button
          label="扫码配对"
          variant="secondary"
          testID="pair-welcome-scan"
          onPress={onOpenScan}
          style={styles.actionBtn}
        />
      </View>

      {paired ? (
        <View
          testID="pair-welcome-paired"
          style={[
            styles.pairedCard,
            {
              backgroundColor: theme.bgCard,
              borderColor: theme.hairline,
            },
          ]}
        >
          <Text style={[styles.pairedTitle, { color: theme.textPrimary }]}>
            已配对
          </Text>
          <Text style={[styles.pairedRow, { color: theme.textSecondary }]}>
            主机：{host ?? '—'}
          </Text>
          <Text style={[styles.pairedRow, { color: theme.textSecondary }]}>
            桌面端：{desktopId ?? '—'}
          </Text>
          <Text style={[styles.pairedRow, { color: theme.textSecondary }]}>
            本机：{deviceId ?? '—'}
          </Text>
          <Button
            label="进入应用"
            testID="pair-welcome-enter"
            onPress={onEnterApp}
            style={styles.enterBtn}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  hero: {
    gap: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  description: {
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  actions: {
    marginTop: 16,
    gap: 12,
  },
  actionBtn: {
    alignSelf: 'stretch',
  },
  pairedCard: {
    marginTop: 24,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 6,
  },
  pairedTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  pairedRow: {
    fontSize: 13,
    lineHeight: 19,
  },
  enterBtn: {
    marginTop: 10,
  },
});
