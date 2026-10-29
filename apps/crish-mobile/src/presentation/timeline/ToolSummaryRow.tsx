// 对话里的工具摘要行：相邻工具调用折叠成一行，点按打开工具抽屉并定位到这一组。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import { PulseDot } from '@/presentation/components/tools/PulseDot';
import { toolBlockSummary } from './buildTimeline';
import type { ToolRunBlock } from './groupToolRuns';

export interface ToolSummaryRowProps {
  run: ToolRunBlock;
  /** 未提供时只读（如运行详情页没有工具抽屉） */
  onOpen?: (focusId: string) => void;
}

function runningLabel(run: ToolRunBlock): string {
  const detail = toolBlockSummary(run.latest) || run.latest.toolName;
  return `正在执行 · ${detail}`;
}

export function ToolSummaryRow({ run, onOpen }: ToolSummaryRowProps) {
  const theme = useTheme();
  const running = run.running > 0;
  const label = running
    ? runningLabel(run)
    : `使用了 ${run.tools.length} 个工具`;
  return (
    <Pressable
      testID={`tool-run-${run.id}`}
      accessibilityRole="button"
      accessibilityLabel={
        run.failed > 0 ? `${label}，${run.failed} 个失败` : label
      }
      disabled={!onOpen}
      onPress={() => onOpen?.(run.id)}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.size.summaryRow,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm,
          borderRadius: theme.radius.pill,
          backgroundColor: pressed
            ? theme.colors.fillPressed
            : theme.colors.fillSubtle,
        },
      ]}
    >
      {running ? (
        <PulseDot testID="tool-run-pulse" />
      ) : (
        <Icon
          name="wrench"
          size={theme.size.iconSmall}
          color={theme.colors.textTertiary}
        />
      )}
      <View style={[styles.label, { gap: theme.space.xs }]}>
        <AppText
          variant="footnote"
          color="textSecondary"
          numberOfLines={1}
          style={styles.shrink}
        >
          {label}
        </AppText>
        {run.failed > 0 ? (
          <AppText variant="footnote" color="danger">
            · {run.failed} 个失败
          </AppText>
        ) : null}
      </View>
      {onOpen ? (
        <Icon
          name="arrow-up"
          size={theme.size.iconSmall}
          color={theme.colors.textTertiary}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center' },
  label: { flexShrink: 1, flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
});

export default ToolSummaryRow;
