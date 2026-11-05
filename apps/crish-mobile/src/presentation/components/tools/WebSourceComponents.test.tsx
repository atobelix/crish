// 网页搜索来源微胶囊卡片、滑动条与详情抽屉单元测试
import { act, fireEvent, render } from '@testing-library/react-native';
import { type ReactElement, type ReactNode } from 'react';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { WebSearchSource } from '@crish/shared-types';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { openLink } from '@/adapters/platform/openLink';
import { extractCleanDomain, WebSourceCard } from './WebSourceCard';
import { WebSourceStrip } from './WebSourceStrip';
import {
  formatPublishDate,
  getProviderBadgeLabel,
  WebSourceSheet,
} from './WebSourceSheet';
import * as ToolsExport from './index';

const mockShowToast = jest.fn();

jest.mock('@/adapters/platform/clipboard', () => ({
  copyTextToClipboard: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/adapters/platform/openLink', () => ({
  openLink: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/presentation/ui', () => {
  const actual = jest.requireActual('@/presentation/ui');
  return {
    ...actual,
    useToast: () => ({
      showToast: mockShowToast,
      show: jest.fn(),
      clear: jest.fn(),
    }),
  };
});

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function TestWrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

async function renderComponent(ui: ReactElement) {
  return await render(ui, { wrapper: TestWrapper });
}

const mockSources: WebSearchSource[] = [
  {
    id: '1',
    title: 'React Native 官方文档与架构指南',
    url: 'https://reactnative.dev/docs/architecture-overview',
    domain: 'reactnative.dev',
    snippet:
      'React Native combines the best parts of native development with React, a best-in-class JavaScript library.',
    provider: 'tavily',
    publishedDate: '2026-03-15T08:00:00Z',
    faviconUrl: 'https://reactnative.dev/favicon.ico',
  },
  {
    id: '2',
    title: 'GitHub: conex - Local & Remote AI Coding Agent',
    url: 'https://github.com/conex/conex',
    domain: 'github.com',
    snippet:
      'High-performance cross-platform AI pair programmer and agentic workspace built with Rust and React Native.',
    provider: 'bocha',
    publishedDate: '2026-04-20',
  },
  {
    id: '3',
    title: 'DuckDuckGo 隐私检索与引擎接口规范',
    url: 'https://duckduckgo.com/about',
    domain: 'duckduckgo.com',
    snippet: 'The search engine that doesn’t track you.',
    provider: 'duckduckgo_html',
  },
];

describe('WebSourceCard 网页来源微胶囊卡片', () => {
  it('正确渲染站点域名、标题与单行截断样式', async () => {
    const view = await renderComponent(
      <WebSourceCard source={mockSources[0]!} index={1} />
    );

    expect(view.getByTestId('web-source-card-domain').props.children).toBe(
      'reactnative.dev'
    );
    expect(view.getByTestId('web-source-card-title').props.children).toBe(
      'React Native 官方文档与架构指南'
    );
    expect(view.getByTestId('web-source-card-title').props.numberOfLines).toBe(
      1
    );
    expect(view.getByTestId('web-source-card-index').props.children).toBe(
      '[1]'
    );
  });

  it('有 faviconUrl 时渲染微图标，并在加载错误时回退至域名首字母', async () => {
    const view = await renderComponent(
      <WebSourceCard source={mockSources[0]!} />
    );

    const image = view.getByTestId('web-source-favicon-image');
    expect(image.props.source).toEqual({
      uri: 'https://reactnative.dev/favicon.ico',
    });

    // 触发图片加载失败
    await act(async () => {
      fireEvent(image, 'error');
    });

    // 回退渲染域名首字母 R
    expect(view.queryByTestId('web-source-favicon-image')).toBeNull();
    const initial = view.getByTestId('web-source-favicon-initial');
    expect(initial).toBeTruthy();
    expect(view.getByText('R')).toBeTruthy();
  });

  it('无 faviconUrl 时直接渲染域名首字母大写', async () => {
    const view = await renderComponent(
      <WebSourceCard source={mockSources[1]!} />
    );

    expect(view.queryByTestId('web-source-favicon-image')).toBeNull();
    const initial = view.getByTestId('web-source-favicon-initial');
    expect(initial).toBeTruthy();
    expect(view.getByText('G')).toBeTruthy();
  });

  it('无有效域名字母时回退至 globe 矢量图标', async () => {
    const emptyDomainSource: WebSearchSource = {
      id: 'empty',
      title: '无域名来源',
      url: '',
      domain: '',
      snippet: 'test snippet',
      provider: 'bocha',
    };

    const view = await renderComponent(
      <WebSourceCard source={emptyDomainSource} />
    );

    expect(view.getByTestId('web-source-favicon-globe')).toBeTruthy();
  });

  it('支持 highlighted 高亮态传递并在点击时回传 source 数据', async () => {
    const onPressMock = jest.fn();
    const view = await renderComponent(
      <WebSourceCard
        source={mockSources[0]!}
        highlighted={true}
        onPress={onPressMock}
        testID="custom-source-card"
      />
    );

    const card = view.getByTestId('custom-source-card');
    expect(card.props.accessibilityState).toEqual({ selected: true });
    expect(view.getByTestId('web-source-card-highlight-overlay')).toBeTruthy();

    fireEvent.press(card);
    expect(onPressMock).toHaveBeenCalledTimes(1);
    expect(onPressMock).toHaveBeenCalledWith(mockSources[0]);
  });
});

describe('WebSourceStrip 网页来源横向滑动条', () => {
  it('sources 为空时安全返回 null', async () => {
    const view = await renderComponent(
      <WebSourceStrip sources={[]} testID="empty-strip" />
    );
    expect(view.queryByTestId('empty-strip')).toBeNull();
  });

  it('渲染一组卡片并通过 activeSourceId 控制高亮', async () => {
    const onPressSourceMock = jest.fn();
    const view = await renderComponent(
      <WebSourceStrip
        sources={mockSources}
        activeSourceId="2"
        onPressSource={onPressSourceMock}
        testID="source-strip"
      />
    );

    expect(view.getByTestId('source-strip')).toBeTruthy();
    const card1 = view.getByTestId('web-source-card-1');
    const card2 = view.getByTestId('web-source-card-2');
    const card3 = view.getByTestId('web-source-card-3');

    expect(card1.props.accessibilityState).toEqual({ selected: false });
    expect(card2.props.accessibilityState).toEqual({ selected: true });
    expect(card3.props.accessibilityState).toEqual({ selected: false });

    fireEvent.press(card1);
    expect(onPressSourceMock).toHaveBeenCalledWith(mockSources[0], 0);
  });

  it('支持通过 highlightedIndex 或 citationIndex 控制高亮', async () => {
    // 0-based 下标高亮
    const view1 = await renderComponent(
      <WebSourceStrip sources={mockSources} highlightedIndex={0} />
    );
    expect(
      view1.getByTestId('web-source-card-1').props.accessibilityState
    ).toEqual({ selected: true });

    // 1-based 角标高亮 (citationIndex=2 指向第二项)
    const view2 = await renderComponent(
      <WebSourceStrip sources={mockSources} citationIndex={2} />
    );
    expect(
      view2.getByTestId('web-source-card-2').props.accessibilityState
    ).toEqual({ selected: true });
  });

  it('超过 10 个来源时自适应展示上限为 10 个', async () => {
    const twelveSources: WebSearchSource[] = Array.from(
      { length: 12 },
      (_, i) => ({
        id: `src-${i + 1}`,
        title: `来源标题 ${i + 1}`,
        url: `https://example.com/page/${i + 1}`,
        domain: `example${i + 1}.com`,
        snippet: `这是第 ${i + 1} 个来源的摘要`,
        provider: 'bocha',
      })
    );

    const view = await renderComponent(
      <WebSourceStrip sources={twelveSources} maxCount={10} />
    );

    // 前 10 个渲染
    expect(view.getByTestId('web-source-card-src-1')).toBeTruthy();
    expect(view.getByTestId('web-source-card-src-10')).toBeTruthy();
    // 第 11、12 个不挂载
    expect(view.queryByTestId('web-source-card-src-11')).toBeNull();
    expect(view.queryByTestId('web-source-card-src-12')).toBeNull();
  });
});

describe('WebSourceSheet 来源详情半屏抽屉', () => {
  it('source 为 null 时不呈现面板内容', async () => {
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={() => undefined}
        source={null}
        testID="sheet-null"
      />
    );
    expect(view.queryByTestId('web-source-sheet-title')).toBeNull();
  });

  it('完整呈现标题栏、引证编号胶囊、元数据、URL 与核心摘录卡片', async () => {
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={() => undefined}
        source={mockSources[0]!}
        citationIndex={1}
        testID="sheet-render"
      />
    );

    // 引证编号胶囊 [1]
    expect(view.getByTestId('web-source-sheet-index')).toBeTruthy();
    expect(view.getByText('[1]')).toBeTruthy();

    // 标题与 2 行截断限制
    const titleText = view.getByTestId('web-source-sheet-title');
    expect(titleText.props.children).toBe('React Native 官方文档与架构指南');
    expect(titleText.props.numberOfLines).toBe(2);

    // 元数据行
    expect(view.getByTestId('web-source-sheet-domain').props.children).toBe(
      'reactnative.dev'
    );
    expect(view.getByTestId('web-source-sheet-date').props.children).toBe(
      '2026-03-15'
    );
    expect(view.getByTestId('web-source-sheet-provider')).toBeTruthy();
    expect(view.getByText('Tavily')).toBeTruthy();

    // 完整 URL
    expect(view.getByTestId('web-source-sheet-url')).toBeTruthy();
    expect(
      view.getByText('https://reactnative.dev/docs/architecture-overview')
    ).toBeTruthy();

    // 核心摘录卡片，支持长按选择
    const snippetText = view.getByTestId('web-source-sheet-snippet');
    expect(snippetText.props.selectable).toBe(true);
    expect(snippetText.props.children).toContain(
      'React Native combines the best parts'
    );
  });

  it('点击关闭按钮触发 onClose 回调', async () => {
    const onCloseMock = jest.fn();
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={onCloseMock}
        source={mockSources[0]!}
        testID="sheet-close-test"
      />
    );

    const closeBtn = view.getByTestId('web-source-sheet-close');
    fireEvent.press(closeBtn);
    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  it('点击复制链接与“复制链接”按钮触发写入剪贴板与 Toast 反馈', async () => {
    mockShowToast.mockClear();
    const onCopyMock = jest.fn();
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={() => undefined}
        source={mockSources[0]!}
        onCopyLink={onCopyMock}
        testID="sheet-copy-test"
      />
    );

    // 点击 URL 栏复制
    const urlBox = view.getByTestId('web-source-sheet-url');
    await act(async () => {
      fireEvent.press(urlBox);
    });
    expect(onCopyMock).toHaveBeenCalledWith(
      'https://reactnative.dev/docs/architecture-overview'
    );

    // 点击底部“复制链接”操作按钮
    const copyBtn = view.getByTestId('web-source-sheet-copy-btn');
    await act(async () => {
      fireEvent.press(copyBtn);
    });
    expect(onCopyMock).toHaveBeenCalledTimes(2);

    // 验证 Toast 反馈触发
    expect(mockShowToast).toHaveBeenCalledWith('已复制网页链接', 'info');
  });

  it('默认复制链接回调写入系统剪贴板', async () => {
    jest.mocked(copyTextToClipboard).mockClear();
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={() => undefined}
        source={mockSources[1]!}
        testID="sheet-copy-default"
      />
    );

    const copyBtn = await view.findByTestId('web-source-sheet-copy-btn');
    await act(async () => {
      fireEvent.press(copyBtn);
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://github.com/conex/conex'
    );
  });

  it('点击“在应用内打开”按钮触发 onOpenPreview 或 openLink', async () => {
    const onPreviewMock = jest.fn();
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={() => undefined}
        source={mockSources[0]!}
        onOpenPreview={onPreviewMock}
        testID="sheet-preview-test"
      />
    );

    const previewBtn = await view.findByTestId('web-source-sheet-preview-btn');
    await act(async () => {
      fireEvent.press(previewBtn);
    });
    expect(onPreviewMock).toHaveBeenCalledWith(
      'https://reactnative.dev/docs/architecture-overview'
    );
  });

  it('无 onOpenPreview 时默认调用 openLink', async () => {
    jest.mocked(openLink).mockClear();
    const view = await renderComponent(
      <WebSourceSheet
        visible={true}
        onClose={() => undefined}
        source={mockSources[2]!}
        testID="sheet-preview-default"
      />
    );

    const previewBtn = await view.findByTestId('web-source-sheet-preview-btn');
    await act(async () => {
      fireEvent.press(previewBtn);
    });
    expect(openLink).toHaveBeenCalledWith('https://duckduckgo.com/about');
  });
});

