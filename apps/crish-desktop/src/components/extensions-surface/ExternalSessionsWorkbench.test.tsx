// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ExternalSessionsWorkbench } from './ExternalSessionsWorkbench';
import { ToastProvider } from '../../services/toast/ToastContext';
import * as externalSessionCache from '../../api/import/externalSessionCache';
import type { DetectedExternalSession } from '../../api/import/types';

describe('ExternalSessionsWorkbench', () => {
  const mockSessions: DetectedExternalSession[] = [
    {
      id: 'session-1',
      source: 'claude-code',
      title: 'Fix issue in auth module',
      updatedAt: 1700000000000,
      cwd: '/workspace/project',
      project: 'project',
      messageCount: 5,
    },
    {
      id: 'session-2',
      source: 'codex',
      title: 'Refactor database models',
      updatedAt: 1700001000000,
      cwd: '/workspace/project',
      project: 'project',
      messageCount: 12,
    },
    {
      id: 'session-3',
      source: 'claude-code',
      title: 'Empty ghost session',
      updatedAt: 1700002000000,
      cwd: '/workspace/project',
      project: 'project',
      messageCount: 0,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(
      externalSessionCache,
      'loadExternalSessionsFromCache'
    ).mockReturnValue(mockSessions);
    vi.spyOn(
      externalSessionCache,
      'getOrScanExternalSessions'
    ).mockResolvedValue(mockSessions);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title, rescan button, and configure settings button', () => {
    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );

    expect(screen.getByText('外部对话导入与接续')).toBeDefined();
    expect(screen.getByText('重新扫描')).toBeDefined();
    expect(screen.getByText('配置设置')).toBeDefined();
  });

  it('opens secondary settings modal when clicking 配置设置 button', () => {
    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );

    const configBtn = screen.getByText('配置设置');
    fireEvent.click(configBtn);

    // Modal should now be opened
    expect(screen.getByText('外部对话导入设置')).toBeDefined();
  });

  it('renders detected session cards with 2-level content and source', () => {
    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );

    // Filter to all to view both
    const allTab = screen.getAllByRole('button', { name: '全部' })[0]!;
    fireEvent.click(allTab);

    expect(
      screen.getAllByText('Fix issue in auth module').length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('Refactor database models').length
    ).toBeGreaterThanOrEqual(1);
  });

  it('displays （空） label for zero-message session and filters via 仅有内容 toggle', () => {
    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );

    const allTab = screen.getByRole('button', { name: '全部' });
    fireEvent.click(allTab);

    expect(screen.getByText('Empty ghost session')).toBeDefined();
    expect(screen.getByText('（空）')).toBeDefined();

    // Find the toggle button in right slot
    const toggleBtn = screen.getByRole('button', { name: '全部会话' });
    fireEvent.click(toggleBtn);

    // After toggling, empty session should be filtered out
    expect(screen.queryByText('Empty ghost session')).toBeNull();
  });

  it('accurately computes isImported and renders open/delete buttons', async () => {
    const importSessionsModule =
      await import('../../api/import/importSessions');
    const deleteSpy = vi
      .spyOn(importSessionsModule, 'deleteImportedSession')
      .mockReturnValue(true);

    const sessionStoreModule = await import('../../store/sessionStore');
    vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(((
      selector: any
    ) => {
      const state = {
        sessions: [
          {
            id: 'real-session-1',
            title: 'Fix issue in auth module',
            importMeta: { source: 'claude-code', sourceSessionId: 'session-1' },
          },
        ],
      };
      return selector ? selector(state) : state;
    }) as any);

    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );

    // Switch to all tab so workspace filter does not hide mock items
    const allTab = screen.getByRole('button', { name: '全部' });
    fireEvent.click(allTab);

    // Card should show 已接续 badge
    expect(screen.getByText('已接续')).toBeDefined();

    // Select session-1 card
    const cardTitle = screen.getAllByText('Fix issue in auth module')[0]!;
    fireEvent.click(cardTitle);

    // Right detail header should have both 打开已接续对话 and 删除该接续对话
    expect(screen.getByText('打开已接续对话')).toBeDefined();
    const deleteBtn = screen.getByText('删除该接续对话');
    expect(deleteBtn).toBeDefined();

    // Click delete
    fireEvent.click(deleteBtn);
    expect(deleteSpy).toHaveBeenCalledWith('real-session-1');
  });

  it('does not falsely mark other sessions as 已接续 when sharing a parent directory with UUID', async () => {
    const parentUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const collisionMockSessions: DetectedExternalSession[] = [
      {
        id: 'session-alpha',
        source: 'claude-code',
        title: 'Alpha Session',
        updatedAt: 1700000000000,
        path: `/workspace/projects/${parentUuid}/session-alpha.jsonl`,
        messageCount: 5,
      },
      {
        id: 'session-beta',
        source: 'claude-code',
        title: 'Beta Session',
        updatedAt: 1700001000000,
        path: `/workspace/projects/${parentUuid}/session-beta.jsonl`,
        messageCount: 3,
      },
    ];

    vi.spyOn(
      externalSessionCache,
      'loadExternalSessionsFromCache'
    ).mockReturnValue(collisionMockSessions);
    vi.spyOn(
      externalSessionCache,
      'getOrScanExternalSessions'
    ).mockResolvedValue(collisionMockSessions);

    const sessionStoreModule = await import('../../store/sessionStore');
    vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(((
      selector: any
    ) => {
      const state = {
        sessions: [
          {
            id: 'conex-alpha-id',
            title: 'Alpha Session',
            importMeta: {
              source: 'claude-code',
              sourceSessionId: 'session-alpha',
              sourcePath: `/workspace/projects/${parentUuid}/session-alpha.jsonl`,
            },
          },
        ],
      };
      return selector ? selector(state) : state;
    }) as any);

    render(
      <ToastProvider>
        <ExternalSessionsWorkbench />
      </ToastProvider>
    );

    const allTab = screen.getByRole('button', { name: '全部' });
    fireEvent.click(allTab);

    // There should be exactly 1 "已接续" badge on the entire workbench, NOT 2!
    const badges = screen.queryAllByText('已接续');
    expect(badges.length).toBe(1);

    // Click on Beta Session (which is not imported)
    const betaCard = screen.getByText('Beta Session');
    fireEvent.click(betaCard);

    // Beta session should NOT show "打开已接续对话" or "删除该接续对话", but rather "导入并接续对话"
    expect(screen.queryByText('打开已接续对话')).toBeNull();
    expect(screen.queryByText('删除该接续对话')).toBeNull();
    expect(screen.getByText('导入并接续对话')).toBeDefined();
  });
});
