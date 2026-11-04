// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/ContentState/ContentState.test.tsx
 *
 * ui/ContentState 契约测试：三态呈现口径——
 * loading = Spinner + 状态文案（不用骨架屏）；error 必带重试槽
 * （onRetry → 按钮且点击回调）；empty = 标题 + 行动槽。
 * 样式源码棘轮：spinner 周期必须经 --transition-spin 令牌，禁止裸时长。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContentState } from './ContentState';
import styles from './ContentState.module.css';

const DIR = dirname(fileURLToPath(import.meta.url));
const CSS_SRC = readFileSync(join(DIR, 'ContentState.module.css'), 'utf8');

describe('ui/ContentState', () => {
  it('loading：Spinner + 状态文案，role=status 且 aria-busy', () => {
    render(<ContentState kind="loading" title="正在加载消息" />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('data-kind', 'loading');
    expect(el).toHaveAttribute('aria-busy', 'true');
    expect(el.textContent).toContain('正在加载消息');
    expect(el.querySelector(`.${styles.spinner}`)).not.toBeNull();
    // 不用骨架屏：不得出现任何 skeleton 类占位
    expect(el.innerHTML).not.toMatch(/skeleton/i);
  });

  it('error：标题 + 说明 + 重试按钮，点击触发 onRetry', () => {
    const onRetry = vi.fn();
    render(
      <ContentState
        kind="error"
        title="消息加载失败"
        description="本地存储暂时不可用"
        onRetry={onRetry}
        retryLabel="重试"
      />
    );
    const el = screen.getByRole('alert');
    expect(el.textContent).toContain('消息加载失败');
    expect(el.textContent).toContain('本地存储暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error：未传 onRetry 时不渲染重试按钮（重试槽由调用方决定是否接线）', () => {
    render(<ContentState kind="error" title="出错了" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('empty：标题 + 说明 + 行动槽内容', () => {
    render(
      <ContentState
        kind="empty"
        title="暂无内容"
        description="说明文字"
        action={<button type="button">去创建</button>}
      />
    );
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('data-kind', 'empty');
    expect(el.textContent).toContain('暂无内容');
    expect(screen.getByRole('button', { name: '去创建' })).not.toBeNull();
    expect(el.querySelector(`.${styles.spinner}`)).toBeNull();
  });

  it('样式棘轮：spinner 动画周期只经 --transition-spin 令牌，无裸时长', () => {
    expect(CSS_SRC).toMatch(
      /animation:\s*contentStateSpin\s+var\(--transition-spin\)/
    );
    expect(CSS_SRC).not.toMatch(/animation:[^;]*\d+(?:\.\d+)?(?:ms|s)\b/);
  });
});
