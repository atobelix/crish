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
  loading?: boolean;
  onStop?: () => void;
  onReload?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onHome?: () => void;
  onBookmark?: () => void;
  onToggleHist?: () => void;
  onClearUrl?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  blank?: boolean;
  frameSrc?: string | null;
  bookmarked?: boolean;
  canBookmark?: boolean;
  showHist?: boolean;
  canExternal?: boolean;
  urlInput?: string;
}) {
  const preview: PreviewToolbarPreviewProps = {
    canBack: overrides?.canBack ?? true,
    canForward: overrides?.canForward ?? true,
    blank: overrides?.blank ?? false,
    frameSrc:
      overrides?.frameSrc !== undefined
        ? overrides.frameSrc
        : 'http://127.0.0.1:8765/v1/preview/proxy?url=test',
    loading: overrides?.loading ?? false,
    urlInput: overrides?.urlInput ?? 'https://example.com',
    canBookmark: overrides?.canBookmark ?? true,
    bookmarked: overrides?.bookmarked ?? false,
    showHist: overrides?.showHist ?? false,
    canExternal: overrides?.canExternal ?? true,
    isInspectorActive: overrides?.inspecting ?? false,
  };
  const navigation: PreviewToolbarNavigationProps = {
    onBack: overrides?.onBack ?? vi.fn(),
    onForward: overrides?.onForward ?? vi.fn(),
    onHome: overrides?.onHome ?? vi.fn(),
    onReload: overrides?.onReload ?? vi.fn(),
    onStop: overrides?.onStop,
    onUrlSubmit: vi.fn(),
    onUrlChange: vi.fn(),
    onClearUrl: overrides?.onClearUrl ?? vi.fn(),
  };
  const actions: PreviewToolbarActionsProps = {
    onBookmark: overrides?.onBookmark ?? vi.fn(),
    onToggleHist: overrides?.onToggleHist ?? vi.fn(),
    onOpenExternal: vi.fn(),
    onToggleInspector: overrides?.onToggleInspect ?? vi.fn(),
  };
  return { preview, navigation, actions };
}

function renderToolbar(overrides?: {
  inspecting?: boolean;
  onToggleInspect?: () => void;
  loading?: boolean;
  onStop?: () => void;
  onReload?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  blank?: boolean;
  frameSrc?: string | null;
  bookmarked?: boolean;
  canBookmark?: boolean;
  showHist?: boolean;
  canExternal?: boolean;
  urlInput?: string;
}) {
  const props = buildProps(overrides);
  return {
    ...render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    ),
    props,
  };
}

