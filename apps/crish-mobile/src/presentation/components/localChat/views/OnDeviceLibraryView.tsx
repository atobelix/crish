// 本机模型 · 模型库（L2 / IA §3.5）：只列还没成为已校验的条目。
// 行上只有名称、完整文件大小（目录 size，标明口径）、量化与推荐
// 标记——许可不在行上（IA §2.8），下载也不是行上按钮：下载是
// 详情页的主动作，点行进详情。支持按名称筛选（目录没有任务类型
// 等字段，不编造分类）。
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import { onDeviceQuantLabel } from '@/adapters/viewmodels/useOnDeviceModelDetailVm';
import { AppHeader, AppText, Input, ListRow, Screen } from '@/presentation/ui';
import { OnDeviceGroup } from './OnDeviceShared';

export interface OnDeviceLibraryViewProps {
  vm?: OnDeviceModelsVm;
  onBack: () => void;
  onOpenDetail?: (modelId: string) => void;
  testID?: string;
}

export default function OnDeviceLibraryView({
  vm: customVm,
  onBack,
  onOpenDetail,
  testID = 'ondevice-library-view',
}: OnDeviceLibraryViewProps) {
  const defaultVm = useOnDeviceModelsVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [keyword, setKeyword] = useState('');
  const rows = useMemo(() => {
    const notReady = vm.rows.filter((row) => row.state?.kind !== 'ready');
    const trimmed = keyword.trim().toLowerCase();
    if (trimmed === '') return notReady;
    return notReady.filter((row) =>
      row.name.toLowerCase().includes(trimmed)
    );
  }, [vm.rows, keyword]);

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="模型库" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <View>
          <Input
            testID="ondevice-library-search"
            tone="field"
            placeholder="按名称筛选"
            value={keyword}
            onChangeText={setKeyword}
            accessibilityLabel="按名称筛选模型"
          />
        </View>
        <OnDeviceGroup label="可下载">
          {rows.length === 0 ? (
            <ListRow title="没有符合条件的模型" divider={false} />
          ) : (
            rows.map((row, index) => {
              const quant = onDeviceQuantLabel(row);
              return (
                <ListRow
                  key={row.id}
                  testID={`ondevice-library-${row.id}`}
                  title={row.name}
                  subtitle={[
                    `完整文件 ${row.sizeText}`,
                    quant,
                    row.recommended ? '推荐' : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                  trailing={
                    <AppText variant="footnote" color="textTertiary">
                      {row.statusText}
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
