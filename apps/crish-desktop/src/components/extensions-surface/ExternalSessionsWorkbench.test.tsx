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
    const allTab = screen.getByText('全部');
    fireEvent.click(allTab);

    expect(
      screen.getAllByText('Fix issue in auth module').length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('Refactor database models').length
    ).toBeGreaterThanOrEqual(1);
  });
});
