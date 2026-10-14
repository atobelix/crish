// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ImportPluginSettingsModal } from './ImportPluginSettingsModal';
import { ToastProvider } from '../../services/toast/ToastContext';
import * as importRootSettings from '../../api/import/importRootSettings';

describe('ImportPluginSettingsModal', () => {
  const onClose = vi.fn();
  const onScanNeeded = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders modal when open is true', () => {
    render(
      <ToastProvider>
        <ImportPluginSettingsModal
          open={true}
          onClose={onClose}
          onScanNeeded={onScanNeeded}
        />
      </ToastProvider>
    );

    expect(screen.getByText('外部对话导入设置')).toBeDefined();
    expect(screen.getByText('自动导入新对话')).toBeDefined();
    expect(screen.getByText('Claude 配置根目录')).toBeDefined();
    expect(screen.getByText('Codex 主目录')).toBeDefined();
  });

  it('handles auto sync switch toggle and persists state', () => {
    render(
      <ToastProvider>
        <ImportPluginSettingsModal
          open={true}
          onClose={onClose}
          onScanNeeded={onScanNeeded}
        />
      </ToastProvider>
    );

    const switchBtn = screen.getByLabelText('自动导入新对话开关');
    fireEvent.click(switchBtn);
    expect(localStorage.getItem('crish_auto_sync_external_sessions')).toBe(
      'true'
    );

    fireEvent.click(switchBtn);
    expect(localStorage.getItem('crish_auto_sync_external_sessions')).toBe(
      'false'
    );
  });

  it('saves and resets custom Claude path', () => {
    const saveClaudeSpy = vi.spyOn(
      importRootSettings,
      'setPersistedClaudeImportRoot'
    );

    render(
      <ToastProvider>
        <ImportPluginSettingsModal
          open={true}
          onClose={onClose}
          onScanNeeded={onScanNeeded}
        />
      </ToastProvider>
    );

    const claudeInput = screen.getByPlaceholderText(
      '如：C:\\Users\\用户名\\.claude'
    );
    fireEvent.change(claudeInput, { target: { value: 'D:\\Custom\\.claude' } });

    // Click first "保存" button
    const saveButtons = screen.getAllByRole('button', { name: '保存' });
    fireEvent.click(saveButtons[0]!);

    expect(saveClaudeSpy).toHaveBeenCalledWith('D:\\Custom\\.claude');
    expect(onScanNeeded).toHaveBeenCalled();

    // Click first "重置" button
    const resetButtons = screen.getAllByRole('button', { name: '重置' });
    fireEvent.click(resetButtons[0]!);

    expect(saveClaudeSpy).toHaveBeenCalledWith(null);
  });

  it('saves and resets custom Codex path', () => {
    const saveCodexSpy = vi.spyOn(
      importRootSettings,
      'setPersistedCodexImportRoot'
    );

    render(
      <ToastProvider>
        <ImportPluginSettingsModal
          open={true}
          onClose={onClose}
          onScanNeeded={onScanNeeded}
        />
      </ToastProvider>
    );

    const codexInput = screen.getByPlaceholderText(
      '如：C:\\Users\\用户名\\.codex'
    );
    fireEvent.change(codexInput, { target: { value: 'E:\\Custom\\.codex' } });

    // Click second "保存" button
    const saveButtons = screen.getAllByRole('button', { name: '保存' });
    fireEvent.click(saveButtons[1]!);

    expect(saveCodexSpy).toHaveBeenCalledWith('E:\\Custom\\.codex');
    expect(onScanNeeded).toHaveBeenCalled();

    // Click second "重置" button
    const resetButtons = screen.getAllByRole('button', { name: '重置' });
    fireEvent.click(resetButtons[1]!);

    expect(saveCodexSpy).toHaveBeenCalledWith(null);
  });

  it('renders imported sessions management card and handles clean all flow', async () => {
    // Import dynamically or spy on cleanAllImportedExternalSessions
    const importSessionsModule =
      await import('../../api/import/importSessions');
    const cleanSpy = vi
      .spyOn(importSessionsModule, 'cleanAllImportedExternalSessions')
      .mockResolvedValue(5);

    const sessionStoreModule = await import('../../store/sessionStore');
    vi.spyOn(sessionStoreModule, 'useSessionStore').mockImplementation(((
      selector: any
    ) => {
      const state = {
        sessions: [
          {
            id: '1',
            importMeta: { source: 'claude-code', sourceSessionId: 'c1' },
          },
          { id: '2', importMeta: { source: 'codex', sourceSessionId: 'x1' } },
        ],
      };
      return selector ? selector(state) : state;
    }) as any);

    render(
      <ToastProvider>
        <ImportPluginSettingsModal
          open={true}
          onClose={onClose}
          onScanNeeded={onScanNeeded}
        />
      </ToastProvider>
    );

    expect(screen.getByText('已导入外部对话管理')).toBeDefined();
    expect(
      screen.getByText(/当前系统内共有 2 个已导入的外部对话/)
    ).toBeDefined();

    const cleanBtn = screen.getByRole('button', { name: /清空所有已导入对话/ });
    expect(cleanBtn).toBeDefined();

    // Click to open confirmation
    fireEvent.click(cleanBtn);
    expect(screen.getByText(/确定清空全部 2 个已导入外部对话？/)).toBeDefined();

    // Click confirm
    const confirmBtn = screen.getByRole('button', { name: '确认清空' });
    fireEvent.click(confirmBtn);

    expect(cleanSpy).toHaveBeenCalled();
  });
});
