// 工具抽屉里的单行：工具名（等宽真名）· 目标摘要 · 状态点；点开在行内显示输出。
// N05 裁定：删除「按工具名猜语义图标」（猜测即装饰）；执行中/完成/失败统一
// 8px 静态色点（brand/success/danger）——PulseDot 呼吸脉冲违 U8 已物理删除。
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import type { ToolBlock } from '@/presentation/timeline/buildTimeline';

export interface ToolRowProps {
  tool: ToolBlock;
}

function statusLabel(status: ToolBlock['status']): string {
  switch (status) {
    case 'running':
      return '执行中';
    case 'error':
      return '失败';
    case 'done':
      return '完成';
  }
}

export function ToolRow({ tool }: ToolRowProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const output = tool.output.trim();
  return (
    <View style={{ gap: theme.space.sm }}>
      <Pressable
        testID={`tool-row-${tool.id}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${tool.toolName}，${statusLabel(tool.status)}`}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: theme.size.row,
            gap: theme.space.md,
            paddingHorizontal: theme.space.screenX,
          },
          pressed && { backgroundColor: theme.colors.fillPressed },
        ]}
      >
        <View style={styles.body}>
          <AppText variant="callout" numberOfLines={1}>
            {tool.toolName}
          </AppText>
          {tool.summary ? (
            <AppText variant="mono" color="textTertiary" numberOfLines={1}>
              {tool.summary}
            </AppText>
          ) : null}
        </View>
        <ToolStatus status={tool.status} />
      </Pressable>
      {expanded ? (
        <View
          style={{
            marginHorizontal: theme.space.screenX,
            padding: theme.space.md,
            borderRadius: theme.radius.control,
            backgroundColor: theme.colors.fillSubtle,
          }}
        >
          <AppText variant="mono" color="textSecondary" selectable>
            {output === '' ? '暂无输出' : tool.output}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

function ToolStatus({ status }: { status: ToolBlock['status'] }) {
  const theme = useTheme();
  const color =
    status === 'running'
      ? theme.colors.brand
      : status === 'error'
        ? theme.colors.danger
        : theme.colors.success;
  return (
    <View
      testID={`tool-status-${status}`}
      accessibilityLabel={statusLabel(status)}
      style={{
        width: theme.size.dot,
        height: theme.size.dot,
        borderRadius: theme.radius.pill,
        backgroundColor: color,
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
});