describe('工具辅助函数与组件出口校验', () => {
  it('extractCleanDomain 正确剥除协议、路径与 www', () => {
    expect(extractCleanDomain('https://www.google.com/search?q=test')).toBe(
      'google.com'
    );
    expect(extractCleanDomain('http://github.com/conex')).toBe('github.com');
    expect(extractCleanDomain('www.bing.com')).toBe('bing.com');
    expect(extractCleanDomain('')).toBe('');
    expect(extractCleanDomain(undefined)).toBe('');
  });

  it('formatPublishDate 正确解析 ISO 格式日期与回退', () => {
    expect(formatPublishDate('2026-11-04T12:00:00Z')).toBe('2026-11-04');
    expect(formatPublishDate('2026-05-20')).toBe('2026-05-20');
    expect(formatPublishDate('not-a-date')).toBe('not-a-date');
    expect(formatPublishDate(undefined)).toBeNull();
  });

  it('getProviderBadgeLabel 覆盖各种搜索提供商标牌', () => {
    expect(getProviderBadgeLabel('tavily')).toBe('Tavily');
    expect(getProviderBadgeLabel('bocha')).toBe('Bocha');
    expect(getProviderBadgeLabel('exa')).toBe('Exa');
    expect(getProviderBadgeLabel('jina')).toBe('Jina');
    expect(getProviderBadgeLabel('duckduckgo_html')).toBe('DuckDuckGo');
    expect(getProviderBadgeLabel('bing_html')).toBe('Bing');
    expect(getProviderBadgeLabel('baidu_html')).toBe('Baidu');
    expect(getProviderBadgeLabel('wikipedia')).toBe('Wikipedia');
    expect(getProviderBadgeLabel('model_native')).toBe('原生检索');
    expect(getProviderBadgeLabel('custom_engine')).toBe('custom_engine');
    expect(getProviderBadgeLabel(undefined)).toBe('Web 检索');
  });

  it('index.ts 完整导出所有核心组件', () => {
    expect(ToolsExport.ToolRow).toBeDefined();
    expect(ToolsExport.WebSourceCard).toBeDefined();
    expect(ToolsExport.WebSourceStrip).toBeDefined();
    expect(ToolsExport.WebSourceSheet).toBeDefined();
  });
});
