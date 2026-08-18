// @vitest-environment jsdom
/**
 * 笔记叶工厂：docId 走 H1，不把 sessionId 当 persist id。
 * jsdom 绿 ≠ 打开完成 ≠ 关 EL。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as projectStore from '../../api/projectStore';
import * as hydrateProduct from '../../components/note-paper/hydrateProjection';
import * as strictDoc from '../../components/workspace/workspaceEmptyStateStrictDoc';
import { resetWorkspacePersistedStrictDocBindings } from '../../components/workspace/workspaceEmptyStateStrictDoc';
import type { ViewRenderContext } from '../../services/view-registry';
import { NoteLeafHost } from './NoteLeafHost';
import { resolveNotePaperDoc } from './productLeafBindings';

function ctx(
  partial: Partial<ViewRenderContext> = {}
): ViewRenderContext {
  return {
    panelId: 'note',
    leafId: 'leaf-note-1',
    sessionId: 'chat-session-99',
    isActive: true,
    openView: () => {},
    params: {},
    ...partial,
  };
}

describe('note-paper factory（02 F4 / F10）', () => {
  beforeEach(() => {
    resetWorkspacePersistedStrictDocBindings();
    vi.spyOn(projectStore, 'getActiveProjectId').mockReturnValue(null);
    vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWorkspacePersistedStrictDocBindings();
  });

  it('F4 不把 ctx.sessionId 当 docId；默认走 resolveProductStrictDocId', () => {
    const spy = vi.spyOn(strictDoc, 'resolveProductStrictDocId');
    const resolution = resolveNotePaperDoc(
      ctx({ sessionId: 'chat-session-99', params: {} })
    );
    expect(resolution.docId).not.toBe('chat-session-99');
    expect(resolution.docId).toBe('strict-default');
    expect(resolution.binding).toBe('synthetic-unbound');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        wsId: 'default',
        productStrictDocId: null,
        recentPersistedDocId: null,
      })
    );
    expect(spy.mock.calls[0]?.[0].wsId).not.toBe('chat-session-99');
  });

  it('F4 显式 params.docId 优先，仍不等于 sessionId（除非碰巧同字）', () => {
    const resolution = resolveNotePaperDoc(
      ctx({ sessionId: 'chat-session-99', params: { docId: 'persisted-abc' } })
    );
    expect(resolution.docId).toBe('persisted-abc');
    expect(resolution.binding).toBe('explicit-prop');
    expect(resolution.docId).not.toBe('chat-session-99');
  });

  it('F4 渲染注入 createProductStrictHydrateTransport，docId ≠ sessionId', async () => {
    const hydrateSpy = vi.spyOn(
      hydrateProduct,
      'createProductStrictHydrateTransport'
    );
    render(<NoteLeafHost {...ctx({ sessionId: 'chat-session-99' })} />);
    await waitFor(() => {
      expect(hydrateSpy).toHaveBeenCalled();
    });
    const docId = hydrateSpy.mock.calls[0]?.[0];
    expect(docId).toBeTruthy();
    expect(docId).not.toBe('chat-session-99');
    const panel = await screen.findByTestId('note-paper-strict-panel');
    expect(panel.getAttribute('data-doc-id')).not.toBe('chat-session-99');
  });

  it('F10 叶壳带 data-open-complete=not-claimed 及既有 el 钉', async () => {
    const { container } = render(
      <NoteLeafHost {...ctx({ sessionId: 'chat-session-99' })} />
    );
    await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-open-complete', 'not-claimed');
    expect(host).toHaveAttribute('data-el01', 'not-claimed');
    expect(host).toHaveAttribute('data-el03', 'not-claimed');
    expect(host).toHaveAttribute('data-el04', 'not-claimed');
    expect(host).toHaveAttribute('data-el08', 'not-claimed');
    expect(host).toHaveAttribute('data-w3p-full', 'not-claimed');
    expect(host).toHaveAttribute('data-inotify-full', 'not-claimed');
  });
});
