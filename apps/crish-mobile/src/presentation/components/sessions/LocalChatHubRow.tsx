// 主页 hub 本地线程行（hub 同列形态）：每个本地线程一行，与远端会话行
// （ChatFlatItem）同版式同列混排——首行 = 线程标题 + 「本地」标识徽标
// （+生成中状态）+ 右上相对时间，次行 = 摘要单行省略；行间虚线分隔
// （末行无）。
// 分区口径：本地线程是手机自身的分区，不属于任何远端设备、不受设备
// 切换影响，与远端行在同一列表里并存呈现但数据源严格分开。
// 本组件是纯呈现面：线程身份由宿主（主页经 hubRows 合并后）传入，
// 点击由宿主送往壳内线程页 /thread/<threadId>（界面统一 U3）。
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { RunningPulseDot } from '@/presentation/components/status/RunningPulseDot';

export interface LocalChatHubRowProps {
  /** 线程 id（testID 的身份来源） */
  threadId: string;
  /** 线程标题（LocalThreadMeta.title，线程自身身份） */
  title: string;
  /** 摘要文本（生成中为实时内容，否则为 meta.preview） */
  snippet: string;
  /** 该线程正在生成（行上呈现「生成中」状态） */
  streaming: boolean;
  /** 相对时间（与 ChatFlatItem 同口径，宿主格式化后传入） */
  time: string;
  /** 末行不画虚线分隔 */
  isLast?: boolean;
  onPress: () => void;
}

export const LocalChatHubRow = memo(function LocalChatHubRow({
  threadId,
  title,
  snippet,
  streaming,
  time,
  isLast = false,
  onPress,
}: LocalChatHubRowProps) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <AnimatedPressable
      testID={`chat-item-local-${threadId}`}
      accessibilityRole="button"
      accessibilityLabel={`本地对话：${title}${streaming ? '，正在生成' : ''}`}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        {
          gap: theme.space.xs + 2,
          paddingBottom: theme.space.xl,
          borderBottomColor: theme.colors.hairline,
        },
        !isLast && styles.divider,
        press.fadeStyle,
      ]}
    >
      <View style={[styles.header, { gap: theme.space.sm }]}>
        <View style={[styles.titleGroup, { gap: theme.space.sm }]}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {title}
          </AppText>
          {/* 「本地」标识徽标：与远端会话行区分分区归属 */}
          <View
            style={[
              styles.localBadge,
              {
                backgroundColor: theme.colors.fillSubtle,
                borderRadius: theme.radius.pill,
                paddingHorizontal: theme.space.sm,
              },
            ]}
          >
            <AppText
              variant="caption"
              color="textTertiary"
              style={{
                // 与 ChatFlatItem 待审批徽标同派生口径（caption − 2）
                fontSize: theme.type.caption.fontSize - 2,
                lineHeight: theme.type.caption.lineHeight - 2,
              }}
            >
              本地
            </AppText>
          </View>
          {streaming ? (
            // 生成中 = 本行即「当前运行」：呼吸点（S4，与桌面 1.6s 口径
            // 对齐）+ 弱文字——此前只有静态文字，长时间生成与卡死无从区分
            <View style={[styles.streamingState, { gap: theme.space.xs + 1 }]}>
              <RunningPulseDot testID={`chat-item-local-running-${threadId}`} />
              <AppText variant="caption" color="textTertiary">
                生成中…
              </AppText>
            </View>
          ) : null}
        </View>
        <AppText variant="caption" color="textTertiary">
          {time}
        </AppText>
      </View>
      {snippet ? (
        <AppText
          variant="footnote"
          color="textSecondary"
          numberOfLines={1}
          style={{
            // 与 ChatFlatItem 摘要同派生口径（footnote + 0.5 / + 2）
            fontSize: theme.type.footnote.fontSize + 0.5,
            lineHeight: theme.type.footnote.lineHeight + 2,
          }}
        >
          {snippet}
        </AppText>
      ) : null}
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  divider: {
    // 发丝线口径（2026-11-02 分割线裁决：更浅更细）
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  localBadge: {
    paddingVertical: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamingState: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});

export default LocalChatHubRow;
