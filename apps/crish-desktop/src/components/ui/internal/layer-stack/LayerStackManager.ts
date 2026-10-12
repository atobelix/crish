/**
 * apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts
 *
 * 浮层调度中枢单核状态机 (LayerStackManager)
 *
 * 核心职能：
 * 1. 单核调度栈 (Single-Source Layer Stack)：管理所有浮层的拓扑与 LIFO 倒序退栈；
 * 2. 50ms 冷却防重入锁状态机 (Anti-Reentry Cooldown Lock)：消除双击/连击触发器导致的震荡重新打开；
 * 3. Tooltip 全局静默互斥协议 (Mutex Protocol)：动态广播 data-floating-active 与 150ms 焦点静默窗口；
 * 4. CJK IME 中文输入法 229 / Process / isComposing 绝对放行门闩；
 * 5. Branch-Aware 外点判定与 LIFO 焦点平滑还原。
 */
import type React from 'react';
import type {
  DismissReason as BaseDismissReason,
  LayerRegistration,
  LayerTraceRecord,
  DismissedByPointerSnapshot,
} from './layerStackTypes';
import {
  LAYER_TYPE_PRIORITY,
  PROCESSED_EVENTS,
  isExclusivePeerLayerType,
  resolveElement,
} from './layerStackTypes';
import { restoreLayerFocus } from './layerFocusRestore';
import { LayerStackListeners } from './layerStackListeners';

// 拆分自本文件的子模块 re-export，保证消费方 import 路径不变
export type { StackListener } from './layerStackListeners';
export type {
  LayerType,
  LayerRegistration,
  LayerTraceRecord,
  DismissedByPointerSnapshot,
} from './layerStackTypes';

export type DismissReason = BaseDismissReason | 'interaction';

const getNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

