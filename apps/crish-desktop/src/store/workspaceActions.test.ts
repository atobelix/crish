/**
 * workspaceActions 单测：immer harness，不碰 layoutStore 全局。
 * 覆盖：安全开/关/聚焦面板、empty workspace guards、无 ghost chat 列。
 */
import { produce } from 'immer';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceActions,
  type WorkspaceStoreSlice,
} from './workspaceActions';
import { createDefaultWorkspace, isChatColumn, isChatOnlyWorkspace } from './layoutHelpers';
import type { WorkspaceState } from './types';

vi.mock('../api/appMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/appMode')>();
  return {
    ...actual,
    isDemoMode: () => false,
  };
});

function bareWs(id = 'ws-a'): WorkspaceState {
  return createDefaultWorkspace(id);
}

function makeSlice(ws: WorkspaceState | WorkspaceState[], tabMode = false): WorkspaceStoreSlice {
  const workspaces = Array.isArray(ws) ? ws : [ws];
  return {
    workspaces,
    activeWorkspaceIndex: 0,
    tabModeEnabled: tabMode,
    draggedTab: null,
    dropPreview: null,
  };
}

function makeHarness(initial: WorkspaceStoreSlice) {
  let state = initial;
  const set = (recipe: (draft: WorkspaceStoreSlice) => void) => {
    state = produce(state, recipe);
  };
  const get = () => state;
  const actions = createWorkspaceActions(set, get);
  return {
    actions,
    getState: () => state,
    ws: (id?: string) => {
      if (id) return state.workspaces.find((w) => w.id === id)!;
      return state.workspaces[state.activeWorkspaceIndex]!;
    },
  };
}

function chatCols(ws: WorkspaceState) {
  return ws.columns.filter((c) => isChatColumn(c));
}

function toolCards(ws: WorkspaceState): string[] {
  return ws.columns
    .filter((c) => !isChatColumn(c))
    .flatMap((c) => c.groups.flatMap((g) => g.cards.map((x) => x.id)));
}

describe('togglePanel — open / focus / close safely', () => {
  it('opens tool beside chat, focuses when already present', () => {
    // tabMode so both tools share a group → can switch active then re-focus
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;

    h.actions.togglePanel(id, 'terminal', true);
    let ws = h.ws();
    expect(ws.columns.length).toBe(2);
    expect(toolCards(ws)).toContain('terminal');
    expect(chatCols(ws)).toHaveLength(1);
    expect(ws!.columns[0]!.groups[0]!.cards.map((c) => c.id)).toEqual(['chat']);

    h.actions.togglePanel(id, 'diff', true);
    ws = h.ws();
    expect(ws!.columns.find((c) => !isChatColumn(c))!.groups[0]!.activeCardId).toBe('diff');

    // second open of terminal → focus only, no duplicate card
    h.actions.togglePanel(id, 'terminal', true);
    ws = h.ws();
    const g = ws.columns.find((c) => !isChatColumn(c))!.groups[0];
    expect(g!.activeCardId).toBe('terminal');
    expect(g!.cards.filter((c) => c.id === 'terminal')).toHaveLength(1);
    expect(g!.cards.map((c) => c.id)).toEqual(['terminal', 'diff']);
    expect(chatCols(ws)).toHaveLength(1);
  });

  it('browser maps to preview; runtime/settings/chat-off are no-ops for columns', () => {
    const h = makeHarness(makeSlice(bareWs()));
    const id = h.ws().id;

    h.actions.togglePanel(id, 'browser', true);
    expect(toolCards(h.ws())).toEqual(['preview']);

    h.actions.togglePanel(id, 'runtime', true);
    h.actions.togglePanel(id, 'settings', true);
    expect(toolCards(h.ws())).toEqual(['preview']);
    expect(chatCols(h.ws())).toHaveLength(1);

    // cannot hide chat
    h.actions.togglePanel(id, 'chat', false);
    expect(h!.ws().columns[0]!.groups[0]!.cards.some((c) => c.id === 'chat')).toBe(true);

    // close preview → chat-only, no empty tool shell
    h.actions.togglePanel(id, 'preview', false);
    expect(isChatOnlyWorkspace(h.ws())).toBe(true);
    expect(h.ws().columns.every((c) => isChatColumn(c) || c.groups.length > 0)).toBe(true);
  });

  it('plan key opens tasks; missing wsId is a no-op', () => {
    const h = makeHarness(makeSlice(bareWs()));
    h.actions.togglePanel('missing-ws', 'terminal', true);
    expect(isChatOnlyWorkspace(h.ws())).toBe(true);

    h.actions.togglePanel(h.ws().id, 'plan', true);
    expect(toolCards(h.ws())).toContain('tasks');
  });

  it('tabMode merges tools into first tool group', () => {
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;
    h.actions.togglePanel(id, 'diff', true);
    h.actions.togglePanel(id, 'files', true);
    const tool = h.ws().columns.find((c) => !isChatColumn(c))!;
    expect(tool.groups).toHaveLength(1);
    expect(tool!.groups[0]!.cards.map((c) => c.id)).toEqual(['diff', 'files']);
    expect(tool!.groups[0]!.activeCardId).toBe('files');
  });

  it('applyTabModeEnabled 关则拆组、开则合并', () => {
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;
    h.actions.togglePanel(id, 'diff', true);
    h.actions.togglePanel(id, 'files', true);
    expect(h.ws().columns.find((c) => !isChatColumn(c))!.groups).toHaveLength(1);

    h.actions.applyTabModeEnabled(false);
    expect(h.getState().tabModeEnabled).toBe(false);
    const split = h.ws().columns.find((c) => !isChatColumn(c))!;
    expect(split.groups).toHaveLength(2);
    expect(split.groups.every((g) => g.cards.length === 1)).toBe(true);

    h.actions.applyTabModeEnabled(true);
    expect(h.getState().tabModeEnabled).toBe(true);
    const merged = h.ws().columns.find((c) => !isChatColumn(c))!;
    expect(merged.groups).toHaveLength(1);
    expect(merged.groups[0]!.cards.map((c) => c.id)).toEqual(
      expect.arrayContaining(['diff', 'files'])
    );
  });
});

