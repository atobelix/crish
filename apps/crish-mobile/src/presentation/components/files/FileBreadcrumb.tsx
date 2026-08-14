// 面包屑导航条（R2-06b，F4 §6.2 面包屑区 + X4-6 导航栈一致性）：
// - 分段 = 导航栈（history）逐层：根（工作区名，未装载显示「根目录」）+
//   各层目录名（路径叶名）；当前层高亮（selected 语义态）；
// - 点击段 → 截断导航栈到该深度（jumpTo，VM 层循环 goBack）；
// - 返回键 [←]：根层禁用（canGoBack=false），X4-6 手势返回一致性；
// - 44pt 触控热区（M4 §3.4 / R2UX-06-08）；返回键视觉 36×36 → HitSlop 补足
//   （R2-16 §3.2 第 4 项修复：iOS 44 / Android 48 双轨）。
import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { workspaceNameOf } from '@/adapters/wiring/filesWiring';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';

/** 段标签：根 = 工作区名（缺省「根目录」）；其余 = 路径叶名 */
export function segmentLabel(
  segment: string,
  index: number,
  workspaceName: string | null
): string {
  if (index === 0) return workspaceName ?? '根目录';
  return workspaceNameOf(segment);
}

export interface FileBreadcrumbProps {
  /** 导航栈（栈顶 = 当前目录；'' = 根，F4 §1.2 relPath 语义） */
  history: readonly string[];
  /** 工作区展示名（null = 未装载 → 显示「根目录」） */
  workspaceName: string | null;
  /** 能否返回（history.length > 1） */
  backEnabled: boolean;
  onBack: () => void;
  /** 点击段（index = history 下标）→ 跳转该层 */
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
    <View style={[styles.bar, { borderBottomColor: theme.hairline }]}>
      <Pressable
        testID="files-back"
        accessibilityRole="button"
        accessibilityLabel="返回上级"
        accessibilityState={{ disabled: !backEnabled }}
        disabled={!backEnabled}
        onPress={onBack}
        hitSlop={dualHitSlop(36, 36)}
        style={({ pressed }) => [
          styles.back,
          { borderColor: theme.hairlineStrong },
          !backEnabled && { opacity: 0.4 },
          pressed && backEnabled && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.backText, { color: theme.textPrimary }]}>←</Text>
      </Pressable>
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
            <Pressable
              testID={isCurrent ? 'crumb-current' : 'crumb'}
              key={`${index}:${segment}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isCurrent }}
              accessibilityLabel={`跳转到 ${label}`}
              disabled={isCurrent}
              onPress={() => onSelectSegment(index)}
              style={({ pressed }) => [
                styles.crumb,
                isCurrent && { backgroundColor: theme.bgTertiary },
                pressed && !isCurrent && { opacity: 0.7 },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.crumbText,
                  {
                    color: isCurrent ? theme.textPrimary : theme.textSecondary,
                  },
                ]}
              >
                {label}
              </Text>
              {index < history.length - 1 ? (
                <Text style={[styles.sep, { color: theme.textTertiary }]}>
                  ›
                </Text>
              ) : null}
            </Pressable>
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
    minHeight: 44,
    paddingLeft: 8,
    paddingRight: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  backText: {
    fontSize: 16,
    lineHeight: 18,
  },
  crumbs: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  crumb: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  crumbText: {
    fontSize: 13,
    maxWidth: 140,
  },
  sep: {
    marginLeft: 8,
    fontSize: 13,
  },
});
