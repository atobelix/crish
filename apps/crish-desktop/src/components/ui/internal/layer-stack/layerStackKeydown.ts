/**
 * apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackKeydown.ts
 *
 * 全局键盘事件分发与调度中枢 (Layer Stack Keydown Dispatcher)
 *
 * 核心职能：
 * 1. CJK IME 中文输入法 229 / Process / isComposing 绝对放行门闩；
 * 2. 50ms Esc 连击防抖状态机 (防止单次击键穿透多层浮层)；
 * 3. 自顶向下倒序寻找首个响应者 (Top-down First Responder Search)；
 * 4. 自定义 onEscapeKeyDown 钩子与阻断型模态层 (modal: true) 拦截保护。
 */

import type { DismissReason, LayerRegistration } from './layerStackTypes';
import { PROCESSED_EVENTS } from './layerStackTypes';

/** 50ms 黄金防抖窗口：连击 Esc 时逐帧退栈，绝不一击穿透全部关闭 */
export const ESC_DEBOUNCE_WINDOW_MS = 50;

/**
 * 守卫 CJK IME 输入法合成态（isComposing / keyCode 229 / Process / nativeEvent.isComposing）。
 * 绝不拦截、绝不消费，保护输入法中文候选框选词。
 */
export function isCjkImeEvent(event: KeyboardEvent): boolean {
  return Boolean(
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === 'Process' ||
    (event as KeyboardEvent & { nativeEvent?: { isComposing?: boolean } })
      .nativeEvent?.isComposing
  );
}

/**
 * 判定当前 Esc 事件是否处于 50ms 防抖锁定窗口内。
 */
export function isEscDebounced(
  now: number,
  lastEscapeDismissTime: number,
  windowMs = ESC_DEBOUNCE_WINDOW_MS
): boolean {
  return Boolean(
    lastEscapeDismissTime &&
    now >= lastEscapeDismissTime &&
    now - lastEscapeDismissTime < windowMs
  );
}

export interface LayerStackKeydownContext {
  getLayers(): readonly LayerRegistration[];
  dismissLayer(layerId: string, reason: DismissReason): void;
  getLastEscapeDismissTime(): number;
}

/**
 * 全局单一 Keydown 调度处理器
 * 自顶向下寻找首个响应者，根除 dismissible:false 调度死锁。
 */
export function handleLayerStackKeyDown(
  event: KeyboardEvent,
  context: LayerStackKeydownContext
): void {
  if (PROCESSED_EVENTS.has(event)) return;
  PROCESSED_EVENTS.add(event);

  // 1. 守卫 CJK IME 输入法合成态
  if (isCjkImeEvent(event)) {
    return;
  }

  if (event.key !== 'Escape') return;

  // 同帧/短时间防抖（50ms 内快速双击 Esc 时，逐帧退栈，绝不一击穿透全部关闭）
  const now = Date.now();
  if (isEscDebounced(now, context.getLastEscapeDismissTime())) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const layers = context.getLayers();
  if (layers.length === 0) {
    return;
  }

  // 2. 自顶向下倒序寻找首个能够消费或退栈的活跃 Layer (Top-down First Responder Search)
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer) continue;

    // 跳过纯环境通知层（如 toast），不消耗 Esc 退出
    if (layer.type === 'toast') continue;

    // A. 若当前层提供了自定义 onEscapeKeyDown 钩子
    if (typeof layer.onEscapeKeyDown === 'function') {
      try {
        const handled = layer.onEscapeKeyDown(event);
        if (handled === true || event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          return; // 消费成功，终止传递
        }
      } catch (err) {
        console.error('[LayerStackManager] Error in onEscapeKeyDown:', err);
      }
    }

    // B. 若当前层允许 Esc 关闭
    if (layer.dismissible) {
      event.preventDefault();
      event.stopPropagation();
      context.dismissLayer(layer.id, 'escape');
      return; // 成功关闭顶层可退栈浮层，终止传递
    }

    // C. 若当前层是阻断型模态层（modal: true），但明确禁止 dismissible，按模态语义阻断 Esc 击穿
    if (layer.modal) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
}
