// 面包屑：工作区根 + 目录层级；点击段跳转。
import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { workspaceNameOf } from '@/domain/pure/workspacePath';
import { AppText, Icon, IconButton } from '@/presentation/ui';

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
    <View style={[styles.bar, { borderBottomColor: theme.colors.border }]}>
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
              <Pressable
                testID={isCurrent ? 'crumb-current' : 'crumb'}
                accessibilityRole="button"
                accessibilityState={{ selected: isCurrent }}
                accessibilityLabel={`跳转到 ${label}`}
                disabled={isCurrent}
                onPress={() => onSelectSegment(index)}
                style={({ pressed }) => [
                  styles.crumb,
                  pressed && !isCurrent && { opacity: 0.6 },
                ]}
              >
                <AppText
                  variant="meta"
                  color={isCurrent ? 'textPrimary' : 'textSecondary'}
                  numberOfLines={1}
                  style={isCurrent ? styles.current : undefined}
                >
                  {label}
                </AppText>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
});

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
