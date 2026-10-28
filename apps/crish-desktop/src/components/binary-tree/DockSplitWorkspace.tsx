/**
 * apps/crish-desktop/src/components/binary-tree/DockSplitWorkspace.tsx
 * 右坞分屏工作区总调度容器（Dock Split System Architecture V2）
 *
 * 契约与职责：
 * 1. 纯净接管 .leafDockDrawer 内部的全部二叉树分屏与工具渲染；
 * 2. 消费权威单一真理源 dock.tree: DockTree；
 * 3. 内部维护 soloLeafId 状态（响应窗格单窗格临时全屏最大化请求）；
 * 4. 通过 flattenDockTree 展平绝对定位几何投影，按需渲染各 DockPane 与 DockResizeSash；
 * 5. 当整树为空或无窗格时，呈现优雅无窗格空态与快速磁贴启动器；
 * 6. 将所有窗格级与分割线操作收敛为 dockLayoutModel.ts 纯函数调用，统一经由 onUpdateDock 提交状态。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  activateDockLeaf,
  activateDockTab,
  closeDockLeaf,
  closeDockTab,
  createDefaultDock,
  createToolTab,
  findSpatialNode,
  isDockTreeEmpty,
  isSpatialLeaf,
  collectSpatialLeaves,
  openToolInDock,
  resizeDockBranch,
  splitDockLeaf,
  migrateLegacyDockStateToV2,
  updateLeafDock,
  type RightToolDockState,
  type DockLeaf,
  type DockTree,
  type ToolTab,
  type ToolViewId,
} from '../../store/storeAccess';
import { killDockTerminalPty } from './treeLeafPanelModel';
import { flattenDockTree, type FlatDockLeaf } from './flattenDockTree';
import { DockPane } from './DockPane';
import { DockResizeSash } from './DockResizeSash';
import { DockTabDragProvider } from './dockTabDragContext';
import { Button } from '@/components/ui/Button';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';
import styles from './BinaryTreeWorkspace.module.css';
import dockStyles from './DockSplitWorkspace.module.css';

export interface DockSplitWorkspaceProps {
  /** 外层会话叶节点 id */
  leafId: string;
  /** 所属会话 id */
  sessionId: string;
  /** 包含 tree: DockTree, widthRatio, collapsed 的右坞状态 */
  dock: RightToolDockState;
  /** 是否外层右坞抽屉整体最大化 */
  isMaximized: boolean;
  /** 切换外层右坞整体最大化回调 */
  onToggleMaximize: () => void;
  /** 更新右坞状态回调（缺省时自动回退至 updateLeafDock） */
  onUpdateDock?: (patch: Partial<RightToolDockState>) => void;
}

