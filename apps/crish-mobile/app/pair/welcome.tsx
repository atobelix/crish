import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

// 配对首页（F6 首次启动引导 / M5 §2.1 pair/welcome.tsx）：
// 说明远程伴侣定位，进入手动配对；扫码入口 P2 隐藏（D4 §12.4-3）
export default function PairWelcomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>配对桌面主机</Text>
      <Text style={styles.description}>
        在桌面端开启配对模式，然后在手机上输入主机 IP 与配对码即可完成配对。
      </Text>
      <Pressable
        style={styles.button}
        onPress={() => router.push('/pair/manual')}
      >
        <Text style={styles.buttonText}>手动输入配对信息</Text>
      </Pressable>
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
  title: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  description: {
    fontSize: 14,
    color: '#555555',
    lineHeight: 22,
    textAlign: 'center',
  },
  button: {
    marginTop: 16,
    height: 48,
    borderRadius: 9999,
    backgroundColor: 'hsl(142,35%,42%)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
