// @vitest-environment jsdom
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedExternalSession } from '../../api/import/types';
import { ToastProvider } from '../../services/toast/ToastContext';
import { ExternalSessionsWorkbench } from './ExternalSessionsWorkbench';

type PreviewStubProps = {
  session: DetectedExternalSession | null;
  onImportAndResume: (session: DetectedExternalSession) => Promise<void>;
  onOpenExisting: (sessionId: string) => void;
  existingSessionId?: string;
  isBusy: boolean;
};

const workbenchMocks = vi.hoisted(() => ({
  loadCache: vi.fn(),
  scan: vi.fn(),
  importSessions: vi.fn(),
}));

vi.mock('../../api/import/externalSessionCache', () => ({
  loadExternalSessionsFromCache: workbenchMocks.loadCache,
  getOrScanExternalSessions: workbenchMocks.scan,
}));

vi.mock('../../api/import/importSessions', () => ({
  importDetectedSessions: workbenchMocks.importSessions,
  deleteImportedSession: vi.fn(),
}));

vi.mock('../../store/storeAccess', () => ({
  useSessionStore: (selector: (state: { sessions: never[] }) => unknown) =>
    selector({ sessions: [] }),
  navigateToChatSession: vi.fn(),
}));

vi.mock('./SessionPreviewPane', () => ({
  SessionPreviewPane: ({
    session,
    onImportAndResume,
    isBusy,
  }: PreviewStubProps) =>
    session ? (
      <div data-testid="preview-pane">
        <span data-testid="preview-title">{session.title}</span>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void onImportAndResume(session)}
        >
          {isBusy ? 'busy' : 'import'}
        </button>
      </div>
    ) : null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ExternalSessionsWorkbench external identity', () => {
  const sameIdSessions: DetectedExternalSession[] = [
    {
      id: 'shared-session-id',
      source: 'claude-code',
      title: 'Claude shared ID',
      messageCount: 1,
    },
    {
      id: 'shared-session-id',
      source: 'codex',
      title: 'Codex shared ID',
      messageCount: 1,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    workbenchMocks.loadCache.mockReturnValue({
      sessions: sameIdSessions,
      issues: [],
    });
    workbenchMocks.scan.mockResolvedValue({
      sessions: sameIdSessions,
      issues: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps same-ID rows distinct and scopes the busy state to the source', async () => {
    const pendingImport = deferred<{
      imported: number;
      skipped: number;
      skippedDuplicates: number;
      errors: string[];
      sessionIds: string[];
    }>();
    workbenchMocks.importSessions.mockReturnValue(pendingImport.promise);
    const reactErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: '全部' }));

    const claudeCard = screen.getByRole('button', {
      name: /Claude shared ID/,
    });
    const codexCard = screen.getByRole('button', {
      name: /Codex shared ID/,
    });
    expect(claudeCard).not.toBeNull();
    expect(codexCard).not.toBeNull();
    expect(claudeCard).not.toBe(codexCard);
    expect(reactErrorSpy.mock.calls.flat().join(' ')).not.toMatch(/same key/i);

    fireEvent.click(codexCard!);
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    expect(workbenchMocks.importSessions).toHaveBeenCalledWith([
      sameIdSessions[1],
    ]);
    expect(screen.getByRole('button', { name: 'busy' })).toBeDefined();

    fireEvent.click(claudeCard!);
    expect(screen.getByTestId('preview-title').textContent).toBe(
      'Claude shared ID'
    );
    expect(screen.getByRole('button', { name: 'import' })).toHaveProperty(
      'disabled',
      false
    );

    await act(async () => {
      pendingImport.resolve({
        imported: 0,
        skipped: 1,
        skippedDuplicates: 0,
        errors: [],
        sessionIds: [],
      });
      await pendingImport.promise;
    });
  });
});
