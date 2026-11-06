// apps/crish-mobile/src/presentation/components/blocks/MarkdownText.citations.test.tsx
// MarkdownText 正文引证解析与角标微光联动测试：
// 1. 各类大模型引文语法识别：[^1], [2], 【3】, [cite:4]；
// 2. 事实源精准绑定：点击角标向 onCitationPress 派发 (index, matchedSource)；
// 3. 联动微光高亮：highlightedCitationIndex 精准驱动目标角标高亮样式；
// 4. 富文本与容器混排：粗体、斜体、列表、引用块、表格内角标均正常解析；
// 5. 守卫与隔离保护：行内代码与代码围栏绝对不误伤解析；
// 6. 流式渐显与超限降级平稳兼容。

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { MarkdownText } from './MarkdownText';
import { haptics } from '@/adapters/platform/haptics';
import { lightTheme } from '@/adapters/platform/theme';
import type { WebSearchSource } from '@crish/shared-types';

jest.mock('@/adapters/platform/openLink', () => ({
  openLink: jest.fn(async () => true),
}));

jest.mock('@/adapters/platform/clipboard', () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

jest.mock('@/adapters/platform/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    tap: jest.fn(),
    snap: jest.fn(),
    success: jest.fn(),
    failure: jest.fn(),
  },
}));

function flat(node: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as never) ?? {};
}

const MOCK_SOURCES: readonly WebSearchSource[] = [
  {
    id: '1',
    title: 'React Native 0.86 官方发布',
    url: 'https://reactnative.dev/blog/2026/0.86',
    snippet: 'React Native 0.86 带来了全新的无缝混合架构与极速渲染能力。',
    domain: 'reactnative.dev',
    provider: 'tavily',
  },
  {
    id: '2',
    title: 'Expo SDK 57 特性总览',
    url: 'https://expo.dev/changelog/sdk-57',
    snippet: '全面对齐 React Native 0.86 与新一代工具链。',
    domain: 'expo.dev',
    provider: 'tavily',
  },
];

