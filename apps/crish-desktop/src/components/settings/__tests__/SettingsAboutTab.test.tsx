// @vitest-environment jsdom
/**
 * SettingsAboutTab 单元测试 (P1-LIC-02)
 *
 * 覆盖验证：
 * 1. 渲染应用品牌、版本号（Crish Desktop v0.1.1, Conex Kernel v0.1.1）及主许可证版权信息（MIT, Copyright (c) 2026 atobelix）
 * 2. 第三方开源协议披露区渲染 MPL-2.0 弱互惠组件披露（bitmaps, cssparser, cssparser-macros, im, sized-chunks, lightningcss, @parcel/watcher）与 SIL OFL-1.1 字体归属（Inter, JetBrains Mono, IBM Plex）
 * 3. 复制系统信息按钮调用剪贴板写入并复制包含 OS、版本与架构的文本
 * 4. 弹窗模态查看完整协议与外部社区/安全链接
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import {
  SettingsAboutTab,
  getSystemInfo,
  formatSystemInfo,
  MPL_DEPENDENCIES,
  BUNDLED_FONTS,
  PERMISSIVE_LICENSES,
} from '../SettingsAboutTab';
import * as sharedUtils from '@crish/shared-utils';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsAboutTab', () => {
  it('渲染应用品牌、版本信息与主许可证版权信息', () => {
    render(<SettingsAboutTab />);

    // 1. 验证 App Brand: Crish Desktop v0.1.1, Conex Kernel v0.1.1
    expect(screen.getByText('Crish Desktop')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.1.1');
    expect(screen.getByTestId('kernel-version')).toHaveTextContent(
      'Conex Kernel v0.1.1'
    );

    // 2. 验证主许可证 MIT License 与 Copyright (c) 2026 atobelix
    expect(screen.getAllByText(/MIT/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('copyright-notice')).toHaveTextContent(
      'Copyright (c) 2026 atobelix'
    );
  });

  it('第三方开源协议折叠区正常展开，并完整披露 MPL-2.0 弱互惠组件及 SIL OFL-1.1 字体', async () => {
    render(<SettingsAboutTab />);

    // 初始状态下展开按钮存在
    const toggleBtn = screen.getByTestId('toggle-licenses-btn');
    expect(toggleBtn).toHaveTextContent('查看第三方许可证');

    // 点击展开
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveTextContent('收起第三方许可证');

    // 验证宽松开源协议标签
    const inlineContent = screen.getByTestId('inline-disclosure-content');
    for (const lic of PERMISSIVE_LICENSES) {
      expect(within(inlineContent).getByText(lic)).toBeInTheDocument();
    }

    // 验证 MPL-2.0 弱互惠组件披露（bitmaps, cssparser, cssparser-macros, im, sized-chunks, lightningcss, @parcel/watcher）
    const mplBadges = screen.getAllByText('MPL-2.0');
    expect(mplBadges.length).toBeGreaterThanOrEqual(MPL_DEPENDENCIES.length);

    for (const dep of MPL_DEPENDENCIES) {
      expect(screen.getByText(dep.name)).toBeInTheDocument();
      const link = screen.getByRole('link', {
        name: `${dep.name} on ${dep.sourceType}`,
      });
      expect(link).toHaveAttribute('href', dep.url);
    }

    // 验证 SIL OFL-1.1 随附字体归属（Inter, JetBrains Mono, IBM Plex）
    for (const font of BUNDLED_FONTS) {
      expect(screen.getByText(font.name)).toBeInTheDocument();
      expect(screen.getByText(font.copyright)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/OFL-1\.1/).length).toBeGreaterThan(0);

    // 验证商业模型商标合理使用声明（OpenAI, Anthropic, Google Gemini, DeepSeek）
    expect(
      screen.getByText(/OpenAI、Anthropic、Google Gemini、DeepSeek/)
    ).toBeInTheDocument();
  });

  it('复制系统信息按钮正常调用剪贴板并写入完整系统与架构信息', async () => {
    const copySpy = vi
      .spyOn(sharedUtils, 'copyTextToClipboard')
      .mockResolvedValue(true);

    render(<SettingsAboutTab />);

    const copyBtn = screen.getByTestId('copy-system-info-btn');
    expect(copyBtn).toBeInTheDocument();

    fireEvent.click(copyBtn);

    expect(copySpy).toHaveBeenCalledTimes(1);
    const copiedText = copySpy.mock.calls[0][0];

    // 断言拷贝内容包含 OS, App 版本, Kernel 版本, Electron/Tauri 架构
    expect(copiedText).toContain('Crish Desktop: v0.1.1');
    expect(copiedText).toContain('Conex Kernel: v0.1.1');
    expect(copiedText).toContain('OS:');
    expect(copiedText).toContain('Architecture:');
    expect(copiedText).toContain('Runtime:');

    // 验证按钮状态文字更新为「已复制」
    await waitFor(() => {
      expect(copyBtn).toHaveTextContent('已复制');
    });
  });

  it('支持模态弹窗查看完整第三方开源协议并触发遮罩通知', async () => {
    const onBlockingOverlayChange = vi.fn();
    render(
      <SettingsAboutTab onBlockingOverlayChange={onBlockingOverlayChange} />
    );

    const openModalBtn = screen.getByTestId('open-licenses-modal-btn');
    fireEvent.click(openModalBtn);

    expect(onBlockingOverlayChange).toHaveBeenCalledWith(true);

    // 弹窗可见并包含披露内容
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('第三方开源许可证与版权披露');
    expect(screen.getByTestId('modal-disclosure-content')).toBeInTheDocument();

    // 关闭弹窗
    const closeBtn = screen.getByRole('button', { name: '关闭弹窗' });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(onBlockingOverlayChange).toHaveBeenCalledWith(false);
    });
  });

  it('渲染 GitHub 仓库与安全漏洞报告链接', () => {
    render(<SettingsAboutTab />);

    const githubLink = screen.getByTestId('github-link');
    expect(githubLink).toHaveAttribute(
      'href',
      'https://github.com/atobelix/crish'
    );
    expect(githubLink).toHaveAttribute('target', '_blank');

    const securityLink = screen.getByTestId('security-report-link');
    expect(securityLink).toHaveAttribute(
      'href',
      'https://github.com/atobelix/crish/security/advisories'
    );
    expect(securityLink).toHaveAttribute('target', '_blank');
  });

  it('getSystemInfo 与 formatSystemInfo 纯函数逻辑一致保真', () => {
    const info = getSystemInfo();
    expect(info.appVersion).toBe('v0.1.1');
    expect(info.kernelVersion).toBe('v0.1.1');
    expect(typeof info.os).toBe('string');
    expect(typeof info.architecture).toBe('string');
    expect(typeof info.runtime).toBe('string');

    const formatted = formatSystemInfo(info);
    expect(formatted).toContain(`Crish Desktop: ${info.appVersion}`);
    expect(formatted).toContain(`Conex Kernel: ${info.kernelVersion}`);
    expect(formatted).toContain(`OS: ${info.os}`);
    expect(formatted).toContain(`Architecture: ${info.architecture}`);
    expect(formatted).toContain(`Runtime: ${info.runtime}`);
  });
});
