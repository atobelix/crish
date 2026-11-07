// 本机模型 · 已安装（L2 / IA §3.4）：一行一个已在正式路径上出现
// 过的目录模型（含待校验与未完成）；纯未下载的不在这里。行只做
// 导航——设为默认/删除/加载等动作集中在详情页，避免列表行上堆
// 破坏性操作。状态词走 IA 表（OnDeviceShared），占用用真实
// usageBytes，目录 size 只在详情作「完整文件大小」出现。
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { formatBytes } from '@/adapters/onDevice/onDeviceModelManager';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelRow,
  type OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import { onDeviceQuantLabel } from '@/adapters/viewmodels/useOnDeviceModelDetailVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';
import { OnDeviceGroup, onDeviceIaStatusText } from './OnDeviceShared';

export interface OnDeviceInstalledViewProps {
  vm?: OnDeviceModelsVm;
  onBack: () => void;
  onOpenDetail?: (modelId: string) => void;
  onOpenLibrary?: () => void;
  testID?: string;
}

/** 已在正式路径出现过：有占用，或状态本身就意味着文件在位/在途 */
export function isInstalledRow(row: OnDeviceModelRow): boolean {
  if (row.usageBytes > 0) return true;
  const kind = row.state?.kind;
  return (
    kind === 'ready' ||
    kind === 'unverified' ||
    kind === 'downloading' ||
    kind === 'verifying' ||
    kind === 'cancelling'
  );
}

export default function OnDeviceInstalledView({
  vm: customVm,
  onBack,
  onOpenDetail,
  onOpenLibrary,
  testID = 'ondevice-installed-view',
}: OnDeviceInstalledViewProps) {
  const defaultVm = useOnDeviceModelsVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const rows = vm.rows.filter(isInstalledRow);

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="已安装" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <OnDeviceGroup label="已安装">
          {rows.length === 0 ? (
            <>
              <ListRow title="还没有已安装的模型" divider={false} />
              {onOpenLibrary ? (
                <ListRow
                  testID="ondevice-installed-open-library"
                  title="去模型库"
                  showChevron
                  divider={false}
                  onPress={onOpenLibrary}
                />
              ) : null}
            </>
          ) : (
            rows.map((row, index) => {
              const quant = onDeviceQuantLabel(row);
              return (
                <ListRow
                  key={row.id}
                  testID={`ondevice-installed-${row.id}`}
                  title={row.name}
                  subtitle={[
                    quant,
                    `占用 ${formatBytes(row.usageBytes)}`,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                  trailing={
                    <AppText variant="footnote" color="textTertiary">
                      {onDeviceIaStatusText(
                        row.state,
                        vm.loadedModelId === row.id
                      )}
                    </AppText>
                  }
                  showChevron={onOpenDetail !== undefined}
                  divider={index < rows.length - 1}
                  onPress={
                    onOpenDetail ? () => onOpenDetail(row.id) : undefined
                  }
                />
              );
            })
          )}
        </OnDeviceGroup>
      </ScrollView>
    </Screen>
  );
}
