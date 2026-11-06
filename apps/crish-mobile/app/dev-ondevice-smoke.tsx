/**
* app/dev-ondevice-smoke.tsx
*
* 端侧模型 O1 批的最小真机验证面，不进正式导航
* （无任何入口链接，仅可经路由直达 /dev-ondevice-smoke）。
*
* 只做四件事：选已侧载的 GGUF 文件并复制进应用文档目录 → initLlama 加载
* → 一句提示词流式 completion（逐 token 显示 + 计时）→ 停止。
* 不接会话栈、不做正式 UI（那是 O3/O4 批）。
*
* 路径纪律（沿 ASR 2026-11-03 真机定根因）：交给原生引擎的必须是真实
* 文件系统路径，file:// URI 会被原生侧判为「不存在」——统一经
* toNativeFilePath 剥 scheme 后再喂 initLlama。
*
* 样式口径：颜色 / 圆角 / 字阶一律走 useTheme token（styleTokens 守卫
* 口径；初版裸 hex / 数字字号曾被全量守卫拦下，收口批 2026-11-06 修正）。
*/
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
ActivityIndicator,
ScrollView,
StyleSheet,
Text,
TextInput,
TouchableOpacity,
View,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import { initLlama, type LlamaContext} from 'llama.rn';
import { toNativeFilePath} from '@/adapters/asr/modelManager';
import { useTheme, type Theme} from '@/adapters/platform/theme';

/** 侧载目标：与 O2 模型管理层的目录口径一致（crish-llm-models/<文件名>） */
const MODEL_FILE_NAME = 'qwen2.5-1.5b-instruct-q4_k_m.gguf';
const MODEL_DIR_SUFFIX = 'crish-llm-models/';
const DEFAULT_PROMPT = '用一句话介绍你自己，并说说你能做什么。';

type Phase =
| 'idle'
| 'copying'
| 'loading'
| 'ready'
| 'generating'
| 'error';

function modelDirUri(): string {
return (FileSystem.documentDirectory?? '') + MODEL_DIR_SUFFIX;
}

function modelFileUri(): string {
return modelDirUri() + MODEL_FILE_NAME;
}

export default function DevOnDeviceSmokeRoute() {
const theme = useTheme();
const styles = useMemo(() => createStyles(theme), [theme]);
const [phase, setPhase] = useState<Phase>('idle');
const [status, setStatus] = useState<string>('未检查模型文件');
const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPT);
const [output, setOutput] = useState<string>('');
const [metrics, setMetrics] = useState<string>('');
const [errorText, setErrorText] = useState<string>('');
  const [hasContext, setHasContext] = useState(false);
const contextRef = useRef<LlamaContext | null>(null);
const tokenCountRef = useRef(0);
const genStartRef = useRef(0);
const firstTokenAtRef = useRef(0);

const refreshFileStatus = useCallback(async () => {
try {
const info = await FileSystem.getInfoAsync(modelFileUri());
if (info.exists) {
const mb = ((info.size?? 0) / (1024 * 1024)).toFixed(1);
setStatus(`模型文件在位：${MODEL_FILE_NAME}（${mb} MiB）`);
} else {
setStatus('模型文件不在位：请先「选择模型文件」侧载 GGUF');
}
} catch (e) {
setStatus(`检查模型文件失败：${String(e)}`);
}
}, []);

useEffect(() => {
void refreshFileStatus();
return () => {
const ctx = contextRef.current;
contextRef.current = null;
if (ctx) void ctx.release().catch(() => undefined);
};
}, [refreshFileStatus]);

/** 选已侧载到共享存储的 GGUF → 复制进应用文档目录 */
const handlePickModel = useCallback(async () => {
setErrorText('');
try {
const picked = await DocumentPicker.getDocumentAsync({
type: '*/*',
copyToCacheDirectory: true,
});
if (picked.canceled ||!picked.assets?.[0]) return;
const asset = picked.assets[0];
setPhase('copying');
setStatus(`复制中：${asset.name}`);
await FileSystem.makeDirectoryAsync(modelDirUri(), {
intermediates: true,
}).catch(() => undefined);
await FileSystem.copyAsync({
from: asset.uri,
to: modelFileUri(),
});
setPhase('idle');
await refreshFileStatus();
} catch (e) {
setPhase('error');
setErrorText(`侧载失败：${String(e)}`);
}
}, [refreshFileStatus]);

/** initLlama：纯 CPU 口径（n_gpu_layers 0），reasonNoGPU 原样展示 */
const handleLoad = useCallback(async () => {
setErrorText('');
setMetrics('');
try {
const old = contextRef.current;
contextRef.current = null;
if (old) await old.release().catch(() => undefined);
setPhase('loading');
setStatus('initLlama 加载中…');
const t0 = Date.now();
const ctx = await initLlama({
model: toNativeFilePath(modelFileUri()),
n_ctx: 4096,
n_gpu_layers: 0,
use_mlock: true,
});
const loadMs = Date.now() - t0;
contextRef.current = ctx;
setHasContext(true);
setPhase('ready');
setStatus(
`加载完成：${loadMs} ms；reasonNoGPU=${JSON.stringify(ctx.reasonNoGPU)}`,
);
} catch (e) {
setPhase('error');
setErrorText(`initLlama 失败：${String(e)}`);
}
}, []);

