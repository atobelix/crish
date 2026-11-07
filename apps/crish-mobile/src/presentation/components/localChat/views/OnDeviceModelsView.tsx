// 本机模型首页（L2 / IA §3.3）：沿用 /settings-local-ondevice 路由，
// 内容换为首页——只报四件实测：已校验数、未完成数、模型文件占用
// （标注口径）、当前已加载；主动作随状态变（有未完成先看下载、
// 无已安装先去模型库）。子页（已安装/模型库/下载任务/存储/详情）
// 各自独立成页，本页不堆全部管理动作。核对失败显示错误态与重试，
// 不保留假就绪快照。
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelsVm,
} from '@/adapters/viewmodels/useOnDeviceModelsVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';
import { OnDeviceGroup } from './OnDeviceShared';

export interface OnDeviceModelsViewProps {
  vm?: OnDeviceModelsVm;
  onBack: () => void;
  onOpenInstalled?: () => void;
  onOpenLibrary?: () => void;
  onOpenDownloads?: () => void;
  onOpenStorage?: () => void;
  testID?: string;
}

export default function OnDeviceModelsView({
  vm: customVm,
  onBack,
  onOpenInstalled,
  onOpenLibrary,
  onOpenDownloads,
  onOpenStorage,
  testID = 'ondevice-models-view',
}: OnDeviceModelsViewProps) {
  const defaultVm = useOnDeviceModelsVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const loadedRow =
    vm.loadedModelId !== null
      ? vm.rows.find((row) => row.id === vm.loadedModelId)
      : undefined;

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
        {vm.loadErrorText !== null ? (
          <OnDeviceGroup label="概览">
            <ListRow
              title="暂时无法读取模型目录"
              subtitle={vm.loadErrorText}
              divider={false}
            />
            <ListRow
              testID="ondevice-home-retry"
              title="重试"
              showChevron
              divider={false}
              onPress={() => void vm.refresh()}
            />
          </OnDeviceGroup>
        ) : (
          <OnDeviceGroup label="概览">
            <ListRow
              title="已校验"
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {`${vm.readyCount} 个`}
                </AppText>
              }
            />
            <ListRow
              title="未完成"
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {vm.incompleteCount > 0
                    ? `${vm.incompleteCount} 个`
                    : '没有未完成的下载'}
                </AppText>
              }
            />
            <ListRow
              title="模型文件占用"
              subtitle="已计算的模型文件（含未完成文件）"
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {vm.totalUsageText}
                </AppText>
              }
            />
            <ListRow
              title="当前已加载"
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {loadedRow ? loadedRow.name : '当前没有加载模型'}
                </AppText>
              }
              divider={false}
            />
          </OnDeviceGroup>
        )}

        {vm.syncErrorText !== null ? (
          <View style={{ paddingHorizontal: theme.space.xs + 2 }}>
            <AppText variant="footnote" color="warning">
              {`同步到模型选择器失败：${vm.syncErrorText}`}
            </AppText>
          </View>
        ) : null}

        <OnDeviceGroup label="管理">
          {vm.incompleteCount > 0 && onOpenDownloads ? (
            <ListRow
              testID="ondevice-home-open-downloads"
              title="查看下载"
              showChevron
              onPress={onOpenDownloads}
            />
          ) : null}
          {vm.readyCount === 0 && vm.incompleteCount === 0 && onOpenLibrary ? (
            <ListRow
              testID="ondevice-home-open-library"
              title="浏览模型库"
              showChevron
              onPress={onOpenLibrary}
            />
          ) : null}
          {onOpenInstalled ? (
            <ListRow
              testID="ondevice-home-open-installed"
              title="已安装"
              showChevron
              onPress={onOpenInstalled}
            />
          ) : null}
          {onOpenLibrary ? (
            <ListRow
              testID="ondevice-home-open-library-nav"
              title="模型库"
              showChevron
              onPress={onOpenLibrary}
            />
          ) : null}
          {vm.incompleteCount > 0 && onOpenDownloads ? (
            <ListRow
              testID="ondevice-home-open-downloads-nav"
              title="下载任务"
              showChevron
              onPress={onOpenDownloads}
            />
          ) : null}
          {onOpenStorage ? (
            <ListRow
              testID="ondevice-home-open-storage"
              title="存储"
              showChevron
              divider={false}
              onPress={onOpenStorage}
            />
          ) : null}
        </OnDeviceGroup>

        <View
          style={{
            paddingHorizontal: theme.space.xs + 2,
            gap: theme.space.xs,
          }}
        >
          <AppText variant="footnote" color="textTertiary">
            模型从目录地址直接下载到本机保存；本机对话不经过云端供应商。
          </AppText>
          <AppText variant="footnote" color="textTertiary">
            供应商模型仍会联网，与本机模型分开计算。
          </AppText>
        </View>
      </ScrollView>
    </Screen>
  );
}
