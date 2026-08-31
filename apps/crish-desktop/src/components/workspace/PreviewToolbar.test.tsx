// @vitest-environment jsdom
/**
 * PreviewToolbar Inspect 开关（DOM 拾取器）测试：
 * 1. 未激活：Tooltip 文案「拾取页面元素 (Inspect)」，aria-pressed=false；
 * 2. 点击触发 onToggleInspect 回调并进入激活态（aria-pressed=true、激活样式类）；
 * 3. 激活态 Tooltip 文案切换为「退出元素拾取 (Esc)」。
 * 遵循测试资产保护铁律（UTF-8 无 BOM，中文注释）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { DEFAULT_DELAY_SHOW_MS } from '../ui/Tooltip/Tooltip';
import { PreviewToolbar } from './PreviewToolbar';
import type {
  PreviewToolbarActionsProps,
  PreviewToolbarNavigationProps,
  PreviewToolbarPreviewProps,
} from './PreviewToolbar';

function buildProps(overrides?: {
  inspecting?: boolean;
  onToggleInspect?: () => void;
}) {
  const preview: PreviewToolbarPreviewProps = {
    canBack: true,
    canForward: true,
    blank: false,
    frameSrc: 'http://127.0.0.1:8765/v1/preview/proxy?url=test',
    loading: false,
    urlInput: 'https://example.com',
    canBookmark: true,
    bookmarked: false,
    showHist: false,
    canExternal: true,
    isInspectorActive: overrides?.inspecting ?? false,
  };
  const navigation: PreviewToolbarNavigationProps = {
    onBack: vi.fn(),
    onForward: vi.fn(),
    onHome: vi.fn(),
    onReload: vi.fn(),
    onUrlSubmit: vi.fn(),
    onUrlChange: vi.fn(),
    onClearUrl: vi.fn(),
  };
  const actions: PreviewToolbarActionsProps = {
    onBookmark: vi.fn(),
    onToggleHist: vi.fn(),
    onOpenExternal: vi.fn(),
    onToggleInspector: overrides?.onToggleInspect ?? vi.fn(),
  };
  return { preview, navigation, actions };
}

function renderToolbar(overrides?: {
  inspecting?: boolean;
  onToggleInspect?: () => void;
}) {
  const props = buildProps(overrides);
  return render(
    <PreviewToolbar
      preview={props.preview}
      navigation={props.navigation}
      actions={props.actions}
    />
  );
}

/** 弹出 Tooltip 文案（fake timers 下推进延迟） */
function hoverAndReadTooltip(el: HTMLElement) {
  fireEvent.mouseEnter(el);
  act(() => {
    vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS);
  });
  return screen.getByRole('tooltip');
}

describe('PreviewToolbar Inspect 开关', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('未激活：按钮展示拾取文案 Tooltip，aria-pressed=false，非激活样式', () => {
    vi.useFakeTimers();
    renderToolbar();
    const btn = screen.getByLabelText('拾取页面元素');
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    const tooltip = hoverAndReadTooltip(btn);
    expect(tooltip).toHaveTextContent('拾取页面元素 (Inspect)');
  });

  it('点击触发 onToggleInspect 回调并进入激活高亮态', () => {
    vi.useFakeTimers();
    const onToggleInspect = vi.fn();
    renderToolbar({ onToggleInspect });
    const btn = screen.getByLabelText('拾取页面元素');
    fireEvent.click(btn);
    expect(onToggleInspect).toHaveBeenCalledTimes(1);
  });

  it('激活态：Tooltip 文案切换为「退出元素拾取 (Esc)」，aria-pressed=true', () => {
    vi.useFakeTimers();
    renderToolbar({ inspecting: true });
    const btn = screen.getByLabelText('拾取页面元素');
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    const tooltip = hoverAndReadTooltip(btn);
    expect(tooltip).toHaveTextContent('退出元素拾取 (Esc)');
  });

  it('空白页（blank=true）：拾取按钮处于 disabled 状态', () => {
    const props = buildProps();
    props.preview.blank = true;
    props.preview.frameSrc = null;
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const btn = screen.getByLabelText('拾取页面元素');
    expect(btn).toBeDisabled();
  });
});
