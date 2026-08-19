// @vitest-environment jsdom
/**
 * ui/Switch 基础测试：受控/非受控双模、键盘交互、aria 断言、label 关联
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Switch } from './Switch';
import styles from './Switch.module.css';

const DIR = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/Switch', () => {
  it('渲染 role=switch 且 aria-checked 反映受控值', () => {
    const { rerender } = render(<Switch checked data-testid="sw" />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    rerender(<Switch checked={false} data-testid="sw" />);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('受控模式：点击上报 onCheckedChange 且状态由外部持有', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('非受控模式：defaultChecked 为初始值，点击后内部自管并上报', () => {
    const onChange = vi.fn();
    render(<Switch defaultChecked={false} onCheckedChange={onChange} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('键盘 Space/Enter 均触发切换（显式 keydown 接管）', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} />);
    const sw = screen.getByRole('switch');
    fireEvent.keyDown(sw, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.keyDown(sw, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled 态：点击与键盘不触发回调', () => {
    const onChange = vi.fn();
    render(<Switch checked disabled onCheckedChange={onChange} />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    fireEvent.keyDown(sw, { key: ' ' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('label 关联：点击前缀说明文案同样切换（htmlFor 关联）', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="开启代理" onCheckedChange={onChange} />);
    fireEvent.click(screen.getByText('开启代理'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('aria-label 替代命名：无 label 时播报自定义名称', () => {
    render(<Switch checked aria-label="暂停工作流" />);
    expect(screen.getByRole('switch', { name: '暂停工作流' })).toBeInTheDocument();
  });

  it('size 变体与 className 追加生效', () => {
    const { rerender } = render(<Switch size="sm" className="layout-extra" />);
    const sw = screen.getByRole('switch');
    expect(sw.className).toContain(styles.trackSm);
    expect(sw.className).toContain('layout-extra');
    rerender(<Switch />);
    expect(screen.getByRole('switch').className).not.toContain(styles.trackSm);
  });

  it('拇指过渡无 y>1 过冲贝塞尔', () => {
    const css = readFileSync(join(DIR, 'Switch.module.css'), 'utf8');
    expect(css).not.toMatch(/1\.51/);
    expect(css).not.toMatch(/cubic-bezier\([^)]*[1-9]\.\d{2,}/);
    expect(css).toMatch(/--easing-enter/);
  });

  it('外部 label htmlFor 可关联开关（设置行标题场景）', () => {
    render(
      <>
        <label htmlFor="my-switch">个性化设置</label>
        <Switch id="my-switch" checked />
      </>
    );
    fireEvent.click(screen.getByText('个性化设置'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
