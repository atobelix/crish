// @vitest-environment jsdom
/**
 * R1（打字解耦，性能 P0-2）契约：useSlashMenu 的 filteredCommands 是逐渲染
 * .filter() 产物（数组身份恒新、元素身份稳定）。useChatComposerProps 必须
 * 在元素序列未变时复用上一份数组引用（否则这份恒新引用会击穿
 * ChatComposer 的 memo 与 ChatCard 主输入框元素 memo），且在元素增减或
 * 被替换时必须换新引用（不得吞掉真实变化）。
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatComposerProps } from './useChatComposerProps';

const h = vi.hoisted(() => {
  const cmdA = { cmd: '/goal', desc: 'a' };
  const cmdB = { cmd: '/clear', desc: 'b' };
  const cmdC = { cmd: '/stop', desc: 'c' };
  return {
    cmdA,
    cmdB,
    cmdC,
    slashFiltered: [cmdA, cmdB] as { cmd: string; desc: string }[],
  };
});

vi.mock('./useChatInput', () => ({
  useChatInput: () => ({
    chatInput: 'hello',
    setChatInput: vi.fn(),
    isComposing: false,
    setIsComposing: vi.fn(),
    hasUndo: false,
    handleUndoDraft: vi.fn(),
    draftInjectionTick: 0,
  }),
}));

vi.mock('./useSlashMenu', () => ({
  useSlashMenu: () => ({
    slashMenuOpen: false,
    setSlashMenuOpen: vi.fn(),
    slashSelectedIndex: 0,
    setSlashSelectedIndex: vi.fn(),
    // 每次 hook 执行都产出新数组（元素引用不变），复刻真实 .filter() 行为
    filteredCommands: [...h.slashFiltered],
    loadSkillSlash: vi.fn(),
    skillCommandsEnabled: true,
  }),
}));

vi.mock('./useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    setAttachments: vi.fn(),
    fileInputRef: { current: null },
    handleFilesSelected: vi.fn(),
    handlePathsSelected: vi.fn(),
    handleDroppedFiles: vi.fn(),
    handlePickFiles: vi.fn(),
    handlePasteImage: vi.fn(),
    handlePasteFiles: vi.fn(),
  }),
}));

vi.mock('./useChatSend', () => ({
  useChatSend: () => ({
    canSend: true,
    showPlusMenu: false,
    setShowPlusMenu: vi.fn(),
    runStreamingAssistant: vi.fn(),
    handleSendChat: vi.fn(),
    handleStopGeneration: vi.fn(),
    handleSilentStopGeneration: vi.fn(),
    handleForceCancelGeneration: vi.fn(),
  }),
}));

vi.mock('../../hooks/chat-stream/staleSessionHealer', () => ({
  settleStaleSessionProcessingMessages: vi.fn(() => ({
    healedCount: 0,
    clearedQueueCount: 0,
  })),
}));

const options = {
  wsId: 'default',
  activeSessionId: 'sess-1',
  needsKeySetup: false,
  needsModelSetup: false,
  isProcessing: false,
  handleGlobalTabClick: vi.fn(),
  setShowModelDropdown: vi.fn(),
  setPickerInlineError: vi.fn(),
};

describe('useChatComposerProps · filteredCommands 身份稳定化（R1）', () => {
  beforeEach(() => {
    h.slashFiltered = [h.cmdA, h.cmdB];
  });

  it('元素序列未变时复用同一数组引用', () => {
    const { result, rerender } = renderHook(() =>
      useChatComposerProps(options)
    );
    const first = result.current.filteredCommands;
    rerender();
    rerender();
    expect(result.current.filteredCommands).toBe(first);
  });

  it('元素增减时换新引用', () => {
    const { result, rerender } = renderHook(() =>
      useChatComposerProps(options)
    );
    const first = result.current.filteredCommands;
    h.slashFiltered = [h.cmdA, h.cmdB, h.cmdC];
    rerender();
    expect(result.current.filteredCommands).not.toBe(first);
    expect(result.current.filteredCommands).toHaveLength(3);
  });

  it('同长度但元素被替换时同样换新引用', () => {
    const { result, rerender } = renderHook(() =>
      useChatComposerProps(options)
    );
    const first = result.current.filteredCommands;
    h.slashFiltered = [h.cmdA, h.cmdC];
    rerender();
    expect(result.current.filteredCommands).not.toBe(first);
    expect(result.current.filteredCommands[1]).toBe(h.cmdC);
  });
});
