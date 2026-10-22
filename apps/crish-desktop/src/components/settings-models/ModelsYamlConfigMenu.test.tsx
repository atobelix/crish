// @vitest-environment jsdom
/**
 * ModelsYamlConfigMenu：文案走 i18n（zh-CN 与拆分前逐字一致，en-US 为英文），交互回调不变。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { mockTauriCommand } from '../../test-setup';
import { I18nProvider, type SupportedLanguage } from '../../i18n';
import { ModelsYamlConfigMenu } from './ModelsYamlConfigMenu';

function renderMenu(
  lang: SupportedLanguage,
  onOpenBuiltinEditor = vi.fn(),
  notify = vi.fn()
) {
  render(
    <I18nProvider initialLanguage={lang}>
      <ModelsYamlConfigMenu
        onOpenBuiltinEditor={onOpenBuiltinEditor}
        notify={notify}
      />
    </I18nProvider>
  );
  return { onOpenBuiltinEditor, notify };
}

describe('ModelsYamlConfigMenu i18n', () => {
  beforeEach(() => {
    mockTauriCommand('workbench_list_host_openers', () => []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('zh-CN：主按钮与下拉触发器的文案、无障碍名保持原中文', () => {
    renderMenu('zh-CN');
    const main = screen.getByRole('button', {
      name: '在内置编辑器中编辑模型配置文件 (models.yaml)',
    });
    expect(main.textContent).toContain('模型配置文件 (models.yaml)');
    expect(
      screen.getByRole('button', { name: '配置文件直达与打开方式' })
    ).toBeTruthy();
  });

  it('en-US：展示英文文案且不含中文，主按钮打开内置编辑器', () => {
    const { onOpenBuiltinEditor } = renderMenu('en-US');
    const main = screen.getByRole('button', {
      name: 'Edit the model config file (models.yaml) in the built-in editor',
    });
    expect(main.textContent).toContain('Model config file (models.yaml)');
    expect(main.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(
      screen.getByRole('button', {
        name: 'Config file shortcuts and open options',
      })
    ).toBeTruthy();
    fireEvent.click(main);
    expect(onOpenBuiltinEditor).toHaveBeenCalledTimes(1);
  });
});
