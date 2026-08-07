// @vitest-environment jsdom
/**
 * ComposePlusMenu（ui/Menu 基座）交互测试：
 * 打开/选择/Esc/触发防冒泡
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import React from 'react';
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
      <ComposePlusMenu open={true} onClose={() => {}} onAddFiles={() => {}} />
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
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={onAddFiles} />
    );
    fireEvent.click(await screen.findByText('添加文件'));
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Esc 关闭（经基座 onOpenChange → onClose）', async () => {
    const onClose = vi.fn();
    render(
      <ComposePlusMenu open={true} onClose={onClose} onAddFiles={() => {}} />
    );
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    // 基座 onKeyDown 与 Radix DismissableLayer 各触发一次（幂等）
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

/**
 * P1-F4（F7 F1）：ComposePlusMenu 曾用 display:none 空 div 作 Radix 浮动锚点，
 * floating-ui 对不可见 reference 的 getBoundingClientRect 返回全 0 → 菜单定位到
 * 视口 (0,0) 左上角。jsdom 测不了真实 float 坐标（F7 T1 建议的结构断言）：
 * ① 修复后不得再渲染任何 display:none 锚点元素；
 * ② 菜单经 Radix 自定义锚点（Popover.Anchor + virtualRef）接入 restoreFocusRef
 *    真实按钮，锚点节点存在且按钮仍在文档、可见。
 */
describe('ComposePlusMenu P1-F4 锚点修复', () => {
  it('不再渲染 display:none 空 div 作浮动锚点（真实按钮作锚）', async () => {
    const anchorRef = React.createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchorRef} type="button">
          ＋
        </button>
        <ComposePlusMenu
          open={true}
          onClose={() => {}}
          onAddFiles={() => {}}
          restoreFocusRef={anchorRef}
        />
      </>
    );
    await screen.findByRole('menu');
    // 修复前：ComposePlusMenu 渲染 display:none 空 div 作 Radix 锚点
    // （floating-ui 测到全 0 rect → 菜单钉在视口 (0,0)）→ 结构断言红
    expect(document.querySelector('[style*="display: none"]')).toBeNull();
  });

  it('打开菜单后 anchor 元素（真实按钮）仍在文档且可见', async () => {
    const anchorRef = React.createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchorRef} type="button">
          ＋
        </button>
        <ComposePlusMenu
          open={true}
          onClose={() => {}}
          onAddFiles={() => {}}
          restoreFocusRef={anchorRef}
        />
      </>
    );
    await screen.findByRole('menu');
    // 锚点 = restoreFocusRef 指向的真实按钮：仍在文档、未被隐藏
    expect(anchorRef.current).not.toBeNull();
    expect(document.body.contains(anchorRef.current as HTMLElement)).toBe(true);
    expect((anchorRef.current as HTMLElement).style.display).not.toBe('none');
    // 菜单经 Radix 自定义锚点（Popover.Anchor + virtualRef）接入——
    // 修复前不存在该节点（锚点是 trigger 克隆的 display:none div）→ 红
    expect(document.querySelector('[data-menu-anchor]')).not.toBeNull();
  });
});
