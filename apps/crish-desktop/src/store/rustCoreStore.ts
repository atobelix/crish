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
  compact: (messages: Message[], maxTokens: number) => Promise<CompactionResult>;
  count: (text: string) => Promise<number>;
  checkCmd: (cmd: string, args: string[]) => Promise<GatekeeperResult>;
  diff: (oldText: string, newText: string) => Promise<DiffResult>;
}

export type RustCoreStore = RustCoreSlice & RustCoreActions;

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
