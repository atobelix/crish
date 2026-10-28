/**
 * Layout Tree Store — 独立常规终端构建与 PTY 进程确定性销毁。
 */

import type { LayoutTree } from './types';
import { isLeaf } from './types';
import { collectLeaves, findNodeById } from './operations';
import {
  type StandaloneTerminalTab,
  createTerminalTab,
} from './sessionTabModel';

export type { StandaloneTerminalTab };

export function createTerminalTabForStore(opts?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  terminalKey?: string;
  cwd?: string;
}): StandaloneTerminalTab {
  return createTerminalTab(opts);
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

export function closeBrowserInLeafTab(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): void {
  const target = findNodeById(tree.root, leafId);
  if (target && isLeaf(target)) {
    const removing = target.tabs.find((t) => t.tabId === tabId);
    if (removing && (removing as { kind?: string }).kind === 'browser') {
      void import('../../api/nativeBrowserApi').then((m) => {
        void m.browserWebviewClose(tabId);
      });
    }
  }
}
