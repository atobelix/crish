// 对话里的工具摘要行：相邻工具调用折叠成一行，点按打开工具抽屉并定位到这一组。
// N05 裁定：文字已含语义（扳手/上箭头属装饰删除）；执行中状态用 8px 静态色点
// （PulseDot 呼吸脉冲违 U8，已物理删除）。
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import { toolBlockSummary } from './buildTimeline';
import type { ToolRunBlock } from './groupToolRuns';
import { useMinResidencyText } from './useActivityLabel';

export interface ToolSummaryRowProps {
  run: ToolRunBlock;
  /** 未提供时只读（如运行详情页没有工具抽屉） */
  onOpen?: (focusId: string) => void;
}

function runningLabel(run: ToolRunBlock): string {
  const detail = toolBlockSummary(run.latest) || run.latest.toolName;
  return `正在执行 · ${detail}`;
}

/** 封口组头：工具数 + 组总时长（durationMs 数据不全时只报工具数，不拼时长） */
function sealedLabel(run: ToolRunBlock): string {
  const base = `使用了 ${run.tools.length} 个工具`;
  if (run.durationMs === undefined) return base;
  const seconds = Math.max(1, Math.round(run.durationMs / 1000));
  return `${base} · ${seconds} 秒`;
}

export function ToolSummaryRow({ run, onOpen }: ToolSummaryRowProps) {
  const theme = useTheme();
  const running = run.running > 0;
  const press = usePressFade();
  // 活动文案最短驻留（批 B）：执行中逐工具切换的文案经 ≥1200ms 驻留
  // 整形防闪变；封口瞬间 active=false 直通终态文案（含组总时长）。
  const rawLabel = running ? runningLabel(run) : sealedLabel(run);
  const label = useMinResidencyText(rawLabel, running);
  return (
    <Pressable
      testID={`tool-run-${run.id}`}
      accessibilityRole="button"
      accessibilityLabel={
        run.failed > 0 ? `${label}，${run.failed} 个失败` : label
      }
      disabled={!onOpen}
      onPress={() => onOpen?.(run.id)}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.row,
        {
          minHeight: theme.size.summaryRow,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
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
