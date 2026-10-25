/**
 * Layout Tree Store — 终端/浏览器标签构建与 PTY 进程确定性销毁。
 */

import type { LayoutTree } from './types';
import { isLeaf } from './types';
import { collectLeaves, findNodeById } from './operations';
import {
  createTerminalTab,
  createBrowserTab,
  type TerminalTab,
  type BrowserTab,
  type RightToolDockState,
} from './sessionTabModel';
import { getWorkspacePath, getActiveProject } from '../../api/projectStore';

export function createTerminalTabForStore(opts?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  terminalKey?: string;
  cwd?: string;
  dock?: Partial<RightToolDockState>;
}): TerminalTab {
  const cwd = (opts?.cwd || getWorkspacePath() || '').trim();
  const activeProj = getActiveProject();
  const projName =
    activeProj?.name || (cwd ? cwd.split(/[/\\]/).filter(Boolean).pop() : '');
  const dynamicTitle = projName ? `Terminal: ${projName}` : 'Terminal';
  const title = opts?.title?.trim() || dynamicTitle;

  return createTerminalTab({
    tabId: opts?.tabId,
    title,
    workspaceKey: opts?.workspaceKey,
    terminalKey: opts?.terminalKey,
    cwd,
    dock: opts?.dock,
  });
}

export function createBrowserTabForStore(opts?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  url?: string;
  favicon?: string;
  dock?: Partial<RightToolDockState>;
}): BrowserTab {
  const title = opts?.title?.trim() || 'Browser';
  const url = opts?.url?.trim() || 'about:blank';

  return createBrowserTab({
    tabId: opts?.tabId,
    title,
    workspaceKey: opts?.workspaceKey,
    url,
    favicon: opts?.favicon,
    dock: opts?.dock,
  });
}

/**
 * 确定性杀终端 PTY：包含自身 primaryKey 及分屏关联的 splitKeys（如 key:split-2）。
 */
export function killTerminalPtyBackground(terminalKey?: string | null): void {
  const key = (terminalKey || '').trim();
  if (!key) return;
  void import('../../api/ptyRegistry')
    .then((m) => {
      m.killPtyForSessionBackground(key);
      const sessionIds = m.ptyRegistry.sessionIds();
      for (const sid of sessionIds) {
        if (sid.startsWith(`${key}:`)) {
          m.killPtyForSessionBackground(sid);
        }
      }
    })
    .catch(() => {
      /* swallow-ok: 终端后台销毁异常不阻断UI */
    });
}

export function killTerminalIfTabIsTerminal(tab?: unknown): void {
  if (!tab || typeof tab !== 'object') return;
  const t = tab as { kind?: string; terminalKey?: string; sessionId?: string };
  if (t.kind === 'terminal' || t.terminalKey) {
    killTerminalPtyBackground(t.terminalKey || t.sessionId);
  }
}

export function killAllTerminalPtysInTree(tree: LayoutTree): void {
  const leaves = collectLeaves(tree.root);
  for (const leaf of leaves) {
    for (const t of leaf.tabs) {
      killTerminalIfTabIsTerminal(t);
    }
  }
}

export function killTerminalInLeafActiveTab(
  tree: LayoutTree,
  leafId: string
): void {
  const target = findNodeById(tree.root, leafId);
  if (target && isLeaf(target) && target.tabs.length > 0) {
    const tabIdx = target.tabs.findIndex((t) => t.tabId === target.activeTabId);
    const currentTab = tabIdx >= 0 ? target.tabs[tabIdx] : target.tabs[0];
    if (currentTab) killTerminalIfTabIsTerminal(currentTab);
  }
}

export function killTerminalInLeafTab(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): void {
  const target = findNodeById(tree.root, leafId);
  if (target && isLeaf(target)) {
    const removing = target.tabs.find((t) => t.tabId === tabId);
    if (removing) killTerminalIfTabIsTerminal(removing);
  }
}
