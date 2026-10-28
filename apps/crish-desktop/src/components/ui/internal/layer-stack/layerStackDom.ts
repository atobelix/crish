/**
 * apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackDom.ts
 *
 * 浮层 DOM 拓扑计算、弱引用包装与外点碰撞判定 (Layer Stack DOM & Topology)
 *
 * 核心职能：
 * 1. 弱引用对象安全封装与 LayerRegistration 实例构造 (toWeakRefObject / createLayerEntry)；
 * 2. 节点树拓扑寻亲与互斥同级判定 (hasAncestor / findExclusivePeersToDismiss)；
 * 3. 模态层挂载时游离浮层重定亲或清退 (reparentOrEvictBackgroundPopovers)；
 * 4. Outside Pointer 命中检测、Drag-off 语义与状态机 (LayerStackPointerTracker)；
 * 5. 全局事件绑定与 Document 级 data-floating-active 状态同步。
 */

import type React from 'react';
import type {
  DismissReason,
  DismissedByPointerSnapshot,
  LayerRegistration,
  LayerTraceRecord,
} from './layerStackTypes';
import {
  PROCESSED_EVENTS,
  getLayerTier,
  isExclusivePeerLayerType,
  isPopoverMenuLayer,
  resolveElement,
} from './layerStackTypes';

/**
 * 将 RefObject 或 HTMLElement 包装为 WeakRef 代理，防止悬空内存泄漏。
 */
export function toWeakRefObject(
  refOrEl?: React.RefObject<HTMLElement | null> | HTMLElement | null
): React.RefObject<HTMLElement | null> | null | undefined {
  if (refOrEl === undefined) return undefined;
  if (refOrEl === null) return null;
  if (typeof WeakRef === 'undefined') {
    return 'current' in refOrEl ? refOrEl : { current: refOrEl };
  }
  if (!('current' in refOrEl)) {
    const weakEl = new WeakRef(refOrEl);
    return {
      get current(): HTMLElement | null {
        return weakEl.deref() ?? null;
      },
    };
  }
  const refWeak = new WeakRef(refOrEl);
  let elementWeak =
    refOrEl.current && typeof refOrEl.current === 'object'
      ? new WeakRef(refOrEl.current)
      : null;
  return {
    get current(): HTMLElement | null {
      const ref = refWeak.deref();
      if (ref) {
        const raw = ref.current;
        if (!raw) {
          elementWeak = null;
          return null;
        }
        if (!elementWeak || elementWeak.deref() !== raw) {
          elementWeak = new WeakRef(raw);
        }
        return elementWeak.deref() ?? null;
      }
      return elementWeak?.deref() ?? null;
    },
  };
}

/**
 * 创建浮层注册项实体，包装 WeakRef 属性保护 DOM 内存。
 */
export function createLayerEntry(
  layer: Omit<LayerRegistration, 'mountedAt'>,
  sequence: number
): LayerRegistration {
  const elementRef = toWeakRefObject(layer.elementRef);
  const anchorRef = toWeakRefObject(layer.anchorRef);
  const weakPortal =
    layer.portalContainer && typeof WeakRef !== 'undefined'
      ? new WeakRef(layer.portalContainer)
      : null;
  const weakRestoreTarget =
    layer.restoreFocusTarget && typeof WeakRef !== 'undefined'
      ? new WeakRef(layer.restoreFocusTarget)
      : null;

  const tier = layer.tier ?? getLayerTier(layer.type);
  const fullLayer: LayerRegistration = {
    ...layer,
    tier,
    elementRef,
    anchorRef,
    mountedAt: sequence,
  };

  if (weakPortal) {
    Object.defineProperty(fullLayer, 'portalContainer', {
      get: () => weakPortal.deref() ?? null,
      enumerable: true,
      configurable: true,
    });
  }

  if (weakRestoreTarget) {
    Object.defineProperty(fullLayer, 'restoreFocusTarget', {
      get: () => weakRestoreTarget.deref() ?? null,
      enumerable: true,
      configurable: true,
    });
  }

  return fullLayer;
}

/**
 * 创建生命周期 Trace 审计记录
 */
export function createTraceRecord(
  layer: LayerRegistration,
  reason: DismissReason
): LayerTraceRecord {
  return {
    id: layer.id,
    type: layer.type,
    tier: layer.tier ?? getLayerTier(layer.type),
    parentId: layer.parentId,
    mountedAt: layer.mountedAt,
    dismissedAt: Date.now(),
    dismissReason: reason,
  };
}

/**
 * 创建外点手势关闭快照（支持 WeakRef 内存回收安全）
 */
export function createDismissedByPointerSnapshot(
  pointerId: number,
  layerId: string,
  anchor: HTMLElement | null,
  target: EventTarget | null,
  timestamp: number
): DismissedByPointerSnapshot {
  if (typeof WeakRef === 'undefined') {
    return { pointerId, layerId, anchor, target, timestamp };
  }
  const anchorWeak =
    anchor && typeof anchor === 'object' ? new WeakRef(anchor) : null;
  const targetWeak =
    target && typeof target === 'object' ? new WeakRef(target) : null;
  return {
    pointerId,
    layerId,
    timestamp,
    get anchor(): HTMLElement | null {
      return anchorWeak ? (anchorWeak.deref() ?? null) : null;
    },
    get target(): EventTarget | null {
      return targetWeak ? (targetWeak.deref() ?? null) : null;
    },
  };
}

