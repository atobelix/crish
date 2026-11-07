// MarkdownText 渲染层断言（审计 §D.2)：
// - 黄金样本渲染后查不到 markdown 原文符号（结构已成型，不是原文直出）；
// - 代码块 / 表格按 testID 可查，独立成段图真加载（批 E 口径）；
// - 链接 press 走 openLink 统一出口；任务列表不可交互；
// - 超限降级有可见标注；流式回放中间帧无表格节点、终态成型。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';
import { MarkdownText } from './MarkdownText';
import { openLink } from '@/adapters/platform/openLink';
import * as clipboardModule from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';
import {
  GOLDEN_MARKDOWN,
  STREAM_DOC,
  streamFrameAt,
} from '@/domain/pure/markdown/__fixtures__/golden';

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

const openLinkMock = openLink as jest.MockedFunction<typeof openLink>;

/** 渲染树 JSON 节点（RNTL v14 已移除 UNSAFE_queryAllByType，改走 toJSON 遍历） */
interface JsonNode {
  type: string;
  children?: (JsonNode | string)[] | null;
}

function walkJson(
  node: unknown,
  visit: (node: JsonNode | string) => void
): void {
  if (typeof node === 'string') {
    visit(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => walkJson(child, visit));
    return;
  }
  if (node && typeof node === 'object') {
    const json = node as JsonNode;
    visit(json);
    json.children?.forEach((child) => walkJson(child, visit));
  }
}

/** 全部可见文本（断言「原文符号不出现」用） */
function allVisibleText(): string {
  const parts: string[] = [];
  walkJson(screen.toJSON(), (node) => {
    if (typeof node === 'string') parts.push(node);
  });
  return parts.join('\n');
}

/** 按宿主类型计数（如 Image：验证 markdown 内嵌图不真加载） */
function countHostType(typeName: string): number {
  let count = 0;
  walkJson(screen.toJSON(), (node) => {
    if (typeof node !== 'string' && node.type === typeName) count += 1;
  });
  return count;
}

beforeEach(() => {
  openLinkMock.mockClear();
});

describe('MarkdownText · 黄金样本', () => {
  it('渲染后查不到 markdown 原文符号', async () => {
    await render(<MarkdownText text={GOLDEN_MARKDOWN} />);
    const visible = allVisibleText();
    expect(visible).not.toContain('```');
    expect(visible).not.toContain('**');
    expect(visible).not.toContain('~~');
    expect(visible).not.toContain('## ');
    expect(visible).not.toContain('| ---');
    expect(visible).not.toContain('- [ ]');
    // 正面锚点：标题 / 表格单元格 / 代码内容都在（代码内容批 E 起按词法
    // 分片渲染，短语跨 span——断言前把空白归一，查「内容完整在场」本意）
    const squashed = visible.replace(/\s+/g, ' ');
    expect(squashed).toContain('Crish 会话周报 Weekly Report');
    expect(squashed).toContain('MD1');
    expect(squashed).toContain('export interface SessionConfig');
  });

  it('代码块 / 表格按 testID 可查；独立成段图真加载（批 E)', async () => {
    await render(<MarkdownText text={GOLDEN_MARKDOWN} />);
    expect(screen.getByTestId('markdown-code-block')).toBeTruthy();
    expect(screen.getByTestId('markdown-table')).toBeTruthy();
    // 批 E 口径（2026-11-03)：独立成段图真加载——Image 以 uri 源呈现，
    // alt 走无障碍标签；占位行只在加载失败时出现（几何 / 回落断言见
    // MarkdownImage.test)。旧「只占位不加载」口径（审计 C.6）就此废止
    const mdImage = screen.getByTestId('markdown-image');
    expect(mdImage.props.source).toEqual({
      uri: 'https://example.com/images/weekly.png',
    });
    expect(mdImage.props.accessibilityLabel).toBe('周报配图');
    expect(screen.queryByTestId('markdown-image-placeholder')).toBeNull();
    expect(countHostType('Image')).toBe(1);
  });
});

