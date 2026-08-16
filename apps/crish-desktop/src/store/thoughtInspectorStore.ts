/**
 * 统一思维链沉浸查阅器状态管理器（FIN-03 规范落地）。
 * 管理全量思考查阅模态窗的打开/关闭、上下文（messageId/turnIndex/content）、以及搜索状态。
 */
import { create } from 'zustand';

export interface ThoughtInspectorOpenParams {
  messageId?: string | null;
  turnIndex?: number | null;
  content?: string;
  title?: string | null;
  durationSec?: number;
  sessionId?: string;
  modelDisplayName?: string;
}

export interface ThoughtInspectorState {
  isOpen: boolean;
  activeMessageId: string | null;
  activeTurnIndex: number | null;
  content: string;
  title: string | null;
  durationSec: number | null;
  sessionId: string | null;
  modelDisplayName: string | null;
  searchQuery: string;

  /** 标准 API */
  openThoughtInspector: (params: ThoughtInspectorOpenParams) => void;
  closeThoughtInspector: () => void;
  setSearchQuery: (query: string) => void;
}

export const useThoughtInspectorStore = create<ThoughtInspectorState>(
  (set) => ({
    isOpen: false,
    activeMessageId: null,
    activeTurnIndex: null,
    content: '',
    title: null,
    durationSec: null,
    sessionId: null,
    modelDisplayName: null,
    searchQuery: '',

    openThoughtInspector: (params: ThoughtInspectorOpenParams) => {
      const text = params.content ?? '';
      const messageId = params.messageId ?? '';
      const turnIndex = params.turnIndex ?? null;
      const title = params.title ?? null;
      const durationSec = params.durationSec;
      const sessionId = params.sessionId;
      const modelDisplayName = params.modelDisplayName;

      set({
        isOpen: true,
        activeMessageId: messageId || null,
        activeTurnIndex: turnIndex,
        content: text,
        title,
        durationSec: durationSec ?? null,
        sessionId: sessionId ?? null,
        modelDisplayName: modelDisplayName ?? null,
        searchQuery: '',
      });
    },

    closeThoughtInspector: () => {
      set({
        isOpen: false,
        activeMessageId: null,
        activeTurnIndex: null,
        content: '',
        title: null,
        durationSec: null,
        sessionId: null,
        modelDisplayName: null,
        searchQuery: '',
      });
    },

    setSearchQuery: (searchQuery: string) => set({ searchQuery }),
  })
);

export function openThoughtInspector(params: ThoughtInspectorOpenParams): void {
  useThoughtInspectorStore.getState().openThoughtInspector(params);
}

export function closeThoughtInspector(): void {
  useThoughtInspectorStore.getState().closeThoughtInspector();
}

export function setSearchQuery(query: string): void {
  useThoughtInspectorStore.getState().setSearchQuery(query);
}
