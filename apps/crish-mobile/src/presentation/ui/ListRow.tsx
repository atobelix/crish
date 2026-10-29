// 列表行：leading + 标题/副标题 + trailing；整行 44+ 热区，分隔线从文字起点开始。
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
          >
            {title}
          </AppText>
          {subtitle ? (
            <AppText variant="footnote" color="textTertiary" numberOfLines={2}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {trailing ?? null}
        {showChevron ? (
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall}
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
    minHeight: 56,
    alignItems: 'stretch',
    paddingLeft: 16,
  },
  leading: {
    width: 30,
    alignItems: 'flex-start',
    justifyContent: 'center',
    marginRight: 12,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingRight: 16,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  texts: {
    flex: 1,
    gap: 3,
  },
});

export default ListRow;
