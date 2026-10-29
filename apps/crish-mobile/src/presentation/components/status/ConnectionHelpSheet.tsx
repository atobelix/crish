// 连接帮助：网络、服务、证书信任的排障步骤。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Sheet } from '@/presentation/ui';

const STEPS = [
  '确认手机与电脑连接到同一 Wi-Fi，且未开启 AP 隔离或 VPN。',
  '在桌面端「设置 → 多端互通」开启服务与局域网配对。',
  '首次连接提示证书错误：在桌面端「安全连接 → 导出证书」，把 crish-ca.crt 传到手机安装并完全信任（Android：设置 → 安全 → 安装 CA 证书；iOS：安装描述文件后在「证书信任设置」中启用）。',
  '仍无法连接时，尝试手动输入电脑的局域网 IP 与配对码。',
];

export interface ConnectionHelpSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function ConnectionHelpSheet({
  visible,
  onClose,
}: ConnectionHelpSheetProps) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="连接帮助">
      <View style={styles.list}>
        {STEPS.map((step, index) => (
          <View key={step} style={styles.row}>
            <View
              style={[
                styles.index,
                { borderRadius: theme.radius.pill },
                { backgroundColor: theme.colors.fillSubtle },
              ]}
            >
              <AppText variant="caption" color="textSecondary">
                {index + 1}
              </AppText>
            </View>
            <AppText variant="body" color="textSecondary" style={styles.text}>
              {step}
            </AppText>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 14,
    paddingBottom: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  index: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  text: {
    flex: 1,
  },
});

export default ConnectionHelpSheet;
