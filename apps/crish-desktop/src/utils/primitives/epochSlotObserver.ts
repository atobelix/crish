/**
 * EpochSlotObserver — 全系统确定性物理原语 3：32 位整型标量代数槽位与 ResizeObserverManager 桥接订阅器
 *
 * 物理不变量：
 * 1. EpochSlot<T>: 维护 32 位有符号整型递增代数 (epoch = (epoch + 1) | 0)，直通 React useSyncExternalStore；
 * 2. 支持按目标值精准分桶订阅 (subscribeKey)，悬停/选中状态切换时严格仅唤醒旧值与新值 <= 2 个订阅者；
 * 3. EpochSlotObserver: 100% 复用全局单例 ResizeObserverManager.getInstance()（严守 G-03 门禁），
 *    将 DOM 尺寸变化转化为 32 位整型标量代数递增，元素卸载时自动解绑释放引用。
 */
import {
  ResizeObserverManager,
  type ResizeCallback,
  type ResizeObserveOptions,
} from '../ResizeObserverManager';

export class EpochSlot<T> {
  private value: T;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  private readonly keyListeners = new Map<T, Set<() => void>>();

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  /**
   * 返回当前 32 位整型版本代数（供 useSyncExternalStore getSnapshot 使用）
   */
  public getSnapshot = (): number => {
    return this.epoch;
  };

  /**
   * 获取槽位当前存储的值
   */
  public getValue = (): T => {
    return this.value;
  };

  /**
   * 更新槽位值：当且仅当 !Object.is(prev, next) 时执行 32 位整型代数递增并触发精准广播
   */
  public setValue(nextValueOrUpdater: T | ((prev: T) => T)): boolean {
    const nextValue =
      typeof nextValueOrUpdater === 'function'
        ? (nextValueOrUpdater as (prev: T) => T)(this.value)
        : nextValueOrUpdater;

    if (Object.is(this.value, nextValue)) {
      return false;
    }

    const prevValue = this.value;
    this.value = nextValue;
    this.epoch = (this.epoch + 1) | 0;

    // 1. 唤醒精准匹配旧值与新值的分桶订阅者（O(1) 复杂度，最多唤醒 2 个桶）
    const prevBucket = this.keyListeners.get(prevValue);
    if (prevBucket) {
      for (const listener of Array.from(prevBucket)) {
        listener();
      }
    }
    const nextBucket = this.keyListeners.get(nextValue);
    if (nextBucket) {
      for (const listener of Array.from(nextBucket)) {
        listener();
      }
    }

    // 2. 唤醒全量槽位订阅者
    for (const listener of Array.from(this.listeners)) {
      listener();
    }

    return true;
  }

  /**
   * 强制递增 32 位整型代数并广播（用于底层可变集合原地更新后的提交）
   */
  public bump(): number {
    this.epoch = (this.epoch + 1) | 0;
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
    for (const bucket of this.keyListeners.values()) {
      for (const listener of Array.from(bucket)) {
        listener();
      }
    }
    return this.epoch;
  }

  /**
   * 订阅槽位任意更新（对齐 React useSyncExternalStore subscribe 签名）
   */
  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 按目标值精准订阅：仅当槽位值切入或切出 targetKey 时唤醒该 listener（O(1) 定向唤醒）
   */
  public subscribeKey = (targetKey: T, listener: () => void): (() => void) => {
    let bucket = this.keyListeners.get(targetKey);
    if (!bucket) {
      bucket = new Set();
      this.keyListeners.set(targetKey, bucket);
    }
    bucket.add(listener);
    return () => {
      const currentBucket = this.keyListeners.get(targetKey);
      if (!currentBucket) return;
      currentBucket.delete(listener);
      if (currentBucket.size === 0) {
        this.keyListeners.delete(targetKey);
      }
    };
  };

  public getListenerCount(): number {
    let keyedCount = 0;
    for (const bucket of this.keyListeners.values()) {
      keyedCount += bucket.size;
    }
    return this.listeners.size + keyedCount;
  }

  public clearListeners(): void {
    this.listeners.clear();
    this.keyListeners.clear();
  }
}

interface ManagedSlotRecord {
  epoch: number;
  lastEntry: ResizeObserverEntry | null;
  elements: Map<Element, ResizeCallback>;
}

export class EpochSlotObserver {
  private static instance: EpochSlotObserver | null = null;
  private readonly slots = new Map<string, ManagedSlotRecord>();
  private readonly slotListeners = new Map<string, Set<() => void>>();

