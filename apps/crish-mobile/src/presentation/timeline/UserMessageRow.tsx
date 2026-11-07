// 用户消息气泡组件（动效质感与无缝飞入过渡）：
// 承担对话时间线中用户角色的消息气泡呈现。
// 动效特性：
// 1. 无缝接力入场（Enter Animation）：
//    新挂载的用户消息气泡从下方输入框方向自然升起（translateY: 24 -> 0,
//    opacity: 0 -> 1, scale: 0.96 -> 1），采用 Material / iOS 标准
//    强调减速曲线 Easing.bezier(0.22, 1, 0.36, 1)，与 Composer 的草稿发射
//    动效形成完美的时空接力，彻底消除突兀段落感与瞬断跳跃；
// 2. 避免滚动复用重触发：
//    仅由时间线在初次生成新消息时开启 animateEntry，历史消息与列表滚动
//    回收挂载时保持静态呈现，杜绝高刷滚动闪烁与布局重排；
// 3. 无障碍单源减动效：
//    严格消费 @/adapters/platform/useReducedMotion 单源信号，开启减弱动态时
//    安全回退为瞬时终态。
import { memo, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { MarkdownText } from '@/presentation/components/blocks/MarkdownText';
import { consumeUserEntryAnimation } from './userEntryQualification';

export interface UserMessageRowProps {
  id?: string;
  text: string;
  /** 是否需要飞入进场动画（默认为 false） */
  animateEntry?: boolean;
  /** 投递状态提示（R5 回显块携带）：pending = 发送中；failed = 未送达可重发 */
  deliveryStatus?: 'pending' | 'failed';
  testID?: string;
}

export const UserMessageRow = memo(function UserMessageRow({
  id,
  text,
  animateEntry = false,
  deliveryStatus,
  testID,
}: UserMessageRowProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  // R8 一次性入场守卫：资格只在首次挂载判定（同 id 重挂/切回不重播）。
  // ref 按 id 缓存判定结果，资格消耗是幂等的一次性动作。
  const entryRef = useRef<{ id?: string; allowed: boolean }>({
    id: undefined,
    allowed: false,
  });
  if (entryRef.current.id !== id) {
    // 资格无条件消耗（减动效下也不回补），保证同 id 全生命周期至多播一次
    const consumed = id !== undefined ? consumeUserEntryAnimation(id) : false;
    entryRef.current = {
      id,
      allowed: Boolean(animateEntry) && !reducedMotion && consumed,
    };
  }
  const shouldAnimate = entryRef.current.allowed;

  const translateY = useSharedValue(shouldAnimate ? 24 : 0);
  const opacity = useSharedValue(shouldAnimate ? 0 : 1);
  const scale = useSharedValue(shouldAnimate ? 0.96 : 1);

  useEffect(() => {
    if (shouldAnimate) {
      translateY.value = withTiming(0, {
        duration: theme.motion.duration.drawer,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      });
      opacity.value = withTiming(1, {
        duration: theme.motion.duration.drawer,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      });
      scale.value = withTiming(1, {
        duration: theme.motion.duration.drawer,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      });
    } else {
      translateY.value = 0;
      opacity.value = 1;
      scale.value = 1;
    }
  }, [shouldAnimate, theme.motion]);

  const animatedBubbleStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }));

  const rowTestID = testID ?? (id ? `user-message-${id}` : 'user-message-row');

  return (
    <View style={styles.userRow} testID={rowTestID}>
      <Animated.View
        testID={`${rowTestID}-bubble`}
        style={[
          styles.userBubble,
          {
            // 用户气泡（原型 18/18/4/18）：尾角朝发言侧收窄
            backgroundColor: theme.colors.bubbleUser,
            borderTopLeftRadius: theme.radius.bubble,
            borderTopRightRadius: theme.radius.bubble,
            borderBottomRightRadius: theme.radius.bubbleTail,
            borderBottomLeftRadius: theme.radius.bubble,
            // 原型 msg-user-bubble：padding 10/14（墨色气泡靠自身明度差区分）
            paddingHorizontal: 14,
            paddingVertical: 10,
          },
          animatedBubbleStyle,
        ]}
      >
        <MarkdownText
          text={text}
          baseStyle={[theme.type.chat, { color: theme.colors.bubbleUserText }]}
        />
      </Animated.View>
      {deliveryStatus !== undefined ? (
        <Text
          style={[
            styles.deliveryHint,
            theme.type.caption,
            { color: theme.colors.textSecondary },
          ]}
          testID={`${rowTestID}-delivery`}
        >
          {deliveryStatus === 'failed' ? '未送达' : '发送中'}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  userRow: {
    width: '100%',
    alignItems: 'flex-end',
  },
  userBubble: {
    maxWidth: '82%',
  },
  deliveryHint: {
    marginTop: 4,
  },
});

export default UserMessageRow;
