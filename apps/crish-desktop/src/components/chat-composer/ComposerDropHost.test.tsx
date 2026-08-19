/**
 * 拖放遮罩：叶内 contain，拖入显示、拖出消失、drop 交附件。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerDropHost } from './ComposerDropHost';

function fileDrag(extra: Record<string, unknown> = {}) {
  return {
    dataTransfer: {
      types: ['Files'],
      files: [],
      dropEffect: 'none',
      ...extra,
    },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

describe('ComposerDropHost（S4 拖放遮罩）', () => {
  it('拖入 Files 显示遮罩，拖出消失', () => {
    render(
      <ComposerDropHost onDropFiles={() => undefined}>
        <span>body</span>
      </ComposerDropHost>
    );
    expect(screen.queryByTestId('composer-drop-mask')).toBeNull();
    const host = screen.getByText('body').parentElement as HTMLElement;
    fireEvent.dragEnter(host, fileDrag());
    expect(screen.getByTestId('composer-drop-mask').textContent).toContain(
      '放到这里添加附件'
    );
    expect(host.getAttribute('data-drop-over')).toBe('1');
    fireEvent.dragLeave(host, fileDrag());
    expect(screen.queryByTestId('composer-drop-mask')).toBeNull();
  });

  it('drop 把文件交给 onDropFiles 并收起遮罩', () => {
    const onDropFiles = vi.fn();
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    render(
      <ComposerDropHost onDropFiles={onDropFiles}>
        <span>body</span>
      </ComposerDropHost>
    );
    const host = screen.getByText('body').parentElement as HTMLElement;
    fireEvent.dragEnter(host, fileDrag());
    fireEvent.drop(
      host,
      fileDrag({
        files: [file],
      })
    );
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(onDropFiles.mock.calls[0][0][0]).toBe(file);
    expect(screen.queryByTestId('composer-drop-mask')).toBeNull();
  });

  it('非文件拖入不显示遮罩', () => {
    render(
      <ComposerDropHost onDropFiles={() => undefined}>
        <span>body</span>
      </ComposerDropHost>
    );
    const host = screen.getByText('body').parentElement as HTMLElement;
    fireEvent.dragEnter(host, {
      dataTransfer: { types: ['text/plain'], files: [] },
    });
    expect(screen.queryByTestId('composer-drop-mask')).toBeNull();
  });
});
