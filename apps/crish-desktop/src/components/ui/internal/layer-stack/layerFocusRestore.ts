/**
 * 焦点平滑还原算法（拆分自 LayerStackManager）。
 *
 * 仅 Esc 与选中项操作还原焦点；外点交互尊重用户外部聚焦目标。
 * 还原优先级：
 * 1. 显式 restoreFocusTarget
 * 2. anchorRef 触发器
 * 3. 父级 Layer 容器的首个可聚焦元素
 */

import type { LayerRegistration } from './layerStackTypes';
import { resolveElement } from './layerStackTypes';

/**
 * 在下一帧还原指定浮层的焦点。
 * @param layer 被关闭的浮层
 * @param getLayers 获取当前栈快照的闭包（父级查找用）
 */
export function restoreLayerFocus(
  layer: LayerRegistration,
  getLayers: () => readonly LayerRegistration[]
): void {
  if (typeof requestAnimationFrame === 'undefined') return;

  requestAnimationFrame(() => {
    // 1. 显式指定的 restoreFocusTarget
    if (
      layer.restoreFocusTarget &&
      typeof layer.restoreFocusTarget.focus === 'function'
    ) {
      layer.restoreFocusTarget.focus();
      return;
    }

    // 2. 绑定的 anchorRef 触发器
    const anchorEl = resolveElement(layer.anchorRef);
    if (anchorEl && typeof anchorEl.focus === 'function') {
      anchorEl.focus();
      return;
    }

    // 3. 若存在父级 Layer，回退到父级容器的首个可聚焦元素
    if (layer.parentId) {
      const parentLayer = getLayers().find((l) => l.id === layer.parentId);
      if (parentLayer) {
        const parentEl = resolveElement(parentLayer.elementRef);
        const firstFocusable = parentEl?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        firstFocusable?.focus();
      }
    }
  });
}