function toWeakRefObject(
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

function createDismissedByPointerSnapshot(
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

export class LayerStackManager {
  private static instance: LayerStackManager | null = null;
  private static readonly MAX_TRACE_HISTORY = 100;
  private static readonly COOLDOWN_WINDOW_MS = 100;
  public static readonly UNHOOK_TIMEOUT_MS = 100;

  private layers: LayerRegistration[] = [];
  private traceHistory: LayerTraceRecord[] = [];
  /** 栈变化订阅者（如原生贴靠热区：模态打开时须撤下，避免穿透遮罩） */
  private readonly stackListeners = new LayerStackListeners();
  private isListening = false;
  private sequence = 0;
  private lastCloseTimestamp = 0;
  private lastEscapeDismissTime = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private unhookTimer: ReturnType<typeof setTimeout> | null = null;
  private anchorPointerDownTargetRef: WeakRef<Node> | null = null;
  /** 本次 pointerdown 外点关掉的层与触发手势快照；附带时间戳确保 100ms 时效性 */
  private dismissedByPointer: DismissedByPointerSnapshot | null = null;

  private get anchorPointerDownTarget(): Node | null {
    if (!this.anchorPointerDownTargetRef) return null;
    return typeof WeakRef !== 'undefined'
      ? (this.anchorPointerDownTargetRef.deref() ?? null)
      : (this.anchorPointerDownTargetRef as any);
  }

  private set anchorPointerDownTarget(node: Node | null) {
    if (!node) {
      this.anchorPointerDownTargetRef = null;
    } else if (typeof WeakRef !== 'undefined') {
      this.anchorPointerDownTargetRef = new WeakRef(node);
    } else {
      this.anchorPointerDownTargetRef = node as any;
    }
  }

  private constructor() {
    this.attachGlobalListeners();
  }

  /**
   * 获取全局单例实例
   */
  public static getInstance(): LayerStackManager {
    if (!LayerStackManager.instance) {
      LayerStackManager.instance = new LayerStackManager();
    }
    return LayerStackManager.instance;
  }

  /**
   * 注册浮层实例，返回注销函数
   */
  public register(layer: Omit<LayerRegistration, 'mountedAt'>): () => void {
    if (this.unhookTimer) {
      clearTimeout(this.unhookTimer);
      this.unhookTimer = null;
    }
    this.attachGlobalListeners();

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

    const fullLayer: LayerRegistration = {
      ...layer,
      elementRef,
      anchorRef,
      mountedAt: ++this.sequence,
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

    // 避免重复 ID 污染
    this.layers = this.layers.filter((l) => l.id !== fullLayer.id);
    this.evictExclusivePeers(fullLayer);
    this.layers.push(fullLayer);

    // 按层级权重稳定排序（相同权重保持 mountedAt 注册入栈顺序）
    this.layers.sort((a, b) => {
      const pA = LAYER_TYPE_PRIORITY[a.type] ?? 0;
      const pB = LAYER_TYPE_PRIORITY[b.type] ?? 0;
      if (pA !== pB) return pA - pB;
      return a.mountedAt - b.mountedAt;
    });

    this.updateFloatingActiveState();
    this.stackListeners.notify();

    return () => {
      this.unregister(fullLayer.id, 'programmatic');
    };
  }

  /**
   * 订阅浮层栈变化（入栈 / 出栈后同步回调）。返回退订函数。
   * 供 DOM 之外、无法被遮罩覆盖的表面（原生子窗口）据 hasActiveModal() 自行让位。
   */
  public subscribe(listener: () => void): () => void {
    return this.stackListeners.subscribe(listener);
  }

  /**
   * 注册临时虚拟拦截器（如快捷键录制态、分屏拖拽态）
   */
  public registerVirtual(
    id: string,
    onEscape: (e: KeyboardEvent) => boolean | void,
    onDismiss?: (reason: DismissReason) => void
  ): () => void {
    return this.register({
      id,
      type: 'virtual-interceptor',
      dismissible: true,
      onDismiss: onDismiss ?? (() => {}),
      onEscapeKeyDown: onEscape,
    });
  }

  /**
   * 注销浮层（并解除孤儿节点的父级指针引用）
   */
  public unregister(
    layerId: string,
    reason: DismissReason = 'programmatic'
  ): void {
    const target = this.layers.find((l) => l.id === layerId);
    if (target) {
      this.recordTrace(target, reason);
    }

    this.layers = this.layers.filter((l) => l.id !== layerId);

    // 解除将已销毁 Layer 作为 parentId 的孤儿节点指针，防止悬空引用
    for (const layer of this.layers) {
      if (layer.parentId === layerId) {
        layer.parentId = undefined;
      }
    }

    this.updateFloatingActiveState();
    if (target) this.stackListeners.notify();

    if (this.layers.length === 0) {
      this.scheduleUnhookTimeout();
    }
  }

  /**
   * 本层刚被同一 pointer 外点关掉：后续 onOpenChange(true) 必须吞掉
   */
  public wasLayerDismissedThisGesture(layerId: string): boolean {
    if (!this.dismissedByPointer) return false;
    const now = getNow();
    if (
      now - this.dismissedByPointer.timestamp >
      LayerStackManager.COOLDOWN_WINDOW_MS
    ) {
      this.dismissedByPointer = null;
      return false;
    }
    return this.dismissedByPointer.layerId === layerId;
  }

  /**
   * 外点已关后同一 pointer 落到该 trigger：不得再 toggle 开。
   * 严格模式：仅当被关层具有真实 anchor 且匹配 triggerEl 时才拦截；彻底放行其它按钮！
   */
  public wasTriggerClickAfterDismiss(triggerEl: HTMLElement | null): boolean {
    const rec = this.dismissedByPointer;
    if (!rec || !triggerEl) return false;

    const now = getNow();
    if (now - rec.timestamp > LayerStackManager.COOLDOWN_WINDOW_MS) {
      this.dismissedByPointer = null;
      return false;
    }

    // 只有明确匹配被关层的 anchor 时，才确认为同一 Trigger 反弹误触
    const anchor = rec.anchor;
    const target = rec.target;
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
   * 100ms 黄金防重入冷却检测
   * 当触发器在 100ms 内接收到连续点击时，判定为重入竞态并静默丢弃
   */
  public isWithinCooldown(
    cooldownMs = LayerStackManager.COOLDOWN_WINDOW_MS
  ): boolean {
    return getNow() - this.lastCloseTimestamp < cooldownMs;
  }

  /**
   * 显式标记关闭高精度时间戳
   */
  public markCloseTimestamp(): void {
    this.lastCloseTimestamp = getNow();
  }

  /**
   * 检查是否处于 Tooltip 静默态
   */
  public isTooltipSilenced(): boolean {
    return this.hasActiveFloatingLayers() || this.silenceTimer !== null;
  }

  /**
   * 检查是否存在活跃的非 Tooltip / 非 Toast 浮层
   */
  public hasActiveFloatingLayers(): boolean {
    return this.layers.some((l) => l.type !== 'tooltip' && l.type !== 'toast');
  }

  /**
   * 获取当前处于活跃状态的最顶层 Layer
   */
  public getTopLayer(): LayerRegistration | undefined {
    if (this.layers.length === 0) return undefined;
    return this.layers[this.layers.length - 1];
  }

  /**
   * 获取所有已注册浮层（按入栈顺序）
   */
  public getLayers(): readonly LayerRegistration[] {
    return this.layers;
  }

  /**
   * 判断是否存在活跃的模态浮层（用于全局快捷键守卫）
   */
  public hasActiveModal(): boolean {
    return this.layers.some(
      (l) => l.modal || l.type === 'modal-dialog' || l.type === 'confirm-dialog'
    );
  }

  /**
   * 获取指定 Layer 的所有直接与间接子孙浮层
   */
  public getDescendants(layerId: string): LayerRegistration[] {
    const results: LayerRegistration[] = [];
    const directChildren = this.layers.filter((l) => l.parentId === layerId);

    for (const child of directChildren) {
      results.push(child);
      results.push(...this.getDescendants(child.id));
    }

    return results;
  }

  /**
   * 登记 dropdown/context-menu 时驱逐同级，子菜单（锚点在已开层内）保留。
   */
  private evictExclusivePeers(incoming: LayerRegistration): void {
    if (!isExclusivePeerLayerType(incoming.type)) return;
    const incomingAnchor = resolveElement(incoming.anchorRef);
    const incomingEl = resolveElement(incoming.elementRef);

    for (const peer of this.layers.slice()) {
      if (peer.id === incoming.id || !isExclusivePeerLayerType(peer.type))
        continue;
      if (incoming.parentId === peer.id || peer.parentId === incoming.id)
        continue;
      if (this.hasAncestor(incoming.parentId, peer.id)) continue;

      const peerEl = resolveElement(peer.elementRef);
      if (
        peerEl &&
        ((incomingAnchor && peerEl.contains(incomingAnchor)) ||
          (incomingEl && peerEl.contains(incomingEl)))
      ) {
        continue;
      }
      this.dismissLayer(peer.id, 'programmatic');
    }
  }

  /**
   * 主动驱逐指定 ID 之外的所有同级互斥浮层（dropdown-menu, popover, context-menu）
   */
  public evictExclusivePeersForId(incomingId: string): void {
    for (const peer of this.layers.slice()) {
      if (peer.id !== incomingId && isExclusivePeerLayerType(peer.type)) {
        this.dismissLayer(peer.id, 'programmatic');
      }
    }
  }

  private hasAncestor(
    startId: string | undefined,
    ancestorId: string
  ): boolean {
    let id = startId;
    const seen = new Set<string>();
    while (id) {
      if (id === ancestorId) return true;
      if (seen.has(id)) break;
      seen.add(id);
      id = this.layers.find((l) => l.id === id)?.parentId;
    }
    return false;
  }

  /**
   * 主动关闭顶层浮层（过滤 toast/tooltip 等非模态常驻通知）
   */
  public dismissTop(reason: DismissReason): boolean {
    const top = [...this.layers]
      .reverse()
      .find((l) => l.dismissible && l.type !== 'toast' && l.type !== 'tooltip');
    if (!top || !top.dismissible) return false;

    this.dismissLayer(top.id, reason);
    return true;
  }

  /**
   * 关闭所有可退栈浮层。
   * 支持 reason = 'interaction'（例如分屏拖拽/窗口重置等全局交互开始时），
   * 安全、即时地仅关闭所有非模态（non-modal）的可关闭悬浮层（如 Tooltip、Menu、Popover），保留模态弹窗。
   */
  public dismissAll(reason: DismissReason = 'programmatic'): void {
    this.markCloseTimestamp();
    this.scheduleUnhookTimeout();
    const toDismiss = [...this.layers].reverse();
    for (const layer of toDismiss) {
      if (layer && layer.dismissible) {
        if (
          reason === 'interaction' &&
          (layer.modal ||
            layer.type === 'modal-dialog' ||
            layer.type === 'confirm-dialog')
        ) {
          continue;
        }
        this.dismissLayer(layer.id, reason);
      }
    }
  }

  /**
   * 关闭指定浮层及其所有子孙浮层，记录 Trace 审计，并还原焦点
   */
  public dismissLayer(layerId: string, reason: DismissReason): void {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer) return;

    this.markCloseTimestamp();
    this.scheduleUnhookTimeout();

    // 1. 级联关闭所有子孙浮层
    const descendants = this.getDescendants(layerId);
    for (let i = descendants.length - 1; i >= 0; i--) {
      const child = descendants[i];
      if (child && child.dismissible) {
        try {
          child.onDismiss('parent-dismissed');
        } catch (err) {
          console.error('[LayerStackManager] Error in cascade dismiss:', err);
        }
        this.recordTrace(child, 'parent-dismissed');
        this.unregister(child.id, 'parent-dismissed');
      }
    }

    // 2. 关闭自身并记录 Trace 审计
    if (reason === 'escape') {
      this.lastEscapeDismissTime = Date.now();
    }

    try {
      layer.onDismiss(reason as any);
    } catch (err) {
      console.error('[LayerStackManager] Error in layer onDismiss:', err);
    }
    this.recordTrace(layer, reason);
    this.unregister(layer.id, reason);

    // 3. 焦点平滑还原（仅 Esc 与选中项操作还原焦点；外点交互尊重用户外部聚焦目标）
    if (reason === 'escape' || reason === 'item-select') {
      restoreLayerFocus(layer, () => this.layers);
    }
  }

  /**
   * 更新 DOM document.body data-floating-active 属性与静默计时器
   */
  private updateFloatingActiveState(): void {
    if (typeof document === 'undefined') return;

    if (this.hasActiveFloatingLayers()) {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      document.documentElement.setAttribute('data-floating-active', 'true');
      document.body?.setAttribute('data-floating-active', 'true');
    } else {
      document.documentElement.removeAttribute('data-floating-active');
      document.body?.removeAttribute('data-floating-active');
      // 启动 150ms 静默窗口，彻底吞掉焦点还原引起的闪烁
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
      }, 150);
    }
  }

  /**
   * 记录生命周期 Trace 审计
   */
  private recordTrace(layer: LayerRegistration, reason: DismissReason): void {
    this.traceHistory.push({
      id: layer.id,
      type: layer.type,
      parentId: layer.parentId,
      mountedAt: layer.mountedAt,
      dismissedAt: Date.now(),
      dismissReason: reason,
    });
    if (this.traceHistory.length > LayerStackManager.MAX_TRACE_HISTORY) {
      this.traceHistory.shift();
    }
  }

  /**
   * 获取生命周期 Trace 审计历史
   */
  public getTraceHistory(): readonly LayerTraceRecord[] {
    return this.traceHistory;
  }

  /**
   * 清空 Trace 审计历史
   */
  public clearTraceHistory(): void {
    this.traceHistory = [];
  }

  /**
   * 兜底清理保护：当触发 dismiss 时设置 100ms unhook 超时，确保彻底注销事件监听与引用
   */
  private scheduleUnhookTimeout(): void {
    if (this.unhookTimer) {
      clearTimeout(this.unhookTimer);
      this.unhookTimer = null;
    }
    this.unhookTimer = setTimeout(() => {
      this.unhookTimer = null;
      this.dismissedByPointer = null;
      this.anchorPointerDownTarget = null;
      if (this.layers.length === 0) {
        this.detachGlobalListeners();
      }
    }, LayerStackManager.UNHOOK_TIMEOUT_MS);
  }

  /**
   * 绑定全局单一监听器
   */
  private attachGlobalListeners(): void {
    if (
      this.isListening ||
      typeof window === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return;
    }

    const evs: [string, EventListener][] = [
      ['keydown', this.handleGlobalKeyDown as EventListener],
      ['pointerdown', this.handleGlobalPointerDown as EventListener],
      ['pointerup', this.handleGlobalPointerUp as EventListener],
    ];
    for (const target of [window, document]) {
      for (const [e, fn] of evs) target.addEventListener(e, fn, true);
    }
    this.isListening = true;
  }

  /**
   * 注销全局事件监听器
   */
  private detachGlobalListeners(): void {
    if (!this.isListening) return;
    const evs: [string, EventListener][] = [
      ['keydown', this.handleGlobalKeyDown as EventListener],
      ['pointerdown', this.handleGlobalPointerDown as EventListener],
      ['pointerup', this.handleGlobalPointerUp as EventListener],
    ];
    if (typeof window !== 'undefined') {
      for (const [e, fn] of evs) window.removeEventListener(e, fn, true);
    }
    if (typeof document !== 'undefined') {
      for (const [e, fn] of evs) document.removeEventListener(e, fn, true);
    }
    this.isListening = false;
  }

  public get isListeningGlobalEvents(): boolean {
    return this.isListening;
  }

  public hasActiveUnhookTimer(): boolean {
    return this.unhookTimer !== null;
  }

  /**
   * 全局单一 Keydown 调度处理器（自顶向下寻找首个响应者，根除 dismissible:false 调度死锁）
   */
  private handleGlobalKeyDown = (event: KeyboardEvent): void => {
    if (PROCESSED_EVENTS.has(event)) return;
    PROCESSED_EVENTS.add(event);

    // 1. 守卫 CJK IME 输入法合成态（isComposing / keyCode 229 / Process / nativeEvent.isComposing）
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === 'Process' ||
      (event as KeyboardEvent & { nativeEvent?: { isComposing?: boolean } })
        .nativeEvent?.isComposing
    ) {
      return; // 绝不拦截、绝不消费，保护输入法中文候选框选词
    }

    if (event.key !== 'Escape') return;

    // 同帧/短时间防抖（50ms 内快速双击 Esc 时，逐帧退栈，绝不一击穿透全部关闭）
    const now = Date.now();
    if (
      this.lastEscapeDismissTime &&
      now >= this.lastEscapeDismissTime &&
      now - this.lastEscapeDismissTime < 50
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.layers.length === 0) {
      return;
    }

    // 2. 自顶向下倒序寻找首个能够消费或退栈的活跃 Layer (Top-down First Responder Search)
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer) continue;

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
        this.dismissLayer(layer.id, 'escape');
        return; // 成功关闭顶层可退栈浮层，终止传递
      }

      // C. 若当前层是阻断型模态层（modal: true），但明确禁止 dismissible，按模态语义阻断 Esc 击穿
      if (layer.modal) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  };

  /**
   * 全局单一 PointerDown 调度处理器（级联清退所有外部可退栈浮层）
   */
  private handleGlobalPointerDown = (event: PointerEvent): void => {
    if (PROCESSED_EVENTS.has(event)) return;
    PROCESSED_EVENTS.add(event);

    this.dismissedByPointer = null;

    const target = event.target as Node | null;
    if (!target) return;

    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    const layersToDismiss: LayerRegistration[] = [];
    let hitAnchorTarget: Node | null = null;

    // 倒序扫描所有已注册浮层
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer || !layer.dismissible) continue;

      // 1. 检查点击是否位于容器内部
      const topEl = resolveElement(layer.elementRef);
      if (topEl && topEl.contains(target)) {
        continue; // 内部点击，保留
      }

      // 2. 检查点击是否位于关联的 Anchor / Trigger 触发源内部
      const anchorEl = resolveElement(layer.anchorRef);
      if (anchorEl && anchorEl.contains(target)) {
        hitAnchorTarget = target;
        continue; // 命中自身 Trigger，交给 Trigger 的 toggle 逻辑
      }

      // 3. 检查点击是否位于任何子孙 Branch 浮层内部
      const descendants = this.getDescendants(layer.id);
      const isInsideDescendants = descendants.some((child) => {
        const childEl = resolveElement(child.elementRef);
        return childEl && childEl.contains(target);
      });
      if (isInsideDescendants) {
        continue;
      }

      // 4. 确认属于外部点击，加入退栈队列
      layersToDismiss.push(layer);
    }

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

      // 依次级联退栈关闭所有外部浮层
      for (const l of layersToDismiss) {
        if (l) {
          this.dismissLayer(l.id, 'outside-pointer');
        }
      }
    }
  };

  /**
   * 全局单一 Pointerup 调度处理器（处理在 Anchor 上按下后拖拽移出 release 的 Drag-off 语义）
   */
  private handleGlobalPointerUp = (event: PointerEvent): void => {
    if (!this.anchorPointerDownTarget) return;
    const target = event.target as Node | null;
    if (!target) return;

    const now = getNow();

    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (l && l.dismissible && l.anchorRef) {
        const anchorEl = resolveElement(l.anchorRef);
        const topEl = resolveElement(l.elementRef);
        if (
          anchorEl &&
          !anchorEl.contains(target) &&
          (!topEl || !topEl.contains(target))
        ) {
          this.dismissedByPointer = createDismissedByPointerSnapshot(
            event.pointerId,
            l.id,
            anchorEl,
            target,
            now
          );
          this.dismissLayer(l.id, 'outside-pointer');
          this.anchorPointerDownTarget = null;
          return;
        }
      }
    }
    this.anchorPointerDownTarget = null;
  };

  /**
   * 销毁并清理全局监听（供热更新与测试使用）
   */
  public dispose(): void {
    if (this.unhookTimer) {
      clearTimeout(this.unhookTimer);
      this.unhookTimer = null;
    }
    this.detachGlobalListeners();
    if (typeof document !== 'undefined') {
      document.documentElement?.removeAttribute('data-floating-active');
      document.body?.removeAttribute('data-floating-active');
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.layers = [];
    this.traceHistory = [];
    this.lastEscapeDismissTime = 0;
    this.lastCloseTimestamp = 0;
    this.anchorPointerDownTarget = null;
    this.dismissedByPointer = null;
    this.sequence = 0;
  }
}

export const layerStackManager = LayerStackManager.getInstance();

// 兼容别名导出
export { LayerStackManager as LayerStackService };
export const layerStackService = layerStackManager;
