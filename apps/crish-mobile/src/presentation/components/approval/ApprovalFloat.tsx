// 全局唯一的审批入口：挂在根 Stack 之后，悬浮于页面之上。
// 数据：approvalStore.pending（已按剩余时间升序）；决策复用 useApprovalDetailVm（防双点、倒计时、到期兜底）。
// 键盘弹起或用户手动收起时缩成胶囊；新到一条审批会重新展开。
import { useEffect, useRef, useState } from 'react';
import { Animated, Keyboard, Platform, StyleSheet } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';
import { useTheme } from '@/adapters/platform/theme';
import { useApprovalDetailVm } from '@/adapters/viewmodels/useApprovalDetailVm';
import { ApprovalFloatCard } from './ApprovalFloatCard';
import { ApprovalFloatPill } from './ApprovalFloatPill';
import {
  approvalFloatModel,
  type ApprovalFloatModel,
} from './approvalFloatModel';

export function ApprovalFloat() {
  const pathname = usePathname();
  const pending = useApprovalStore((s) => s.pending);
  const model = approvalFloatModel(pending, pathname);
  if (!model) return null;
  return <ApprovalFloatPanel model={model} />;
}

function ApprovalFloatPanel({ model }: { model: ApprovalFloatModel }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const { item, others, mode, anchor } = model;
  const toolCallId = item.request.toolCallId;
  const vm = useApprovalDetailVm(toolCallId);
  // 按条目记住「手动收起」，换到下一条时自然重新展开
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const keyboardUp = keyboardHeight > 0;
  const collapsed = keyboardUp || collapsedId === toolCallId;

  // Android 由系统 resize 抬起窗口；iOS 需自行加上键盘高度
  const base =
    Platform.OS === 'ios' && keyboardUp ? keyboardHeight : insets.bottom;
  const bottom =
    base +
    (anchor === 'composer'
      ? theme.size.composerMin + theme.space.xl
      : theme.space.lg);

  const enter = useEnterAnimation(toolCallId);

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
          opacity: enter.opacity,
          transform: [{ translateY: enter.translateY }],
        },
      ]}
    >
      {collapsed ? (
        <ApprovalFloatPill
          count={others + 1}
          remainingMs={vm.remainingMs}
          onExpand={expand}
        />
      ) : (
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
      )}
    </Animated.View>
  );
}

/** 每条审批出现时淡入上移（motion.enter） */
function useEnterAnimation(key: string) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(
    new Animated.Value(theme.motion.enter.translateY)
  ).current;
  const { duration, translateY: offset } = theme.motion.enter;
  useEffect(() => {
    opacity.setValue(0);
    translateY.setValue(offset);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration,
        useNativeDriver: true,
      }),
    ]).start();
  }, [key, opacity, translateY, duration, offset]);
  return { opacity, translateY };
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute' },
});

export default ApprovalFloat;
