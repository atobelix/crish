// 本机模型管理视图（O4）：端侧 GGUF 模型的下载/删除管理面。
// 形态沿用语音设置页的 ASR 下载门（分组卡 + ListRow + 删除确认
// Dialog），状态全部来自 O2 管理器经 useOnDeviceModelsVm 投影：
// 未下载 / 下载中 x% / 校验中 / 已就绪 / 失败（带原因可重试），
// 不编造状态；许可如实标注，Qwen2.5-3B 的研究许可警示显式成行。
import { Fragment, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelRow,
  type OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import { AppHeader, AppText, Dialog, ListRow, Screen } from '@/presentation/ui';

export interface OnDeviceModelsViewProps {
  vm?: OnDeviceModelsVm;
  onBack: () => void;
  testID?: string;
}

export default function OnDeviceModelsView({
  vm: customVm,
  onBack,
  testID = 'ondevice-models-view',
}: OnDeviceModelsViewProps) {
  const defaultVm = useOnDeviceModelsVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [pendingRemove, setPendingRemove] = useState<OnDeviceModelRow | null>(
    null
  );

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="本机模型" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <ModelGroup label="模型" theme={theme}>
          {vm.rows.map((row, index) => (
            <Fragment key={row.id}>
              <ListRow
                testID={`ondevice-model-${row.id}`}
                title={row.name}
                subtitle={
                  row.state?.kind === 'downloading'
                    ? (row.progressText ?? row.statusText)
                    : row.state?.kind === 'error'
                      ? row.errorText
                      : `${row.sizeText} · ${row.licenseLabel}${row.recommended ? ' · 推荐' : ''}`
                }
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    {row.statusText}
                  </AppText>
                }
                divider={false}
              />
              {row.licenseWarning ? (
                <View
                  style={{
                    paddingHorizontal: theme.space.md,
                    paddingBottom: theme.space.sm,
                  }}
                >
                  <AppText variant="footnote" color="warning">
                    {row.licenseWarning}
                  </AppText>
                </View>
              ) : null}
              {row.state?.kind === 'missing' && !row.busy ? (
                <ListRow
                  testID={`ondevice-download-${row.id}`}
                  title="下载"
                  showChevron
                  divider={index < vm.rows.length - 1}
                  onPress={() => vm.download(row.id)}
                />
              ) : null}
              {row.state?.kind === 'error' && row.canRetry && !row.busy ? (
                <ListRow
                  testID={`ondevice-retry-${row.id}`}
                  title="重新下载"
                  showChevron
                  divider={index < vm.rows.length - 1}
                  onPress={() => vm.download(row.id)}
                />
              ) : null}
              {row.state?.kind === 'ready' && !row.busy ? (
                <ListRow
                  testID={`ondevice-remove-${row.id}`}
                  title="删除"
                  destructive
                  divider={index < vm.rows.length - 1}
                  onPress={() => setPendingRemove(row)}
                />
              ) : null}
            </Fragment>
          ))}
        </ModelGroup>

        <ModelGroup label="存储" theme={theme}>
          <ListRow
            title="已占用空间"
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {vm.totalUsageText}
              </AppText>
            }
            divider={false}
          />
        </ModelGroup>
      </ScrollView>

      <Dialog
        visible={pendingRemove !== null}
        title="删除本机模型"
        description={
          pendingRemove
            ? `确定删除 ${pendingRemove.name} 并释放 ${pendingRemove.sizeText} 空间？`
            : undefined
        }
        onDismiss={() => setPendingRemove(null)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setPendingRemove(null),
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: () => {
              const target = pendingRemove;
              setPendingRemove(null);
              if (target) void vm.removeModel(target.id);
            },
          },
        ]}
      />
    </Screen>
  );
}

function ModelGroup({
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
