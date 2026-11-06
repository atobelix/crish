// @vitest-environment jsdom
/**
 * ThinkingBlock.openPath.test.tsx — S1a：思考块内路径链接接线回归
 *
 * 旧实现 handleContentClick 只把 { t } 交给 handleMarkdownEvent，
 * onOpenPath 从未注入——思考内的 .md-path-link 与相对链接点击后
 * 被 preventDefault 吞掉、无任何反应（死链）。本套件钉死：
 * onOpenPath 注入后两类链接都按解析后的路径（与行号）投递，
 * 且宿主适配层（narrativeRenderers）把 navigation.onOpenPath 透传进来。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThinkingBlock } from './ThinkingBlock';
import { renderNarrativeThought } from './narrativeRenderers';

vi.mock('../../api/markdown/useMarkdownRender', () => ({
  useMarkdownResult: () => ({
    html:
      '<p>参考 <button type="button" class="md-path-link" ' +
      'data-path="src/app.ts:12">src/app.ts:12</button> 与 ' +
      '<a href="docs/guide.md">指南</a></p>',
  }),
}));

describe('ThinkingBlock 路径链接（S1a）', () => {
  it('.md-path-link 点击经 onOpenPath 投递解析后的路径与行号', () => {
    const onOpenPath = vi.fn();
    render(
      <ThinkingBlock content="思考正文" defaultOpen onOpenPath={onOpenPath} />
    );
    fireEvent.click(screen.getByText('src/app.ts:12'));
    expect(onOpenPath).toHaveBeenCalledTimes(1);
    expect(onOpenPath).toHaveBeenCalledWith('src/app.ts', { line: 12 });
  });

  it('相对链接点击同样经 onOpenPath 投递', () => {
    const onOpenPath = vi.fn();
    render(
      <ThinkingBlock content="思考正文" defaultOpen onOpenPath={onOpenPath} />
    );
    fireEvent.click(screen.getByText('指南'));
    expect(onOpenPath).toHaveBeenCalledTimes(1);
    expect(onOpenPath).toHaveBeenCalledWith('docs/guide.md', {});
  });

  it('未注入 onOpenPath 时点击不抛错（缺省空操作）', () => {
    render(<ThinkingBlock content="思考正文" defaultOpen />);
    expect(() => fireEvent.click(screen.getByText('src/app.ts:12'))).not.toThrow();
  });

  it('narrativeRenderers 把宿主 onOpenPath 透传给 ThinkingBlock（只透传 path）', () => {
    const onOpenPath = vi.fn();
    render(
      <>
        {renderNarrativeThought(
          { content: '思考正文', messageId: 'm1' },
          onOpenPath
        )}
      </>
    );
    fireEvent.click(screen.getByText('src/app.ts:12'));
    expect(onOpenPath).toHaveBeenCalledTimes(1);
    expect(onOpenPath).toHaveBeenCalledWith('src/app.ts');
  });
});
