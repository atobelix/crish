// 本地发送必须采用输入框传入的全文。父级 prompt 可能停在空与非空
// 切换时的快照，不能拿它覆盖缓冲里的最新文本。
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ToastProvider } from '@/presentation/ui';
import { useLocalConversationEngine } from './useLocalConversationEngine';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { InMemorySecureStore, type SecureStoreDriver } from '@/db/secureStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
} from '@/domain/store/localChatStore';
import {
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
} from '@/adapters/localChat/localChatWiring';
import { configureLocalChatSessionPersistence } from '@/domain/store/localChatSessionStore';
import { resetLocalChatEngineForTest } from '@/adapters/localChat/localChatEngine';
import type { StreamTransport } from '@/adapters/localChat/localChatClient';
import { resetComposerDraftsForTest } from '@/domain/store/composerDraftStore';

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));

class MemoryPersist implements SettingsPersist {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async getAll(): Promise<ReadonlyArray<{ key: string; value: string }>> {
    return [...this.map.entries()].map(([key, value]) => ({ key, value }));
  }
}

const fakeTransport: StreamTransport = () => ({ abort: () => {} });

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

let secure: SecureStoreDriver;

beforeEach(() => {
  resetComposerDraftsForTest();
  secure = new InMemorySecureStore();
  configureLocalChatPersistence(new MemoryPersist());
  configureLocalChatSecure(secure);
  setLocalChatClientForTest({ streamTransport: fakeTransport });
  localChatStore.setState({
    config: { version: 2, providers: {}, activeModel: null },
    hydrated: true,
    keyPresence: {},
  });
  localChatSessionStore.setState({
    threads: [],
    activeThreadId: null,
    inactive: {},
    hydrated: true,
    completedAtByThread: {},
    messages: [],
    streaming: false,
    error: null,
  });
  resetLocalChatEngineForTest();
  configureLocalChatSessionPersistence(null);
});

afterEach(() => {
  resetLocalChatClientForTest();
  resetLocalChatEngineForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
  configureLocalChatSessionPersistence(null);
  resetComposerDraftsForTest();
});

describe('本地引擎显式文本发送', () => {
  it('父级仍是旧快照时，发送使用调用参数里的最新全文', async () => {
    await localChatStore.getState().upsertProvider(
      'p1',
      {
        displayName: '测试供应商',
        baseUrl: 'https://api.example.com/v1',
        protocol: 'openai/chat',
        models: [{ id: 'm1', enabled: true }],
      },
      'sk-engine'
    );
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    expect(result.current.composer.draftKey).toBe(`local:${id}`);

    await act(async () => {
      result.current.composer.setPrompt('旧');
    });
    await act(async () => {
      result.current.composer.submit('新稿');
    });

    expect(result.current.composer.prompt).toBe('');
    expect(localChatSessionStore.getState().messages[0]?.content).toBe('新稿');
  });

  it('发送未被受理时保留父级原文', async () => {
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.composer.setPrompt('旧');
    });
    await act(async () => {
      result.current.composer.submit('新稿');
    });
    expect(result.current.composer.prompt).toBe('旧');
    expect(localChatSessionStore.getState().messages).toHaveLength(0);
  });
});
