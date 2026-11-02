// 本地对话 VM 测试：未配置前置拦截、发送→流式→收尾全链（假传输）、
// 停止生成保留已生成内容、与远程连接状态无关（不触碰 connectionStore）。
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useLocalChatVm } from './useLocalChatVm';
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
import type {
  StreamHandlers,
  StreamTransport,
} from '@/adapters/localChat/localChatClient';

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

let handlers: StreamHandlers | null = null;
const fakeTransport: StreamTransport = (_req, h) => {
  handlers = h;
  return { abort: () => {} };
};

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
let secure: SecureStoreDriver;

beforeEach(async () => {
  handlers = null;
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
    messages: [],
    streaming: false,
    error: null,
  });
});

afterEach(() => {
  resetLocalChatClientForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
});

async function configureOneProvider() {
  await localChatStore.getState().upsertProvider(
    'p1',
    {
      displayName: '测试供应商',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai/chat',
      models: [{ id: 'm1', enabled: true }],
    },
    'sk-vm'
  );
}

describe('useLocalChatVm', () => {
  it('未配置：configured=false，发送被前置拦下并给出 notConfigured', async () => {
    const { result } = await renderHook(() => useLocalChatVm());
    expect(result.current.configured).toBe(false);
    await act(async () => {
      result.current.send('你好');
    });
    expect(result.current.error?.kind).toBe('notConfigured');
    expect(result.current.messages).toHaveLength(0);
  });

  it('发送→流式增量→完成：消息落位、streaming 收尾、标签为供应商·模型', async () => {
    await configureOneProvider();
    const { result } = await renderHook(() => useLocalChatVm());
    expect(result.current.configured).toBe(true);
    expect(result.current.activeLabel).toBe('测试供应商 · m1');

    await act(async () => {
      result.current.send('第一问');
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);

    await act(async () => {
      handlers?.onChunk(
        sse({ choices: [{ delta: { content: '回答' }, finish_reason: null }] })
      );
      handlers?.onChunk(
        sse({
          choices: [{ delta: { content: '完毕' }, finish_reason: 'stop' }],
        })
      );
      handlers?.onDone();
    });
    expect(result.current.streaming).toBe(false);
    const assistant = result.current.messages[1];
    expect(assistant?.content).toBe('回答完毕');
    expect(assistant?.streaming).toBe(false);
  });

  it('多轮上下文：第二问出站消息含首轮问答（经 buildWireMessages 组装）', async () => {
    await configureOneProvider();
    let lastBody = '';
    setLocalChatClientForTest({
      streamTransport: (req, h) => {
        lastBody = req.body;
        handlers = h;
        return { abort: () => {} };
      },
    });
    const { result } = await renderHook(() => useLocalChatVm());
    await act(async () => {
      result.current.send('一');
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    await act(async () => {
      handlers?.onChunk(
        sse({
          choices: [{ delta: { content: '答一' }, finish_reason: 'stop' }],
        })
      );
      handlers?.onDone();
    });
    await act(async () => {
      result.current.send('二');
    });
    await waitFor(() => expect(JSON.parse(lastBody).messages).toHaveLength(4));
    const messages = JSON.parse(lastBody).messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages.slice(1).map((m) => m.content)).toEqual([
      '一',
      '答一',
      '二',
    ]);
  });

  it('停止生成：保留已生成内容并标注 stopped，不产生错误', async () => {
    await configureOneProvider();
    const { result } = await renderHook(() => useLocalChatVm());
    await act(async () => {
      result.current.send('问');
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    await act(async () => {
      handlers?.onChunk(
        sse({ choices: [{ delta: { content: '一半' }, finish_reason: null }] })
      );
    });
    await act(async () => {
      result.current.stop();
    });
    expect(result.current.streaming).toBe(false);
    const assistant = result.current.messages[1];
    expect(assistant?.content).toBe('一半');
    expect(assistant?.stopped).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
