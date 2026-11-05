// hub 本地行摘要口径：生成中线程直接返回「正在生成…」标量（避免逐 Token
// 轰炸主屏）；非生成线程直取 meta.preview。
import { renderHook } from '@testing-library/react-native';
import { useLocalHubEntryVm } from './useLocalHubEntryVm';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import type {
  LocalChatMessage,
  LocalThreadMeta,
} from '@/domain/types/localChat';

const META: LocalThreadMeta = {
  id: 't1',
  title: '本地线程',
  titleSource: 'derived',
  preview: '已落定摘要',
  modelRef: null,
  createdAt: 1,
  updatedAt: 2,
};

function seed(input: {
  messages: LocalChatMessage[];
  streaming: boolean;
}): void {
  localChatStore.setState({
    config: { version: 2, providers: {}, activeModel: null },
    hydrated: true,
    keyPresence: {},
  });
  localChatSessionStore.setState({
    threads: [META],
    activeThreadId: 't1',
    inactive: {},
    hydrated: true,
    messages: input.messages,
    streaming: input.streaming,
    error: null,
  });
}

describe('useLocalHubEntryVm · snippetOf 标量与落定摘要', () => {
  it('生成中：直接返回「正在生成…」标量，不受 messages 内容干扰', async () => {
    seed({
      streaming: true,
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          streaming: true,
          content:
            '结论 **重点** 如下\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 甲一 | 乙一 |',
        },
      ],
    });
    const { result } = await renderHook(() => useLocalHubEntryVm());
    const snippet = result.current.snippetOf('t1');
    expect(snippet).toBe('正在生成…');
  });

  it('生成中非活动线程：同样返回「正在生成…」标量', async () => {
    localChatStore.setState({
      config: { version: 2, providers: {}, activeModel: null },
      hydrated: true,
      keyPresence: {},
    });
    localChatSessionStore.setState({
      threads: [META, { ...META, id: 't2', preview: '旧摘要' }],
      activeThreadId: 't1',
      inactive: {
        t2: {
          messages: [],
          streaming: true,
          error: null,
        },
      },
      hydrated: true,
      messages: [],
      streaming: false,
      error: null,
    });
    const { result } = await renderHook(() => useLocalHubEntryVm());
    expect(result.current.snippetOf('t2')).toBe('正在生成…');
  });

  it('非生成：直取 meta.preview；未知线程为空串', async () => {
    seed({ streaming: false, messages: [] });
    const { result } = await renderHook(() => useLocalHubEntryVm());
    expect(result.current.snippetOf('t1')).toBe('已落定摘要');
    expect(result.current.snippetOf('nope')).toBe('');
  });
});
