// 扫码配对占位（P2 / G-10 注记：扫码功能即将推出，v1 手动输入先行，D4 §12.4-3）：
// 占位文案 + 返回（onBack 注入；页面层接 router.back()，回到配对引导）。
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '@/adapters/settings/themeProjection';
import Button from '@/presentation/components/ui/Button';

export interface PairScanScreenProps {
  /** 返回（→ 配对引导；页面层接 router.back()） */
  onBack: () => void;
}

export default function PairScanScreen({ onBack }: PairScanScreenProps) {
  const theme = useAppTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <Text style={[styles.title, { color: theme.textPrimary }]}>扫码配对</Text>
      <Text style={[styles.description, { color: theme.textSecondary }]}>
        扫码功能即将推出，请使用手动输入。
      </Text>
      <Button
        label="返回"
        variant="secondary"
        testID="pair-scan-back"
        onPress={onBack}
        style={styles.backBtn}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  description: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  backBtn: {
    marginTop: 16,
    minWidth: 120,
  },
});
