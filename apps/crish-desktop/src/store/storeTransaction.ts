import { useSessionStore } from './sessionStore';
import { useWorkspaceStore } from './workspaceStore';
import { useSettingsUiStore } from './settingsUiStore';
import { setBatchRollback } from './bootstrapStores';

export interface MultiStoreSnapshot {
  session: ReturnType<typeof useSessionStore.getState>;
  workspace: ReturnType<typeof useWorkspaceStore.getState>;
  settingsUi: ReturnType<typeof useSettingsUiStore.getState>;
}

function deepClone<T>(obj: T): T {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(obj);
    }
  } catch {
    /* fallback when Immer proxy or non-cloneable objects are present */
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}

export class StoreTransaction {
  private snapshots: MultiStoreSnapshot[] = [];

  begin(): void {
    this.snapshots.push({
      session: deepClone(useSessionStore.getState()),
      workspace: deepClone(useWorkspaceStore.getState()),
      settingsUi: deepClone(useSettingsUiStore.getState()),
    });
  }

  commit(): void {
    this.snapshots.pop();
  }

  rollback(): void {
    const snap = this.snapshots.pop();
    if (!snap) return;
    setBatchRollback(true);
    try {
      useSessionStore.setState(() => snap.session);
      useWorkspaceStore.setState(() => snap.workspace);
      useSettingsUiStore.setState(() => snap.settingsUi);
    } finally {
      setBatchRollback(false);
    }
  }

  run<T>(fn: () => T): T {
    this.begin();
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  get depth(): number {
    return this.snapshots.length;
  }
}
