// @vitest-environment jsdom
/**
 * AsyncMarkdownBlock 组件测试（PE-02 T02.2/T02.4 验收锚点）。
 *
 * 覆盖：
 *   1. 多帧增量 push → data-block-id 数 = finalizedBlocks 数、data-block-tail 至多 1 个
 *   2. 未闭合 fence 软渲染（tail 为 md-code-block，内容可见）
 *   3. fence 闭合 → finalized 块、tail 消失
 *   4. 完成态切换 → innerHTML 一次收敛为 rustHtml、解析器 dispose
 *   5. parser 抛错 → 回退纯文本（零回归）
 *   6. visible=false（视口外）→ 暂停增量解析；恢复可见后渲染
 *   7. 文本全量替换 → reset 重建（不残留旧内容）
 *
 * 说明：完成态 hook（useAsyncMarkdownHtml）以 mock 控制 html/loading；
 * 增量解析器为真实实例（jsdom container 直操 DOM）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { AsyncMarkdownBlock } from './AsyncMarkdownBlock';
import { IncrementalMarkdownParser } from '../../api/markdown-render/IncrementalMarkdownParser';

const mocks = vi.hoisted(() => ({
  useAsyncMarkdownHtml: vi.fn(),
}));

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: mocks.useAsyncMarkdownHtml,
}));

const RUST_HTML = '<h1 class="md-h1">标题</h1><p class="md-p">正文</p>';

function useEmptyRender() {
  mocks.useAsyncMarkdownHtml.mockReturnValue({ html: '', loading: false });
}

function blockNodes(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('[data-block-id]')
  ) as HTMLElement[];
}

function tailNodes(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('[data-block-tail]')
  ) as HTMLElement[];
}

afterEach(() => {
  vi.restoreAllMocks();
  useEmptyRender();
});

describe('AsyncMarkdownBlock', () => {
  it('用例1：多帧增量 push → 块数一致且 tail 至多 1 个（渲染 markdown 而非纯文本）', () => {
    useEmptyRender();
    const text = '## 二级标题\n\n段落一\n\n- 项1\n- 项2';
    const frames = [
      '## 二级标题',
      '## 二级标题\n\n段落一',
      '## 二级标题\n\n段落一\n\n- 项1',
      text,
    ];
    const { container, rerender } = render(
      <AsyncMarkdownBlock text={frames[0]!} isStreaming />
    );
    const parser = new IncrementalMarkdownParser();
    for (const frame of frames) {
      rerender(<AsyncMarkdownBlock text={frame} isStreaming />);
      parser.push(frame);
    }
    // [data-block-id] 数 = finalizedBlocks 数
    expect(blockNodes(container)).toHaveLength(parser.finalizedBlocks.length);
    // [data-block-tail] 至多 1 个
    expect(tailNodes(container).length).toBeLessThanOrEqual(1);
    // 呈现 markdown 结构而非纯文本
    expect(container.innerHTML).toContain('md-h2');
    expect(container.innerHTML).toContain('md-ul');
    expect(container.innerHTML).toContain('md-li');
    // 内容可见（CJK wbr / hljs span 拆字 → 用 textContent 断言）
    expect(container.textContent).toContain('项1');
    // 最末帧 tail 为开放列表
    const tail = tailNodes(container)[0];
    expect(tail).toBeTruthy();
    expect(tail!.textContent).toContain('项2');
  });

  it('用例2：未闭合 fence 软渲染 → tail 为 md-code-block 且内容可见', () => {
    useEmptyRender();
    const text = '```typescript\nconst a = 1;\nlet b = 2;';
    const { container } = render(<AsyncMarkdownBlock text={text} isStreaming />);
    const tail = tailNodes(container)[0];
    expect(tail).toBeTruthy();
    expect(tail!.innerHTML).toContain('md-code-block');
    // hljs 行级高亮会拆 span，源码文本用 textContent 断言
    expect(tail!.textContent).toContain('const a = 1;');
    expect(tail!.textContent).toContain('let b = 2;');
    expect(blockNodes(container)).toHaveLength(0);
    // 内容可见：源码字符出现在 DOM 文本中（非 React 纯文本节点，但可见）
    expect(container.textContent).toContain('const a = 1;');
  });

  it('用例3：fence 闭合 → 变为 finalized 块，tail 消失', () => {
    useEmptyRender();
    const { container, rerender } = render(
      <AsyncMarkdownBlock text={'```typescript\nconst a = 1;'} isStreaming />
    );
    expect(tailNodes(container)).toHaveLength(1);
    rerender(
      <AsyncMarkdownBlock text={'```typescript\nconst a = 1;\n```'} isStreaming />
    );
    expect(tailNodes(container)).toHaveLength(0);
    expect(blockNodes(container)).toHaveLength(1);
    expect(container.innerHTML).toContain('md-code-block');
  });

  it('用例4：完成态切换 → 一次收敛为 rustHtml（precomputedHtml 命中跳过 IPC），解析器 dispose', () => {
    useEmptyRender();
    const disposeSpy = vi.spyOn(
      IncrementalMarkdownParser.prototype,
      'dispose'
    );
    const { container, rerender } = render(
      <AsyncMarkdownBlock text={'## 标题\n\n正文'} isStreaming />
    );
    expect(container.querySelectorAll('[data-block-id]').length).toBeGreaterThan(0);
    // 完成态：precomputedHtml 优先，hook 不得被调起渲染
    rerender(
      <AsyncMarkdownBlock
        text={'## 标题\n\n正文'}
        isStreaming={false}
        precomputedHtml={RUST_HTML}
      />
    );
    const rendered = container.firstElementChild as HTMLElement;
    expect(rendered.innerHTML).toBe(RUST_HTML);
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-block-tail]')).toHaveLength(0);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('用例4b：完成态无 precomputedHtml → hook 结果收敛（Rust 权威渲染兜底路径）', () => {
    mocks.useAsyncMarkdownHtml.mockReturnValue({
      html: '<p class="md-p">完成正文</p>',
      loading: false,
    });
    const { container, rerender } = render(
      <AsyncMarkdownBlock text="进行中正文" isStreaming />
    );
    rerender(<AsyncMarkdownBlock text="完成正文" isStreaming={false} />);
    const rendered = container.firstElementChild as HTMLElement;
    expect(rendered.innerHTML).toBe('<p class="md-p">完成正文</p>');
    // 无纯文本闪现：完成态 DOM 不含 markdown 源码文本节点
    expect(rendered.textContent).not.toContain('进行中正文');
  });

  it('用例5：parser 抛错 → 回退纯文本（零回归）', () => {
    useEmptyRender();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    vi.spyOn(IncrementalMarkdownParser.prototype, 'push').mockImplementation(
      () => {
        throw new Error('parser boom');
      }
    );
    const text = '# 标题\n\n正文';
    const { container } = render(<AsyncMarkdownBlock text={text} isStreaming />);
    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('用例6：视口外（visible=false）暂停增量解析；恢复可见后渲染', () => {
    useEmptyRender();
    const text = '# 标题\n\n正文';
    const { container, rerender } = render(
      <AsyncMarkdownBlock text={text} isStreaming visible={false} />
    );
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(0);
    expect(container.firstElementChild?.innerHTML ?? '').toBe('');
    rerender(<AsyncMarkdownBlock text={text} isStreaming visible />);
    expect(container.innerHTML).toContain('md-h1');
    expect(container.textContent).toContain('正文');
  });

  it('用例7：文本全量替换（非增量追加）→ reset 重建，不残留旧内容', () => {
    useEmptyRender();
    const { container, rerender } = render(
      <AsyncMarkdownBlock text="旧文本片段" isStreaming />
    );
    expect(container.textContent).toContain('旧文本片段');
    rerender(<AsyncMarkdownBlock text="全新文本 A\n\n全新文本 B" isStreaming />);
    expect(container.textContent).toContain('全新文本 A');
    expect(container.textContent).not.toContain('旧文本片段');
  });
});
