// 面包屑：工作区根 + 目录层级；点击段跳转。
// 按压反馈（按压过渡统一批）：段链接整件透明度 120ms 过渡。
import { memo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { workspaceNameOf } from '@/domain/pure/workspacePath';
import { AppText, Icon, IconButton } from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

export function segmentLabel(
  segment: string,
  index: number,
  workspaceName: string | null
): string {
  if (index === 0) return workspaceName ?? '根目录';
  return workspaceNameOf(segment);
}

export interface FileBreadcrumbProps {
  history: readonly string[];
  workspaceName: string | null;
  backEnabled: boolean;
  onBack: () => void;
  onSelectSegment: (index: number) => void;
}

export const FileBreadcrumb = memo(function FileBreadcrumb({
  history,
  workspaceName,
  backEnabled,
  onBack,
  onSelectSegment,
}: FileBreadcrumbProps) {
  const theme = useTheme();
  return (
    <View style={[styles.bar, { borderBottomColor: theme.colors.hairline }]}>
      <IconButton
        name="chevron-left"
        accessibilityLabel="返回上级目录"
        onPress={onBack}
        disabled={!backEnabled}
        testID="files-back"
      />
      <ScrollView
        testID="files-breadcrumb"
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.crumbs}
      >
        {history.map((segment, index) => {
          const isCurrent = index === history.length - 1;
          const label = segmentLabel(segment, index, workspaceName);
          return (
            <View key={`${index}:${segment}`} style={styles.segment}>
              {index > 0 ? (
                <Icon
                  name="chevron-right"
                  size={12}
                  color={theme.colors.textTertiary}
                />
              ) : null}
              <CrumbLink
                label={label}
                isCurrent={isCurrent}
                onPress={() => onSelectSegment(index)}
              />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
});

/** 单段链接：整件透明度 120ms 过渡（当前段禁用无按压） */
function CrumbLink({
  label,
  isCurrent,
  onPress,
}: {
  label: string;
  isCurrent: boolean;
  onPress: () => void;
}) {
  const press = usePressFade();
  return (
    <AnimatedPressable
      testID={isCurrent ? 'crumb-current' : 'crumb'}
      accessibilityRole="button"
      accessibilityState={{ selected: isCurrent }}
      accessibilityLabel={`跳转到 ${label}`}
      disabled={isCurrent}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[styles.crumb, press.fadeStyle]}
    >
      <AppText
        variant="footnote"
        color={isCurrent ? 'textPrimary' : 'textSecondary'}
        numberOfLines={1}
        style={isCurrent ? styles.current : undefined}
      >
        {label}
      </AppText>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingRight: 8,
  },
  crumbs: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  crumb: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  current: {
    fontWeight: '600',
  },
});
