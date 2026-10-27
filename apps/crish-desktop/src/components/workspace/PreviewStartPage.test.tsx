// @vitest-environment jsdom
/**
 * PreviewStartPage 单元测试套件：
 * 1. 纯净空白：无活跃端口且无历史时不显示任何视觉杂音；
 * 2. 运行中服务：按行显示，绿色状态点，点击导航；无服务时零占用；
 * 3. 最近访问：按行规整对齐，微型 13px 图标，点击导航。
 *
 * UTF-8 无 BOM，中文注释。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { PreviewStartPage } from './PreviewStartPage';

describe('PreviewStartPage 极简浏览器起始页', () => {
  const defaultProps = {
    activePorts: [],
    recentPages: [],
    onNavigate: vi.fn(),
  };

  it('1. 默认无内容时保持极简空白，无任何废话文案', () => {
    const { container } = render(<PreviewStartPage {...defaultProps} />);
    expect(screen.queryByText('Web 预览与探索')).toBeNull();
    expect(screen.queryByText(/输入网址/)).toBeNull();
    expect(screen.queryByRole('button', { name: /localhost/ })).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('2. 检测到活跃端口时：按行展示运行中的服务，无多余未检测提示', () => {
    const onNav = vi.fn();
    render(
      <PreviewStartPage
        {...defaultProps}
        activePorts={[5173]}
        onNavigate={onNav}
      />
    );

    const portBtn = screen.getByRole('button', {
      name: /运行中的本地服务: localhost:5173/,
    });
    expect(portBtn.textContent).toBe('localhost:5173');
    fireEvent.click(portBtn);
    expect(onNav).toHaveBeenCalledWith('http://localhost:5173');

    // 确保没有出现任何“未检测到服务”等废话说明
    expect(screen.queryByText(/未检测到/)).toBeNull();
    expect(screen.queryByText(/正在扫描/)).toBeNull();
  });

  it('3. 有最近访问时：按行规整展示，微型辅助图标，点击正常导航', () => {
    const onNav = vi.fn();
    render(
      <PreviewStartPage
        {...defaultProps}
        recentPages={['https://baidu.com', 'http://0.0.0.2']}
        onNavigate={onNav}
      />
    );

    expect(screen.getByText('最近访问')).toBeInTheDocument();
    expect(screen.getByText('baidu.com')).toBeInTheDocument();
    expect(screen.getByText('0.0.0.2')).toBeInTheDocument();

    const row = screen.getByRole('button', {
      name: '打开最近网页 baidu.com',
    });
    fireEvent.click(row);
    expect(onNav).toHaveBeenCalledWith('https://baidu.com');
  });
});
