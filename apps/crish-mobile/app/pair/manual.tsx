import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { pairWithHost } from '@/pairing/pairProtocol';

// 手动配对页（D4 §5.1）：输入主机 IP + CXN 配对码
// 骨架：仅 UI 骨架 + pairProtocol 占位调用；完整配对逻辑（verify/token 交换/
// 证书固定）由 R2-03 落地
export default function PairManualScreen() {
  const [host, setHost] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // R2-03 前 pairWithHost 恒返回未实现错误，此处仅验证占位链路
    const result = await pairWithHost({ host, pin });
    setBusy(false);
    if (!result.ok && result.message) {
      setError(result.message);
    }
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
