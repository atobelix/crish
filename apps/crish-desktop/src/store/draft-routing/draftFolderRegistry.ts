/**
 * draftFolderRegistry.ts — 草稿项目绑定注册表（单一职责）。
 *
 * 职责：
 * 维护草稿会话（draftSessionId，如 `__pending_draft__:leaf_xxx`）与其绑定的
 * 项目 folder 标识之间的映射与响应式通知。
 *
 * 保证在草稿未提交（尚未写入 sessionsById）期间，面包屑（UnitChromeActions）、
 * 输入框与工作区环境能够 100% 确定性读取并展示绑定的项目名称。
 */

import { useSyncExternalStore } from 'react';

type Listener = () => void;

class DraftFolderRegistry {
  private map = new Map<string, string>();
  private listeners = new Set<Listener>();
  private version = 0;

  /**
   * 为指定草稿登记绑定的项目 folder
   */
  set(draftSessionId: string, folder: string): void {
    const key = (draftSessionId || '').trim();
    const val = (folder || '').trim();
    if (!key || !val) return;
    if (this.map.get(key) === val) return;
    this.map.set(key, val);
    this.version++;
    this.notify();
  }

  /**
   * 获取指定草稿绑定的项目 folder
   */
  get(draftSessionId: string): string | undefined {
    const key = (draftSessionId || '').trim();
    if (!key) return undefined;
    return this.map.get(key);
  }

  /**
   * 清除指定草稿的绑定
   */
  delete(draftSessionId: string): void {
    const key = (draftSessionId || '').trim();
    if (this.map.delete(key)) {
      this.version++;
      this.notify();
    }
  }

  /**
   * 清空所有草稿绑定
   */
  clear(): void {
    if (this.map.size > 0) {
      this.map.clear();
      this.version++;
      this.notify();
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => {
    return this.version;
  };

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

export const draftFolderRegistry = new DraftFolderRegistry();

const getServerSnapshot = (): number => 0;

/**
 * React Hook：响应式读取指定草稿的绑定项目 folder
 */
export function useDraftFolder(draftSessionId: string | undefined | null): string | undefined {
  useSyncExternalStore(
    draftFolderRegistry.subscribe,
    draftFolderRegistry.getSnapshot,
    getServerSnapshot
  );
  return draftSessionId ? draftFolderRegistry.get(draftSessionId) : undefined;
}
