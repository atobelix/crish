/**
 * apps/crish-mobile/src/presentation/components/webview/WebPreviewSheet.test.tsx
 *
 * 网页安全预览抽屉单元测试套件：
 * 1. normalizeDomain 纯函数解析与归一化断言；
 * 2. 安全合规 URL 允许加载并正常展示 WebView 与进度条；
 * 3. 危险/保留/私有 IP 及高危协议刚性拦截，居中展示拦截卡片且禁止渲染 WebView；
 * 4. 顶栏操作（外部浏览器打开、复制链接、关闭抽屉、背景遮罩点击）交互断言；
 * 5. 加载进度推进、错误卡片呈现与重新加载重试流程。
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { openLink } from '@/adapters/platform/openLink';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { normalizeDomain, WebPreviewSheet } from './WebPreviewSheet';

jest.mock('@/adapters/platform/openLink', () => ({
  openLink: jest.fn(async () => true),
}));

jest.mock('@/adapters/platform/clipboard', () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

const mockOpenLink = openLink as jest.MockedFunction<typeof openLink>;
const mockCopyText = copyTextToClipboard as jest.MockedFunction<
  typeof copyTextToClipboard
>;

const mockMetrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderWithSafeArea(ui: ReactElement) {
  return await render(
    <SafeAreaProvider initialMetrics={mockMetrics}>{ui}</SafeAreaProvider>
  );
}

describe('WebPreviewSheet - normalizeDomain 纯逻辑断言', () => {
  it('剥除 www. 前缀并提取小写域名', () => {
    expect(normalizeDomain('https://www.github.com/facebook/react')).toBe(
      'github.com'
    );
    expect(normalizeDomain('https://WWW.GOOGLE.COM/search?q=123')).toBe(
      'google.com'
    );
  });

  it('保留多级子域名与端口无关域名', () => {
    expect(normalizeDomain('https://docs.expo.dev/versions/latest')).toBe(
      'docs.expo.dev'
    );
    expect(normalizeDomain('http://api.staging.example.org:8080/v1')).toBe(
      'api.staging.example.org'
    );
  });

  it('空串与非法 URL 安全容错并使用 fallbackHost', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('   ')).toBe('');
    expect(normalizeDomain('invalid-url', 'fallback.org')).toBe('fallback.org');
    expect(normalizeDomain('invalid-url', 'www.fallback.org')).toBe(
      'fallback.org'
    );
  });
});

describe('WebPreviewSheet - 安全 URL 正常加载与顶栏展示', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('可见且安全 URL：展示顶栏安全锁图标、归一化域名、标题与 WebView', async () => {
    const onClose = jest.fn();
    const { getByTestId, queryByTestId, getByText } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url="https://github.com/facebook/react"
        title="React 官方仓库"
        onClose={onClose}
      />
    );

    // 抽屉与顶部手柄在场
    expect(getByTestId('web-preview-sheet')).toBeTruthy();
    expect(getByTestId('web-preview-handle')).toBeTruthy();

    // 顶栏安全锁与归一化域名展示
    expect(getByTestId('web-preview-domain-badge')).toBeTruthy();
    expect(getByText('github.com')).toBeTruthy();
    expect(getByText('React 官方仓库')).toBeTruthy();

    // 加载进度条存在，拦截卡片不存在
    expect(getByTestId('web-preview-progress-bar')).toBeTruthy();
    expect(queryByTestId('web-preview-blocked')).toBeNull();
    expect(queryByTestId('web-preview-error')).toBeNull();

    // WebView 正常挂载并传入安全 URL
    const webView = getByTestId('web-preview-webview');
    expect(webView.props.source).toEqual({
      uri: 'https://github.com/facebook/react',
    });
  });

  it('当 visible 为 false 时完全不渲染', async () => {
    const { queryByTestId } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={false}
        url="https://github.com/facebook/react"
        onClose={jest.fn()}
      />
    );
    expect(queryByTestId('web-preview-sheet')).toBeNull();
  });
});

describe('WebPreviewSheet - 危险内网与非法协议 SSRF 刚性拦截', () => {
  const dangerousUrls = [
    'http://127.0.0.1/admin',
    'http://localhost:8080/debug',
    'http://192.168.1.1/gateway',
    'http://10.0.0.1:8000/api',
    'http://172.16.0.1/secret',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://files.example.com/data',
    'http://company.internal/dashboard',
    'http://server.local/index.html',
  ];

  dangerousUrls.forEach((badUrl) => {
    it(`刚性拦截高危地址: ${badUrl}`, async () => {
      const { getByTestId, queryByTestId, getByText } =
        await renderWithSafeArea(
          <WebPreviewSheet visible={true} url={badUrl} onClose={jest.fn()} />
        );

      // 居中呈现安全拦截卡片
      expect(getByTestId('web-preview-blocked')).toBeTruthy();
      expect(getByText('安全拦截：禁止访问内网或高危地址')).toBeTruthy();

      // 绝不渲染 WebView 向外发起请求
      expect(queryByTestId('web-preview-webview')).toBeNull();

      // 进度条不应在拦截态展示
      expect(queryByTestId('web-preview-progress-bar')).toBeNull();
    });
  });
});

describe('WebPreviewSheet - 顶栏动作与交互操作', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('点击在外部系统浏览器打开调用 openLink', async () => {
    const url = 'https://react.dev/learn';
    const { getByTestId } = await renderWithSafeArea(
      <WebPreviewSheet visible={true} url={url} onClose={jest.fn()} />
    );

    const openBtn = getByTestId('web-preview-open-external');
    await fireEvent.press(openBtn);

    expect(mockOpenLink).toHaveBeenCalledTimes(1);
    expect(mockOpenLink).toHaveBeenCalledWith(url);
  });

  it('支持自定义 onOpenExternal 覆盖', async () => {
    const url = 'https://react.dev/learn';
    const customOpen = jest.fn();
    const { getByTestId } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url={url}
        onClose={jest.fn()}
        onOpenExternal={customOpen}
      />
    );

    const openBtn = getByTestId('web-preview-open-external');
    await fireEvent.press(openBtn);

    expect(customOpen).toHaveBeenCalledTimes(1);
    expect(customOpen).toHaveBeenCalledWith(url);
    expect(mockOpenLink).not.toHaveBeenCalled();
  });

  it('点击复制链接调用 copyTextToClipboard', async () => {
    const url = 'https://react.dev/reference';
    const { getByTestId } = await renderWithSafeArea(
      <WebPreviewSheet visible={true} url={url} onClose={jest.fn()} />
    );

    const copyBtn = getByTestId('web-preview-copy-link');
    await fireEvent.press(copyBtn);

    expect(mockCopyText).toHaveBeenCalledTimes(1);
    expect(mockCopyText).toHaveBeenCalledWith(url);
  });

  it('支持自定义 onCopyLink 覆盖', async () => {
    const url = 'https://react.dev/reference';
    const customCopy = jest.fn();
    const { getByTestId } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url={url}
        onClose={jest.fn()}
        onCopyLink={customCopy}
      />
    );

    const copyBtn = getByTestId('web-preview-copy-link');
    await fireEvent.press(copyBtn);

    expect(customCopy).toHaveBeenCalledTimes(1);
    expect(customCopy).toHaveBeenCalledWith(url);
    expect(mockCopyText).not.toHaveBeenCalled();
  });

  it('点击关闭按钮或遮罩触发 onClose 回调', async () => {
    const onClose = jest.fn();
    const { getByTestId } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url="https://react.dev"
        onClose={onClose}
      />
    );

    const closeBtn = getByTestId('web-preview-close');
    await fireEvent.press(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = getByTestId('web-preview-backdrop');
    await fireEvent.press(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('WebPreviewSheet - 进度反馈、加载失败与重新加载', () => {
  it('WebView 进度推进与完成', async () => {
    const { getByTestId } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url="https://react.dev"
        onClose={jest.fn()}
      />
    );

    const webView = getByTestId('web-preview-webview');

    await act(async () => {
      webView.props.onLoadStart();
    });

    await act(async () => {
      webView.props.onLoadProgress({
        nativeEvent: { progress: 0.65 },
      });
    });

    await act(async () => {
      webView.props.onLoadEnd();
    });

    expect(getByTestId('web-preview-progress-bar')).toBeTruthy();
  });

  it('加载失败时展示居中错误卡片，点击重新加载可重试恢复', async () => {
    const { getByTestId, queryByTestId, getByText } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url="https://react.dev"
        onClose={jest.fn()}
      />
    );

    const webView = getByTestId('web-preview-webview');

    // 模拟网络故障触发 onError
    await act(async () => {
      webView.props.onError({
        nativeEvent: { description: 'net::ERR_CONNECTION_TIMED_OUT' },
      });
    });

    // 错误卡片呈现，展示故障信息与重试按钮
    expect(getByTestId('web-preview-error')).toBeTruthy();
    expect(getByText('网页加载失败')).toBeTruthy();
    expect(getByText('net::ERR_CONNECTION_TIMED_OUT')).toBeTruthy();
    const reloadBtn = getByTestId('web-preview-reload');
    expect(reloadBtn).toBeTruthy();

    // 点击重新加载
    await fireEvent.press(reloadBtn);

    // 错误卡片清除，WebView 重新挂载
    expect(queryByTestId('web-preview-error')).toBeNull();
    expect(getByTestId('web-preview-webview')).toBeTruthy();
  });

  it('HTTP 状态码错误（如 404 / 500）触发 onHttpError 错误提示', async () => {
    const { getByTestId, getByText } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url="https://react.dev/missing-page"
        onClose={jest.fn()}
      />
    );

    const webView = getByTestId('web-preview-webview');

    await act(async () => {
      webView.props.onHttpError({
        nativeEvent: { statusCode: 404 },
      });
    });

    expect(getByTestId('web-preview-error')).toBeTruthy();
    expect(getByText('HTTP 错误 (404)')).toBeTruthy();
  });

  it('页面动态标题回传自适应', async () => {
    const { getByTestId, getByText } = await renderWithSafeArea(
      <WebPreviewSheet
        visible={true}
        url="https://react.dev"
        onClose={jest.fn()}
      />
    );

    const webView = getByTestId('web-preview-webview');

    await act(async () => {
      webView.props.onNavigationStateChange({
        title: 'React – The library for web and native interfaces',
      });
    });

    expect(
      getByText('React – The library for web and native interfaces')
    ).toBeTruthy();
  });
});
