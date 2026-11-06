// 运行时域 → 前台 Toast 的唯一桥（2026-11-05 设备上线提醒接线引入）：
// 非 React 域（runtime / adapters / notifications 编排层）没有 hook 上下文，
// 向前台发提醒经本总线；ToastProvider 挂载时订阅、卸载时退订。
// 载荷与 ToastController.show 完全同构（ToastOptions | string + tone），
// 支持复合卡片与动作按钮（设备上线提醒按定案只发纯提醒、不带动作）。
// 未挂载（后台 /
// 测试 / Provider 未树）→ 静默丢弃（提醒是尽力而为的前台呈现，绝不转
// 系统通知——通知面扩张需走偏好场景裁决）。
import type { ToastOptions, ToastTone } from './Toast';

type ToastBusListener = (
  options: ToastOptions | string,
  tone?: ToastTone
) => void;

let listener: ToastBusListener | null = null;

/** ToastProvider 挂载时订阅（返回退订函数；重复订阅以后到者为准） */
export function subscribeHostToasts(l: ToastBusListener): () => void {
  listener = l;
  return () => {
    if (listener === l) {
      listener = null;
    }
  };
}

/** 运行时域发出前台提醒（无宿主时静默丢弃） */
export function emitHostToast(
  options: ToastOptions | string,
  tone?: ToastTone
): void {
  listener?.(options, tone);
}
