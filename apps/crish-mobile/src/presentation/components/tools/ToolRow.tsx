// 工具抽屉里的单行：图标 · 工具名 · 目标（等宽）· 状态；点开在行内显示输出。
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, type IconName } from '@/presentation/ui';
import type { ToolBlock } from '@/presentation/timeline/buildTimeline';
import { PulseDot } from './PulseDot';

export interface ToolRowProps {
  tool: ToolBlock;
}

/** 按工具名猜一个语义图标（只用于视觉区分，不影响行为） */
export function toolIconFor(toolName: string): IconName {
  const name = toolName.toLowerCase();
  if (/(bash|shell|exec|command|terminal)/.test(name)) return 'terminal';
  if (/(grep|search|find|glob)/.test(name)) return 'search';
  if (/(write|edit|patch|replace)/.test(name)) return 'file-code';
  if (/(read|view|cat)/.test(name)) return 'file-text';
  return 'wrench';
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
        <Icon
          name={toolIconFor(tool.toolName)}
          size={theme.size.icon}
          color={theme.colors.textSecondary}
        />
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
  switch (status) {
    case 'running':
      return <PulseDot testID="tool-status-running" />;
    case 'error':
      return (
        <Icon
          name="x"
          size={theme.size.iconSmall}
          color={theme.colors.danger}
        />
      );
    case 'done':
      return (
        <Icon
          name="check"
          size={theme.size.iconSmall}
          color={theme.colors.success}
        />
      );
  }
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, minWidth: 0 },
});
