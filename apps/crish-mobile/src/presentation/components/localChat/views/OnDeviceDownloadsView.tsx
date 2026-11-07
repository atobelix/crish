// 本机模型 · 下载任务（L2 / IA §3.3/§3.5）：只在有未完成、失败
// 或进行中的任务时从首页进入；本页列全这批行：进度只报管理器
// 实测的字节/比例/速度（速度缺失就不显示，不估算剩余时间），
// 下载中的行可在此取消（删除不在此页——取消即清未完成文件）。
import { Fragment } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { formatBytes } from '@/adapters/onDevice/onDeviceModelManager';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelRow,
  type OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';
import { OnDeviceGroup, onDeviceIaStatusText } from './OnDeviceShared';

export interface OnDeviceDownloadsViewProps {
  vm?: OnDeviceModelsVm;
  onBack: () => void;
  onOpenDetail?: (modelId: string) => void;
  testID?: string;
}

/** 下载任务行集合：未完成/待校验/失败/进行中（已取消磁盘已清，不入列） */
export function isDownloadTaskRow(row: OnDeviceModelRow): boolean {
  const kind = row.state?.kind;
  return (
    kind === 'partial' ||
    kind === 'unverified' ||
    kind === 'error' ||
    kind === 'downloading' ||
    kind === 'verifying' ||
    kind === 'cancelling'
  );
}

export default function OnDeviceDownloadsView({
  vm: customVm,
  onBack,
  onOpenDetail,
  testID = 'ondevice-downloads-view',
}: OnDeviceDownloadsViewProps) {
  const defaultVm = useOnDeviceModelsVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const rows = vm.rows.filter(isDownloadTaskRow);

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="下载任务" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <OnDeviceGroup label="下载任务">
          {rows.length === 0 ? (
            <ListRow title="没有未完成的下载" divider={false} />
          ) : (
            rows.map((row, index) => (
              <Fragment key={row.id}>
                <ListRow
                  testID={`ondevice-downloads-${row.id}`}
                  title={row.name}
                  subtitle={
                    row.state?.kind === 'downloading'
                      ? [
                          row.progressText ?? row.statusText,
                          row.speedBytesPerSec !== undefined
                            ? `${formatBytes(row.speedBytesPerSec)}/s`
                            : null,
                        ]
                          .filter((part): part is string => part !== null)
                          .join(' · ')
                      : row.state?.kind === 'error'
                        ? row.errorText
                        : `占用 ${formatBytes(row.usageBytes)}`
                  }
                  trailing={
                    <AppText variant="footnote" color="textTertiary">
                      {onDeviceIaStatusText(row.state, false)}
                    </AppText>
                  }
                  showChevron={onOpenDetail !== undefined}
                  divider={
                    row.state?.kind !== 'downloading' &&
                    index < rows.length - 1
                  }
                  onPress={
                    onOpenDetail ? () => onOpenDetail(row.id) : undefined
                  }
                />
                {row.state?.kind === 'downloading' && !row.busy ? (
                  <ListRow
                    testID={`ondevice-downloads-cancel-${row.id}`}
                    title="取消下载"
                    destructive
                    divider={index < rows.length - 1}
                    onPress={() => void vm.cancelDownload(row.id)}
                  />
                ) : null}
              </Fragment>
            ))
          )}
        </OnDeviceGroup>
      </ScrollView>
    </Screen>
  );
}