/**
 * 递归判定 startId 是否为 ancestorId 的子孙层
 */
export function hasAncestor(
  layers: readonly LayerRegistration[],
  startId: string | undefined,
  ancestorId: string
): boolean {
  let id = startId;
  const seen = new Set<string>();
  while (id) {
    if (id === ancestorId) return true;
    if (seen.has(id)) break;
    seen.add(id);
    id = layers.find((l) => l.id === id)?.parentId;
  }
  return false;
}

/**
 * 查找需要被新入栈浮层驱逐的互斥同级浮层（dropdown/popover/context-menu）
 */
export function findExclusivePeersToDismiss(
  incoming: LayerRegistration,
  layers: readonly LayerRegistration[]
): string[] {
  if (!isExclusivePeerLayerType(incoming.type)) return [];
  const incomingAnchor = resolveElement(incoming.anchorRef);
  const incomingEl = resolveElement(incoming.elementRef);
  const toDismiss: string[] = [];

  for (const peer of layers) {
    if (peer.id === incoming.id || !isExclusivePeerLayerType(peer.type)) {
      continue;
    }
    if (incoming.parentId === peer.id || peer.parentId === incoming.id) {
      continue;
    }
    if (hasAncestor(layers, incoming.parentId, peer.id)) {
      continue;
    }

    const peerEl = resolveElement(peer.elementRef);
    if (
      peerEl &&
      ((incomingAnchor && peerEl.contains(incomingAnchor)) ||
        (incomingEl && peerEl.contains(incomingEl)))
    ) {
      continue;
    }
    toDismiss.push(peer.id);
  }
  return toDismiss;
}

/**
 * 当全屏模态层入栈时，自动驱逐背景中游离的非本模态子孙的非模态浮层（如残留的 Popover/Menu）
 */
export function reparentOrEvictBackgroundPopovers(
  modalLayer: LayerRegistration,
  layers: LayerRegistration[],
  dismissLayer: (id: string, reason: DismissReason) => void
): void {
  const modalEl = resolveElement(modalLayer.elementRef);
  for (const peer of layers.slice()) {
    if (
      isPopoverMenuLayer(peer.type) &&
      peer.dismissible &&
      peer.parentId !== modalLayer.id
    ) {
      const peerEl = resolveElement(peer.elementRef);
      const peerAnchor = resolveElement(peer.anchorRef);
      if (
        modalEl &&
        ((peerEl && modalEl.contains(peerEl)) ||
          (peerAnchor && modalEl.contains(peerAnchor)))
      ) {
        peer.parentId = modalLayer.id;
        continue;
      }
      dismissLayer(peer.id, 'programmatic');
    }
  }
}

export interface OutsidePointerScanResult {
  layersToDismiss: LayerRegistration[];
  hitAnchorTarget: Node | null;
}

/**
 * 扫描当前栈中因 pointerdown 外点命中需要退栈的浮层列表
 */
export function scanLayersForOutsidePointer(
  layers: readonly LayerRegistration[],
  target: Node,
  getDescendants: (layerId: string) => LayerRegistration[]
): OutsidePointerScanResult {
  const layersToDismiss: LayerRegistration[] = [];
  let hitAnchorTarget: Node | null = null;

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer || !layer.dismissible) continue;

    const topEl = resolveElement(layer.elementRef);
    if (topEl && topEl.contains(target)) continue;

    const anchorEl = resolveElement(layer.anchorRef);
    if (anchorEl && anchorEl.contains(target)) {
      hitAnchorTarget = target;
      continue;
    }

    const descendants = getDescendants(layer.id);
    const isInsideDescendants = descendants.some((child) => {
      const childEl = resolveElement(child.elementRef);
      return childEl && childEl.contains(target);
    });
    if (isInsideDescendants) continue;

    layersToDismiss.push(layer);
  }

  return { layersToDismiss, hitAnchorTarget };
}

/**
 * 检测在 Anchor 上按下后拖拽移出 release 的 Drag-off 目标浮层
 */
export function findDragOffLayer(
  layers: readonly LayerRegistration[],
  target: Node
): { layer: LayerRegistration; anchorEl: HTMLElement } | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l && l.dismissible && l.anchorRef) {
      const anchorEl = resolveElement(l.anchorRef);
      const topEl = resolveElement(l.elementRef);
      if (
        anchorEl &&
        !anchorEl.contains(target) &&
        (!topEl || !topEl.contains(target))
      ) {
        return { layer: l, anchorEl };
      }
    }
  }
  return null;
}

/**
 * 校验触发器点击是否为刚被同一手势外点关闭的 Anchor 反弹误触
 */
