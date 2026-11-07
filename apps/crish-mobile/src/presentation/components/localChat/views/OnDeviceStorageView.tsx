// 本机模型 · 存储（L2 / IA §3.9）：两行实测分开标注——模型文件
// （usageBytes 之和，含 .part、不含校验标记）与可用空间（读不到
// 写「未能读取」，不估算、不画百分比圆环）。清理只提供「删除未
// 完成文件」与进详情做单模型删除，不提供会扫到别的功能的
// 「清空缓存」；正在下载/已加载的文件不在清理列表里。
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { formatBytes } from '@/adapters/onDevice/onDeviceModelManager';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelRow,
  type OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import { AppHeader, AppText, Dialog, ListRow, Screen } from '@/presentation/ui';
import { OnDeviceGroup } from './OnDeviceShared';

export interface OnDeviceStorageViewProps {
  vm?: OnDeviceModelsVm;
  onBack: () => void;
  onOpenDetail?: (modelId: string) => void;
  testID?: string;
}

/** 可清理的未完成文件：只有 .part 半成品的行（下载中/已加载不在此列） */
export function isCleanableRow(
  row: OnDeviceModelRow,
  loadedModelId: string | null
): boolean {
  return row.state?.kind === 'partial' && loadedModelId !== row.id;
}

export default function OnDeviceStorageView({
  vm: customVm,
  onBack,
  onOpenDetail,
  testID = 'ondevice-storage-view',
}: OnDeviceStorageViewProps) {
  const defaultVm = useOnDeviceModelsVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [pendingClean, setPendingClean] = useState<OnDeviceModelRow | null>(
    null
  );
  const cleanable = vm.rows.filter((row) =>
    isCleanableRow(row, vm.loadedModelId)
  );

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="存储" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <OnDeviceGroup label="实测">
          <ListRow
            title="模型文件"
            subtitle="含未完成文件，不含校验标记"
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {vm.totalUsageText}
              </AppText>
            }
          />
          <ListRow
            title="可用空间"
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {vm.freeDiskSpaceBytes === null
                  ? '未能读取'
                  : formatBytes(vm.freeDiskSpaceBytes)}
              </AppText>
            }
            divider={false}
          />
        </OnDeviceGroup>

        <OnDeviceGroup label="清理未完成文件">
          {cleanable.length === 0 ? (
            <ListRow title="没有可清理的未完成文件" divider={false} />
          ) : (
            cleanable.map((row, index) => (
              <ListRow
                key={row.id}
                testID={`ondevice-storage-clean-${row.id}`}
                title={row.name}
                subtitle={`未完成文件 ${formatBytes(row.usageBytes)}`}
                trailing={
                  <AppText variant="footnote" color="textTertiary">
                    删除
                  </AppText>
                }
                divider={index < cleanable.length - 1}
                onPress={() => setPendingClean(row)}
              />
            ))
          )}
        </OnDeviceGroup>

        <OnDeviceGroup label="全部模型">
          {vm.rows.map((row, index) => (
            <ListRow
              key={row.id}
              testID={`ondevice-storage-model-${row.id}`}
              title={row.name}
              subtitle={`占用 ${formatBytes(row.usageBytes)}`}
              showChevron={onOpenDetail !== undefined}
              divider={index < vm.rows.length - 1}
              onPress={onOpenDetail ? () => onOpenDetail(row.id) : undefined}
            />
          ))}
        </OnDeviceGroup>
      </ScrollView>

      <Dialog
        visible={pendingClean !== null}
        title="删除未完成文件"
        description={
          pendingClean
            ? `删除 ${pendingClean.name} 的未完成文件（${formatBytes(pendingClean.usageBytes)}）？进度不能恢复。`
            : undefined
        }
        onDismiss={() => setPendingClean(null)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setPendingClean(null),
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: () => {
              const target = pendingClean;
              setPendingClean(null);
              if (target) void vm.removeIncomplete(target.id);
            },
          },
        ]}
      />
    </Screen>
  );
}
