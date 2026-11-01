// 列表行：leading + 标题/副标题 + trailing（原型 settings-row 口径：
// 内衬 14/16、标题 14/500、值 13/400 #777、箭头 14、分隔线 dashed faint 从文字起点开始）。
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  destructive?: boolean;
  /** 是否绘制底部分隔线（分组最后一行传 false） */
  divider?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  showChevron = false,
  destructive = false,
  divider = true,
  testID,
  accessibilityLabel,
}: ListRowProps) {
  const theme = useTheme();
  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View
        style={[
          styles.body,
          { borderBottomColor: theme.colors.hairline },
          divider && styles.divider,
        ]}
      >
        <View style={styles.texts}>
          <AppText
            variant="body"
            color={destructive ? 'danger' : 'textPrimary'}
            numberOfLines={1}
            style={styles.titleWeight}
          >
            {title}
          </AppText>
          {subtitle ? (
            <AppText variant="caption" color="textTertiary" numberOfLines={2}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {trailing ?? null}
        {showChevron ? (
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall - 2}
            color={theme.colors.textTertiary}
          />
        ) : null}
      </View>
    </>
  );

  if (!onPress) {
    return (
      <View testID={testID} style={styles.row}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingLeft: 16,
  },
  leading: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingRight: 16,
  },
  divider: {
    borderBottomWidth: 1,
    borderStyle: 'dashed',
  },
  titleWeight: {
    fontWeight: '500',
  },
  texts: {
    flex: 1,
    gap: 3,
  },
});

export default ListRow;
