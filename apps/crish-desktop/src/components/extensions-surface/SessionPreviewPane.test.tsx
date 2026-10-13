// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { SessionPreviewPane } from './SessionPreviewPane';
import * as mapModule from '../../api/import/map';
import type {
  DetectedExternalSession,
  MappedImportSession,
} from '../../api/import/types';

describe('SessionPreviewPane', () => {
  const mockSession: DetectedExternalSession = {
    id: 'test-session-1',
    source: 'claude-code',
    title: 'Test Session Title',
    updatedAt: 1700000000000,
    cwd: '/test/cwd',
    project: 'test-proj',
    messageCount: 2,
  };

  const mockMapped: MappedImportSession = {
    source: 'claude-code',
    sourceId: 'test-session-1',
    title: 'Test Session Title',
    messages: [
      {
        id: 'msg-1',
        sender: 'user',
        timestamp: 1700000001000,
        status: 'completed',
        text: 'Hello assistant! How are you?',
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        timestamp: 1700000002000,
        status: 'completed',
        text: 'I am doing well, thank you!',
        thinking: 'I will respond politely to the greeting.',
        toolCalls: [
          {
            id: 'call-1',
            name: 'view_file',
            status: 'success',
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(mapModule, 'mapExternalSession').mockResolvedValue(mockMapped);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders empty state when session is null', () => {
    render(
      <SessionPreviewPane
        session={null}
        onImportAndResume={vi.fn()}
        onOpenExisting={vi.fn()}
        isBusy={false}
      />
    );

    expect(screen.getByText('请在左侧选择对话记录')).toBeDefined();
    expect(screen.getByText(/选中后将直接展示对话内容/)).toBeDefined();
  });

  it('renders header with title and subtitle without redundant badges or status banners', async () => {
    render(
      <SessionPreviewPane
        session={mockSession}
        onImportAndResume={vi.fn()}
        onOpenExisting={vi.fn()}
        isBusy={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Test Session Title')).toBeDefined();
    });

    // Subtitle has source and message count
    expect(screen.getByText('Claude Code · 2 条消息')).toBeDefined();

    // Redundant badges must NOT exist
    expect(screen.queryByText('解析正常')).toBeNull();
    expect(screen.queryByText('用户输入')).toBeNull();
    expect(screen.queryByText('模型输出')).toBeNull();
    expect(screen.queryByText('Claude 回复')).toBeNull();
    expect(screen.queryByText('Codex 回复')).toBeNull();
  });

  it('renders "导入并接续对话" button when existingSessionId is not present and calls handler', async () => {
    const handleImport = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionPreviewPane
        session={mockSession}
        onImportAndResume={handleImport}
        onOpenExisting={vi.fn()}
        isBusy={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('导入并接续对话')).toBeDefined();
    });

    const btn = screen.getByText('导入并接续对话');
    fireEvent.click(btn);
    expect(handleImport).toHaveBeenCalledWith(mockSession);
  });

  it('renders "打开已接续对话" button when existingSessionId is present and calls handler', async () => {
    const handleOpenExisting = vi.fn();
    render(
      <SessionPreviewPane
        session={mockSession}
        onImportAndResume={vi.fn()}
        onOpenExisting={handleOpenExisting}
        existingSessionId="conex-session-99"
        isBusy={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('打开已接续对话')).toBeDefined();
    });

    const btn = screen.getByText('打开已接续对话');
    fireEvent.click(btn);
    expect(handleOpenExisting).toHaveBeenCalledWith('conex-session-99');
  });

  it('renders normal chat stream with user bubble and assistant details', async () => {
    render(
      <SessionPreviewPane
        session={mockSession}
        onImportAndResume={vi.fn()}
        onOpenExisting={vi.fn()}
        isBusy={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Hello assistant! How are you?')).toBeDefined();
    });

    // User message
    expect(screen.getByText('Hello assistant! How are you?')).toBeDefined();

    // Assistant message text
    expect(screen.getByText('I am doing well, thank you!')).toBeDefined();

    // Thinking process in details
    expect(screen.getByText('思考过程')).toBeDefined();
    expect(
      screen.getByText('I will respond politely to the greeting.')
    ).toBeDefined();

    // Tool chip
    expect(screen.getByText('view_file')).toBeDefined();
    expect(screen.getByText('调用成功')).toBeDefined();
  });
});
