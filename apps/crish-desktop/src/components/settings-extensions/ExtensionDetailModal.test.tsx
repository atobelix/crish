// @vitest-environment jsdom
/**
 * 插件详情弹层：标题、操作和说明收在同一块，不再拆出空的简介带。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInstalledExtension } from './types';
import { ExtensionDetailModal } from './ExtensionDetailModal';

const mcpState = {
  expandedMcpTools: new Set<string>(),
  toolTick: 0,
  mcpServerBusy: false,
  mcpToolBusy: false,
};

function importPlugin(): PluginInstalledExtension {
  return {
    id: '@crish/plugin-import-claude-codex',
    kind: 'plugin',
    source: 'official',
    name: '外部历史对话接续与导入',
    description: '探测并接续本机 Claude 与 Codex 会话记录，一键导入迁移',
    pluginId: '@crish/import-claude-codex',
    pluginVersion: '1.0.0',
    pluginEnabled: true,
    pluginTools: [],
    pluginHooks: [],
  };
}

describe('ExtensionDetailModal', () => {
  afterEach(() => {
    cleanup();
  });

  it('把说明收进标题，操作贴在名称旁边', () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    const onOpenExternalSync = vi.fn();

    render(
      <ExtensionDetailModal
        open
        onClose={onClose}
        scope="installed"
        item={importPlugin()}
        canUninstall
        mcpState={mcpState}
        onRemovePackage={onRemove}
        onOpenExternalSync={onOpenExternalSync}
      />
    );

    expect(screen.queryByText('简介')).toBeNull();
    expect(
      screen.getByText('探测并接续本机 Claude 与 Codex 会话记录，一键导入迁移')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '卸载' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '进入导入与管理' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenExternalSync).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '卸载' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
