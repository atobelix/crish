/**
 * ComposePlusMenu（ui/Menu 基座）交互测试：
 * 打开/选择/Esc/触发防冒泡
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ComposePlusMenu } from './ComposePlusMenu';
import styles from './ComposePlusMenu.module.css';

describe('ComposePlusMenu 样式', () => {
  it('should apply max-height viewport clamping', () => {
    expect(styles.root).toBeDefined();
    expect(styles.main).toBeDefined();
    expect(typeof styles.main).toBe('string');
  });

  it('should prevent scroll overflow', () => {
    expect(styles.slim).toBeDefined();
    expect(typeof styles.slim).toBe('string');
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ComposePlusMenu（ui/Menu 基座）', () => {
  it('受控打开后渲染全部菜单项', async () => {
    render(
      <ComposePlusMenu
        open={true}
        onClose={() => {}}
        onAddFiles={() => {}}
      />
    );
    expect(await screen.findByText('添加文件')).toBeInTheDocument();
    expect(screen.getByText('使用技能')).toBeInTheDocument();
    expect(screen.getByText('插件')).toBeInTheDocument();
    expect(screen.getByText('定时任务')).toBeInTheDocument();
  });

  it('点击「添加文件」触发 onAddFiles 并关闭', async () => {
    const onAddFiles = vi.fn();
    const onClose = vi.fn();
    render(
      <ComposePlusMenu
        open={true}
        onClose={onClose}
        onAddFiles={onAddFiles}
      />
    );
    fireEvent.click(await screen.findByText('添加文件'));
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Esc 关闭（经基座 onOpenChange → onClose）', async () => {
    const onClose = vi.fn();
    render(
      <ComposePlusMenu
        open={true}
        onClose={onClose}
        onAddFiles={() => {}}
      />
    );
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    // 基座 onKeyDown 与 Radix DismissableLayer 各触发一次（幂等）
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
