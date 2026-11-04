// hub 本地行摘要口径（MD3 列表面纯文本纪律）：生成中线程的实时内容是
// markdown 原文且多行——snippetOf 必须摘为纯文本单行（与 meta.preview
// 同口径），标记不得泄漏到主页本地行；非生成线程直取 meta.preview。
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

describe('useLocalHubEntryVm · snippetOf 纯文本纪律', () => {
  it('生成中：实时 markdown 原文摘为纯文本（标记不泄漏、无换行）', async () => {
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
    expect(snippet).toBe('结论 重点 如下 列甲 列乙 甲一 乙一');
    expect(snippet).not.toContain('**');
    expect(snippet).not.toContain('|');
    expect(snippet).not.toContain('\n');
  });

  it('生成中尚无内容：生成中文案', async () => {
    seed({
      streaming: true,
      messages: [{ id: 'a1', role: 'assistant', content: '', streaming: true }],
    });
    const { result } = await renderHook(() => useLocalHubEntryVm());
    expect(result.current.snippetOf('t1')).toBe('正在生成…');
  });

  it('非生成：直取 meta.preview；未知线程为空串', async () => {
    seed({ streaming: false, messages: [] });
    const { result } = await renderHook(() => useLocalHubEntryVm());
    expect(result.current.snippetOf('t1')).toBe('已落定摘要');
    expect(result.current.snippetOf('nope')).toBe('');
  });
});
