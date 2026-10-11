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
});
