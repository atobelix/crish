// 对话里的工具摘要行：相邻工具调用折叠成一行，点按打开工具抽屉并定位到这一组。
// 美化排版：终端图标、运行状态指示、发丝边框与右侧抽屉进入指示。
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, type IconName } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import { toolBlockSummary } from './buildTimeline';
import type { ToolRunBlock } from './groupToolRuns';
import { useMinResidencyText } from './useActivityLabel';

export interface ToolSummaryRowProps {
  run: ToolRunBlock;
  /** 未提供时只读（如运行详情页没有工具抽屉） */
  onOpen?: (focusId: string) => void;
}

function getToolIconName(toolName?: string): IconName {
  if (!toolName) return 'terminal';
  if (toolName === 'web_search' || toolName === 'search_web') {
    return 'search';
  }
  if (
    toolName === 'web_fetch' ||
    toolName === 'fetch_url' ||
    toolName === 'read_url_content'
  ) {
    return 'globe';
  }
  if (
    toolName === 'run_js_sandbox' ||
    toolName === 'quickjs_sandbox' ||
    toolName === 'run_javascript'
  ) {
    return 'terminal';
  }
  return 'terminal';
}

function runningLabel(run: ToolRunBlock): string {
  const current = run.activeTool ?? run.latest;
  const detail = toolBlockSummary(current) || current.toolName;
  return `正在执行 · ${detail}`;
}

/** 封口组头：工具数 + 组总时长（单特化工具优先展示专用完成文案） */
function sealedLabel(run: ToolRunBlock): string {
  if (run.tools.length === 1) {
    const single = run.tools[0]!;
    if (
      single.toolName === 'web_search' ||
      single.toolName === 'search_web' ||
      single.toolName === 'web_fetch' ||
      single.toolName === 'fetch_url' ||
      single.toolName === 'read_url_content' ||
      single.toolName === 'run_js_sandbox' ||
      single.toolName === 'quickjs_sandbox' ||
      single.toolName === 'run_javascript'
    ) {
      const summary = toolBlockSummary(single);
      if (summary) {
        if (run.durationMs === undefined) return summary;
        const seconds = Math.max(1, Math.round(run.durationMs / 1000));
        return `${summary} · ${seconds} 秒`;
      }
    }
  }
  const base = `使用了 ${run.tools.length} 个工具`;
  if (run.durationMs === undefined) return base;
  const seconds = Math.max(1, Math.round(run.durationMs / 1000));
  return `${base} · ${seconds} 秒`;
}

export function ToolSummaryRow({ run, onOpen }: ToolSummaryRowProps) {
  const theme = useTheme();
  const running = run.running > 0;
  const press = usePressFade();
  const currentTool = run.activeTool ?? run.latest;
  const iconName = getToolIconName(currentTool?.toolName);

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
          minHeight: 26,
          paddingHorizontal: 9,
          paddingVertical: 3.5,
          gap: 5,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surfaceGrouped,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.hairline,
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
      <Icon
        name={iconName}
        size={11}
        color={running ? theme.colors.brand : theme.colors.textSecondary}
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
          variant="caption"
          color="textSecondary"
          numberOfLines={1}
          style={styles.shrink}
        >
          {label}
        </AppText>
        {run.failed > 0 ? (
          <AppText variant="caption" color="danger">
            · {run.failed} 个失败
          </AppText>
        ) : null}
      </View>
      {onOpen ? (
        <Icon
          name="chevron-right"
          size={11}
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
