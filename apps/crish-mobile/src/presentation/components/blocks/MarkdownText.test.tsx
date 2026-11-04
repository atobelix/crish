// MarkdownText 渲染层断言（审计 §D.2)：
// - 黄金样本渲染后查不到 markdown 原文符号（结构已成型，不是原文直出）；
// - 代码块 / 表格按 testID 可查，独立成段图真加载（批 E 口径）；
// - 链接 press 走 openLink 统一出口；任务列表不可交互；
// - 超限降级有可见标注；流式回放中间帧无表格节点、终态成型。
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MarkdownText } from './MarkdownText';
import { openLink } from '@/adapters/platform/openLink';
import {
  GOLDEN_MARKDOWN,
  STREAM_DOC,
  streamFrameAt,
} from '@/domain/pure/markdown/__fixtures__/golden';

jest.mock('@/adapters/platform/openLink', () => ({
  openLink: jest.fn(async () => true),
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
