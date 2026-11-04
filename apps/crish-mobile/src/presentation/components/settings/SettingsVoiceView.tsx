// 语音输入子面板（2026-11-02 用户裁决：语音归设置）：端侧离线 ASR
// 的真实状态与管理面——引擎可用性、麦克风权限、模型状态/下载/修复/
// 删除，全部接既有栈（voiceInputService / AsrModelManager），无假入口：
// 设备不支持时只诚实呈现不支持，不给下载钮。模型「校验并修复」走
// ensureReady 的全量哈希校验通道（坏件自动重下），与下载门的重试同源。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Linking,
  PermissionsAndroid,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import {
  asrModelManager,
  ASR_MODEL_TOTAL_BYTES,
  type AsrModelState,
} from '@/adapters/asr/modelManager';
import { voiceInputService } from '@/adapters/asr/voiceInputService';
import { AppHeader, AppText, Dialog, ListRow, Screen } from '@/presentation/ui';

type PermState = 'checking' | 'granted' | 'denied' | 'blocked';

const PERM_SUBTITLES: Record<PermState, string> = {
  checking: '读取中',
  granted: '已授权',
  denied: '未授权，点按授权',
  blocked: '已在系统中关闭，点按前往设置开启',
};

function modelStatusLabel(state: AsrModelState | null): string {
  if (!state) return '读取中';
  switch (state.kind) {
    case 'ready':
      return '已就绪';
    case 'missing':
      return '未下载';
    case 'downloading':
      return `下载中 ${Math.round(state.overallFraction * 100)}%`;
    case 'verifying':
      return '校验中';
    case 'error':
      return '下载失败';
  }
}

export interface SettingsVoiceViewProps {
  onBack: () => void;
}

export function SettingsVoiceView({ onBack }: SettingsVoiceViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const available = voiceInputService.isAvailable();
  const [modelState, setModelState] = useState<AsrModelState | null>(null);
  const [perm, setPerm] = useState<PermState>('checking');
  const [busy, setBusy] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshModel = useCallback(async () => {
    const state = await asrModelManager().check();
    if (aliveRef.current) setModelState(state);
  }, []);

  const refreshPerm = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    const granted = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    );
    if (aliveRef.current) setPerm(granted ? 'granted' : 'denied');
  }, []);

  useEffect(() => {
    void refreshModel();
    void refreshPerm();
  }, [refreshModel, refreshPerm]);

  // 下载 / 校验修复 / 重新下载共用同一通道：ensureReady 流式回状态，
  // 就绪文件走全量哈希校验、坏件与缺件自动（重）下载。
  const runEnsure = useCallback(() => {
    setBusy(true);
    void asrModelManager()
      .ensureReady((state) => {
        if (aliveRef.current) setModelState(state);
      })
      .then((final) => {
        if (aliveRef.current) setModelState(final);
      })
      .finally(() => {
        if (aliveRef.current) setBusy(false);
      });
  }, []);

  const runRemove = useCallback(() => {
    setRemoveOpen(false);
    setBusy(true);
    void asrModelManager()
      .removeAll()
      .then(refreshModel)
      .finally(() => {
        if (aliveRef.current) setBusy(false);
      });
  }, [refreshModel]);

  const onPermPress = useCallback(() => {
    if (perm === 'blocked') {
      void Linking.openSettings();
      return;
    }
    if (perm !== 'denied') return;
    void voiceInputService.requestPermission().then((granted) => {
      if (!aliveRef.current) return;
      // 请求后仍拒绝 = 已被系统设为不再询问，只能去系统设置开启
      setPerm(granted ? 'granted' : 'blocked');
    });
  }, [perm]);

  const totalMb = Math.round(ASR_MODEL_TOTAL_BYTES / (1024 * 1024));
  const modelKind = modelState?.kind;
  const showDownload = available && modelKind === 'missing' && !busy;
  const showRepair = available && modelKind === 'ready' && !busy;
  const showRedownload = available && modelKind === 'error' && !busy;
  const showRemove =
    available && (modelKind === 'ready' || modelKind === 'error') && !busy;

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="语音输入" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <VoiceGroup label="识别" theme={theme}>
          <ListRow
            title="识别引擎"
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {available ? '可用' : '当前设备不支持'}
              </AppText>
            }
            divider={available && Platform.OS === 'android'}
          />
          {available && Platform.OS === 'android' ? (
            <ListRow
              title="麦克风权限"
              subtitle={PERM_SUBTITLES[perm]}
              divider={false}
              showChevron={perm === 'denied' || perm === 'blocked'}
              onPress={
                perm === 'denied' || perm === 'blocked'
                  ? onPermPress
                  : undefined
              }
            />
          ) : null}
        </VoiceGroup>

        {available ? (
          <VoiceGroup label="离线模型" theme={theme}>
            <ListRow
              title="模型状态"
              subtitle={
                modelState?.kind === 'downloading'
                  ? `正在下载 ${modelState.fileName}`
                  : modelState?.kind === 'error'
                    ? modelState.message
                    : undefined
              }
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {modelStatusLabel(modelState)}
                </AppText>
              }
            />
            <ListRow
              title="模型大小"
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {`约 ${totalMb}MB`}
                </AppText>
              }
              divider={
                showDownload || showRepair || showRedownload || showRemove
              }
            />
            {showDownload ? (
              <ListRow
                title="下载模型"
                divider={false}
                showChevron
                onPress={runEnsure}
              />
            ) : null}
            {showRepair ? (
              <ListRow
                title="校验并修复"
                divider={showRemove}
                showChevron
                onPress={runEnsure}
              />
            ) : null}
            {showRedownload ? (
              <ListRow
                title="重新下载"
                divider={showRemove}
                showChevron
                onPress={runEnsure}
              />
            ) : null}
            {showRemove ? (
              <ListRow
                title="删除模型"
                destructive
                divider={false}
                onPress={() => setRemoveOpen(true)}
              />
            ) : null}
          </VoiceGroup>
        ) : null}
      </ScrollView>

      <Dialog
        visible={removeOpen}
        title="删除语音模型"
        description={`确定删除离线模型并释放约 ${totalMb}MB 空间？`}
        onDismiss={() => setRemoveOpen(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setRemoveOpen(false),
          },
          { label: '删除', variant: 'danger', onPress: runRemove },
        ]}
      />
    </Screen>
  );
}

function VoiceGroup({
  label,
  theme,
  children,
}: {
  label: string;
  theme: ReturnType<typeof useTheme>;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: theme.space.xs + 2 }}>
      <AppText
        variant="sectionLabel"
        color="textTertiary"
        style={{
          paddingHorizontal: theme.space.xs + 2,
          fontWeight: '500',
          letterSpacing: -(theme.type.sectionLabel.letterSpacing ?? 0),
        }}
      >
        {label}
      </AppText>
      <View
        style={{
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surfaceGrouped,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

export default SettingsVoiceView;
