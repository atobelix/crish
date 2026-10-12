// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as unitSplitter from '../../api/markdown/unitSplitter';
import { ReconciledMarkdownHtml } from './ReconciledMarkdownHtml';

describe('ReconciledMarkdownHtml', () => {
  it('keeps rendered prefix nodes and patches only the growing tail', () => {
    const view = render(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html="<ul><li>first</li></ul><p>tail</p>"
      />
    );
    const root = view.getByTestId('markdown');
    const list = root.querySelector('ul');
    const firstItem = root.querySelector('li');
    const paragraph = root.querySelector('p');

    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html="<ul><li>first</li><li>second</li></ul><p>tail keeps growing</p>"
      />
    );

    expect(root.querySelector('ul')).toBe(list);
    expect(root.querySelectorAll('li')[0]).toBe(firstItem);
    expect(root.querySelectorAll('li')).toHaveLength(2);
    expect(root.querySelector('p')).toBe(paragraph);
    expect(paragraph?.textContent).toBe('tail keeps growing');
    expect(root.textContent).not.toMatch(/^\s*(?:\||- |\* |\d+\. |> |```)/m);
  });

  it('removes stale rendered suffix when the stream retracts', () => {
    const view = render(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html="<p>stable</p><p>retracted</p>"
      />
    );
    const root = view.getByTestId('markdown');
    const stable = root.querySelector('p');

    view.rerender(
      <ReconciledMarkdownHtml data-testid="markdown" html="<p>stable</p>" />
    );

    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelector('p')).toBe(stable);
  });

  it('只解析变化的活动单元并保留稳定单元 DOM 身份', () => {
    const splitSpy = vi.spyOn(unitSplitter, 'splitHtmlIntoUnits');
    const view = render(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html="<p>stable</p><p>tail</p>"
        incrementalUnits={[
          { id: 1, kind: 'paragraph', html: '<p>stable</p>' },
          { id: 2, kind: 'paragraph', html: '<p>tail</p>' },
        ]}
      />
    );
    const root = view.getByTestId('markdown');
    const stable = root.querySelector('p');
    expect(splitSpy).toHaveBeenCalledTimes(2);

    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html="<p>stable</p><p>tail grows</p>"
        incrementalUnits={[
          { id: 1, kind: 'paragraph', html: '<p>stable</p>' },
          { id: 2, kind: 'paragraph', html: '<p>tail grows</p>' },
        ]}
      />
    );

    expect(splitSpy).toHaveBeenCalledTimes(3);
    expect(root.querySelectorAll('p')[0]).toBe(stable);
    expect(root.querySelectorAll('p')[1]?.textContent).toBe('tail grows');
    splitSpy.mockRestore();
  });

  it('零坍塌硬防御盾（Zero-Collapse Guard）：从 incrementalUnits 切换到 undefined 且 html="" 时保持 DOM 节点不清空（N_void === 0），并在权威 html 到达时原地平滑更新', () => {
    const view = render(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html=""
        incrementalUnits={[
          {
            id: 1,
            kind: 'paragraph',
            html: '<p class="md-p">Streaming paragraph</p>',
          },
        ]}
      />
    );
    const root = view.getByTestId('markdown');
    const paragraphBefore = root.querySelector('p');
    expect(paragraphBefore).not.toBeNull();
    expect(root.childNodes.length).toBeGreaterThan(0);

    // 模拟封口过渡瞬间的异步真空帧：incrementalUnits=undefined 且 html=""
    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html=""
        incrementalUnits={undefined}
      />
    );

    // 零坍塌断言 N_void === 0：容器内 DOM 节点数量保持 > 0，原段落节点引用恒定
    expect(root.childNodes.length).toBeGreaterThan(0);
    expect(root.querySelector('p')).toBe(paragraphBefore);
    expect(root.textContent).toBe('Streaming paragraph');

    // 随后权威 html 到达，原地平滑更新为最终 DOM，复用同一 <p> 节点
    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html='<p class="md-p">Final</p>'
        incrementalUnits={undefined}
      />
    );

    expect(root.childNodes.length).toBeGreaterThan(0);
    expect(root.querySelector('p')).toBe(paragraphBefore);
    expect(root.querySelector('p')?.textContent).toBe('Final');
  });

  it('从流式多单元快照切换到含块间换行与代码头部的权威 HTML 时原地复用块级与代码容器 DOM', () => {
    const view = render(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html=""
        incrementalUnits={[
          { id: 1, kind: 'paragraph', html: '<p class="md-p">第一段</p>' },
          {
            id: 2,
            kind: 'code',
            html: '<div class="md-code-block" data-lang="ts"><pre class="md-code-pre hljs"><code class="language-ts">const a = 1;</code></pre></div>',
          },
          { id: 3, kind: 'paragraph', html: '<p class="md-p">第二段</p>' },
        ]}
      />
    );
    const root = view.getByTestId('markdown');
    const [firstP, secondP] = Array.from(root.querySelectorAll('p'));
    const codeBlock = root.querySelector('.md-code-block');
    const pre = root.querySelector('pre');
    const code = root.querySelector('code');

    // 经历封口真空期（Zero-Collapse Guard 拦截）
    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html=""
        incrementalUnits={undefined}
      />
    );
    expect(root.childNodes.length).toBe(3);

    // 权威 HTML 抵达（含块间 \n 文本节点及新增 .md-code-header）
    const authoritativeHtml =
      '<p class="md-p">第一段（完）</p>\n' +
      '<div class="md-code-block" data-lang="typescript">' +
      '<div class="md-code-header"><span class="md-code-lang">typescript</span></div>' +
      '<pre class="md-code-pre hljs"><code class="language-typescript"><span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;</code></pre>' +
      '</div>\n' +
      '<p class="md-p">第二段（完）</p>';

    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html={authoritativeHtml}
        incrementalUnits={undefined}
      />
    );

    const paragraphsAfter = Array.from(root.querySelectorAll('p'));
    expect(paragraphsAfter[0]).toBe(firstP);
    expect(paragraphsAfter[1]).toBe(secondP);
    expect(paragraphsAfter[0]?.textContent).toBe('第一段（完）');
    expect(paragraphsAfter[1]?.textContent).toBe('第二段（完）');
    expect(root.querySelector('.md-code-block')).toBe(codeBlock);
    expect(root.querySelector('pre')).toBe(pre);
    expect(root.querySelector('code')).toBe(code);
    expect(root.querySelector('.md-code-header')).not.toBeNull();
  });

  it('当显式传入 allowEmptyClear={true} 且 html="" 时允许清空容器', () => {
    const view = render(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html="<p>Initial content</p>"
      />
    );
    const root = view.getByTestId('markdown');
    expect(root.childNodes.length).toBe(1);

    // 默认 allowEmptyClear=false 时拒绝清空
    view.rerender(<ReconciledMarkdownHtml data-testid="markdown" html="" />);
    expect(root.childNodes.length).toBe(1);

    // 显式 allowEmptyClear=true 时执行清空
    view.rerender(
      <ReconciledMarkdownHtml
        data-testid="markdown"
        html=""
        allowEmptyClear={true}
      />
    );
    expect(root.childNodes.length).toBe(0);
  });
});
