/**
 * apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts
 *
 * 浮层调度中枢单核状态机 (LayerStackManager)
 *
 * 核心职能：
 * 1. 单核调度栈 (Single-Source Layer Stack)：管理所有浮层的拓扑与 LIFO 倒序退栈；
 * 2. 50ms 冷却防重入锁状态机 (Anti-Reentry Cooldown Lock)：消除双击/连击触发器导致的震荡重新打开；
 * 3. Tooltip 全局静默互斥协议 (Mutex Protocol)：动态广播 data-floating-active 与 150ms 焦点静默窗口；
 * 4. Branch-Aware 外点判定与 LIFO 焦点平滑还原。
 */
import { useSyncExternalStore } from 'react';
import type {
  DismissReason,
  LayerRegistration,
  LayerTraceRecord,
  LayerTier,
} from './layerStackTypes';
import {
  LAYER_TYPE_PRIORITY,
  isExclusivePeerLayerType,
  getLayerTier,
  isModalLayer,
} from './layerStackTypes';
import { restoreLayerFocus } from './layerFocusRestore';
import { LayerStackListeners } from './layerStackListeners';
import { handleLayerStackKeyDown } from './layerStackKeydown';
import {
  createLayerEntry,
  createTraceRecord,
  findExclusivePeersToDismiss,
  reparentOrEvictBackgroundPopovers,
  syncDocumentFloatingActive,
  bindGlobalEvents,
  LayerStackPointerTracker,
} from './layerStackDom';

// 拆分自本文件的子模块 re-export，保证消费方 import 路径不变
export type { StackListener } from './layerStackListeners';
export type {
  DismissReason,
  LayerType,
  LayerTier,
  LayerRegistration,
  LayerTraceRecord,
  DismissedByPointerSnapshot,
} from './layerStackTypes';
export {
  LAYER_TYPE_PRIORITY,
  LAYER_TIER_MAP,
  LAYER_TIER_PRIORITY,
  getLayerTier,
  isModalLayer,
  isPopoverMenuLayer,
  isOverlayToastLayer,
} from './layerStackTypes';
export {
  LayerContext,
  LayerProvider,
  useLayerContext,
  type LayerContextValue,
  type LayerProviderProps,
} from './LayerContext';
export { isCjkImeEvent, ESC_DEBOUNCE_WINDOW_MS } from './layerStackKeydown';

const getNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class LayerStackManager {
  private static instance: LayerStackManager | null = null;
  private static readonly MAX_TRACE_HISTORY = 100;
  private static readonly COOLDOWN_WINDOW_MS = 100;
  public static readonly UNHOOK_TIMEOUT_MS = 100;

  private layers: LayerRegistration[] = [];
  private traceHistory: LayerTraceRecord[] = [];
  private readonly stackListeners = new LayerStackListeners();
  private readonly pointerTracker = new LayerStackPointerTracker();
  private isListening = false;
  private sequence = 0;
  private lastCloseTimestamp = 0;
  private lastEscapeDismissTime = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private unhookTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {
    this.attachGlobalListeners();
  }

  public static getInstance(): LayerStackManager {
    if (!LayerStackManager.instance) {
      LayerStackManager.instance = new LayerStackManager();
    }
    return LayerStackManager.instance;
  }

  public register(layer: Omit<LayerRegistration, 'mountedAt'>): () => void {
    if (this.unhookTimer) {
      clearTimeout(this.unhookTimer);
      this.unhookTimer = null;
    }
    this.attachGlobalListeners();

    const fullLayer = createLayerEntry(layer, ++this.sequence);
    const tier = fullLayer.tier ?? getLayerTier(fullLayer.type);

    this.layers = this.layers.filter((l) => l.id !== fullLayer.id);
    this.evictExclusivePeers(fullLayer);

    if (fullLayer.modal || tier === 'modal' || isModalLayer(fullLayer.type)) {
      reparentOrEvictBackgroundPopovers(fullLayer, this.layers, (peerId) => {
        this.dismissLayer(peerId, 'programmatic');
      });
    }

    this.layers.push(fullLayer);
    this.layers.sort((a, b) => {
      const pA = LAYER_TYPE_PRIORITY[a.type] ?? 0;
      const pB = LAYER_TYPE_PRIORITY[b.type] ?? 0;
      return pA !== pB ? pA - pB : a.mountedAt - b.mountedAt;
    });

    this.updateFloatingActiveState();
    this.stackListeners.notify();

    return () => {
      this.unregister(fullLayer.id, 'programmatic');
    };
  }

  public subscribe(listener: () => void): () => void {
    return this.stackListeners.subscribe(listener);
  }

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

  public unregister(
    layerId: string,
    reason: DismissReason = 'programmatic'
  ): void {
    const target = this.layers.find((l) => l.id === layerId);
    if (target) this.recordTrace(target, reason);

    this.layers = this.layers.filter((l) => l.id !== layerId);

    for (const layer of this.layers) {
      if (layer.parentId === layerId) layer.parentId = undefined;
    }

    this.updateFloatingActiveState();
    if (target) this.stackListeners.notify();
    if (this.layers.length === 0) this.scheduleUnhookTimeout();
  }

  public wasLayerDismissedThisGesture(layerId: string): boolean {
    return this.pointerTracker.wasLayerDismissedThisGesture(
      layerId,
      LayerStackManager.COOLDOWN_WINDOW_MS
    );
  }

  public wasTriggerClickAfterDismiss(triggerEl: HTMLElement | null): boolean {
    return this.pointerTracker.wasTriggerClickAfterDismiss(
      triggerEl,
      LayerStackManager.COOLDOWN_WINDOW_MS
    );
  }

  public isWithinCooldown(
    cooldownMs = LayerStackManager.COOLDOWN_WINDOW_MS
  ): boolean {
    return getNow() - this.lastCloseTimestamp < cooldownMs;
  }

  public markCloseTimestamp(): void {
    this.lastCloseTimestamp = getNow();
  }

  public isTooltipSilenced(): boolean {
    return this.hasActiveFloatingLayers() || this.silenceTimer !== null;
  }

  public hasActiveFloatingLayers(): boolean {
    return this.layers.some((l) => l.type !== 'tooltip' && l.type !== 'toast');
  }

  public getTopLayer(): LayerRegistration | undefined {
    return this.layers.length === 0
      ? undefined
      : this.layers[this.layers.length - 1];
  }

  public getLayers(): readonly LayerRegistration[] {
    return this.layers;
  }

  public hasActiveModal(): boolean {
    return this.layers.some(
      (l) => l.modal || l.tier === 'modal' || isModalLayer(l.type)
    );
  }

  public getLayersByTier(tier: LayerTier): readonly LayerRegistration[] {
    return this.layers.filter((l) => (l.tier ?? getLayerTier(l.type)) === tier);
  }

  public hasActiveLayerOfTier(tier: LayerTier): boolean {
    return this.layers.some((l) => (l.tier ?? getLayerTier(l.type)) === tier);
  }

  public getTopLayerOfTier(tier: LayerTier): LayerRegistration | undefined {
    const tierLayers = this.getLayersByTier(tier);
    return tierLayers[tierLayers.length - 1];
  }

  public getDescendants(layerId: string): LayerRegistration[] {
    const results: LayerRegistration[] = [];
    const directChildren = this.layers.filter((l) => l.parentId === layerId);
    for (const child of directChildren) {
      results.push(child);
      results.push(...this.getDescendants(child.id));
    }
    return results;
  }

  private evictExclusivePeers(incoming: LayerRegistration): void {
    const toDismiss = findExclusivePeersToDismiss(incoming, this.layers);
    for (const peerId of toDismiss) {
      this.dismissLayer(peerId, 'programmatic');
    }
  }

  public evictExclusivePeersForId(incomingId: string): void {
    for (const peer of this.layers.slice()) {
      if (peer.id !== incomingId && isExclusivePeerLayerType(peer.type)) {
        this.dismissLayer(peer.id, 'programmatic');
      }
    }
  }

  public dismissTop(reason: DismissReason): boolean {
    const top = [...this.layers]
      .reverse()
      .find((l) => l.dismissible && l.type !== 'toast' && l.type !== 'tooltip');
    if (!top || !top.dismissible) return false;
    this.dismissLayer(top.id, reason);
    return true;
  }

  public dismissAll(reason: DismissReason = 'programmatic'): void {
    this.markCloseTimestamp();
    this.scheduleUnhookTimeout();
    for (const layer of [...this.layers].reverse()) {
      if (!layer || !layer.dismissible) continue;
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

  public dismissLayer(layerId: string, reason: DismissReason): void {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer) return;

    this.markCloseTimestamp();
    this.scheduleUnhookTimeout();

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

    if (reason === 'escape') {
      this.lastEscapeDismissTime = Date.now();
    }

    try {
      layer.onDismiss(reason);
    } catch (err) {
      console.error('[LayerStackManager] Error in layer onDismiss:', err);
    }
    this.recordTrace(layer, reason);
    this.unregister(layer.id, reason);

    if (reason === 'escape' || reason === 'item-select') {
      restoreLayerFocus(layer, () => this.layers);
    }
  }

  private updateFloatingActiveState(): void {
    if (typeof document === 'undefined') return;

    if (this.hasActiveFloatingLayers()) {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      syncDocumentFloatingActive(true);
    } else {
      syncDocumentFloatingActive(false);
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
      }, 150);
    }
  }

  private recordTrace(layer: LayerRegistration, reason: DismissReason): void {
    this.traceHistory.push(createTraceRecord(layer, reason));
    if (this.traceHistory.length > LayerStackManager.MAX_TRACE_HISTORY) {
      this.traceHistory.shift();
    }
  }

  public getTraceHistory(): readonly LayerTraceRecord[] {
    return this.traceHistory;
  }

  public clearTraceHistory(): void {
    this.traceHistory = [];
  }

  private scheduleUnhookTimeout(): void {
    if (this.unhookTimer) {
      clearTimeout(this.unhookTimer);
      this.unhookTimer = null;
    }
    this.unhookTimer = setTimeout(() => {
      this.unhookTimer = null;
      this.pointerTracker.clear();
      if (this.layers.length === 0) {
        this.detachGlobalListeners();
      }
    }, LayerStackManager.UNHOOK_TIMEOUT_MS);
  }

  private attachGlobalListeners(): void {
    if (
      this.isListening ||
      typeof window === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return;
    }

    bindGlobalEvents(this.globalEventListeners, 'add');
    this.isListening = true;
  }

  private detachGlobalListeners(): void {
    if (!this.isListening) return;
    bindGlobalEvents(this.globalEventListeners, 'remove');
    this.isListening = false;
  }

  public get isListeningGlobalEvents(): boolean {
    return this.isListening;
  }

  public hasActiveUnhookTimer(): boolean {
    return this.unhookTimer !== null;
  }

  private handleGlobalKeyDown = (event: KeyboardEvent): void => {
    handleLayerStackKeyDown(event, {
      getLayers: () => this.layers,
      dismissLayer: (id, reason) => this.dismissLayer(id, reason),
      getLastEscapeDismissTime: () => this.lastEscapeDismissTime,
    });
  };

  private handleGlobalPointerDown = (event: PointerEvent): void => {
    this.pointerTracker.handlePointerDown(
      event,
      this.layers,
      (id) => this.getDescendants(id),
      (id, reason) => this.dismissLayer(id, reason)
    );
  };

  private handleGlobalPointerUp = (event: PointerEvent): void => {
    this.pointerTracker.handlePointerUp(event, this.layers, (id, reason) =>
      this.dismissLayer(id, reason)
    );
  };

  private get globalEventListeners(): [string, EventListener][] {
    return [
      ['keydown', this.handleGlobalKeyDown as EventListener],
      ['pointerdown', this.handleGlobalPointerDown as EventListener],
      ['pointerup', this.handleGlobalPointerUp as EventListener],
    ];
  }

  public dispose(): void {
    if (this.unhookTimer) {
      clearTimeout(this.unhookTimer);
      this.unhookTimer = null;
    }
    this.detachGlobalListeners();
    syncDocumentFloatingActive(false);
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.layers = [];
    this.traceHistory = [];
    this.lastEscapeDismissTime = 0;
    this.lastCloseTimestamp = 0;
    this.pointerTracker.clear();
    this.sequence = 0;
  }
}

export const layerStackManager = LayerStackManager.getInstance();

export { LayerStackManager as LayerStackService };
export const layerStackService = layerStackManager;

export function useIsModalActive(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => layerStackManager.subscribe(onStoreChange),
    () => layerStackManager.hasActiveModal(),
    () => false
  );
}

export const useLayerStackModalActive = useIsModalActive;

export function useFloatingActive(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => layerStackManager.subscribe(onStoreChange),
    () => layerStackManager.hasActiveFloatingLayers(),
    () => false
  );
}