/** 弹出 Tooltip 文案（fake timers 下推进延迟） */
function hoverAndReadTooltip(el: HTMLElement) {
  fireEvent.pointerEnter(el, { pointerType: 'mouse' });
  fireEvent.mouseEnter(el);
  fireEvent.mouseMove(el);
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

  it('原生 Webview 尚未创建或事件订阅未就绪时禁用 Inspector', () => {
    const props = buildProps();
    props.preview.isInspectorAvailable = false;
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    expect(screen.getByLabelText('拾取页面元素')).toBeDisabled();
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

describe('PreviewToolbar 地址栏极简重塑', () => {
  afterEach(() => {
    cleanup();
  });

  it('网址常态清晰可见且呈现当前 urlInput', () => {
    const props = buildProps();
    props.preview.urlInput = 'https://mysite.local:3000';
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const input = screen.getByLabelText('预览地址') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('https://mysite.local:3000');
  });

  it('输入网址触发 onUrlChange 回调', () => {
    const props = buildProps();
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const input = screen.getByLabelText('预览地址');
    fireEvent.change(input, { target: { value: 'https://new-url.com' } });
    expect(props.navigation.onUrlChange).toHaveBeenCalledWith(
      'https://new-url.com'
    );
  });

  it('提交表单触发 onUrlSubmit 回调', () => {
    const props = buildProps();
    props.preview.urlInput = 'https://submit-test.com';
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const form = screen.getByLabelText('预览地址栏');
    fireEvent.submit(form);
    expect(props.navigation.onUrlSubmit).toHaveBeenCalledWith(
      'https://submit-test.com'
    );
  });

  it('空网址提交时回退为 about:blank', () => {
    const props = buildProps();
    props.preview.urlInput = '   ';
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const form = screen.getByLabelText('预览地址栏');
    fireEvent.submit(form);
    expect(props.navigation.onUrlSubmit).toHaveBeenCalledWith('about:blank');
  });

  it('输入缺少协议的常用域名（如 google.com、github.com）时顺利提交', () => {
    const props = buildProps();
    props.preview.urlInput = 'google.com';
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const form = screen.getByLabelText('预览地址栏');
    fireEvent.submit(form);
    expect(props.navigation.onUrlSubmit).toHaveBeenCalledWith('google.com');
  });

  it('点击清空按钮触发 onClearUrl 并清空地址栏', () => {
    const onClearUrl = vi.fn();
    const props = buildProps({ urlInput: 'https://test.com', onClearUrl });
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const clearBtn = screen.getByRole('button', { name: '清空输入' });
    fireEvent.click(clearBtn);
    expect(onClearUrl).toHaveBeenCalledTimes(1);
  });

  it('按 Escape 键：有文本时触发清空', () => {
    const onClearUrl = vi.fn();
    const props = buildProps({ urlInput: 'https://test.com', onClearUrl });
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const input = screen.getByLabelText('预览地址');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClearUrl).toHaveBeenCalledTimes(1);
  });

  it('按 Escape 键：无文本时重置并提交 about:blank', () => {
    const props = buildProps({ urlInput: '' });
    render(
      <PreviewToolbar
        preview={props.preview}
        navigation={props.navigation}
        actions={props.actions}
      />
    );
    const input = screen.getByLabelText('预览地址');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.navigation.onUrlSubmit).toHaveBeenCalledWith('about:blank');
  });
});

describe('PreviewToolbar 加载状态与停止加载交互', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('未加载（loading=false）：按钮显示刷新 Tooltip 与刷新图标，点击触发 onReload', () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    const { container } = renderToolbar({ loading: false, onReload });
    const btn = screen.getByRole('button', { name: '刷新' });
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('aria-label')).toBe('刷新');

    const tooltip = hoverAndReadTooltip(btn);
    expect(tooltip).toHaveTextContent('刷新');

    fireEvent.click(btn);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-icon="loader"]')).toBeNull();
    expect(container.querySelector('[data-icon="rotate-cw"]')).not.toBeNull();
  });

  it('加载中（loading=true）：按钮切换为旋转 Loader 图标，展示停止加载 Tooltip，点击触发 onStop', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const onReload = vi.fn();
    const { container } = renderToolbar({ loading: true, onStop, onReload });
    const btn = screen.getByRole('button', { name: '停止加载' });
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('aria-label')).toBe('停止加载');
    expect(btn.getAttribute('aria-busy')).toBe('true');

    // 旋转 Loader 图标生效
    expect(container.querySelector('[data-icon="loader"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="rotate-cw"]')).toBeNull();

    const tooltip = hoverAndReadTooltip(btn);
    expect(tooltip).toHaveTextContent('停止加载');

    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('加载中（loading=true）但未传 onStop 时回退触发 onReload', () => {
    const onReload = vi.fn();
    renderToolbar({ loading: true, onReload });
    const btn = screen.getByRole('button', { name: '停止加载' });
    fireEvent.click(btn);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('加载中时即使 frameSrc 为 null 也不应被禁用，允许点击取消', () => {
    const onStop = vi.fn();
    renderToolbar({ loading: true, blank: true, frameSrc: null, onStop });
    const btn = screen.getByRole('button', { name: '停止加载' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('PreviewToolbar 按钮禁用态与高亮态交互', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('后退与前进按钮依据 canBack/canForward 准确禁用与启用', () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    renderToolbar({ canBack: false, canForward: true, onBack, onForward });

    const backBtn = screen.getByRole('button', { name: '后退' });
    const forwardBtn = screen.getByRole('button', { name: '前进' });

    expect(backBtn).toBeDisabled();
    expect(forwardBtn).toBeEnabled();

    fireEvent.click(forwardBtn);
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it('主页按钮点击触发 onHome', () => {
    const onHome = vi.fn();
    renderToolbar({ onHome });
    const homeBtn = screen.getByRole('button', { name: '主页' });
    fireEvent.click(homeBtn);
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it('书签按钮：未加书签时 Tooltip 为「加入书签」，aria-pressed=false', () => {
    vi.useFakeTimers();
    renderToolbar({ bookmarked: false, canBookmark: true });
    const btn = screen.getByRole('button', { name: '加入书签' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    const tooltip = hoverAndReadTooltip(btn);
    expect(tooltip).toHaveTextContent('加入书签');
  });

  it('书签按钮：已加书签时处于高亮态，Tooltip 为「取消书签」，aria-pressed=true', () => {
    vi.useFakeTimers();
    renderToolbar({ bookmarked: true, canBookmark: true });
    const btn = screen.getByRole('button', { name: '取消书签' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    const tooltip = hoverAndReadTooltip(btn);
    expect(tooltip).toHaveTextContent('取消书签');
  });

  it('历史按钮：showHist 为 true 时高亮（aria-expanded=true）', () => {
    const onToggleHist = vi.fn();
    renderToolbar({ showHist: true, onToggleHist });
    const btn = screen.getByRole('button', { name: '历史与书签' });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(onToggleHist).toHaveBeenCalledTimes(1);
  });

  it('外部打开按钮：canExternal 为 false 时处于禁用态', () => {
    renderToolbar({ canExternal: false });
    const btn = screen.getByRole('button', { name: '系统浏览器打开' });
    expect(btn).toBeDisabled();
  });
});