describe('MarkdownText · 正文引证角标与交互式 Citation 解析', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('语法识别与角标渲染', () => {
    it('识别标准 Markdown 脚注 [^1] 并渲染为微缩上标胶囊 [1]', async () => {
      const markdown = '根据最新的工程实践 [^1]，性能大幅提升。';
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      const pill = screen.getByTestId('citation-pill-1');
      expect(pill).toBeTruthy();
      expect(pill.props.accessibilityRole).toBe('button');
      expect(pill.props.accessibilityLabel).toBe('引用来源 1');
      expect(screen.getByText('[1]')).toBeTruthy();

      // 正文文字完整保留
      expect(screen.getByText(/根据最新的工程实践/)).toBeTruthy();
      expect(screen.getByText(/性能大幅提升。/)).toBeTruthy();
    });

    it('兼容括号数字 [2]、全角中文【1】与显式格式 [cite:2]', async () => {
      const markdown =
        '对比分析：方案 A 胜出 [1]，结合【2】的数据，佐证见 [cite:1]。';
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      // [1] 与 [cite:1] 均为序号 1
      const allPill1 = screen.getAllByTestId('citation-pill-1');
      expect(allPill1.length).toBe(2);
      expect(screen.getByTestId('citation-pill-2')).toBeTruthy();
    });

    it('连续引文角标 [^1][^2] 独立排版渲染', async () => {
      const markdown = '多方交叉核对表明 [^1][^2] 该结论可靠。';
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.getByTestId('citation-pill-1')).toBeTruthy();
      expect(screen.getByTestId('citation-pill-2')).toBeTruthy();
    });
  });

  describe('交互回调与触感震动', () => {
    it('点击引文角标触发 onCitationPress 并传递序号及匹配的事实源', async () => {
      const onCitationPressMock = jest.fn();
      const markdown = '深入分析见报告 [^1]。';

      await render(
        <MarkdownText
          text={markdown}
          sources={MOCK_SOURCES}
          onCitationPress={onCitationPressMock}
        />
      );

      const pill = screen.getByTestId('citation-pill-1');
      await act(async () => {
        fireEvent.press(pill);
      });

      expect(haptics.selection).toHaveBeenCalledTimes(1);
      expect(onCitationPressMock).toHaveBeenCalledTimes(1);
      expect(onCitationPressMock).toHaveBeenCalledWith(1, MOCK_SOURCES[0]);
    });

    it('未匹配到 sources 时仍派发序号并将 source 回传 undefined', async () => {
      const onCitationPressMock = jest.fn();
      const markdown = '未录入的事实源 [^99]。';

      await render(
        <MarkdownText
          text={markdown}
          sources={MOCK_SOURCES}
          onCitationPress={onCitationPressMock}
        />
      );

      const pill = screen.getByTestId('citation-pill-99');
      await act(async () => {
        fireEvent.press(pill);
      });

      expect(haptics.selection).toHaveBeenCalledTimes(1);
      expect(onCitationPressMock).toHaveBeenCalledWith(99, undefined);
    });
  });

  describe('微光联动高亮', () => {
    it('highlightedCitationIndex 触发特定角标的高亮样式与普通角标区分', async () => {
      const markdown = '结论一 [^1]，结论二 [^2]。';
      const { rerender } = await render(
        <MarkdownText
          text={markdown}
          sources={MOCK_SOURCES}
          highlightedCitationIndex={1}
        />
      );

      const pill1 = screen.getByTestId('citation-pill-1');
      const pill2 = screen.getByTestId('citation-pill-2');

      // 序号 1 处于高亮态
      expect(flat(pill1).backgroundColor).toBe(lightTheme.colors.fillPressed);
      expect(flat(pill1).borderColor).toBe(lightTheme.colors.brand);

      // 序号 2 处于普通态
      expect(flat(pill2).backgroundColor).toBe(
        lightTheme.colors.surfaceGrouped
      );
      expect(flat(pill2).borderColor).toBe(lightTheme.colors.hairline);

      // 动态切换高亮到序号 2
      await rerender(
        <MarkdownText
          text={markdown}
          sources={MOCK_SOURCES}
          highlightedCitationIndex={2}
        />
      );

      const updatedPill1 = screen.getByTestId('citation-pill-1');
      const updatedPill2 = screen.getByTestId('citation-pill-2');

      expect(flat(updatedPill1).backgroundColor).toBe(
        lightTheme.colors.surfaceGrouped
      );
      expect(flat(updatedPill2).backgroundColor).toBe(
        lightTheme.colors.fillPressed
      );
      expect(flat(updatedPill2).borderColor).toBe(lightTheme.colors.brand);
    });
  });

  describe('复杂 Markdown 结构兼容性', () => {
    it('在粗体与斜体中正常识别引文', async () => {
      const markdown = '特别强调 **重点一 [^1]** 与 *次要推论 [^2]*。';
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.getByTestId('citation-pill-1')).toBeTruthy();
      expect(screen.getByTestId('citation-pill-2')).toBeTruthy();
    });

    it('在无序列表与有序列表中正常识别引文', async () => {
      const markdown = `
- 列表项 A 证实 [^1]
- 列表项 B 佐证 [^2]

1. 步骤一实施 【1】
2. 步骤二验收 【2】
`;
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.getAllByTestId('citation-pill-1').length).toBe(2);
      expect(screen.getAllByTestId('citation-pill-2').length).toBe(2);
    });

    it('在引用块中正常识别引文', async () => {
      const markdown = '> 引述原话如下：系统已完成部署 [^1]。';
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.getByTestId('citation-pill-1')).toBeTruthy();
    });

    it('在 Markdown 表格单元格中正常识别引文', async () => {
      const markdown = `
| 模块 | 结论 | 引用源 |
| :--- | :--- | :--- |
| 网络层 | 安全无漏洞 | [^1] |
| 存储层 | 读写吞吐提升 | 详见 [^2] |
`;
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.getByTestId('citation-pill-1')).toBeTruthy();
      expect(screen.getByTestId('citation-pill-2')).toBeTruthy();
    });
  });

  describe('防误伤安全守卫', () => {
    it('代码围栏中的类似语法绝对不解析为角标', async () => {
      const markdown = `
\`\`\`typescript
const array = [1, 2, 3];
const item = array[^1];
\`\`\`
`;
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.queryByTestId('citation-pill-1')).toBeNull();
      expect(screen.getByTestId('markdown-code-block')).toBeTruthy();
    });

    it('行内代码中的类似语法绝对不解析为角标', async () => {
      const markdown = '请调用 `items[1]` 获取首项，而非 `lookup[^2]`。';
      await render(<MarkdownText text={markdown} sources={MOCK_SOURCES} />);

      expect(screen.queryByTestId('citation-pill-1')).toBeNull();
      expect(screen.queryByTestId('citation-pill-2')).toBeNull();
      expect(screen.getByText('items[1]')).toBeTruthy();
      expect(screen.getByText('lookup[^2]')).toBeTruthy();
    });
  });

  describe('流式与超限平稳兼容', () => {
    it('流式活跃期 (streaming=true) 正常承载角标与尾端渐变', async () => {
      const markdown = '实时流式输出分析 [^1]';
      await render(
        <MarkdownText
          text={markdown}
          streaming
          tailFade={{
            births: Array.from({ length: 24 }, () => 10_000),
            atTime: 10_000,
          }}
          sources={MOCK_SOURCES}
        />
      );

      // 流式下末端时间渐显分段渲染在场
      expect(screen.getByTestId('tail-fade-0')).toBeTruthy();
    });

    it('全文超限降级期 (text > 50,000) 平稳降级不发生崩溃', async () => {
      const giantText = '长文本 [^1] '.repeat(6000);
      await render(<MarkdownText text={giantText} sources={MOCK_SOURCES} />);

      expect(screen.getByTestId('markdown-degraded-note')).toBeTruthy();
    });
  });
});
