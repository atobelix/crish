// 本地对话视图模型：与远程会话完全分开的一条纯对话链——
// 数据源 = localChatStore（本机供应商配置）+ localChatSessionStore（内存线程）；
// 发送瞬间才从 SecureStore 读密钥（经 store.readApiKey），密钥不进 React 状态。
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import {
  buildWireMessages,
  notConfiguredError,
  resolveActiveSelection,
  withErrorMessage,
} from '@/domain/pure/localChatProtocol';
import { nextId } from '@/domain/pure/id';
import type {
  LocalChatError,
  LocalChatMessage,
} from '@/domain/types/localChat';
import type { StreamHandle } from '@/adapters/localChat/localChatClient';
import { getLocalChatClient } from '@/adapters/localChat/localChatWiring';

export interface LocalChatVm {
  messages: readonly LocalChatMessage[];
  streaming: boolean;
  error: LocalChatError | null;
  /** 已配置且可选定活动模型（false = 未配置态：入口仍可用，发送被前置拦下并引导配置） */
  configured: boolean;
  /** 当前供应商 · 模型标签（如「DeepSeek · deepseek-chat」；未配置为 null） */
  activeLabel: string | null;
  canSend: boolean;
  send: (text: string) => void;
  stop: () => void;
  clearThread: () => void;
  dismissError: () => void;
}

export function useLocalChatVm(): LocalChatVm {
  const config = useStore(localChatStore, (s) => s.config);
  const messages = useStore(localChatSessionStore, (s) => s.messages);
  const streaming = useStore(localChatSessionStore, (s) => s.streaming);
  const error = useStore(localChatSessionStore, (s) => s.error);
  const handleRef = useRef<StreamHandle | null>(null);

  // 配置可能在 App 启动后才水合：本页挂载时若尚未水合，主动补一次
  // （hydrate 幂等；无注入持久化时立即置位为空配置）。
  useEffect(() => {
    if (!localChatStore.getState().hydrated) {
      void localChatStore.getState().hydrate();
    }
  }, []);

  // 卸载时断流，避免回调写入已卸载页面背后的 store（线程本身保留）
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
      handleRef.current = null;
    };
  }, []);

  const selection = useMemo(() => resolveActiveSelection(config), [config]);
  const configured = selection !== null;
  const activeLabel = selection
    ? `${selection.provider.displayName ?? selection.providerId} · ${selection.modelId}`
    : null;

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === '' || localChatSessionStore.getState().streaming) return;
    const session = localChatSessionStore.getState();
    const sel = resolveActiveSelection(localChatStore.getState().config);
    if (!sel) {
      session.setError(withErrorMessage(notConfiguredError()));
      return;
    }
    const userMessage: LocalChatMessage = {
      id: nextId('lcm'),
      role: 'user',
      content: trimmed,
    };
    session.appendUser(userMessage);
    const assistantId = nextId('lcm');
    session.beginAssistant({
      id: assistantId,
      role: 'assistant',
      content: '',
    });
    const history = localChatSessionStore.getState().messages;
    const wire = buildWireMessages(history);
    void localChatStore
      .getState()
      .readApiKey(sel.providerId)
      .then((apiKey) => {
        const client = getLocalChatClient();
        handleRef.current = client.streamChatCompletion(
          {
            baseUrl: sel.provider.baseUrl ?? '',
            apiKey,
            model: sel.modelId,
            messages: wire,
          },
          {
            onTextDelta: (delta) => {
              localChatSessionStore
                .getState()
                .appendAssistantDelta(assistantId, delta);
            },
            onComplete: ({ toolCallCount }) => {
              handleRef.current = null;
              localChatSessionStore.getState().finishAssistant(assistantId, {
                ...(toolCallCount > 0 ? { toolCallCount } : {}),
              });
            },
            onError: (err) => {
              handleRef.current = null;
              const state = localChatSessionStore.getState();
              // 已生成部分保留在消息里，错误以横幅呈现（不吞内容）
              state.finishAssistant(assistantId);
              state.setError(err);
            },
          }
        );
      });
  }, []);

  const stop = useCallback(() => {
    if (handleRef.current === null) return;
    handleRef.current.abort();
    handleRef.current = null;
    const state = localChatSessionStore.getState();
    const streamingMessage = state.messages.find((m) => m.streaming);
    if (streamingMessage) {
      state.finishAssistant(streamingMessage.id, { stopped: true });
    } else {
      state.setStreaming(false);
    }
  }, []);

  const clearThread = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
    localChatSessionStore.getState().clearThread();
  }, []);

  const dismissError = useCallback(() => {
    localChatSessionStore.getState().setError(null);
  }, []);

  return {
    messages,
    streaming,
    error,
    configured,
    activeLabel,
    canSend: !streaming,
    send,
    stop,
    clearThread,
    dismissError,
  };
}

export type { LocalChatError };
