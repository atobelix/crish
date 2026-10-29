// 分组标题：仅用于设置 / 分组列表，不和页面大标题竞争。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';

export interface SectionHeaderProps {
  title: string;
  /** 右侧说明（可选；仅放真实状态，不放解释文案） */
  trailing?: string;
}

export function SectionHeader({ title, trailing }: SectionHeaderProps) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { paddingHorizontal: theme.space.lg }]}>
      <AppText variant="sectionLabel" color="textTertiary">
        {title}
      </AppText>
      {trailing ? (
        <AppText variant="caption" color="textTertiary">
          {trailing}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 32,
  },
});

export default SectionHeader;
