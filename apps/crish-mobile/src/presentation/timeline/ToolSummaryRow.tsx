// 对话里的工具摘要行：相邻工具调用折叠成一行，点按打开工具抽屉并定位到这一组。
// N05 裁定：文字已含语义（扳手/上箭头属装饰删除）；执行中状态用 8px 静态色点
// （PulseDot 呼吸脉冲违 U8，已物理删除）。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
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
        <View
          testID="tool-run-status-dot"
          style={{
            width: theme.size.dot,
            height: theme.size.dot,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.brand,
          }}
        />
      ) : null}
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center' },
  label: { flexShrink: 1, flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
});

export default ToolSummaryRow;
