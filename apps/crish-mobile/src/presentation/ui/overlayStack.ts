// 覆盖层注册表（批 D，2026-11-03；深比 02-3 的浮层纪律落点）：
// 全仓覆盖层（Sheet / Dialog / DropdownMenu / AttachmentSheet 锚点
// Popover）打开期间按开启顺序登记成栈，系统返回统一由栈顶裁决：
//   - 栈顶有钻取返回（onBack）→ 只退钻取一层，不关浮层；
//   - 栈顶可关闭（dismissible）→ 请求关闭栈顶；
//   - 栈顶不可关闭（dismissible=false，必须表态）→ 消费返回且什么
//     都不关（下层浮层与页面导航同样不得越过它）；
//   - 栈空 → 不消费，交回导航兜底（根布局 useAndroidBackGuard）。
// Android 返回的两条到达路径汇入同一裁决：
//   - RN Modal 型浮层（Sheet/Dialog）的返回经原生对话框送达为
//     onRequestClose（不走 JS BackHandler 链），故 Modal 在自己的
//     onRequestClose 里调 handleOverlayBackFor(自身 id)；
//   - 非 Modal 浮层（菜单/锚点 Popover）收不到原生返回，由根布局
//     的 useOverlayBackHandler 订阅 BackHandler 后调
//     handleOverlayBack——订阅顺序在 useAndroidBackGuard 之后
//     （BackHandler 按后订阅先调用），浮层优先于导航兜底。
// 本模块只管栈与裁决：不渲染、不感知具体组件。
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

export interface OverlayEntry {
  /** 浮层唯一 id（组件以 useId/testID 派生，同 id 重复登记 = 原位更新） */
  id: string;
  /** false = 必须表态层：返回/遮罩/手势都不得关闭（手柄诚实口径在 Sheet 侧） */
  dismissible: boolean;
  /** 请求关闭本层（仅 dismissible 时由裁决调用） */
  onRequestClose: () => void;
  /**
   * 面板内钻取返回：在场且真的退了一层钻取时返回 true（裁决止步
   * 于此、不关本层）；无钻取可退时返回 false，裁决继续走关闭面。
   */
  onBack?: () => boolean;
}

const stack: OverlayEntry[] = [];

/** 登记（同 id 已在栈 = 原位更新字段，栈序不变） */
export function pushOverlay(entry: OverlayEntry): void {
  const index = stack.findIndex((e) => e.id === entry.id);
  if (index >= 0) {
    stack[index] = entry;
    return;
  }
  stack.push(entry);
}

/** 注销（不在栈内为无操作） */
export function removeOverlay(id: string): void {
  const index = stack.findIndex((e) => e.id === id);
  if (index >= 0) stack.splice(index, 1);
}

/** 栈顶条目（栈空 = null） */
export function topOverlay(): OverlayEntry | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

/** 当前栈深（测试/诊断面） */
export function overlayStackDepth(): number {
  return stack.length;
}

/**
 * 返回裁决（对栈顶生效）：返回 true = 本次返回已被浮层层消费
 * （含「被不可关层挡下」的情形），页面导航不得继续处理。
 */
export function handleOverlayBack(): boolean {
  const top = topOverlay();
  if (!top) return false;
  if (top.onBack && top.onBack()) {
    return true;
  }
  if (top.dismissible) {
    top.onRequestClose();
  }
  return true;
}

/**
 * Modal 型浮层的 onRequestClose 汇入口：信号虽送达本层，裁决仍归
 * 栈顶（栈顶可能是叠在本层之上的另一浮层）。返回 false 仅发生在
 * 栈空（本层尚未登记/已注销的竞态窗口），调用方据此回落自身口径。
 */
export function handleOverlayBackFor(id: string): boolean {
  if (stack.length === 0) return false;
  void id;
  return handleOverlayBack();
}

/**
 * 登记 hook：active 期间把本层压栈，回调恒取最新 props（经 ref
 * 转发，回调换引用不重登记、栈序不动）；dismissible 变化经
 * pushOverlay 原位更新同步。
 */
export function useOverlayRegistration(
  id: string,
  active: boolean,
  options: {
    dismissible: boolean;
    onRequestClose: () => void;
    onBack?: () => void;
  }
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dismissible = options.dismissible;
  useEffect(() => {
    if (!active) return undefined;
    pushOverlay({
      id,
      dismissible,
      onRequestClose: () => optionsRef.current.onRequestClose(),
      onBack: () => {
        const back = optionsRef.current.onBack;
        if (!back) return false;
        back();
        return true;
      },
    });
    return () => removeOverlay(id);
  }, [id, active, dismissible]);
}

/**
 * 非 Modal 浮层的返回接管（根布局挂载一次）：栈空时不消费，
 * 交回后续 BackHandler 订阅（抽屉、导航兜底）按各自口径处理。
 */
export function useOverlayBackHandler(): void {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () =>
      handleOverlayBack()
    );
    return () => subscription.remove();
  }, []);
}
