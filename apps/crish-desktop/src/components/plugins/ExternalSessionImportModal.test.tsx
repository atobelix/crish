// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type {
  DetectedExternalSession,
  ExternalSessionSourceScan,
} from '../../api/import/types';
import { ToastProvider } from '../../services/toast/ToastContext';
import { ExternalSessionImportModal } from './ExternalSessionImportModal';

const scanMocks = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
}));

vi.mock('../../api/import/scan', () => ({
  scanClaudeCodeSessions: scanMocks.claude,
  scanCodexSessions: scanMocks.codex,
  combineExternalSessionScans: (scans: ExternalSessionSourceScan[]) => ({
    sessions: scans.flatMap((scan) => scan.sessions),
    issues: scans.flatMap((scan) => scan.issues),
  }),
}));

function sourceScan(
  source: 'claude-code' | 'codex',
  sessions: DetectedExternalSession[],
  issues: ExternalSessionSourceScan['issues'] = []
): ExternalSessionSourceScan {
  return { source, sessions, issues };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ExternalSessionImportModal scan state', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    scanMocks.claude.mockResolvedValue(sourceScan('claude-code', []));
    scanMocks.codex.mockResolvedValue(sourceScan('codex', []));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('labels a readable empty scan as completed with no sessions', async () => {
    render(
      <ToastProvider>
        <ExternalSessionImportModal open onClose={vi.fn()} />
      </ToastProvider>
    );

    expect(
      await screen.findByText('扫描完成，未发现外部历史对话')
    ).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows unreadable sources as incomplete instead of claiming there are no sessions', async () => {
    scanMocks.claude.mockResolvedValue(
      sourceScan(
        'claude-code',
        [],
        [
          {
            source: 'claude-code',
            kind: 'warning',
            message: 'Claude projects dir not readable',
          },
        ]
      )
    );

    render(
      <ToastProvider>
        <ExternalSessionImportModal open onClose={vi.fn()} />
      </ToastProvider>
    );

    expect(
      await screen.findByText(
        '暂时无法确认是否存在可导入会话，请检查上方扫描状态或配置路径后重试。'
      )
    ).toBeDefined();
    expect(screen.getByText(/Claude Code 扫描提示/)).toBeDefined();
    expect(screen.queryByText('扫描完成，未发现外部历史对话')).toBeNull();
  });

  it('reports when both sources fail and keeps each source diagnostic', async () => {
    scanMocks.claude.mockResolvedValue(
      sourceScan(
        'claude-code',
        [],
        [
          {
            source: 'claude-code',
            kind: 'error',
            message: 'Claude root denied',
          },
        ]
      )
    );
    scanMocks.codex.mockResolvedValue(
      sourceScan(
        'codex',
        [],
        [
          {
            source: 'codex',
            kind: 'error',
            message: 'Codex root denied',
          },
        ]
      )
    );

    render(
      <ToastProvider>
        <ExternalSessionImportModal open onClose={vi.fn()} />
      </ToastProvider>
    );

    expect(
      await screen.findByText(/全部来源扫描失败，无法确认是否存在外部会话/)
    ).toBeDefined();
    expect(
      screen.getByText(/Claude Code 扫描失败：Claude root denied/)
    ).toBeDefined();
    expect(screen.getByText(/Codex 扫描失败：Codex root denied/)).toBeDefined();
    expect(screen.queryByText('扫描完成，未发现外部历史对话')).toBeNull();
  });

  it('keeps same-ID Claude and Codex sessions as separate rows', async () => {
    const sameId = 'shared-session-id';
    scanMocks.claude.mockResolvedValue(
      sourceScan('claude-code', [
        {
          id: sameId,
          source: 'claude-code',
          title: 'Claude shared ID',
          messageCount: 1,
        },
      ])
    );
    scanMocks.codex.mockResolvedValue(
      sourceScan('codex', [
        {
          id: sameId,
          source: 'codex',
          title: 'Codex shared ID',
          messageCount: 1,
        },
      ])
    );
    const reactErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    render(
      <ToastProvider>
        <ExternalSessionImportModal open onClose={vi.fn()} />
      </ToastProvider>
    );
    fireEvent.click(await screen.findByRole('tab', { name: /全部/ }));

    expect(screen.getByText('Claude shared ID')).toBeDefined();
    expect(screen.getByText('Codex shared ID')).toBeDefined();
    expect(screen.getAllByRole('button', { name: '同步呈现' })).toHaveLength(2);
    expect(reactErrorSpy.mock.calls.flat().join(' ')).not.toMatch(/same key/i);
    reactErrorSpy.mockRestore();
  });

  it('ignores a slower scan from a closed modal after a newer open scan completes', async () => {
    const oldScan = deferred<ExternalSessionSourceScan>();
    const newSession: DetectedExternalSession = {
      id: 'new-session',
      source: 'claude-code',
      title: 'New scan result',
      messageCount: 1,
    };
    const oldSession: DetectedExternalSession = {
      id: 'old-session',
      source: 'claude-code',
      title: 'Old scan result',
      messageCount: 1,
    };
    scanMocks.claude
      .mockReturnValueOnce(oldScan.promise)
      .mockResolvedValueOnce(sourceScan('claude-code', [newSession]));

    const onClose = vi.fn();
    const view = render(
      <ToastProvider>
        <ExternalSessionImportModal open onClose={onClose} />
      </ToastProvider>
    );
    await waitFor(() => expect(scanMocks.claude).toHaveBeenCalledTimes(1));

    view.rerender(
      <ToastProvider>
        <ExternalSessionImportModal open={false} onClose={onClose} />
      </ToastProvider>
    );
    view.rerender(
      <ToastProvider>
        <ExternalSessionImportModal open onClose={onClose} />
      </ToastProvider>
    );

    await waitFor(() => expect(scanMocks.claude).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('tab', { name: /全部/ }));
    expect(await screen.findByText('New scan result')).toBeDefined();

    await act(async () => {
      oldScan.resolve(sourceScan('claude-code', [oldSession]));
      await oldScan.promise;
    });

    expect(screen.getByText('New scan result')).toBeDefined();
    expect(screen.queryByText('Old scan result')).toBeNull();
  });
});
