// 全局唯一的审批入口：挂在根 Stack 之后，悬浮于页面之上。
// 数据：approvalStore.pending（已按剩余时间升序）；决策复用 useApprovalDetailVm（防双点、倒计时、到期兜底）。
// 键盘弹起或用户手动收起时缩成胶囊；新到一条审批会重新展开。
// 形态过渡（M-B 2026-11-02）：卡 / 胶囊双形态常驻，切换由共享值 morph
// 驱动高度插值 + 交叉淡化（motion.duration.fast + emphasized 曲线），
// 取代原条件渲染硬切。功能与视觉分离：当前形态在切换提交的同一帧即
// 接管触摸与无障碍（非当前形态 pointerEvents=none 且对读屏隐藏），
// 动画只管观感——审批可点、可达的时点不被过渡推迟。
// 定位（M-B）：静态 bottom 只取键盘关闭口径（安全区 + 锚点距）；键盘
// 升降的逐帧贴合走键盘动画值（useReanimatedKeyboardAnimation，与
// KeyboardStickyView 同源同出 KeyboardProvider），不再由离散高度状态
// 瞬移定位。useKeyboardHeight 只保留语义判定（自动收起、展开先落键盘）。
import { useEffect, useState } from 'react';
import {
  InteractionManager,
  Keyboard,
  StyleSheet,
  type LayoutChangeEvent,
} from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';
import { useTheme } from '@/adapters/platform/theme';
import { useApprovalDetailVm } from '@/adapters/viewmodels/useApprovalDetailVm';
import { ApprovalFloatCard } from './ApprovalFloatCard';
import { ApprovalFloatPill } from './ApprovalFloatPill';
import {
  approvalFloatModel,
  isApprovalFloatHiddenOn,
  type ApprovalFloatModel,
} from './approvalFloatModel';

export function ApprovalFloat() {
  const pathname = usePathname();
  const pending = useApprovalStore((s) => s.pending);
  const hiddenOnCurrentRoute = isApprovalFloatHiddenOn(pathname);

  // 【流畅度方案 08·核心优化】：转场落定延时挂载门
  // 从设置页（hidden=true）返回主屏（hidden=false）时，绝不在转场黄金 300ms 帧窗口
  // 突发挂载复杂的 ApprovalFloatPanel 子树；等待转场完全结束、InteractionManager 释放后再挂载。
  const [shouldRender, setShouldRender] = useState(!hiddenOnCurrentRoute);

  useEffect(() => {
    if (hiddenOnCurrentRoute) {
      setShouldRender(false);
      return;
    }
    // 从隐藏恢复到显示：走 runAfterInteractions 排队，给转场动画完全让出 CPU
    const task = InteractionManager.runAfterInteractions(() => {
      setShouldRender(true);
    });
    return () => {
      if (typeof task?.cancel === 'function') {
        task.cancel();
      }
    };
  }, [hiddenOnCurrentRoute]);

  if (!shouldRender) return null;

  const model = approvalFloatModel(pending, pathname);
  if (!model) return null;
  return <ApprovalFloatPanel model={model} />;
}

