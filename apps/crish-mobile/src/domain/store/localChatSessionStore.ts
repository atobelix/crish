// 本地对话会话 store（纯内存，不落盘）：本地对话与远程会话完全分开——
// 不进远程会话列表、不经 RelaySocket；线程只活在 App 会话内（冷启动清空，
// 与「兜底纯对话」的定位一致；配置面在 localChatStore 持久化）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { LocalChatError, LocalChatMessage } from '../types/localChat';

export interface LocalChatSessionState {
  messages: LocalChatMessage[];
  /** 生成中（流式占位消息已入列） */
  streaming: boolean;
  /** 最近一次失败（横幅呈现；下一次发送时清除） */
  error: LocalChatError | null;

  appendUser: (message: LocalChatMessage) => void;
  beginAssistant: (message: LocalChatMessage) => void;
  appendAssistantDelta: (id: string, delta: string) => void;
  finishAssistant: (id: string, patch?: Partial<LocalChatMessage>) => void;
  setError: (error: LocalChatError | null) => void;
  setStreaming: (streaming: boolean) => void;
  clearThread: () => void;
}

export const localChatSessionStore: StoreApi<LocalChatSessionState> =
  createStore<LocalChatSessionState>()(
    immer((set) => ({
      messages: [],
      streaming: false,
      error: null,

      appendUser: (message) => {
        set((s) => {
          s.messages.push(message);
          s.error = null;
        });
      },

      beginAssistant: (message) => {
        set((s) => {
          s.messages.push({ ...message, streaming: true });
          s.streaming = true;
        });
      },

      appendAssistantDelta: (id, delta) => {
        set((s) => {
          const target = s.messages.find((m) => m.id === id);
          if (target) target.content += delta;
        });
      },

      finishAssistant: (id, patch) => {
        set((s) => {
          const target = s.messages.find((m) => m.id === id);
          if (target) {
            target.streaming = false;
            if (patch) Object.assign(target, patch);
          }
          s.streaming = false;
        });
      },

      setError: (error) => {
        set((s) => {
          s.error = error;
        });
      },

      setStreaming: (streaming) => {
        set((s) => {
          s.streaming = streaming;
        });
      },

      clearThread: () => {
        set((s) => {
          s.messages = [];
          s.error = null;
          s.streaming = false;
        });
      },
    }))
  );
