/**
 * ui/internal/layer-registration/useLayerRegistration.ts
 *
 * 浮层注册 Hook —— ui/ 原子层内部私有版本。
 *
 * 由来：原 `src/hooks/useLayerRegistration.ts` 被 ui/ 原子层（Dialog/Menu）反向
 * 依赖 over `src/services/`，违反原子层门禁。按详案 F1-α 将 hook 与最小 service
 * 子集一并**无副作用下沉** `ui/internal/**`，使原子层零业务 import。
 *
 * 行为与对外版本完全一致（dynamic getter + Ref 同步，消除 StrictMode / 初始挂载
 * Stale Ref 缺陷；虚拟拦截器经 `registerVirtual` 直通最高优先级拦截）。
 */
import { useEffect, useRef } from 'react';
import {
  layerStackService,
  type LayerRegistration,
  type DismissReason,
} from '../layer-stack/LayerStackService';

/**
 * 注册标准 UI 浮层 Hook
 * 采用 dynamic getter 与 Ref 同步，消除 React StrictMode 与初始挂载阶段的 Stale Ref 缺陷
 */
export function useLayerRegistration(
  layer: Omit<LayerRegistration, 'mountedAt'>,
  active = true
): void {
  const layerRef = useRef(layer);
  layerRef.current = layer;

  useEffect(() => {
    if (!active) return;

    const unregister = layerStackService.register({
      id: layer.id,
      type: layer.type,
      parentId: layer.parentId,
      get elementRef() {
        return layerRef.current.elementRef;
      },
      get portalContainer() {
        return layerRef.current.portalContainer;
      },
      get anchorRef() {
        return layerRef.current.anchorRef;
      },
      get dismissible() {
        return layerRef.current.dismissible;
      },
      get modal() {
        return layerRef.current.modal;
      },
      get restoreFocusTarget() {
        return layerRef.current.restoreFocusTarget;
      },
      onDismiss: (reason: DismissReason) => layerRef.current.onDismiss(reason),
      onEscapeKeyDown: (e: KeyboardEvent) =>
        layerRef.current.onEscapeKeyDown?.(e),
      onPointerDownOutside: (e: PointerEvent) =>
        layerRef.current.onPointerDownOutside?.(e),
    });

    return unregister;
  }, [active, layer.id, layer.type, layer.parentId]);
}

/**
 * 注册临时虚拟拦截器 Hook（如快捷键录制态、拖拽态）
 */
export function useVirtualLayer(
  id: string,
  onEscape: (e: KeyboardEvent) => boolean | void,
  active = true
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    return layerStackService.registerVirtual(id, (e) => onEscapeRef.current(e));
  }, [id, active]);
}
