// @vitest-environment jsdom
/**
 * SettingsSecurityTab 用户视角测试：
 * 验证三态权限模式单选卡片组（ask / smart / full）的渲染与切换交互。
 * 遵循极简架构契约：彻底消除虚假白名单与路径展示。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsSecurityTab } from './SettingsSecurityTab';
import { ToastProvider } from '../../services/toast';
import { usePermissionStore } from '../../store/permissionStore';
import type { PermissionMode } from '@crish/shared-types';

function renderTab() {
  return render(
    <ToastProvider>
      <SettingsSecurityTab />
    </ToastProvider>
  );
}

describe('SettingsSecurityTab（现代三态权限设置）', () => {
  beforeEach(() => {
    usePermissionStore.setState({
      permissionMode: 'smart',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('渲染 3 个权限单选卡片，且智能放行为推荐项', () => {
    renderTab();

    const radiogroup = screen.getByRole('radiogroup', { name: /执行权限模式/ });
    expect(radiogroup).toBeInTheDocument();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);

    // 默认 smart 处于选中态
    const smartRadio = radios.find(
      (r) => r.getAttribute('aria-checked') === 'true'
    );
    expect(smartRadio).toBeDefined();
    expect(smartRadio).toHaveTextContent(/智能放行/);
    expect(smartRadio).toHaveTextContent(/推荐/);
  });

  it('点击「每次询问」卡片正确切换权限模式', () => {
    renderTab();

    const askCard = screen.getByText('每次询问').closest('button')!;
    expect(askCard).toBeInTheDocument();
    expect(askCard.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(askCard);

    expect(usePermissionStore.getState().permissionMode).toBe('ask');
    expect(askCard.getAttribute('aria-checked')).toBe('true');
  });

  it('点击「完全允许」卡片正确切换权限模式', () => {
    renderTab();

    const fullCard = screen.getByText('完全允许').closest('button')!;
    expect(fullCard).toBeInTheDocument();
    expect(fullCard.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(fullCard);

    expect(usePermissionStore.getState().permissionMode).toBe('full');
    expect(fullCard.getAttribute('aria-checked')).toBe('true');
  });

  it('初始为 ask 模式时能够正确回显选中态', () => {
    usePermissionStore.setState({ permissionMode: 'ask' });
    renderTab();

    const askCard = screen.getByText('每次询问').closest('button')!;
    expect(askCard.getAttribute('aria-checked')).toBe('true');
  });
});
