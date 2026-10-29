// 抽屉底部：搜索胶囊（就地过滤会话）+ 设置圆钮。
import { StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { Icon, IconButton } from '@/presentation/ui';

export interface DrawerFooterProps {
  query: string;
  onChangeQuery: (query: string) => void;
  onOpenSettings: () => void;
  bottomInset: number;
}

export function DrawerFooter({
  query,
  onChangeQuery,
  onOpenSettings,
  bottomInset,
}: DrawerFooterProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        {
          gap: theme.space.sm,
          paddingHorizontal: theme.space.md,
          paddingTop: theme.space.sm,
          paddingBottom: bottomInset + theme.space.md,
        },
      ]}
    >
      <View
        style={[
          styles.row,
          styles.flex,
          {
            height: theme.size.iconButton,
            gap: theme.space.sm,
            paddingHorizontal: theme.space.md,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.fillSubtle,
          },
        ]}
      >
        <Icon
          name="search"
          size={theme.size.iconSmall}
          color={theme.colors.textTertiary}
        />
        <TextInput
          testID="drawer-search"
          accessibilityLabel="搜索会话"
          placeholder="搜索会话"
          placeholderTextColor={theme.colors.textTertiary}
          value={query}
          onChangeText={onChangeQuery}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={[
            styles.flex,
            theme.type.callout,
            styles.input,
            { color: theme.colors.textPrimary },
          ]}
        />
      </View>
      <IconButton
        variant="floating"
        name="settings"
        accessibilityLabel="设置"
        testID="drawer-settings"
        onPress={onOpenSettings}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  // 去掉 Android 默认内边距，让文字在胶囊里垂直居中
  input: { paddingVertical: 0 },
});