describe('closeTabInGroup — no chat strip, prune empty', () => {
  it('closes tool tab with left-neighbor active and prunes empty col', () => {
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;
    h.actions.togglePanel(id, 'files', true);
    h.actions.togglePanel(id, 'agent', true);
    h.actions.togglePanel(id, 'terminal', true);

    const tool = h.ws().columns.find((c) => !isChatColumn(c))!;
    const groupId = tool!.groups[0]!.id;
    h.actions.closeTabInGroup(id, groupId, 'agent');

    const after = h.ws().columns.find((c) => !isChatColumn(c))!.groups[0];
    expect(after!.cards.map((c) => c.id)).not.toContain('agent');
    expect(after!.activeCardId).not.toBe('chat');
    expect(chatCols(h.ws())).toHaveLength(1);

    // close remaining tools → chat only
    for (const cid of [...after!.cards.map((c) => c.id)]) {
      h.actions.closeTabInGroup(id, after!.id, cid);
    }
    expect(isChatOnlyWorkspace(h.ws())).toBe(true);
    expect(chatCols(h.ws())).toHaveLength(1);
  });

  it('refuses to close chat card', () => {
    const h = makeHarness(makeSlice(bareWs()));
    const chatGroup = h!.ws().columns[0]!.groups[0];
    h.actions.closeTabInGroup(h.ws().id, chatGroup!.id, 'chat');
    expect(h!.ws().columns[0]!.groups[0]!.cards.map((c) => c.id)).toEqual(['chat']);
  });
});