  public static getInstance(): EpochSlotObserver {
    if (!EpochSlotObserver.instance) {
      EpochSlotObserver.instance = new EpochSlotObserver();
    }
    return EpochSlotObserver.instance;
  }

  public static resetInstanceForTest(): void {
    if (EpochSlotObserver.instance) {
      EpochSlotObserver.instance.destroy();
      EpochSlotObserver.instance = null;
    }
  }

  private constructor() {}

  /**
   * 观察指定 DOM 元素的尺寸变化并桥接至 slotId 的 32 位整型代数槽位。
   * 底层严格复用 ResizeObserverManager.getInstance() 单例管线。
   */
  public observe(
    el: Element,
    slotId: string,
    options?: ResizeObserveOptions | string
  ): () => void {
    let record = this.slots.get(slotId);
    if (!record) {
      record = {
        epoch: 1,
        lastEntry: null,
        elements: new Map(),
      };
      this.slots.set(slotId, record);
    }

    const existingCb = record.elements.get(el);
    if (existingCb) {
      ResizeObserverManager.getInstance().unobserve(el, existingCb);
    }

    const callback: ResizeCallback = (entry: ResizeObserverEntry) => {
      const current = this.slots.get(slotId);
      if (!current) return;
      current.epoch = (current.epoch + 1) | 0;
      current.lastEntry = entry;
      this.notifySlot(slotId);
    };

    record.elements.set(el, callback);
    ResizeObserverManager.getInstance().observe(el, callback, options);

    return () => {
      const current = this.slots.get(slotId);
      if (!current) return;
      const cb = current.elements.get(el);
      if (cb) {
        ResizeObserverManager.getInstance().unobserve(el, cb);
        current.elements.delete(el);
      }
      if (
        current.elements.size === 0 &&
        (this.slotListeners.get(slotId)?.size ?? 0) === 0
      ) {
        this.slots.delete(slotId);
      }
    };
  }

  /**
   * 获取指定 slotId 的当前 32 位整型版本代数（未注册时返回 0）
   */
  public getEpoch = (slotId: string): number => {
    return this.slots.get(slotId)?.epoch ?? 0;
  };

  /**
   * 对齐 useSyncExternalStore 的快照读取器
   */
  public getSnapshot = (slotId: string): number => {
    return this.getEpoch(slotId);
  };

  /**
   * 获取指定 slotId 最近一次触发的 ResizeObserverEntry
   */
  public getLastEntry(slotId: string): ResizeObserverEntry | null {
    return this.slots.get(slotId)?.lastEntry ?? null;
  }

  /**
   * 手动递增指定 slotId 的 32 位整型版本代数并唤醒订阅者
   */
  public bumpSlot(slotId: string): number {
    let record = this.slots.get(slotId);
    if (!record) {
      record = {
        epoch: 1,
        lastEntry: null,
        elements: new Map(),
      };
      this.slots.set(slotId, record);
    } else {
      record.epoch = (record.epoch + 1) | 0;
    }
    this.notifySlot(slotId);
    return record.epoch;
  }

  /**
   * 订阅指定 slotId 的代数变更
   */
  public subscribe = (slotId: string, listener: () => void): (() => void) => {
    let listeners = this.slotListeners.get(slotId);
    if (!listeners) {
      listeners = new Set();
      this.slotListeners.set(slotId, listeners);
    }
    listeners.add(listener);

    return () => {
      const currentListeners = this.slotListeners.get(slotId);
      if (!currentListeners) return;
      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        this.slotListeners.delete(slotId);
        const slotRecord = this.slots.get(slotId);
        if (slotRecord && slotRecord.elements.size === 0) {
          this.slots.delete(slotId);
        }
      }
    };
  };

  public getActiveSlotCount(): number {
    return this.slots.size;
  }

  public destroy(): void {
    const roManager = ResizeObserverManager.getInstance();
    for (const record of this.slots.values()) {
      for (const [el, cb] of record.elements.entries()) {
        roManager.unobserve(el, cb);
      }
      record.elements.clear();
    }
    this.slots.clear();
    this.slotListeners.clear();
  }

  private notifySlot(slotId: string): void {
    const listeners = this.slotListeners.get(slotId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (err) {
        console.error('[EpochSlotObserver] Listener error:', err);
      }
    }
  }
}