const handleGenerate = useCallback(async () => {
const ctx = contextRef.current;
if (!ctx) return;
setErrorText('');
setOutput('');
setMetrics('');
tokenCountRef.current = 0;
firstTokenAtRef.current = 0;
genStartRef.current = Date.now();
setPhase('generating');
try {
const result = await ctx.completion(
{
messages: [{ role: 'user', content: prompt}],
n_predict: 128,
temperature: 0.7,
},
(data) => {
if (firstTokenAtRef.current === 0) {
firstTokenAtRef.current = Date.now();
}
tokenCountRef.current += 1;
if (data.token) {
setOutput((prev) => prev + data.token);
}
},
);
const totalMs = Date.now() - genStartRef.current;
const ttftMs =
firstTokenAtRef.current > 0
? firstTokenAtRef.current - genStartRef.current
: -1;
const tm = result.timings;
setMetrics(
[
`总耗时 ${totalMs} ms；首 token ${ttftMs} ms`,
`回调 token 数 ${tokenCountRef.current}`,
tm
? `原生 timings：predicted_n=${tm.predicted_n}，decode=${tm.predicted_per_second.toFixed(2)} tok/s，prompt_n=${tm.prompt_n}，prefill=${tm.prompt_per_second.toFixed(2)} tok/s`
: '原生 timings 缺失',
`finish text 长度 ${result.text?.length?? 0}`,
].join('\n'),
);
setPhase('ready');
} catch (e) {
setPhase('error');
setErrorText(`completion 失败：${String(e)}`);
}
}, [prompt]);

const handleStop = useCallback(async () => {
const ctx = contextRef.current;
if (!ctx) return;
try {
await ctx.stopCompletion();
setStatus('已请求 stopCompletion（生成应在当前 token 后停下）');
} catch (e) {
setErrorText(`stopCompletion 失败：${String(e)}`);
}
}, []);

const busy =
phase === 'copying' || phase === 'loading' || phase === 'generating';

return (
<ScrollView style={styles.root} contentContainerStyle={styles.content}>
<Text style={styles.title}>端侧模型冒烟（O1 · 开发专用）</Text>
<Text style={styles.status}>{status}</Text>
{errorText? <Text style={styles.error}>{errorText}</Text>: null}

<TouchableOpacity
style={styles.button}
onPress={() => void handlePickModel()}
disabled={busy}
>
<Text style={styles.buttonText}>选择模型文件（侧载 GGUF）</Text>
</TouchableOpacity>

<TouchableOpacity
style={styles.button}
onPress={() => void handleLoad()}
disabled={busy}
>
<Text style={styles.buttonText}>加载模型（initLlama）</Text>
</TouchableOpacity>

<TextInput
style={styles.input}
value={prompt}
onChangeText={setPrompt}
multiline
/>

<View style={styles.row}>
<TouchableOpacity
style={[styles.button, styles.flexButton]}
onPress={() => void handleGenerate()}
disabled={busy || !hasContext}
>
<Text style={styles.buttonText}>生成（流式）</Text>
</TouchableOpacity>
<TouchableOpacity
style={[styles.button, styles.flexButton]}
onPress={() => void handleStop()}
disabled={phase!== 'generating'}
>
<Text style={styles.buttonText}>停止</Text>
</TouchableOpacity>
</View>

{busy? <ActivityIndicator />: null}
{metrics? <Text style={styles.metrics}>{metrics}</Text>: null}
<Text style={styles.output}>{output}</Text>
</ScrollView>
);
}

function createStyles(theme: Theme) {
return StyleSheet.create({
root: { flex: 1, backgroundColor: theme.colors.canvas},
content: { padding: theme.space.lg, gap: theme.space.md},
title: {...theme.type.headline, color: theme.colors.textPrimary},
status: {...theme.type.body, color: theme.colors.textSecondary},
error: {...theme.type.body, color: theme.colors.danger},
button: {
paddingVertical: 10,
paddingHorizontal: theme.space.md,
borderRadius: theme.radius.control,
backgroundColor: theme.colors.surface,
borderWidth: 1,
borderColor: theme.colors.hairline,
alignItems: 'center',
},
buttonText: {...theme.type.body, color: theme.colors.textPrimary},
row: { flexDirection: 'row', gap: theme.space.md},
flexButton: { flex: 1},
input: {
borderWidth: 1,
borderColor: theme.colors.borderStrong,
borderRadius: theme.radius.control,
backgroundColor: theme.colors.field,
color: theme.colors.textPrimary,
padding: 10,
...theme.type.body,
minHeight: theme.size.inputMultilineMin,
},
metrics: {...theme.type.footnote, color: theme.colors.textTertiary},
output: {...theme.type.body, color: theme.colors.textPrimary},
});
}