describe('empty workspace guards', () => {
  it('closeWorkspace keeps at least one and reseeds empty slice', () => {
    const h = makeHarness(makeSlice(bareWs('ws-only')));
    h.actions.closeWorkspace('ws-only');
    expect(h.getState().workspaces).toHaveLength(1);
    expect(h.getState().activeWorkspaceIndex).toBe(0);
    expect(chatCols(h.ws())).toHaveLength(1);

    // force empty then close → reseed
    const empty = makeHarness({
      workspaces: [],
      activeWorkspaceIndex: 0,
      tabModeEnabled: false,
      draggedTab: null,
      dropPreview: null,
    });
    empty.actions.closeWorkspace('nope');
    expect(empty.getState().workspaces).toHaveLength(1);
    expect(empty.ws().columns.some((c) => isChatColumn(c))).toBe(true);
  });

  it('closeWorkspace clamps active index when closing right/left of active', () => {
    const h = makeHarness(
      makeSlice([bareWs('ws-0'), bareWs('ws-1'), bareWs('ws-2')]),
    );
    // active = 0; close last
    h.actions.closeWorkspace('ws-2');
    expect(h.getState().workspaces.map((w) => w.id)).toEqual(['ws-0', 'ws-1']);
    expect(h.getState().activeWorkspaceIndex).toBe(0);

    // active → 1 then close active
    h.getState(); // silence lint
    // set active via produce path: split then close
    h.actions.splitScreenWorkspace('sess');
    const ids = h.getState().workspaces.map((w) => w.id);
    expect(ids.length).toBe(3);
    expect(h.getState().activeWorkspaceIndex).toBe(2);
    const activeId = h!.getState().workspaces[2]!.id;
    h.actions.closeWorkspace(activeId);
    expect(h.getState().activeWorkspaceIndex).toBeLessThan(h.getState().workspaces.length);
    expect(h.getState().activeWorkspaceIndex).toBeGreaterThanOrEqual(0);
  });

  it('splitScreenWorkspace reseeds when workspaces empty', () => {
    const h = makeHarness({
      workspaces: [],
      activeWorkspaceIndex: 99,
      tabModeEnabled: false,
      draggedTab: null,
      dropPreview: null,
    });
    h.actions.splitScreenWorkspace('s');
    expect(h.getState().workspaces.length).toBe(2);
    expect(h.getState().activeWorkspaceIndex).toBe(1);
    for (const w of h.getState().workspaces) {
      expect(chatCols(w)).toHaveLength(1);
    }
  });

  it('resizeColumns/Groups no-op on empty/single column or bad container size', () => {
    const h = makeHarness(makeSlice(bareWs()));
    const id = h.ws().id;
    const before = h!.ws().columns[0]!.widthRatio;
    h.actions.resizeColumns(id, 0, 10, 0);
    h.actions.resizeColumns(id, 0, 10, 800);
    expect(h!.ws().columns[0]!.widthRatio).toBe(before);

    h.actions.togglePanel(id, 'diff', true);
    h.actions.resizeColumns(id, 0, 40, 1000);
    expect(h!.ws().columns[0]!.widthRatio).not.toBe(before);

    h.actions.resizeGroups(id, 1, 0, 10, 0);
    // single group col — no-op
    const h2 = h!.ws().columns[1]!.groups[0]!.heightRatio;
    h.actions.resizeGroups(id, 1, 0, 10, 500);
    expect(h!.ws().columns[1]!.groups[0]!.heightRatio).toBe(h2);
  });
});

