// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExternalLongSessionDetection } from '../useExternalLongSessionDetection';
import * as autoSync from '../../../api/import/autoSyncExternalSessions';
import * as importSessions from '../../../api/import/importSessions';
import {
  useSessionStore,
  useWorkspaceShellStore,
} from '../../../store/storeAccess';
import * as ToastContext from '../../../services/toast/ToastContext';

vi.mock('../../../api/import/autoSyncExternalSessions');
vi.mock('../../../api/import/importSessions');
vi.mock('../../../services/toast/ToastContext');

describe('useExternalLongSessionDetection', () => {
  const showToastMock = vi.fn();
  let openSessionMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      sessionsById: {},
    });
    openSessionMock = vi.fn((sessionId: string) => {
      useSessionStore.getState().setActiveSessionId(sessionId);
    });
    useWorkspaceShellStore.setState({ openSession: openSessionMock });
    vi.mocked(ToastContext.useToast).mockReturnValue({
      showToast: showToastMock,
      toast: null,
      hideToast: vi.fn(),
    });
  });

  it('does not detect when not in landing or empty state', async () => {
    const { result } = renderHook(() =>
      useExternalLongSessionDetection({
        emptyKind: null,
        activeSessionId: 'sess-1',
      })
    );

    expect(result.current.previewExternalSession).toBeNull();
    expect(autoSync.detectLatestExternalLongSession).not.toHaveBeenCalled();
  });

  it('detects and sets previewExternalSession on landing empty state', async () => {
    const mockResult: autoSync.DetectedLongSessionResult = {
      detected: {
        id: 'ext-sess-1',
        source: 'claude-code',
        title: 'Claude 历史长会话',
        messageCount: 14,
      },
      mapped: {
        source: 'claude-code',
        sourceId: 'ext-sess-1',
        title: 'Claude 历史长会话',
        messages: [
          {
            id: 'm1',
            sender: 'user',
            text: 'Hi',
            timestamp: 1000,
            status: 'completed',
          },
          {
            id: 'm2',
            sender: 'assistant',
            text: 'Hello',
            timestamp: 1001,
            status: 'completed',
          },
        ],
      },
    };

    vi.mocked(autoSync.detectLatestExternalLongSession).mockResolvedValue(
      mockResult
    );

    const { result } = renderHook(() =>
      useExternalLongSessionDetection({
        emptyKind: 'session-empty',
        activeSessionId: 'empty-sess-id',
      })
    );

    // 等待异步探测完成
    await act(async () => {
      await Promise.resolve();
    });

    expect(autoSync.detectLatestExternalLongSession).toHaveBeenCalledTimes(1);
    expect(result.current.previewExternalSession).toEqual(mockResult);
  });

  it('imports session and continues conversation upon handleImportAndContinue', async () => {
    const mockResult: autoSync.DetectedLongSessionResult = {
      detected: {
        id: 'ext-sess-2',
        source: 'codex',
        title: 'Codex 探索长对话',
        messageCount: 18,
      },
      mapped: {
        source: 'codex',
        sourceId: 'ext-sess-2',
        title: 'Codex 探索长对话',
        messages: [
          {
            id: 'm1',
            sender: 'user',
            text: 'query',
            timestamp: 2000,
            status: 'completed',
          },
        ],
      },
    };

    vi.mocked(autoSync.detectLatestExternalLongSession).mockResolvedValue(
      mockResult
    );
    vi.mocked(importSessions.importDetectedSessions).mockImplementation(
      async () => {
        useSessionStore.getState().createSession({
          id: 'imported-crish-id-123',
          title: 'Codex 探索长对话',
        });
        return {
          imported: 1,
          skipped: 0,
          skippedDuplicates: 0,
          errors: [],
          sessionIds: ['imported-crish-id-123'],
        };
      }
    );

    const { result } = renderHook(() =>
      useExternalLongSessionDetection({
        emptyKind: 'no-session',
        activeSessionId: null,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.previewExternalSession).not.toBeNull();

    await act(async () => {
      await result.current.handleImportAndContinue();
    });

    expect(importSessions.importDetectedSessions).toHaveBeenCalledWith([
      mockResult.detected,
    ]);
    expect(openSessionMock).toHaveBeenCalledWith('imported-crish-id-123', {
      title: 'Codex 探索长对话',
      workspaceKey: '对话',
    });
    expect(useSessionStore.getState().activeSessionId).toBe(
      'imported-crish-id-123'
    );
    expect(result.current.previewExternalSession).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(
      '已成功导入并接续该对话，您可以直接在此继续提问！'
    );
  });

  it('retrieves existing session and continues conversation when already imported (soft dedup)', async () => {
    const mockResult: autoSync.DetectedLongSessionResult = {
      detected: {
        id: 'session-abc-123',
        source: 'claude-code',
        title: '已存在的长对话',
        messageCount: 20,
      },
      mapped: {
        source: 'claude-code',
        sourceId: 'session-abc-123',
        title: '已存在的长对话',
        folder: 'my-project',
        messages: [
          {
            id: 'm1',
            sender: 'user',
            text: 'query',
            timestamp: 2000,
            status: 'completed',
          },
        ],
      },
    };

    const expectedId = 'sess-import-claude-session-abc-123';
    useSessionStore.setState({
      sessionsById: {
        [expectedId]: {
          id: expectedId,
          title: '已存在的长对话',
        } as any,
      },
    });

    vi.mocked(autoSync.detectLatestExternalLongSession).mockResolvedValue(
      mockResult
    );
    // 模拟软去重，返回空 sessionIds
    vi.mocked(importSessions.importDetectedSessions).mockResolvedValue({
      imported: 0,
      skipped: 1,
      skippedDuplicates: 1,
      errors: [],
      sessionIds: [],
    });

    const { result } = renderHook(() =>
      useExternalLongSessionDetection({
        emptyKind: 'session-empty',
        activeSessionId: null,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handleImportAndContinue();
    });

    expect(openSessionMock).toHaveBeenCalledWith(expectedId, {
      title: '已存在的长对话',
      workspaceKey: 'my-project',
    });
    expect(result.current.previewExternalSession).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(
      '已成功导入并接续该对话，您可以直接在此继续提问！'
    );
  });

  it('dismisses preview upon handleDismissPreview', async () => {
    const mockResult: autoSync.DetectedLongSessionResult = {
      detected: {
        id: 'ext-sess-3',
        source: 'claude-code',
        title: '测试',
        messageCount: 10,
      },
      mapped: {
        source: 'claude-code',
        sourceId: 'ext-sess-3',
        title: '测试',
        messages: [],
      },
    };

    vi.mocked(autoSync.detectLatestExternalLongSession).mockResolvedValue(
      mockResult
    );

    const { result } = renderHook(() =>
      useExternalLongSessionDetection({
        emptyKind: 'session-empty',
        activeSessionId: null,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.previewExternalSession).not.toBeNull();

    act(() => {
      result.current.handleDismissPreview();
    });

    expect(result.current.previewExternalSession).toBeNull();
  });
});