function ApprovalFloatPanel({ model }: { model: ApprovalFloatModel }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const reduceMotion = useReducedMotion();
  const { item, others, mode, anchor } = model;
  const toolCallId = item.request.toolCallId;
  const vm = useApprovalDetailVm(toolCallId);
  // 按条目记住「手动收起」，换到下一条时自然重新展开
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const keyboardUp = keyboardHeight > 0;
  const collapsed = keyboardUp || collapsedId === toolCallId;

  // 静态底座 = 键盘关闭口径：底安全区 + 锚点距（有 Composer 的页面让开
  // 输入条本体，其余只让一组间距）。键盘全开稳态由下方逐帧贴合在动画
  // 末端抵达，与旧离散口径（键盘高 + 锚点距）逐像素一致。
  const bottom =
    insets.bottom +
    (anchor === 'composer'
      ? theme.size.composerMin + theme.space.xl
      : theme.space.lg);

  const enter = useEnterAnimation(toolCallId, reduceMotion);

  // 键盘逐帧贴合（与 Composer 的 KeyboardStickyView 同一动画源）：
  // lift = 当前键盘高 − 底安全区 × progress。键盘关闭时 0；动画中段浮层
  // 恒在键盘当前顶缘之上 insets.bottom × (1 − progress) 处（即它在静止
  // 态相对安全区的留白随键盘升起渐让出），全开时恰好贴键盘顶缘。
  const keyboard = useReanimatedKeyboardAnimation();
  const insetBottom = insets.bottom;
  const anchorStyle = useAnimatedStyle(() => {
    const lift = -keyboard.height.value - insetBottom * keyboard.progress.value;
    return {
      opacity: enter.opacity.value,
      transform: [{ translateY: enter.translateY.value - lift }],
    };
  });

  // ── 形态过渡：morph 1 = 卡、0 = 胶囊 ──
  const morph = useSharedValue(collapsed ? 0 : 1);
  const morphDuration = theme.motion.duration.fast;
  useEffect(() => {
    const target = collapsed ? 0 : 1;
    morph.value = reduceMotion
      ? target
      : withTiming(target, {
          duration: morphDuration,
          easing: Easing.bezier(...theme.motion.easing.emphasized),
        });
  }, [collapsed, reduceMotion, morph, morphDuration, theme]);

  // 两形态实测高度由各自壳的 onLayout 回填（停靠态壳脱离流但仍有自身
  // 尺寸，照常回填）；测齐前形态盒不定高、由当前形态自然撑起，测齐的
  // 瞬间插值高度恰等于当前形态实高，切换无跳变。
  const cardHeight = useSharedValue(0);
  const pillHeight = useSharedValue(0);
  const boxStyle = useAnimatedStyle(() => {
    const pill = pillHeight.value;
    const card = cardHeight.value;
    if (pill <= 0 || card <= 0) return { height: undefined };
    return { height: interpolate(morph.value, [0, 1], [pill, card]) };
  });
  const cardShellStyle = useAnimatedStyle(() => ({ opacity: morph.value }));
  const pillShellStyle = useAnimatedStyle(() => ({
    opacity: 1 - morph.value,
  }));
  const onCardLayout = (event: LayoutChangeEvent) => {
    cardHeight.value = event.nativeEvent.layout.height;
  };
  const onPillLayout = (event: LayoutChangeEvent) => {
    pillHeight.value = event.nativeEvent.layout.height;
  };

  const expand = () => {
    if (keyboardUp) Keyboard.dismiss();
    setCollapsedId(null);
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.anchor,
        {
          bottom,
          left: theme.space.md + insets.left,
          right: theme.space.md + insets.right,
        },
        anchorStyle,
      ]}
    >
      <Animated.View pointerEvents="box-none" style={boxStyle}>
        <Animated.View
          testID="approval-float-card-shell"
          pointerEvents={collapsed ? 'none' : 'auto'}
          accessibilityElementsHidden={collapsed}
          importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
          onLayout={onCardLayout}
          style={[
            collapsed ? styles.shellDocked : styles.shellFlow,
            cardShellStyle,
          ]}
        >
          <ApprovalFloatCard
            item={item}
            mode={mode}
            others={others}
            remainingMs={vm.remainingMs}
            busy={vm.busy}
            onAllow={vm.onAllow}
            onDeny={vm.onDeny}
            onReview={() => router.push(`/approval/${toolCallId}`)}
            onOpenQueue={() => router.push('/approvals')}
            onOpenSession={() =>
              router.navigate(`/session/${item.request.sessionId}`)
            }
            onCollapse={() => setCollapsedId(toolCallId)}
          />
        </Animated.View>
        <Animated.View
          testID="approval-float-pill-shell"
          pointerEvents={collapsed ? 'auto' : 'none'}
          accessibilityElementsHidden={!collapsed}
          importantForAccessibility={
            !collapsed ? 'no-hide-descendants' : 'auto'
          }
          onLayout={onPillLayout}
          style={[
            collapsed ? styles.shellFlow : styles.shellDocked,
            pillShellStyle,
          ]}
        >
          <ApprovalFloatPill
            count={others + 1}
            remainingMs={vm.remainingMs}
            onExpand={expand}
          />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/** 每条审批出现时淡入上移（motion.enter）；减动效时直达终态 */
function useEnterAnimation(
  key: string,
  reduceMotion: boolean
): { opacity: SharedValue<number>; translateY: SharedValue<number> } {
  const theme = useTheme();
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(theme.motion.enter.translateY);
  const { duration, translateY: offset } = theme.motion.enter;
  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 1;
      translateY.value = 0;
      return;
    }
    opacity.value = 0;
    translateY.value = offset;
    const config = {
      duration,
      easing: Easing.bezier(...theme.motion.easing.emphasized),
    };
    opacity.value = withTiming(1, config);
    translateY.value = withTiming(0, config);
  }, [key, reduceMotion, opacity, translateY, duration, offset, theme]);
  return { opacity, translateY };
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute' },
  // 当前形态：在流内，决定形态盒的自然高度
  shellFlow: {},
  // 非当前形态：脱离流、底缘锚定形态盒底（与浮层整体同锚），
  // 淡出期间位置不随盒高插值移动
  shellDocked: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});

export default ApprovalFloat;
