// @vitest-environment jsdom
/**
 * R2-a ③ 竞态测试（详案 §1.1-2 / 02-总计划 R2-a）：
 * `editQueuedMessage` 把队内消息移回输入框编辑后 processing 结束 →
 * drain 不抢发被编辑项（queuedMessages[0] 与编辑中 id 冲突时被跳过）。
 *
 * 实现面：useChatComposerProps 组件级「可 drain」标记（editMovedIdsRef）。
 * - 编辑队首 → 处理结束 → 被编辑文本绝不进入 sendQueuedMessageNow；
 * - 未编辑队首 → 处理结束 → 队首正常 drain（回归保护）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatComposerProps } from './useChatComposerProps';
import { useSettingsStore } from '../../store/settingsStore';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { ChatAttachment } from '../../hooks/chat-stream/types';
import type { Settings } from '../../api/clientApi';
import type { UseChatComposerPropsOptions } from './useChatComposerProps';

const handleSendChat = vi.fn(async () => undefined);
const runStreamingAssistant = vi.fn();

vi.mock('../../hooks/useChatStream', () => ({
  useChatStream: () => ({
    runNotice: null,
    setRunNotice: vi.fn(),
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration: vi.fn(),
    handleForceCancelGeneration: vi.fn(),
  }),
}));

vi.mock('../../api/appMode', () => ({ isDemoMode: () => false }));

vi.mock('../../api/clientApi', () => ({
  clientApi: {
    getSettings: vi.fn(async () => ({
      enableSkillCommands: true,
      queueMode: true,
    })),
  },
}));

const SID = 'sess-drain-race';

function makeProps(
  overrides: Partial<UseChatComposerPropsOptions> = {}
): UseChatComposerPropsOptions {
  return {
    wsId: 'ws-1',
    activeSessionId: SID,
    needsKeySetup: false,
    needsModelSetup: false,
    isProcessing: true,
    onShowToast: vi.fn(),
    handleGlobalTabClick: vi.fn(),
    setShowModelDropdown: vi.fn(),
    setPickerInlineError: vi.fn(),
    ...overrides,
  };
}

function makeQueueItem(id: string, text: string) {
  return {
    id,
    text,
    attachments: [] as ChatAttachment[],
    createdAt: Date.now(),
  };
}

describe('useChatComposerProps drain 抢跑窗口关闭（R2-a ③）', () => {
  const Q_X = makeQueueItem('q-x', 'edit me');
  const Q_Y = makeQueueItem('q-y', 'drain me');

  beforeEach(() => {
    handleSendChat.mockClear();
    runStreamingAssistant.mockClear();
    useSettingsStore.setState({
      appSettings: { queueMode: true } as unknown as Settings,
    });
    sessionRuntimeRegistry.save(SID, {
      attachments: [],
      queuedMessages: [Q_X, Q_Y],
    });
  });

  afterEach(() => {
    sessionRuntimeRegistry.remove(SID);
  });

  it('editQueuedMessage 后 processing 结束 → drain 不抢发被编辑项，其余队首继续正常发送', async () => {
    const { result, rerender } = renderHook(
      (props: UseChatComposerPropsOptions) => useChatComposerProps(props),
      { initialProps: makeProps() }
    );

    expect(result.current.queuedMessages.map((m) => m.id)).toEqual([
      'q-x',
      'q-y',
    ]);

    // 用户把队首移回输入框编辑（「可 drain」标记关闭）
    act(() => {
      result.current.editQueuedMessage('q-x');
    });
    expect(result.current.chatInput).toBe('edit me');
    expect(result.current.queuedMessages.map((m) => m.id)).toEqual(['q-y']);

    // processing 恰在此刻结束 → drain effect 触发
    await act(async () => {
      rerender(makeProps({ isProcessing: false }));
    });
    await vi.waitFor(() => {
      expect(handleSendChat).toHaveBeenCalled();
    });

    const sentTexts = handleSendChat.mock.calls.map((c) => c[1] as string);
    // 被编辑项绝不抢发（q-x 的文本不进入 send）
    expect(sentTexts).not.toContain('edit me');
    // 其余队首（q-y）在编辑中 id 移出队列后正常 drain
    expect(sentTexts).toContain('drain me');
  });

  it('未编辑队首 → processing 结束正常 drain 队首（回归保护）', async () => {
    const { rerender } = renderHook(
      (props: UseChatComposerPropsOptions) => useChatComposerProps(props),
      { initialProps: makeProps() }
    );

    await act(async () => {
      rerender(makeProps({ isProcessing: false }));
    });
    await vi.waitFor(() => {
      expect(handleSendChat).toHaveBeenCalled();
    });

    const sentTexts = handleSendChat.mock.calls.map((c) => c[1] as string);
    expect(sentTexts).toContain('edit me');
  });

  it('编辑后重新入队（新 id 入队）→ 新消息不被旧编辑标记阻塞，处理结束正常 drain', async () => {
    const { result, rerender } = renderHook(
      (props: UseChatComposerPropsOptions) => useChatComposerProps(props),
      { initialProps: makeProps() }
    );

    act(() => {
      result.current.editQueuedMessage('q-x');
    });
    // 运行中重新提交编辑后的文本（enqueueMessage 生成新 id，追加队尾）
    act(() => {
      result.current.enqueueMessage('edit me v2', []);
    });
    const newId = result.current.queuedMessages.find((m) => m.id !== 'q-y')?.id;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe('q-x');
    expect(result.current.queuedMessages).toHaveLength(2);

    // 处理结束 → drain 队首 q-y（新入队消息不被旧编辑标记阻塞；drain 每
    // 次处理结束仅送队首——原语义不变）
    await act(async () => {
      rerender(makeProps({ isProcessing: false }));
    });
    await vi.waitFor(() => {
      expect(handleSendChat).toHaveBeenCalledTimes(1);
    });
    const sentTexts = handleSendChat.mock.calls.map((c) => c[1] as string);
    expect(sentTexts).toContain('drain me');
    expect(sentTexts).not.toContain('edit me');
    expect(sentTexts).not.toContain('edit me v2');
  });
});
