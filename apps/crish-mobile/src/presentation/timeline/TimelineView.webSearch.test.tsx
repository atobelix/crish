/**
 * apps/crish-mobile/src/presentation/timeline/TimelineView.webSearch.test.tsx
 *
 * 时间线网页搜索、来源微胶囊横向滑动条、角标联动与抽屉弹窗完整闭环测试
 */

import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { TimelineView } from './TimelineView';
import type { TimelineBlock } from './buildTimeline';
import { ToastProvider } from '@/presentation/ui';
import { haptics } from '@/adapters/platform/haptics';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

jest.mock('@/adapters/platform/openLink', () => ({
  openLink: jest.fn(async () => true),
}));

jest.mock('@/adapters/platform/clipboard', () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

describe('TimelineView 网页搜索来源与角标交互闭环', () => {
  const mockSources = [
    {
      id: 'cite-1',
      title: 'React Native 0.86 架构概览',
      url: 'https://reactnative.dev/blog/0.86',
      snippet: 'React Native 0.86 带来了默认新架构与端侧工具调用支持。',
      domain: 'reactnative.dev',
      provider: 'google' as const,
    },
    {
      id: 'cite-2',
      title: 'GitHub 仓库代码',
      url: 'https://github.com/facebook/react-native',
      snippet: 'Facebook 官方 React Native 核心仓库源码。',
      domain: 'github.com',
      provider: 'bing' as const,
    },
  ];

  it('当工具块包含 webSources 时，时间线渲染 WebSourceStrip 胶囊流', async () => {
    const blocks: TimelineBlock[] = [
      {
        kind: 'tool',
        id: 'tool-search-1',
        toolName: 'web_search',
        status: 'done',
        input: '{"query":"React Native 0.86"}',
        output: '...',
        atMs: 1000,
        webSources: mockSources,
      },
      {
        kind: 'message',
        id: 'msg-assistant-1',
        role: 'assistant',
        text: '根据最新的技术发布 [1]，新架构已默认启用。详细源码可见 [2]。',
        streaming: false,
        atMs: 2000,
      },
    ];

    const { getByTestId, getByText } = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TimelineView
            blocks={blocks}
            follow={true}
            onFollowChange={jest.fn()}
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    // 1. 验证 24px 工具单行正常渲染
    expect(getByTestId('tool-run-tool-search-1')).toBeDefined();

    // 2. 验证 WebSourceStrip 胶囊条渲染
    expect(getByTestId('tool-run-tool-search-1-sources')).toBeDefined();
    expect(getByText('reactnative.dev')).toBeDefined();
    expect(getByText('github.com')).toBeDefined();
  });

  it('点击来源胶囊，展开 WebSourceSheet 详情抽屉并可唤起 WebPreviewSheet', async () => {
    const hapticsSpy = jest.spyOn(haptics, 'selection');

    const blocks: TimelineBlock[] = [
      {
        kind: 'tool',
        id: 'tool-search-1',
        toolName: 'web_search',
        status: 'done',
        input: '{"query":"React Native 0.86"}',
        output: '...',
        atMs: 1000,
        webSources: mockSources,
      },
    ];

    const { getByTestId, queryByTestId, getAllByText } = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TimelineView
            blocks={blocks}
            follow={true}
            onFollowChange={jest.fn()}
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    // 初始状态抽屉均未打开
    expect(queryByTestId('web-source-sheet')).toBeNull();
    expect(queryByTestId('web-preview-sheet')).toBeNull();

    // 点击首个来源胶囊
    const firstCard = getByTestId('web-source-card-cite-1');
    await act(async () => {
      fireEvent.press(firstCard);
    });

    expect(hapticsSpy).toHaveBeenCalled();
    // 详情抽屉展现
    expect(getByTestId('web-source-sheet')).toBeDefined();
    expect(
      getAllByText('React Native 0.86 架构概览').length
    ).toBeGreaterThanOrEqual(1);

    // 点击在应用内打开按钮
    const previewBtn = getByTestId('web-source-sheet-preview-btn');
    await act(async () => {
      fireEvent.press(previewBtn);
    });

    // WebSourceSheet 关闭，WebPreviewSheet 展现
    expect(queryByTestId('web-source-sheet')).toBeNull();
    expect(getByTestId('web-preview-sheet')).toBeDefined();
  });

  it('点击 Markdown 正文角标 [1]，触发触感反馈并直接打开该引证来源详情', async () => {
    const hapticsSpy = jest.spyOn(haptics, 'selection');

    const blocks: TimelineBlock[] = [
      {
        kind: 'tool',
        id: 'tool-search-1',
        toolName: 'web_search',
        status: 'done',
        input: '{"query":"React Native 0.86"}',
        output: '...',
        atMs: 1000,
        webSources: mockSources,
      },
      {
        kind: 'message',
        id: 'msg-assistant-1',
        role: 'assistant',
        text: '新架构默认开启 [1]，请查阅文档。',
        streaming: false,
        atMs: 2000,
      },
    ];

    const { getByTestId, getAllByText } = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TimelineView
            blocks={blocks}
            follow={true}
            onFollowChange={jest.fn()}
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    // 寻找角标微胶囊
    const pill = getByTestId('citation-pill-1');
    expect(pill).toBeDefined();

    await act(async () => {
      fireEvent.press(pill);
    });

    // 验证震动与详情抽屉展开
    expect(hapticsSpy).toHaveBeenCalled();
    expect(getByTestId('web-source-sheet')).toBeDefined();
    expect(
      getAllByText('React Native 0.86 架构概览').length
    ).toBeGreaterThanOrEqual(1);
  });
});