export const DockSplitWorkspace: React.FC<DockSplitWorkspaceProps> = React.memo(
  ({
    leafId: outerLeafId,
    sessionId,
    dock,
    isMaximized,
    onToggleMaximize,
    onUpdateDock,
  }) => {
    const { t } = useI18n();
    const workspaceRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);

    // 内部维护单窗格临时全屏聚焦状态（solo 模式）
    const [soloLeafId, setSoloLeafId] = useState<string | null>(null);

    // 状态归一化：若未提供合法 tree，安全回退或冷迁移
    const normalizedDock: RightToolDockState = useMemo(() => {
      if (!dock) {
        return createDefaultDock();
      }
      if (!dock.tree) {
        return migrateLegacyDockStateToV2(dock);
      }
      return dock;
    }, [dock]);

    const tree = normalizedDock.tree;

    // 提交右坞状态修改（优先调用传入回调，回退使用 updateLeafDock）
    const commitDock = useCallback(
      (patch: Partial<RightToolDockState>) => {
        if (onUpdateDock) {
          onUpdateDock(patch);
        } else {
          updateLeafDock(outerLeafId, patch);
        }
      },
      [onUpdateDock, outerLeafId]
    );

    // 校验 soloLeafId 有效性（若所指窗格已被移除，则自动失效）
    const effectiveSoloLeafId = useMemo(() => {
      if (!soloLeafId || !tree) return null;
      const target = findSpatialNode(tree.root, soloLeafId);
      if (!target || !isSpatialLeaf(target)) return null;
      return soloLeafId;
    }, [soloLeafId, tree]);

    // 二叉树几何投影展平
    const flattened = useMemo(() => {
      if (!tree || isDockTreeEmpty(tree)) {
        return { leaves: [] as readonly FlatDockLeaf[], branches: [] };
      }
      return flattenDockTree(tree, effectiveSoloLeafId);
    }, [tree, effectiveSoloLeafId]);

    // 计算整树物理叶片总数（非 solo 投影数），用于决定是否展示单个窗格的关闭按钮
    const totalLeavesCount = useMemo(() => {
      if (!tree) return 0;
      return collectSpatialLeaves(tree.root).length;
    }, [tree]);

    const isOnlyPane = totalLeavesCount <= 1;

    // ── 窗格交互操作原子调度 ──────────────────────────────────────────

    // 1. 标签选中与激活
    const handleSelectTab = useCallback(
      (targetLeafId: string, tabId: string) => {
        if (!tree) return;
        const nextTree = activateDockTab(tree, targetLeafId, tabId);
        commitDock({ tree: nextTree });
      },
      [tree, commitDock]
    );

    // 2. 标签关闭（支持 PTY 进程精准释放与空树自愈）
    const handleCloseTab = useCallback(
      (targetLeafId: string, tabId: string) => {
        if (!tree) return;
        const { tree: nextTree, closedTab } = closeDockTab(
          tree,
          targetLeafId,
          tabId
        );

        // 若关闭终端或原生浏览器标签，精准销毁对应底层物理资源
        if (closedTab) {
          if (
            closedTab.viewId === 'terminal' ||
            closedTab.viewId.startsWith('terminal:')
          ) {
            killDockTerminalPty(closedTab.tabId, sessionId);
          } else if (
            closedTab.viewId === 'preview' ||
            closedTab.viewId.startsWith('preview:')
          ) {
            void import('../../api/nativeBrowserApi').then((m) => {
              void m.browserWebviewClose(closedTab.tabId);
            });
          }
        }

        // 若当前 solo 窗格被关闭或已不存在，重置 solo
        if (soloLeafId === targetLeafId) {
          const node = findSpatialNode(nextTree.root, targetLeafId);
          if (
            !node ||
            !isSpatialLeaf(node) ||
            (node as DockLeaf).tabs.length === 0
          ) {
            setSoloLeafId(null);
          }
        }

        const patch: { collapsed?: boolean; tree?: DockTree } = {
          tree: nextTree,
          ...(isDockTreeEmpty(nextTree) ? { collapsed: true } : {}),
        };
        commitDock(patch);
      },
      [tree, soloLeafId, sessionId, commitDock]
    );

    // 3. 打开新工具标签
    const handleAddTab = useCallback(
      (targetLeafId: string, viewId: ToolViewId) => {
        if (!tree) return;
        const { tree: nextTree } = openToolInDock(tree, {
          targetLeafId: targetLeafId || undefined,
          viewId,
        });
        commitDock({ tree: nextTree, collapsed: false });
      },
      [tree, commitDock]
    );

    // 获取当前叶片的激活 Tab（用于切分时复制产生新实例）
    const getActiveTabForLeaf = useCallback(
      (targetLeafId: string): ToolTab => {
        if (tree) {
          const node = findSpatialNode(tree.root, targetLeafId);
          if (node && isSpatialLeaf(node)) {
            const leaf = node as DockLeaf;
            const currentActive =
              leaf.tabs.find((t) => t.tabId === leaf.activeTabId) ??
              leaf.tabs[0];
            if (currentActive) {
              return createToolTab(currentActive.viewId, {
                title: currentActive.title,
                params: currentActive.params
                  ? { ...currentActive.params }
                  : undefined,
              });
            }
          }
        }
        return createToolTab('terminal');
      },
      [tree]
    );

    // 4. 水平向右二叉切分
    const handleSplitRight = useCallback(
      (targetLeafId: string) => {
        if (!tree) return;
        const newTab = getActiveTabForLeaf(targetLeafId);
        const nextTree = splitDockLeaf(
          tree,
          targetLeafId,
          'horizontal',
          newTab
        );
        if (soloLeafId) {
          setSoloLeafId(null);
        }
        commitDock({ tree: nextTree });
      },
      [tree, getActiveTabForLeaf, soloLeafId, commitDock]
    );

    // 5. 垂直向下二叉切分
    const handleSplitDown = useCallback(
      (targetLeafId: string) => {
        if (!tree) return;
        const newTab = getActiveTabForLeaf(targetLeafId);
        const nextTree = splitDockLeaf(tree, targetLeafId, 'vertical', newTab);
        if (soloLeafId) {
          setSoloLeafId(null);
        }
        commitDock({ tree: nextTree });
      },
      [tree, getActiveTabForLeaf, soloLeafId, commitDock]
    );

    // 6. 切换单窗格 Solo 聚焦模式
    const handleToggleSolo = useCallback((targetLeafId: string) => {
      setSoloLeafId((prev) => (prev === targetLeafId ? null : targetLeafId));
    }, []);

    // 7. 关闭整分屏窗格（单窗格时直接收起右侧栏；多窗格时修剪该窗格）
    const handleClosePane = useCallback(
      (targetLeafId: string) => {
        if (!tree) return;
        const allLeaves = collectSpatialLeaves(tree.root);
        if (allLeaves.length <= 1) {
          commitDock({ collapsed: true });
          return;
        }

        const { tree: nextTree, closedTabs } = closeDockLeaf(
          tree,
          targetLeafId
        );
        // 销毁关闭窗格中的所有 PTY 进程与原生浏览器
        for (const tab of closedTabs) {
          if (tab.viewId === 'terminal' || tab.viewId.startsWith('terminal:')) {
            killDockTerminalPty(tab.tabId, sessionId);
          } else if (
            tab.viewId === 'preview' ||
            tab.viewId.startsWith('preview:')
          ) {
            void import('../../api/nativeBrowserApi').then((m) => {
              void m.browserWebviewClose(tab.tabId);
            });
          }
        }

        if (soloLeafId === targetLeafId) {
          setSoloLeafId(null);
        }

        const patch: { collapsed?: boolean; tree?: DockTree } = {
          tree: nextTree,
          ...(isDockTreeEmpty(nextTree) ? { collapsed: true } : {}),
        };
        commitDock(patch);
      },
      [tree, soloLeafId, sessionId, commitDock]
    );

    // 8. 窗格聚焦回调
    const handleFocusPane = useCallback(
      (targetLeafId: string) => {
        if (!tree) return;
        if (tree.activeDockLeafId !== targetLeafId) {
          const nextTree = activateDockLeaf(tree, targetLeafId);
          commitDock({ tree: nextTree });
        }
      },
      [tree, commitDock]
    );

    // 9. 分割线比例提交
    const handleCommitRatio = useCallback(
      (branchId: string, newRatio: number) => {
        if (!tree) return;
        const nextTree = resizeDockBranch(tree, branchId, newRatio);
        commitDock({ tree: nextTree });
      },
      [tree, commitDock]
    );

    // 10. 拖拽落点不可变树提交
    const handleCommitTree = useCallback(
      (newTree: DockTree) => {
        commitDock({ tree: newTree });
      },
      [commitDock]
    );

    // ── 空态渲染 ──────────────────────────────────────────────────────
    if (!tree || isDockTreeEmpty(tree) || flattened.leaves.length === 0) {
      return (
        <div
          className={`${styles.dockSplitWorkspace} ${dockStyles.workspace}`}
          data-dock-split-workspace="true"
          data-outer-leaf-id={outerLeafId}
          data-empty="true"
        >
          <div
            className={styles.emptyState}
            data-testid="dock-workspace-empty-state"
          >
            <div className={dockStyles.emptyContainer}>
              <div className={dockStyles.emptyTitle}>
                {t('workspace.dock.workspaceEmptyTitle')}
              </div>
              <div className={dockStyles.emptyDesc}>
                {t('workspace.dock.workspaceEmptyDesc')}
              </div>
              <div className={dockStyles.emptyActionGrid}>
                <Button
                  variant="unstyled"
                  className={dockStyles.emptyActionBtn}
                  onClick={() => handleAddTab('', 'terminal')}
                >
                  <AppIcon name="terminal" size={13} aria-hidden />
                  <span>{t('workspace.dock.toolTerminal')}</span>
                </Button>
                <Button
                  variant="unstyled"
                  className={dockStyles.emptyActionBtn}
                  onClick={() => handleAddTab('', 'preview')}
                >
                  <AppIcon name="globe" size={13} aria-hidden />
                  <span>{t('workspace.dock.toolPreview')}</span>
                </Button>
                <Button
                  variant="unstyled"
                  className={dockStyles.emptyActionBtn}
                  onClick={() => handleAddTab('', 'files')}
                >
                  <AppIcon name="folder" size={13} aria-hidden />
                  <span>{t('workspace.dock.toolFiles')}</span>
                </Button>
                <Button
                  variant="unstyled"
                  className={dockStyles.emptyActionBtn}
                  onClick={() => handleAddTab('', 'diff')}
                >
                  <AppIcon name="code" size={13} aria-hidden />
                  <span>{t('workspace.dock.toolDiff')}</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // ── 多窗格与分割线渲染 ────────────────────────────────────────────
    return (
      <DockTabDragProvider
        dockRootRef={workspaceRef}
        dockTree={tree}
        onCommitTree={handleCommitTree}
      >
        <div
          ref={workspaceRef}
          className={`${styles.dockSplitWorkspace} ${dockStyles.workspace}`}
          data-dock-split-workspace="true"
          data-outer-leaf-id={outerLeafId}
          data-maximized={isMaximized ? 'true' : 'false'}
          data-has-solo={effectiveSoloLeafId ? 'true' : 'false'}
        >
          <div
            ref={canvasRef}
            className={`${styles.dockCanvas} ${dockStyles.canvas}`}
            data-dock-canvas="true"
          >
            {/* 遍历渲染所有分屏叶片 */}
            {flattened.leaves.map((flatLeaf) => {
              const isSolo = Boolean(
                effectiveSoloLeafId && effectiveSoloLeafId === flatLeaf.leafId
              );

              return (
                <DockPane
                  key={flatLeaf.leafId}
                  flatLeaf={flatLeaf}
                  leafId={flatLeaf.leafId}
                  sessionId={sessionId}
                  isSolo={isSolo}
                  isMaximized={isMaximized}
                  isOnlyPane={isOnlyPane}
                  onSelectTab={(tabId) =>
                    handleSelectTab(flatLeaf.leafId, tabId)
                  }
                  onCloseTab={(tabId) => handleCloseTab(flatLeaf.leafId, tabId)}
                  onAddTab={(viewId) => handleAddTab(flatLeaf.leafId, viewId)}
                  onSplitRight={() => handleSplitRight(flatLeaf.leafId)}
                  onSplitDown={() => handleSplitDown(flatLeaf.leafId)}
                  onToggleSolo={() => handleToggleSolo(flatLeaf.leafId)}
                  onToggleMaximize={onToggleMaximize}
                  onClosePane={() => handleClosePane(flatLeaf.leafId)}
                  onFocusPane={() => handleFocusPane(flatLeaf.leafId)}
                />
              );
            })}

            {/* 当未处于 Solo 聚焦且有分支时渲染发丝分割线 */}
            {!effectiveSoloLeafId &&
              flattened.branches.map((branch) => (
                <DockResizeSash
                  key={branch.branchId}
                  branch={branch}
                  containerRef={canvasRef}
                  onCommitRatio={handleCommitRatio}
                />
              ))}
          </div>
        </div>
      </DockTabDragProvider>
    );
  }
);

DockSplitWorkspace.displayName = 'DockSplitWorkspace';
