// 本地供应商列表（设置子页）：与远程「模型」设置（桌面全局默认）严格区分——
// 这里是手机本地直连供应商，远程连不上时本地对话靠它工作。
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import type { LocalProvidersVm } from '@/adapters/viewmodels/useLocalProvidersVm';
import {
  AppHeader,
  AppText,
  Button,
  EmptyState,
  Icon,
  ListRow,
  Screen,
} from '@/presentation/ui';

export interface LocalProvidersViewProps {
  vm: LocalProvidersVm;
  onBack: () => void;
  onAdd: () => void;
  onEdit: (providerId: string) => void;
}

export default function LocalProvidersView({
  vm,
  onBack,
  onAdd,
  onEdit,
}: LocalProvidersViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="本地供应商" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <AppText variant="footnote" color="textTertiary">
          手机直连的 AI 供应商（OpenAI
          兼容接口）。与电脑端的模型设置互相独立：远程连接不可用时，本地对话使用这里的配置。
        </AppText>

        {vm.rows.length === 0 ? (
          <EmptyState title="尚未添加供应商" />
        ) : (
          <View
            style={{
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.surfaceGrouped,
              overflow: 'hidden',
            }}
          >
            {vm.rows.map((row, index) => (
              <ListRow
                key={row.id}
                testID={`local-provider-${row.id}`}
                title={row.name}
                subtitle={`${row.baseUrl} · ${row.modelCount} 个模型${row.hasKey ? '' : ' · 未填密钥'}`}
                leading={
                  <Icon
                    name={row.isActive ? 'check' : 'zap'}
                    size={theme.size.iconSmall + 2}
                    color={
                      row.isActive
                        ? theme.colors.brand
                        : theme.colors.textSecondary
                    }
                  />
                }
                trailing={
                  row.isActive ? (
                    <AppText variant="footnote" color="brand">
                      使用中
                    </AppText>
                  ) : (
                    <AppText
                      variant="footnote"
                      color="textTertiary"
                      onPress={() => vm.activate(row.id)}
                    >
                      设为当前
                    </AppText>
                  )
                }
                showChevron
                divider={index < vm.rows.length - 1}
                onPress={() => onEdit(row.id)}
              />
            ))}
          </View>
        )}

        <Button
          label="添加供应商"
          onPress={onAdd}
          testID="local-provider-add"
        />
      </ScrollView>
    </Screen>
  );
}
