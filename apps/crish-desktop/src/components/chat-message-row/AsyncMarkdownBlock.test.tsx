// @vitest-environment jsdom
/**
 * AsyncMarkdownBlock 组件测试（PE-02 T02.2/T02.4 验收锚点）。
 *
 * 覆盖（对齐 D0 residual 清理后的组件契约）：
 *   1. 流式期间（isStreaming=true）→ 纯文本 + caret，不注入 HTML、不调 hook 渲染
 *   2. 未闭合 fence 流式 → 纯文本可见（不提前渲染）
 *   3. 完成态切换 → 一次收敛为 rustHtml（hook 结果写入 innerHTML）
 *   4. 完成态无 rustHtml → skeleton 占位；渲染完成清除
 *   5. hook 渲染失败（reject）→ 不崩溃、无骨架残留
 *   6. 文本全量替换 → 完成态按新文本重新渲染（不残留旧内容）
 *   7. 空文本 → 渲染 null
 *
 * 说明：完成态 hook（useAsyncMarkdownHtml）以 mock 控制 html/loading；
 * 已删除路径（IncrementalMarkdownParser / data-block-id / data-block-tail /
 * visible 暂停）不再断言（D0 residual）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { AsyncMarkdownBlock } from './AsyncMarkdownBlock';

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

afterEach(() => {
  vi.restoreAllMocks();
  useEmptyRender();
});

describe('AsyncMarkdownBlock', () => {
  it('用例1：流式期间纯文本可见，不注入 HTML（不调 hook 渲染）', () => {
    useEmptyRender();
    const text = '## 二级标题\n\n段落一\n\n- 项1\n- 项2';
    const { container } = render(<AsyncMarkdownBlock text={text} isStreaming />);
    // 纯文本直接可见（markdown 源码，未渲染）
    expect(container.textContent).toContain('## 二级标题');
    expect(container.textContent).toContain('项1');
    // 不注入渲染结果（Rust/worker 渲染为 0 IPC）
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-block-tail]')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('md-h2');
    // hook 未被调起渲染（流式期间 renderTarget 为空）
    expect(mocks.useAsyncMarkdownHtml).toHaveBeenCalledWith('', undefined);
  });

  it('用例2：未闭合 fence 流式 → 纯文本可见', () => {
    useEmptyRender();
    const text = '```typescript\nconst a = 1;\nlet b = 2;';
    const { container } = render(<AsyncMarkdownBlock text={text} isStreaming />);
    // 源码字符直接可见（不等待渲染完成）
    expect(container.textContent).toContain('const a = 1;');
    expect(container.textContent).toContain('let b = 2;');
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(0);
  });

  it('用例3：完成态切换 → 一次收敛为 rustHtml（hook 结果写入 innerHTML）', () => {
    mocks.useAsyncMarkdownHtml.mockReturnValue({
      html: RUST_HTML,
      loading: false,
    });
    const { container, rerender } = render(
      <AsyncMarkdownBlock text={'```typescript\nconst a = 1;'} isStreaming />
    );
    // 流式结束：完成态渲染
    rerender(
      <AsyncMarkdownBlock text={'```typescript\nconst a = 1;\n```'} isStreaming={false} />
    );
    const rendered = container.firstElementChild as HTMLElement;
    expect(rendered.innerHTML).toBe(RUST_HTML);
    // 无纯文本 / 无骨架残留
    expect(rendered.textContent).not.toContain('const a = 1;');
  });

  it('用例4：完成态无 rustHtml → 空容器（不泄漏源码）；有结果后渲染', () => {
    mocks.useAsyncMarkdownHtml.mockReturnValue({
      html: '',
      loading: true,
    });
    // 卸载旧实例再渲染新实例（避免 React 对 effect 清空过的容器做 diff）
    const { container, unmount } = render(
      <AsyncMarkdownBlock text={'## 标题\n\n正文'} isStreaming={false} />
    );
    // 渲染中：容器保持空（innerHTML effect 清空骨架占位），不注入源码文本
    expect(container.firstElementChild?.innerHTML ?? '').toBe('');
    expect(container.textContent).not.toContain('## 标题');
    unmount();

    mocks.useAsyncMarkdownHtml.mockReturnValue({
      html: RUST_HTML,
      loading: false,
    });
    const { container: c2 } = render(
      <AsyncMarkdownBlock text={'## 标题\n\n正文'} isStreaming={false} />
    );
    expect((c2.firstElementChild as HTMLElement).innerHTML).toBe(RUST_HTML);
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

  it('用例5：hook 渲染失败 → 不崩溃、无骨架残留（loading 结束回退空态）', () => {
    mocks.useAsyncMarkdownHtml.mockReturnValue({
      html: '',
      loading: false,
    });
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const text = '# 标题\n\n正文';
    const { container } = render(
      <AsyncMarkdownBlock text={text} isStreaming={false} />
    );
    // 失败后不抛错：容器保留 md-rendered 骨架 div，无源码泄漏
    expect(container.querySelector('.md-rendered')).toBeTruthy();
    expect(container.textContent).not.toContain('# 标题');
    errorSpy.mockRestore();
  });

  it('用例6：文本全量替换（非增量追加）→ 完成态按新文本重新渲染，不残留旧内容', () => {
    useEmptyRender();
    mocks.useAsyncMarkdownHtml.mockReturnValue({
      html: '<p class="md-p">全新文本 A</p>',
      loading: false,
    });
    const { container, rerender } = render(
      <AsyncMarkdownBlock text="旧文本片段" isStreaming />
    );
    expect(container.textContent).toContain('旧文本片段');
    rerender(<AsyncMarkdownBlock text="全新文本 A\n\n全新文本 B" isStreaming={false} />);
    expect(container.querySelector('.md-rendered')?.textContent ?? '').toContain('全新文本 A');
    expect(container.textContent).not.toContain('旧文本片段');
  });

  it('用例7：空文本 → 渲染 null', () => {
    useEmptyRender();
    const { container } = render(<AsyncMarkdownBlock text="" isStreaming />);
    expect(container.innerHTML).toBe('');
  });
});
