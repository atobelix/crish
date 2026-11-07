// 对话里的工具摘要行：相邻工具调用折叠成一行，点按打开工具抽屉并定位到这一组。
// 美化排版：终端图标、运行状态指示、发丝边框与右侧抽屉进入指示。
// 下方若有搜索结果，自动挂载 32px 网页来源微胶囊横向滑动条 (WebSourceStrip)。
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, type IconName } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import type { WebSearchSource } from '@crish/shared-types';
import { WebSourceStrip } from '@/presentation/components/tools/WebSourceStrip';
import { formatToolDisplayName, toolBlockSummary } from './buildTimeline';
import type { ToolRunBlock } from './groupToolRuns';
import { useMinResidencyText } from './useActivityLabel';

export interface ToolSummaryRowProps {
  run: ToolRunBlock;
  /** 未提供时只读（如运行详情页没有工具抽屉） */
  onOpen?: (focusId: string) => void;
  /** 点击具体网页来源胶囊回调 */
  onSelectSource?: (source: WebSearchSource) => void;
  /** 高亮的来源序号（对应点击正文 [N] 角标联动） */
  highlightedSourceIndex?: number;
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
  const detail =
    current.intent ||
    current.group ||
    toolBlockSummary(current) ||
    formatToolDisplayName(current.toolName) ||
    '处理中';
  return `正在执行 · ${detail}`;
}

/**
 * 封口组头（D0-2 效果锁）：
 * 绝不展示工具数量（如“使用了 N 个工具”）与耗时秒数（如“N 秒”）。
 * 展示意图标题（优先组标题 group / 最新工具的 intent，无意图时显示单工具展示名或「处理过程」）。
 */
function sealedLabel(run: ToolRunBlock): string {
  // 1. 优先提取当前组内声明的 group 标题
  const groupTitle = run.latest?.group ?? run.tools.find((t) => t.group)?.group;
  if (groupTitle) {
    return groupTitle;
  }

  // 2. 其次读取最新/末尾工具的 clean intent
  const latestIntent = run.latest?.intent;
  if (latestIntent) {
    return latestIntent;
  }

  // 3. 单工具特化摘要或展示名
  if (run.tools.length === 1) {
    const single = run.tools[0]!;
    const summary = toolBlockSummary(single);
    if (summary) {
      return summary;
    }
    return formatToolDisplayName(single.toolName) || '处理过程';
  }

  // 4. 多工具无意图兜底
  return '处理过程';
}

export function ToolSummaryRow({
  run,
  onOpen,
  onSelectSource,
  highlightedSourceIndex,
}: ToolSummaryRowProps) {
  const theme = useTheme();
  const running = run.running > 0;
  const press = usePressFade();
  const currentTool = run.activeTool ?? run.latest;
  const iconName = getToolIconName(currentTool?.toolName);

  // 汇聚提取该工具组下所有子工具产出的 webSources
  const allWebSources = useMemo(() => {
    const sources: WebSearchSource[] = [];
    for (const t of run.tools) {
      if (Array.isArray(t.webSources) && t.webSources.length > 0) {
        sources.push(...t.webSources);
      }
    }
    return sources;
  }, [run.tools]);

  // 活动文案最短驻留（批 B）：执行中逐工具切换的文案经 ≥1200ms 驻留
  // 整形防闪变；封口瞬间 active=false 直通终态文案（含组总时长）。
  const rawLabel = running ? runningLabel(run) : sealedLabel(run);
  const label = useMinResidencyText(rawLabel, running);

  const capsule = (
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

  if (allWebSources.length === 0) {
    return capsule;
  }

  return (
    <View style={styles.container}>
      {capsule}
      <View style={styles.stripWrapper}>
        <WebSourceStrip
          sources={allWebSources}
          onSelectSource={onSelectSource}
          highlightedIndex={highlightedSourceIndex}
          testID={`tool-run-${run.id}-sources`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
    gap: 4,
  },
  row: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center' },
  label: { flexShrink: 1, flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
  stripWrapper: {
    marginTop: 2,
    marginBottom: 2,
  },
});

export default ToolSummaryRow;