export function isAnchorTriggerMatch(
  snapshot: DismissedByPointerSnapshot,
  triggerEl: HTMLElement
): boolean {
  const anchor = snapshot.anchor;
  const target = snapshot.target;
  if (
    anchor &&
    anchor.isConnected &&
    (anchor === triggerEl ||
      anchor.contains(triggerEl) ||
      triggerEl.contains(anchor) ||
      (target instanceof Node && anchor.contains(target)))
  ) {
    return true;
  }
  return false;
}

/**
 * 同步 document.documentElement 与 document.body 的 data-floating-active 属性
 */
export function syncDocumentFloatingActive(isActive: boolean): void {
  if (typeof document === 'undefined') return;
  if (isActive) {
    document.documentElement.setAttribute('data-floating-active', 'true');
    document.body?.setAttribute('data-floating-active', 'true');
  } else {
    document.documentElement.removeAttribute('data-floating-active');
    document.body?.removeAttribute('data-floating-active');
  }
}

/**
 * 全局 DOM 事件批量挂载与卸载
 */
export function bindGlobalEvents(
  listeners: [string, EventListener][],
  action: 'add' | 'remove'
): void {
  const targets = [
    typeof window !== 'undefined' ? window : null,
    typeof document !== 'undefined' ? document : null,
  ];
  for (const target of targets) {
    if (!target) continue;
    for (const [evt, fn] of listeners) {
      if (action === 'add') target.addEventListener(evt, fn, true);
      else target.removeEventListener(evt, fn, true);
    }
  }
}

/**
 * Pointer 手势与防重入快照状态追踪器
 */
export class LayerStackPointerTracker {
  private anchorPointerDownTargetRef: WeakRef<Node> | null = null;
  private dismissedByPointer: DismissedByPointerSnapshot | null = null;

  public get anchorPointerDownTarget(): Node | null {
    if (!this.anchorPointerDownTargetRef) return null;
    return typeof WeakRef !== 'undefined'
      ? (this.anchorPointerDownTargetRef.deref() ?? null)
      : (this.anchorPointerDownTargetRef as any);
  }

  public set anchorPointerDownTarget(node: Node | null) {
    if (!node) {
      this.anchorPointerDownTargetRef = null;
    } else if (typeof WeakRef !== 'undefined') {
      this.anchorPointerDownTargetRef = new WeakRef(node);
    } else {
      this.anchorPointerDownTargetRef = node as any;
    }
  }

  public clear(): void {
    this.dismissedByPointer = null;
    this.anchorPointerDownTarget = null;
  }

  public wasLayerDismissedThisGesture(
    layerId: string,
    cooldownMs: number
  ): boolean {
    if (!this.dismissedByPointer) return false;
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.dismissedByPointer.timestamp > cooldownMs) {
      this.dismissedByPointer = null;
      return false;
    }
    return this.dismissedByPointer.layerId === layerId;
  }

  public wasTriggerClickAfterDismiss(
    triggerEl: HTMLElement | null,
    cooldownMs: number
  ): boolean {
    const rec = this.dismissedByPointer;
    if (!rec || !triggerEl) return false;

    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - rec.timestamp > cooldownMs) {
      this.dismissedByPointer = null;
      return false;
    }

    return isAnchorTriggerMatch(rec, triggerEl);
  }

  public handlePointerDown(
    event: PointerEvent,
    layers: readonly LayerRegistration[],
    getDescendants: (id: string) => LayerRegistration[],
    dismissLayer: (id: string, reason: DismissReason) => void
  ): void {
    if (PROCESSED_EVENTS.has(event)) return;
    PROCESSED_EVENTS.add(event);

    this.dismissedByPointer = null;
    const target = event.target as Node | null;
    if (!target) return;

    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { layersToDismiss, hitAnchorTarget } = scanLayersForOutsidePointer(
      layers,
      target,
      getDescendants
    );

    this.anchorPointerDownTarget = hitAnchorTarget;

    if (layersToDismiss.length > 0 && layersToDismiss[0]) {
      const topLayer = layersToDismiss[0];
      this.dismissedByPointer = createDismissedByPointerSnapshot(
        event.pointerId,
        topLayer.id,
        resolveElement(topLayer.anchorRef),
        target,
        now
      );

      for (const l of layersToDismiss) {
        if (l) dismissLayer(l.id, 'outside-pointer');
      }
    }
  }

  public handlePointerUp(
    event: PointerEvent,
    layers: readonly LayerRegistration[],
    dismissLayer: (id: string, reason: DismissReason) => void
  ): void {
    if (!this.anchorPointerDownTarget) return;
    const target = event.target as Node | null;
    if (!target) return;

    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const match = findDragOffLayer(layers, target);
    if (match) {
      this.dismissedByPointer = createDismissedByPointerSnapshot(
        event.pointerId,
        match.layer.id,
        match.anchorEl,
        target,
        now
      );
      dismissLayer(match.layer.id, 'outside-pointer');
      this.anchorPointerDownTarget = null;
      return;
    }
    this.anchorPointerDownTarget = null;
  }
}