describe('merge / detach / move — no ghost chat columns', () => {
  it('mergeTab same-group reorder and cross-group without duplicating chat', () => {
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;
    h.actions.togglePanel(id, 'files', true);
    h.actions.togglePanel(id, 'agent', true);
    const groupId = h!.ws().columns.find((c) => !isChatColumn(c))!.groups[0]!.id;

    h.actions.mergeTab(id, 'agent', groupId, groupId, 0);
    expect(
      h!.ws().columns.find((c) => !isChatColumn(c))!.groups[0]!.cards.map((c) => c.id),
    ).toEqual(['agent', 'files']);

    // refuse moving chat across groups
    const chatG = h!.ws().columns[0]!.groups[0]!.id;
    h.actions.mergeTab(id, 'chat', chatG, groupId);
    expect(toolCards(h.ws())).not.toContain('chat');
    expect(chatCols(h.ws())).toHaveLength(1);
  });

  it('detachTabToStandalone never places tools into chat column', () => {
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;
    h.actions.togglePanel(id, 'diff', true);
    h.actions.togglePanel(id, 'terminal', true);
    const tool = h.ws().columns.find((c) => !isChatColumn(c))!;
    const gid = tool!.groups[0]!.id;

    h.actions.detachTabToStandalone(id, 'terminal', gid, 0, 'new-col');
    const ws = h.ws();
    expect(chatCols(ws)).toHaveLength(1);
    // no tool card inside chat col
    const chatCardIds = ws.columns
      .filter((c) => isChatColumn(c))
      .flatMap((c) => c.groups.flatMap((g) => g.cards.map((x) => x.id)));
    expect(chatCardIds.every((cid) => cid === 'chat')).toBe(true);
    expect(toolCards(ws)).toContain('terminal');
    expect(toolCards(ws)).toContain('diff');
  });

  it('moveTabOrGroupRealtime refuses chat and uses tool column', () => {
    const h = makeHarness(makeSlice(bareWs(), true));
    const id = h.ws().id;
    h.actions.togglePanel(id, 'files', true);
    h.actions.togglePanel(id, 'agent', true);
    const gid = h!.ws().columns.find((c) => !isChatColumn(c))!.groups[0]!.id;

    h.actions.moveTabOrGroupRealtime(id, 'agent', gid, 0, 0);
    const ws = h.ws();
    expect(chatCols(ws)).toHaveLength(1);
    const chatIds = ws!.columns[0]!.groups.flatMap((g) => g.cards.map((c) => c.id));
    expect(chatIds).toEqual(['chat']);
    expect(toolCards(ws)).toContain('agent');
    expect(toolCards(ws)).toContain('files');
  });
});

describe('applyLayoutPreset / applyWorkspaceLayout', () => {
  it('presets keep single chat col; telemetry has no runtime ghost', () => {
    const h = makeHarness(makeSlice(bareWs()));
    h.actions.applyLayoutPreset('developer-split');
    expect(chatCols(h.ws())).toHaveLength(1);
    expect(toolCards(h.ws())).toEqual(expect.arrayContaining(['preview', 'diff']));

    h.actions.applyLayoutPreset('full-chat');
    expect(isChatOnlyWorkspace(h.ws())).toBe(true);
    expect(chatCols(h.ws())).toHaveLength(1);

    h.actions.applyLayoutPreset('telemetry-focus');
    expect(chatCols(h.ws())).toHaveLength(1);
    expect(toolCards(h.ws())).toContain('terminal');
    expect(toolCards(h.ws())).not.toContain('runtime');
    // width sums ~1
    const sum = h.ws().columns.reduce((a, c) => a + c.widthRatio, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('applyWorkspaceLayout merges multi chat cols and strips floats', () => {
    const h = makeHarness(makeSlice(bareWs()));
    h.actions.applyWorkspaceLayout({
      savedAt: Date.now(),
      columns: [
        {
          widthRatio: 0.4,
          groups: [{ cards: ['chat', 'runtime'], activeCardId: 'chat', heightRatio: 1 }],
        },
        {
          widthRatio: 0.3,
          groups: [{ cards: ['chat', 'settings'], activeCardId: 'settings', heightRatio: 1 }],
        },
        {
          widthRatio: 0.3,
          groups: [{ cards: ['browser', 'plan'], activeCardId: 'browser', heightRatio: 1 }],
        },
      ],
    });

    const ws = h.ws();
    expect(chatCols(ws)).toHaveLength(1);
    // runtime/settings stripped; browser→preview; plan→tasks
    const all = ws.columns.flatMap((c) =>
      c.groups.flatMap((g) => g.cards.map((x) => x.id)),
    );
    expect(all).toContain('chat');
    expect(all).toContain('preview');
    expect(all).toContain('tasks');
    expect(all).not.toContain('runtime');
    expect(all).not.toContain('settings');
    expect(all).not.toContain('browser');
    expect(all.filter((id) => id === 'chat')).toHaveLength(1);
  });

  it('applyWorkspaceLayout empty snapshot is no-op; no columns snapshot ignored', () => {
    const h = makeHarness(makeSlice(bareWs()));
    h.actions.togglePanel(h.ws().id, 'diff', true);
    const before = toolCards(h.ws());
    h.actions.applyWorkspaceLayout({ columns: [], savedAt: Date.now() });
    expect(toolCards(h.ws())).toEqual(before);
  });
});
