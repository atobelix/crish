// @vitest-environment jsdom
/**
 * ModelBadgePickerMenu（ui/Menu 基座迁移版）交互测试：
 * 打开/选择（激活模型）/Esc/外点关闭/管理入口
 */
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ModelBadgePickerMenu } from './ModelBadgePickerMenu';

const PROFILES_KEY = 'crish_provider_profiles_v1';

function seedProfiles() {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify([
      {
        id: 'p1',
        name: '测试服务商',
        baseUrl: 'https://example.com',
        hasKey: false,
        enabled: true,
        models: ['model-a', 'model-b'],
      },
    ])
  );
}

function Wrapper({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ModelBadgePickerMenu
      activeModel="model-a"
      open={open}
      onClose={() => {
        setOpen(false);
        onClose?.();
      }}
    >
      <button type="button" data-testid="model-badge-trigger">
        模型徽标
      </button>
    </ModelBadgePickerMenu>
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ModelBadgePickerMenu（ui/Menu 基座）', () => {
  it('渲染服务商行与模型管理入口', async () => {
    seedProfiles();
    render(<Wrapper />);
    expect(screen.getByText('测试服务商')).toBeInTheDocument();
    expect(screen.getByText('模型管理...')).toBeInTheDocument();
  });

  it('点击「模型管理...」调用打开设置并关闭', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.click(screen.getByText('模型管理...'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Esc 关闭（经基座 onOpenChange → onClose）', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    // 基座浮层内容（Radix Popover.Content，role=dialog）
    fireEvent.keyDown(await screen.findByRole('dialog'), {
      key: 'Escape',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('外点关闭（真实外点 pointerdown+click，经基座 onOpenChange → onClose）', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    await screen.findByRole('dialog');
    const outside = document.createElement('button');
    outside.textContent = '外部';
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    outside.remove();
  });

  it('无服务商时显示空态', () => {
    // loadProfiles 对空存储会回填默认服务商，故用「全部禁用」制造空列表
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'p-disabled',
          name: '已停用服务商',
          baseUrl: '',
          hasKey: false,
          enabled: false,
          models: [],
        },
      ])
    );
    render(<Wrapper />);
    expect(screen.getByText('暂无可用服务商')).toBeInTheDocument();
  });
});
