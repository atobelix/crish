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
import {
  bindWorkspacePersistedStrictDoc,
  resetWorkspacePersistedStrictDocBindings,
} from '../../components/workspace/workspaceEmptyStateStrictDoc';
import type { ViewRenderContext } from '../../services/view-registry';
import { NoteLeafHost } from './NoteLeafHost';
import {
  resolveExplicitNoteDocId,
  resolveNotePaperDoc,
} from './productLeafBindings';

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

  it('显式 note:<docId> panelId 在无 params 时仍绑 persist id，≠ sessionId', () => {
    const input = ctx({
      sessionId: 'chat-session-99',
      panelId: 'note:persisted-from-uri',
      params: {},
    });
    expect(resolveExplicitNoteDocId(input)).toBe('persisted-from-uri');
    const resolution = resolveNotePaperDoc(input);
    expect(resolution.docId).toBe('persisted-from-uri');
    expect(resolution.binding).toBe('explicit-prop');
    expect(resolution.docId).not.toBe('chat-session-99');
    expect(resolution.docId).not.toBe(resolution.syntheticFallback);
  });

  it('params.docId 赢过 panelId 的 note: URI', () => {
    const resolution = resolveNotePaperDoc(
      ctx({
        sessionId: 'chat-session-99',
        panelId: 'note:from-uri',
        params: { docId: 'from-params' },
      })
    );
    expect(resolution.docId).toBe('from-params');
    expect(resolution.binding).toBe('explicit-prop');
    expect(resolution.docId).not.toBe('chat-session-99');
  });

  it('无显式、无 persist 查询源仍合成诚实空；recent 恒 null', () => {
    const spy = vi.spyOn(strictDoc, 'resolveProductStrictDocId');
    const resolution = resolveNotePaperDoc(
      ctx({ sessionId: 'chat-session-99', panelId: 'note', params: {} })
    );
    expect(resolution.docId).toBe('strict-default');
    expect(resolution.binding).toBe('synthetic-unbound');
    expect(resolution.docId).not.toBe('chat-session-99');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ recentPersistedDocId: null })
    );
  });

  it('无显式时仍走 resolver 打开前 bind；不是 persist 查询，也不是 sessionId', () => {
    bindWorkspacePersistedStrictDoc('default', 'doc-pre-open');
    const resolution = resolveNotePaperDoc(
      ctx({ sessionId: 'chat-session-99', panelId: 'note', params: {} })
    );
    expect(resolution.docId).toBe('doc-pre-open');
    expect(resolution.binding).toBe('pre-open-bind');
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

  it('叶宿主对 note:<docId> 写出 data-doc-id，≠ sessionId，≠ 合成空', async () => {
    const { container } = render(
      <NoteLeafHost
        {...ctx({
          sessionId: 'chat-session-99',
          panelId: 'note:persisted-leaf',
          params: {},
        })}
      />
    );
    const panel = await screen.findByTestId('note-paper-strict-panel');
    expect(panel.getAttribute('data-doc-id')).toBe('persisted-leaf');
    expect(panel.getAttribute('data-doc-id')).not.toBe('chat-session-99');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toHaveAttribute('data-strict-doc-id', 'persisted-leaf');
    expect(host).toHaveAttribute('data-strict-doc-binding', 'explicit-prop');
    expect(host?.getAttribute('data-strict-doc-id')).not.toBe(
      host?.getAttribute('data-synthetic-strict-doc-id')
    );
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
