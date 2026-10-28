// @vitest-environment jsdom
/**
 * LazyMotion(strict) 运行时契约：用量页与全局 Toast 必须在全局
 * AppMotionProvider 下可直接渲染。
 *
 * 背景（2026-10-27）：这两个面曾因组件内部使用 `motion.*` 在 strict 模式下
 * 抛错——用量页整页被错误边界接管、Toast 把整个应用打成白屏。静态门禁
 * `scripts/check-motion-strict.mjs` 拦截导入面，本测试锁定运行时行为。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AppMotionProvider } from './AppMotionProvider';
import { UsageSummaryHero } from '../settings/usage/UsageSummaryHero';
import { ToastCard } from '../overlay/ToastCard';

describe('LazyMotion(strict) 运行时契约', () => {
  it('用量概览（SlotText / AnimatedCounter）在 AppMotionProvider 下不抛错', () => {
    const { container } = render(
      <AppMotionProvider>
        <UsageSummaryHero totalTokens={123456} totalCost={1.23} />
      </AppMotionProvider>
    );
    expect(container.textContent).toContain('tokens');
    expect(container.textContent).toContain('CNY');
  });

  it('ToastCard 在 AppMotionProvider 下不抛错（多端服务开启提示路径）', () => {
    expect(() =>
      render(
        <AppMotionProvider>
          <ToastCard
            toast={{
              id: 'toast-1',
              type: 'success',
              message: '多端服务已开启：本机可被手机连接',
              timestamp: Date.now(),
              duration: 5000,
            }}
            onDismiss={vi.fn()}
          />
        </AppMotionProvider>
      )
    ).not.toThrow();
  });
});
