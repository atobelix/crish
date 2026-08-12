import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { buildPairHello } from '@/pairing/pairProtocol';

// 手动配对页（D4 §5.1）：输入主机 IP + CXN 配对码
// 骨架：UI 骨架 + R2-03 协议层本地校验占位；完整配对流程（状态机接线：
// submitCode → hello 发送 → pair.ok 存 token）由接线层落地（未覆盖项）
export default function PairManualScreen() {
  const [host, setHost] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // R2-03 协议层本地校验：CXN 格式非法直接拒绝（不发起网络请求）
    const hello = buildPairHello({ code: pin, deviceName: 'crish-mobile' });
    if (!hello.ok) {
      setBusy(false);
      setError(hello.error);
      return;
    }
    // 校验通过：此处为接线占位——真实配对走状态机（pairMachine 深化后
    // submitCode 事件 + WsGateway 发送 hello + pair.ok 提取 token 持久化），
    // 网络发送属接线层未覆盖项，暂不发起请求
    setBusy(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>手动配对</Text>
      <TextInput
        style={styles.input}
        placeholder="主机 IP / 主机名"
        placeholderTextColor="#999999"
        value={host}
        onChangeText={setHost}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        placeholder="配对码（CXN-XXXX-XXXX-XXXX）"
        placeholderTextColor="#999999"
        value={pin}
        onChangeText={setPin}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={[styles.button, busy ? styles.buttonDisabled : null]}
        onPress={() => void onSubmit()}
        disabled={busy}
      >
        <Text style={styles.buttonText}>{busy ? '连接中…' : '连接'}</Text>
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
    marginBottom: 8,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: 'hsl(35,10%,86%)',
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  error: {
    color: 'hsl(0,55%,55%)',
    fontSize: 13,
  },
  button: {
    height: 48,
    borderRadius: 9999,
    backgroundColor: 'hsl(142,35%,42%)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
