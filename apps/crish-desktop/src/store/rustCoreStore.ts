import { create } from 'zustand';
import {
  getRustCoreStatus,
  searchFiles,
  compactMessages,
  countTokens,
  checkCommand,
  computeDiff,
  type RustCoreStatus,
  type FileHit,
  type CompactionResult,
  type GatekeeperResult,
  type DiffResult,
  type Message,
  type SearchRequest,
} from '../api/rustCore';

export interface RustCoreSlice {
  status: RustCoreStatus | null;
  statusLoading: boolean;
  statusError: string | null;
}

export interface RustCoreActions {
  refreshStatus: () => Promise<RustCoreStatus | null>;
  search: (request: SearchRequest) => Promise<FileHit[]>;
  compact: (
    messages: Message[],
    maxTokens: number
  ) => Promise<CompactionResult>;
  count: (text: string) => Promise<number>;
  checkCmd: (cmd: string, args: string[]) => Promise<GatekeeperResult>;
  diff: (oldText: string, newText: string) => Promise<DiffResult>;
}

export type RustCoreStore = RustCoreSlice & RustCoreActions;

/**
 * @deprecated DEAD — 0 调用点死代码（A2 P2-6，store/index.ts:174 导出）。
 * Rust 主路径经 Tauri transport 直连（ConnectionLifecycle / transport），
 * 本 store 未接线任何消费方。HONEST-HIDE：保留声明以兼容潜在外部导入，
 * 禁止新增消费点；R7 收尾按 `fetchLatestModels` 的 DEAD formal 模式复核。
 * @removeWhen 缓存优化多 Agent 方案 R7 终验（docs/cache-optimization/90-final/）
 * 确认零外部导入后整体删除（对齐 apps/crish-desktop/src/api/clientApi.ts
 * 中 `fetchLatestModels` 的 DEAD 声明与删除流程）。
 */
export const useRustCoreStore = create<RustCoreStore>((set) => ({
  status: null,
  statusLoading: false,
  statusError: null,

  refreshStatus: async () => {
    set({ statusLoading: true, statusError: null });
    try {
      const status = await getRustCoreStatus();
      set({ status, statusLoading: false });
      return status;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set({ statusError: errorMsg, statusLoading: false });
      return null;
    }
  },

  search: async (request: SearchRequest) => {
    return searchFiles(request);
  },

  compact: async (messages: Message[], maxTokens: number) => {
    return compactMessages(messages, maxTokens);
  },

  count: async (text: string) => {
    return countTokens(text);
  },

  checkCmd: async (cmd: string, args: string[]) => {
    return checkCommand(cmd, args);
  },

  diff: async (oldText: string, newText: string) => {
    return computeDiff(oldText, newText);
  },
}));