describe('MarkdownText · 链接与任务列表', () => {
  it('链接 press → openLink 收到 href（统一出口）', async () => {
    await render(
      <MarkdownText text="见 [项目主页](https://example.com/crish) 与说明" />
    );
    const linkNode = screen.getByText('项目主页');
    expect(linkNode.props.onPress).toBeTruthy();
    await fireEvent.press(linkNode);
    expect(openLinkMock).toHaveBeenCalledWith('https://example.com/crish');
  });

  it('任务列表呈现为不可交互（无按钮角色，勾选仅图形）', async () => {
    await render(<MarkdownText text={'- [x] 已完成项\n- [ ] 待办项'} />);
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByText('○')).toBeTruthy();
    expect(screen.getByText('已完成项')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('MarkdownText · 超限降级', () => {
  it('> 5 万字符降级纯文本 + 可见标注（不静默）', async () => {
    const text = '长内容'.repeat(20_000);
    await render(<MarkdownText text={text} />);
    expect(screen.getByTestId('markdown-degraded-note')).toBeTruthy();
    expect(screen.getByText('内容过长，已按纯文本显示')).toBeTruthy();
    expect(screen.queryByTestId('markdown-code-block')).toBeNull();
  });
});

describe('MarkdownText · 流式回放（只显最终形态）', () => {
  it('中间帧无表格节点；代码块以定型块承载；终态表格成型', async () => {
    const { rerender } = await render(
      <MarkdownText text={streamFrameAt('前言：本轮 **重')} streaming />
    );
    // 悬空粗体帧：符号不直显
    expect(allVisibleText()).not.toContain('**');

    await rerender(
      <MarkdownText text={streamFrameAt('```ts\nconst ans')} streaming />
    );
    expect(screen.getByTestId('markdown-code-block')).toBeTruthy();
    expect(screen.queryByTestId('markdown-table')).toBeNull();

    await rerender(
      <MarkdownText text={streamFrameAt('| --- | --- |')} streaming />
    );
    expect(screen.queryByTestId('markdown-table')).toBeNull();

    await rerender(<MarkdownText text={streamFrameAt('| 甲二')} streaming />);
    expect(screen.queryByTestId('markdown-table')).toBeNull();

    await rerender(<MarkdownText text={STREAM_DOC} streaming={false} />);
    expect(screen.getByTestId('markdown-table')).toBeTruthy();
    expect(screen.getByText('甲一')).toBeTruthy();
  });
});

describe('MarkdownText · 批 E 封口增强（高亮 / 公式 / 图 / 封顶）', () => {
  /** 收集渲染树中全部 style 颜色（含数组样式与嵌套 span 样式） */
  function collectStyleColors(): Set<string> {
    const colors = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const json = node as { props?: { style?: unknown }; children?: unknown };
      const styles = Array.isArray(json.props?.style)
        ? json.props.style
        : [json.props?.style];
      for (const style of styles) {
        if (
          style &&
          typeof style === 'object' &&
          'color' in style &&
          typeof (style as { color: unknown }).color === 'string'
        ) {
          colors.add((style as { color: string }).color);
        }
      }
      walk(json.children);
    };
    walk(screen.toJSON());
    return colors;
  }

  function hasMaxHeightStyle(value: number): boolean {
    let found = false;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object' || found) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const json = node as { props?: { style?: unknown }; children?: unknown };
      const styles = Array.isArray(json.props?.style)
        ? json.props.style
        : [json.props?.style];
      for (const style of styles) {
        if (
          style &&
          typeof style === 'object' &&
          (style as { maxHeight?: unknown }).maxHeight === value
        ) {
          found = true;
        }
      }
      walk(json.children);
    };
    walk(screen.toJSON());
    return found;
  }

  it('封口代码块高亮：关键字走浅色板 keyword 色；尾块保持原文无着色', async () => {
    const { rerender } = await render(
      <MarkdownText
        text={'```ts\nconst answer = 42;\n```\n\n后续段落生长中'}
        streaming
      />
    );
    // 围栏已闭合且非尾块 = 封口：keyword 色 #a626a4（浅色板）出现
    expect(collectStyleColors().has('#a626a4')).toBe(true);

    // 同一代码块成为尾块（生长中）时不着色——等宽原文呈现
    await rerender(
      <MarkdownText text={'```ts\nconst answer = 42;\n```'} streaming />
    );
    expect(collectStyleColors().has('#a626a4')).toBe(false);
    expect(screen.getByTestId('markdown-code-block')).toBeTruthy();
  });

  it('代码块纵向封顶 320（layout token）', async () => {
    await render(<MarkdownText text={'```ts\nconst a = 1;\n```'} />);
    expect(hasMaxHeightStyle(320)).toBe(true);
  });

  it('mermaid 围栏：封口后 WebView 化，尾块保持代码块原文', async () => {
    const { rerender } = await render(
      <MarkdownText
        text={'```mermaid\ngraph TD; A-->B;\n```\n\n解说生长中'}
        streaming
      />
    );
    expect(screen.getByTestId('markdown-web-mermaid')).toBeTruthy();
    expect(screen.queryByTestId('markdown-code-block')).toBeNull();

    await rerender(
      <MarkdownText text={'```mermaid\ngraph TD; A--'} streaming />
    );
    expect(screen.queryByTestId('markdown-web-mermaid')).toBeNull();
    expect(screen.getByTestId('markdown-code-block')).toBeTruthy();
  });

  it('展示公式：静态 / 封口段 WebView 化；流式尾段保持原文', async () => {
    const { rerender } = await render(
      <MarkdownText text={'$$\nE = mc^2\n$$'} />
    );
    expect(screen.getByTestId('markdown-web-math')).toBeTruthy();

    await rerender(
      <MarkdownText text={'$$\nx^2\n$$\n\n后文生长中'} streaming />
    );
    expect(screen.getByTestId('markdown-web-math')).toBeTruthy();

    await rerender(<MarkdownText text={'$$\nx^2'} streaming />);
    expect(screen.queryByTestId('markdown-web-math')).toBeNull();
  });

  it('与正文混排的行内公式不转换（保持原文呈现）', async () => {
    await render(<MarkdownText text={'能量公式 $E = mc^2$ 很重要'} />);
    expect(screen.queryByTestId('markdown-web-math')).toBeNull();
    expect(screen.getByText(/\$E = mc\^2\$/)).toBeTruthy();
  });
});

describe('MarkdownText · 代码块顶栏复制与极浅分割线', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('渲染代码块时展示语言标签、复制按钮与居中极浅分割线', async () => {
    await render(
      <MarkdownText text={'```typescript\nconst a: number = 42;\n```'} />
    );

    // 1. 代码块容器存在
    expect(screen.getByTestId('markdown-code-block')).toBeTruthy();

    // 2. 语言标签正确展示
    expect(screen.getByText('typescript')).toBeTruthy();

    // 3. 复制按钮与初始无障碍语义存在
    const copyBtn = screen.getByTestId('markdown-code-copy-btn');
    expect(copyBtn).toBeTruthy();
    expect(copyBtn.props.accessibilityLabel).toBe('复制代码');

    // 4. 居中发丝级分割线存在且样式符合规范（width 94%, alignSelf center, hairlineWidth）
    const divider = screen.getByTestId('markdown-code-divider');
    expect(divider).toBeTruthy();
    const flatStyle = StyleSheet.flatten(divider.props.style);
    expect(flatStyle.width).toBe('94%');
    expect(flatStyle.alignSelf).toBe('center');
    expect(flatStyle.height).toBe(StyleSheet.hairlineWidth);
  });

  it('无语言标记的代码块降级显示 code，复制按钮与分割线依然正常在场', async () => {
    await render(<MarkdownText text={'```\nplain snippet\n```'} />);
    expect(screen.getByText('code')).toBeTruthy();
    expect(screen.getByTestId('markdown-code-copy-btn')).toBeTruthy();
    expect(screen.getByTestId('markdown-code-divider')).toBeTruthy();
  });

  it('点击复制触发剪贴板写入与触感反馈，1500ms 后自动复位', async () => {
    const copySpy = jest.spyOn(clipboardModule, 'copyTextToClipboard');
    await render(<MarkdownText text={'```python\nprint("hello")\n```'} />);

    const copyBtn = screen.getByTestId('markdown-code-copy-btn');
    await act(async () => {
      fireEvent.press(copyBtn);
    });

    // 剪贴板入参为完整文本
    expect(copySpy).toHaveBeenCalledWith('print("hello")');
    // 触发选择触感
    expect(haptics.selection).toHaveBeenCalled();

    // 状态切换为已复制
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('已复制代码');

    // 快进 1500ms，状态自动恢复
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('复制代码');
  });

  it('1500ms 内再次点击重新计时，防抖稳定', async () => {
    await render(<MarkdownText text={'```python\nprint("hello")\n```'} />);
    const copyBtn = screen.getByTestId('markdown-code-copy-btn');

    await act(async () => {
      fireEvent.press(copyBtn);
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('已复制代码');

    // 前进 1000ms（尚未超时）
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('已复制代码');

    // 再次点击重新计时
    await act(async () => {
      fireEvent.press(screen.getByTestId('markdown-code-copy-btn'));
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('已复制代码');

    // 再过 1000ms（距离第二次点击只有 1000ms，若没重置则已 2000ms 恢复了）
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('已复制代码');

    // 再过 500ms（达到第二次点击的 1500ms）
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('复制代码');
  });

  it('组件卸载时安全清理定时器，不发生悬空回调', async () => {
    const { unmount } = await render(
      <MarkdownText text={'```python\nprint("hello")\n```'} />
    );
    const copyBtn = screen.getByTestId('markdown-code-copy-btn');
    await act(async () => {
      fireEvent.press(copyBtn);
    });
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('已复制代码');

    // 卸载组件
    await act(async () => {
      unmount();
    });

    // 卸载后再快进定时器，无任何异常抛出
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
  });

  it('剪贴板返回 false 时不进入已复制状态', async () => {
    const copySpy = jest
      .spyOn(clipboardModule, 'copyTextToClipboard')
      .mockResolvedValueOnce(false);
    await render(<MarkdownText text={'```python\nprint("failed")\n```'} />);
    const copyBtn = screen.getByTestId('markdown-code-copy-btn');

    await act(async () => {
      fireEvent.press(copyBtn);
    });

    expect(copySpy).toHaveBeenCalledWith('print("failed")');
    expect(haptics.selection).toHaveBeenCalled();
    // 状态仍为未复制
    expect(
      screen.getByTestId('markdown-code-copy-btn').props.accessibilityLabel
    ).toBe('复制代码');
  });
});

describe('MarkdownText · 代码块内滚跟随（任务四 A)', () => {
  const LONG_CODE = '```ts\n' + 'const line = 1;\n'.repeat(40);

  function spyScrollTo() {
    const spy = jest.fn();
    const protoSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(spy);
    return { spy, protoSpy };
  }

  async function layoutScroll(
    scroll: ReturnType<typeof screen.getByTestId>
  ) {
    await act(async () => {
      fireEvent(scroll, 'layout', {
        nativeEvent: { layout: { height: 320, width: 350 } },
      });
    });
  }

  it('未封口尾块超高后按内容尺寸一次性落位（偏移 = 内容高 − 视口高，animated: false）', async () => {
    const { spy, protoSpy } = spyScrollTo();
    await render(<MarkdownText text={LONG_CODE} streaming />);
    const scroll = screen.getByTestId('markdown-code-scroll');
    await layoutScroll(scroll);
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 900);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ y: 580, animated: false });
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 1000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ y: 680, animated: false });
    protoSpy.mockRestore();
  });

  it('内容未超过视口高度时不落位', async () => {
    const { spy, protoSpy } = spyScrollTo();
    await render(<MarkdownText text={LONG_CODE} streaming />);
    const scroll = screen.getByTestId('markdown-code-scroll');
    await layoutScroll(scroll);
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 200);
    });
    expect(spy).not.toHaveBeenCalled();
    protoSpy.mockRestore();
  });

  it('用户拖动后退出跟随；回到底部后恢复跟随', async () => {
    const { spy, protoSpy } = spyScrollTo();
    await render(<MarkdownText text={LONG_CODE} streaming />);
    const scroll = screen.getByTestId('markdown-code-scroll');
    await layoutScroll(scroll);
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 900);
    });
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent(scroll, 'scrollBeginDrag');
    });
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 1200);
    });
    // 拖动后新增长不拽回底部
    expect(spy).toHaveBeenCalledTimes(1);

    // 回到贴底（离底 0）→ 恢复跟随
    await act(async () => {
      fireEvent(scroll, 'scroll', {
        nativeEvent: {
          contentSize: { height: 1200, width: 350 },
          contentOffset: { x: 0, y: 880 },
          layoutMeasurement: { height: 320, width: 350 },
        },
      });
    });
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 1300);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ y: 980, animated: false });
    protoSpy.mockRestore();
  });

  it('流式中途封口后不再跟随（封口不拽回底部）', async () => {
    const { spy, protoSpy } = spyScrollTo();
    const { rerender } = await render(
      <MarkdownText text={'```ts\nconst a = 1;'} streaming />
    );
    const scroll = screen.getByTestId('markdown-code-scroll');
    await layoutScroll(scroll);
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 900);
    });
    // 未封口时跟随一次
    expect(spy).toHaveBeenCalledTimes(1);

    // 围栏闭合且后有段落 → 该块封口
    await rerender(
      <MarkdownText text={'```ts\nconst a = 1;\n```\n\n封口后的说明'} streaming />
    );
    const scrollAfter = screen.getByTestId('markdown-code-scroll');
    await act(async () => {
      fireEvent(scrollAfter, 'contentSizeChange', 350, 1000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    protoSpy.mockRestore();
  });

  it('静态（全封口）代码块从不自动落位', async () => {
    const { spy, protoSpy } = spyScrollTo();
    await render(
      <MarkdownText
        text={'```ts\n' + 'const line = 1;\n'.repeat(40) + '```'}
      />
    );
    const scroll = screen.getByTestId('markdown-code-scroll');
    await layoutScroll(scroll);
    await act(async () => {
      fireEvent(scroll, 'contentSizeChange', 350, 900);
    });
    expect(spy).not.toHaveBeenCalled();
    protoSpy.mockRestore();
  });
});
