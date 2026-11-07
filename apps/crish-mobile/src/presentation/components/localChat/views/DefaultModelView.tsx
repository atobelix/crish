// 默认模型页（L3 / IA §3.2）：默认模型的唯一真源是
// config.activeModel；本页是它的显式选择面——
// - 当前默认如实呈现：有效才报供应商与模型名；已失效给原因并明示
//   系统没有自动改用其他模型；未设置就写未设置；
// - 可选行只含真能用的模型（启用供应商的启用模型 + 本机已就绪
//   模型），点选即落位，没有「顺手帮你选一个」的路径；
// - 不可用行给原因：停用写已停用/供应商已停用，本机未就绪写 IA
//   状态词且点行去详情页处理——不在本页内嵌下载。
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import {
  useDefaultModelVm,
  type DefaultModelVm,
} from '@/adapters/viewmodels/useDefaultModelVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';
import { OnDeviceGroup } from './OnDeviceShared';

export interface DefaultModelViewProps {
  vm?: DefaultModelVm;
  onBack: () => void;
  onOpenProviders?: () => void;
  onOpenOnDevice?: () => void;
  onOpenOnDeviceDetail?: (modelId: string) => void;
  testID?: string;
}

export default function DefaultModelView({
  vm: customVm,
  onBack,
  onOpenProviders,
  onOpenOnDevice,
  onOpenOnDeviceDetail,
  testID = 'default-model-view',
}: DefaultModelViewProps) {
  const defaultVm = useDefaultModelVm();
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader title="默认模型" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.xl,
        }}
      >
        <OnDeviceGroup label="当前默认">
          <ListRow title={vm.currentText} divider={false} />
        </OnDeviceGroup>
        {vm.invalidReasonText ? (
          <AppText
            variant="footnote"
            color="textSecondary"
            style={{ paddingHorizontal: theme.space.xs + 2 }}
          >
            {vm.invalidReasonText}
          </AppText>
        ) : null}

        {!vm.hasAnySelectable ? (
          <OnDeviceGroup label="可用模型">
            <ListRow title="还没有可用的模型" divider={false} />
            {onOpenProviders ? (
              <ListRow
                testID="default-model-open-providers"
                title="去配置供应商"
                showChevron
                divider={Boolean(onOpenOnDevice)}
                onPress={onOpenProviders}
              />
            ) : null}
            {onOpenOnDevice ? (
              <ListRow
                testID="default-model-open-ondevice"
                title="下载本机模型"
                showChevron
                divider={false}
                onPress={onOpenOnDevice}
              />
            ) : null}
          </OnDeviceGroup>
        ) : (
          vm.groups.map((group) => (
            <OnDeviceGroup key={group.providerId} label={group.providerName}>
              {group.selectable.map((row, index) => (
                <ListRow
                  key={row.modelId}
                  testID={`default-model-select-${group.providerId}-${row.modelId}`}
                  title={row.name}
                  trailing={
                    row.isCurrent ? (
                      <AppText variant="footnote" color="textTertiary">
                        当前默认
                      </AppText>
                    ) : undefined
                  }
                  showChevron={!row.isCurrent}
                  divider={
                    index < group.selectable.length - 1 ||
                    group.unavailable.length > 0
                  }
                  onPress={() => vm.select(group.providerId, row.modelId)}
                />
              ))}
              {group.unavailable.map((row, index) => (
                <ListRow
                  key={row.modelId}
                  testID={`default-model-unavailable-${group.providerId}-${row.modelId}`}
                  title={row.name}
                  subtitle={row.reasonText}
                  showChevron={row.onDeviceDetailId !== null}
                  divider={index < group.unavailable.length - 1}
                  onPress={
                    row.onDeviceDetailId !== null && onOpenOnDeviceDetail
                      ? () => onOpenOnDeviceDetail(row.onDeviceDetailId!)
                      : undefined
                  }
                />
              ))}
              {group.selectable.length === 0 &&
              group.unavailable.length === 0 ? (
                <ListRow title="暂无模型" divider={false} />
              ) : null}
            </OnDeviceGroup>
          ))
        )}

        <AppText
          variant="footnote"
          color="textTertiary"
          style={{ paddingHorizontal: theme.space.xs + 2 }}
        >
          默认模型是新对话的起始模型，可随时在这里更换；某个模型不可用时系统不会自动改用其他模型。
        </AppText>
      </ScrollView>
    </Screen>
  );
}
