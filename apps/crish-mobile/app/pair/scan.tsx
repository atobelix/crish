import { StyleSheet, Text, View } from 'react-native';

// 扫码配对（P2，D4 §12.4-3）：v1 手动输入先行，扫码入口隐藏
// R2-03 评估 expo-camera 时按需启用
export default function PairScanScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>扫码配对</Text>
      <Text style={styles.description}>
        扫码配对为 P2 预留入口（v1 使用手动输入）。
      </Text>
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
    color: '#555555',
    textAlign: 'center',
  },
});
