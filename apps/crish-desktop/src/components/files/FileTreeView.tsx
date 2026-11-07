import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './FilesCard.module.css';
import { Button, Tooltip } from '@/components/ui';
import { FileFormatIcon } from '../../assets/icons';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { isSameFsPath } from '../../api/workspaceFsApi';
import type { HostOpener } from '../../api/hostOpenersApi';
import type { TreeNode } from './hooks/useFileNavigation';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import { AppIcon } from '@/components/ui/icons';
import { diffToggleChange } from './fileTreeMotion';
import { calcAccordionDuration, EASE_DECELERATE } from '../../utils/motionTokens';
import { isRevealDegraded } from '../chat-tool-call/toolRevealState';

function TreeFileIcon({ name }: { name: string }) {
  return (
    <FileFormatIcon fileName={name} size={14} className={styles.filesRowIco} />
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export interface FileTreeViewProps {
  root?: string;
  flatTree: TreeNode[];
  selected: string | null;
  /**
   * 揭示鉴别键（格式见 buildRevealSelectionKey：路径 + 一次性 nonce）：
   * 滚动居中 + 抢焦点 + 绿脉冲三件套只由本键的变化触发；普通 selected
   * 变化（树内点选 / 键盘选中 / 带恢复选中重挂载）只更新选中呈现。
   * 缺省（不传 / null）= 永不触发三件套。
   */
  revealSelectionKey?: string | null;
  expanded: Record<string, unknown>;
  loading: boolean;
  error: string;
  filter: string;
  filterMode: boolean;
  gitStatusMap: Record<string, string>;
  onSelect: (path: string, isDir: boolean) => void;
  onToggleExpand: (path: string, e: React.MouseEvent) => void;
  onDoubleClick: (path: string, isDir: boolean) => void;
  onFilterChange: (v: string) => void;
  onFilterModeToggle: () => void;
  onErrorDismiss: () => void;
  /** 右键菜单「打开方式」候选（宿主已装配的系统打开器列表） */
  fileOpeners?: HostOpener[];
  /** 右键菜单复制路径（按目标 path 定向复制，宿主负责 toast 反馈） */
  onCopyPath?: (path: string, mode: 'abs' | 'rel') => void;
}

/**
 * 揭示鉴别键的单一真源：`${seq}:${path}`。seq 为宿主侧单调递增计数，
 * 保证同一路径被重复揭示时也能产生新键、再次触发三件套；
 * path 天然可含 ':'（如盘符），故解析只认首段数字前缀、其余整体为路径。
 */
export function buildRevealSelectionKey(path: string, seq: number): string {
  return `${seq}:${path}`;
}

function parseRevealSelectionKey(key: string): string | null {
  const sep = key.indexOf(':');
  if (sep <= 0) return null;
  if (!/^\d+$/.test(key.slice(0, sep))) return null;
  const path = key.slice(sep + 1);
  return path ? path : null;
}

const ITEM_HEIGHT = 28;

export const FileTreeView: React.FC<FileTreeViewProps> = React.memo(
  function FileTreeView({
    root: _root,
    flatTree,
    selected,
    revealSelectionKey,
    expanded,
    loading,
    error,
    filter,
    filterMode: _filterMode,
    gitStatusMap,
    onSelect,
    onToggleExpand,
    onDoubleClick,
    onFilterChange: _onFilterChange,
    onFilterModeToggle: _onFilterModeToggle,
    onErrorDismiss,
    fileOpeners,
    onCopyPath,
  }) {
    const ids = useMemo(() => flatTree.map((e) => e.path), [flatTree]);

    // 真实 Hook 契约对齐：参数名为 fallbackHeight 与 overscan，返回值包含 visibleRange
    const { visibleRange, containerRef, onScroll, totalHeight } =
      useVirtualScroll({
        ids,
        itemCount: flatTree.length,
        fallbackHeight: ITEM_HEIGHT,
        overscan: 4,
      });

    const { startIndex, endIndex } = visibleRange;

    // 真实渲染切片严谨包含最后一项（endIndex + 1 闭区间）
    const visibleItems = useMemo(() => {
      return flatTree.slice(startIndex, endIndex + 1);
    }, [flatTree, startIndex, endIndex]);

    const [pulseTarget, setPulseTarget] = useState<string | null>(null);
    /** 已消费的揭示键：三件套只认 revealSelectionKey 的新值，与 selected 变化无关 */
    const consumedRevealKeyRef = useRef<string | null>(null);

    /**
     * S6 文件树展开/折叠动效（G §3.1 + 审计 A 2-1）：
     * - 展开：新增子行 WAAPI 淡入（100ms 微档）+ 下方行 FLIP 下移（下标差 × 28，
     *   时长走 calcAccordionDuration 单一时钟）；折叠：子行快照淡出 + 下方行 FLIP 上移。
     * - 归因关口：只认 diffToggleChange 承认的「锚点目录后单段连续插入/删除」；
     *   过滤替换、外部重载等一律静默同步。切换意图由 noteToggle 记录（单击目录行 /
     *   键盘 ←/→/Enter / 双击目录），diff 不符时记录即作废，不产生动画。
     * - 入场不用 @starting-style：标记在布局 effect 里才算出，晚于行挂载的首帧样式计算，
     *   故淡入直接走 WAAPI（布局 effect 在首漆前执行，首帧即为 opacity 0）。
     *   退场行则不同——快照在 effect 触发的重渲染里首帧即带 data-leaving 挂载，
     *   故走 CSS [data-leaving] 目标态 + @starting-style（节点复用时类名切换同样过渡）。
     */
    const [leavingRows, setLeavingRows] = useState<
      Array<{ node: TreeNode; top: number }>
    >([]);
    /** 退场快照的 ref 真源（state 的镜像）：effect 内同步读写，避免闭包过期 */
    const leavingRowsRef = useRef<Array<{ node: TreeNode; top: number }>>([]);
    const pendingToggleRef = useRef<string | null>(null);
    const prevFlatTreeRef = useRef<TreeNode[]>(flatTree);
    const prevVisibleRef = useRef({ startIndex, endIndex });
    const motionTimerRef = useRef<number | null>(null);
    const flipAnimsRef = useRef(new Map<string, Animation>());

    const noteToggle = useCallback((path: string) => {
      pendingToggleRef.current = path;
    }, []);

    // 行右键菜单（统一 ui/ContextMenu 基座）：右键不改选择态，
    // 直接以命中节点为目标（目录右键不得触发 onSelect 的展开副作用）
    const [ctxMenu, setCtxMenu] = useState<{
      node: TreeNode;
      x: number;
      y: number;
      anchorEl: HTMLElement | null;
    } | null>(null);

    const openRowContextMenu = useCallback(
      (node: TreeNode, x: number, y: number, anchorEl: HTMLElement | null) => {
        setCtxMenu({ node, x, y, anchorEl });
      },
      []
    );

    const focusTreeRow = useCallback(
      (targetIndex: number) => {
        containerRef.current
          ?.querySelector<HTMLElement>(`[data-tree-index="${targetIndex}"]`)
          ?.focus();
      },
      [containerRef]
    );

    // 核心时序闭环：W3C 原生 scrollend 停泊守护与脉冲高亮挂载（CRIT-04 & MIN-05）
    // 触发源已收窄为 revealSelectionKey（外部揭示）：selected 单独变化
    // （树内点选 / Enter 选中 / 带恢复选中重挂载）不再滚动、不再抢焦、不再脉冲；
    // 目标行由键内路径定位，与 selected 的到达时序无关。
    useEffect(() => {
      const key = revealSelectionKey ?? null;
      if (!key || !containerRef.current) {
        return;
      }
      if (key === consumedRevealKeyRef.current) return;

      const revealPath = parseRevealSelectionKey(key);
      if (!revealPath) {
        // 格式非法：消费掉，避免后续渲染反复解析
        consumedRevealKeyRef.current = key;
        return;
      }

      const targetIndex = flatTree.findIndex((n) =>
        isSameFsPath(n.path, revealPath)
      );
      if (targetIndex === -1) {
        // 目标行尚未进树（揭示落点展开父链后才会出现）：不消费，
        // 等 flatTree 就绪后由本 effect 重跑触发
        return;
      }
      consumedRevealKeyRef.current = key;

      const container = containerRef.current;
      const viewHeight = container.clientHeight;
      if (viewHeight <= 0) return;

      const itemTop = targetIndex * ITEM_HEIGHT;
      const itemBottom = itemTop + ITEM_HEIGHT;
      const currentScrollTop = container.scrollTop;
      const maxScrollTop = Math.max(0, totalHeight - viewHeight);

      const isAtTopBoundary = currentScrollTop === 0 && targetIndex === 0;
      const isAtBottomBoundary =
        currentScrollTop >= maxScrollTop && targetIndex === flatTree.length - 1;

      // MIN-05 极限矮视口（< 56px）非空判定
      const isInView =
        isAtTopBoundary ||
        isAtBottomBoundary ||
        (viewHeight >= 2 * ITEM_HEIGHT
          ? itemTop >= currentScrollTop + ITEM_HEIGHT &&
            itemBottom <= currentScrollTop + viewHeight - ITEM_HEIGHT
          : itemTop >= currentScrollTop &&
            itemBottom <= currentScrollTop + viewHeight);

      let pulseTimer: number | null = null;
      let cleanupScrollEnd: (() => void) | null = null;

      const triggerFocusAndPulse = () => {
        setPulseTarget(revealPath);
        // S6：与 fileRowPulse 动画时长 1.6s 对齐（原 1400ms 会在动画约 87% 处截断尾巴）
        pulseTimer = window.setTimeout(() => {
          setPulseTarget(null);
        }, 1600);
        focusTreeRow(targetIndex);
        requestAnimationFrame(() => {
          focusTreeRow(targetIndex);
        });
      };

      if (!isInView) {
        const rawScrollTop =
          itemTop - Math.floor((viewHeight - ITEM_HEIGHT) / 2);
        const targetScrollTop = Math.min(
          maxScrollTop,
          Math.max(0, rawScrollTop)
        );

        let settled = false;
        const onScrollEnd = () => {
          if (settled) return;
          settled = true;
          container.removeEventListener('scrollend', onScrollEnd);
          window.clearTimeout(fallbackTimer);
          requestAnimationFrame(() => {
            triggerFocusAndPulse();
          });
        };

        container.addEventListener('scrollend', onScrollEnd, { once: true });
        container.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth',
        });

        // 350ms 双重保险优雅降级兜底守卫
        const fallbackTimer = window.setTimeout(onScrollEnd, 350);
        cleanupScrollEnd = () => {
          container.removeEventListener('scrollend', onScrollEnd);
          window.clearTimeout(fallbackTimer);
        };
      } else {
        triggerFocusAndPulse();
      }

      return () => {
        if (pulseTimer != null) window.clearTimeout(pulseTimer);
        cleanupScrollEnd?.();
      };
    }, [revealSelectionKey, flatTree, focusTreeRow, containerRef, totalHeight]);

    // S6 展开/折叠动效主 effect：flatTree 变化后、首漆前执行。
    // 滚动引起的 visibleRange 变化会同 effect 重跑，此时 diff 为 null（无切换记录），
    // 仅静默同步基线——滚动挂载的行不做入场（G §七反例 1 裁决沿用），
    // 且不碰退场快照的 200ms 定时器（滚动不打断正在进行的退场）。
    useLayoutEffect(() => {
      const prevTree = prevFlatTreeRef.current;
      const prevVisible = prevVisibleRef.current;
      const container = containerRef.current;
      const change = diffToggleChange(
        prevTree,
        flatTree,
        pendingToggleRef.current
      );
      pendingToggleRef.current = null;

      const filterActive = filter.trim() !== '';
      if (!change || filterActive || isRevealDegraded() || !container) {
        prevFlatTreeRef.current = flatTree;
        prevVisibleRef.current = { startIndex, endIndex };
        return;
      }

      // 有新切换：接管退场定时器（旧快照的回收权移交本次切换）
      if (motionTimerRef.current != null) {
        window.clearTimeout(motionTimerRef.current);
        motionTimerRef.current = null;
      }

      const isOpening = change.kind === 'expand';
      const prevIndexByPath = new Map(prevTree.map((n, i) => [n.path, i]));
      let maxDeltaPx = 0;
      const flips: Array<{ el: HTMLElement; delta: number; path: string }> =
        [];
      flatTree.forEach((node, newIdx) => {
        const oldIdx = prevIndexByPath.get(node.path);
        if (oldIdx === undefined || oldIdx === newIdx) return;
        if (newIdx < startIndex || newIdx > endIndex) return;
        const el = container.querySelector<HTMLElement>(
          `[data-tree-index="${newIdx}"]`
        );
        if (!el) return;
        const delta = (oldIdx - newIdx) * ITEM_HEIGHT;
        maxDeltaPx = Math.max(maxDeltaPx, Math.abs(delta));
        flips.push({ el, delta, path: node.path });
      });
      const duration = calcAccordionDuration(maxDeltaPx, isOpening);
      for (const { el, delta, path } of flips) {
        flipAnimsRef.current.get(path)?.cancel();
        const anim = el.animate(
          [
            { transform: `translateY(${delta}px)` },
            { transform: 'translateY(0px)' },
          ],
          { duration, easing: EASE_DECELERATE }
        );
        flipAnimsRef.current.set(path, anim);
      }

      // 入场淡入：新增段中当前可见的行（WAAPI，首漆前启动即首帧 opacity 0）
      if (isOpening) {
        for (
          let i = change.runStartIndex;
          i < change.runStartIndex + change.run.length;
          i++
        ) {
          if (i < startIndex || i > endIndex) continue;
          const el = container.querySelector<HTMLElement>(
            `[data-tree-index="${i}"]`
          );
          if (!el) continue;
          el.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 100,
            easing: 'ease-out',
          });
        }
      } else {
        // 退场快照：删除段中此前可见的行，按旧 top 留位淡出（CSS [data-leaving] 接管）
        const leaving: Array<{ node: TreeNode; top: number }> = [];
        change.run.forEach((node, k) => {
          const prevIdx = change.runStartIndex + k;
          if (
            prevIdx >= prevVisible.startIndex &&
            prevIdx <= prevVisible.endIndex
          ) {
            leaving.push({ node, top: prevIdx * ITEM_HEIGHT });
          }
        });
        if (leaving.length > 0) {
          leavingRowsRef.current = leaving;
          setLeavingRows(leaving);
          // 退场主档 150ms + 50ms 余量（与 S4 useClosingFlag 同口径）
          motionTimerRef.current = window.setTimeout(() => {
            leavingRowsRef.current = [];
            setLeavingRows([]);
            motionTimerRef.current = null;
          }, 200);
        } else if (leavingRowsRef.current.length > 0) {
          // 本次切换无退场行：立即撤下上一批快照
          leavingRowsRef.current = [];
          setLeavingRows([]);
        }
      }

      prevFlatTreeRef.current = flatTree;
      prevVisibleRef.current = { startIndex, endIndex };
      // leavingRows 的回收权唯一归属 motionTimerRef；本 effect 不返回定时器清理，
      // 滚动重跑不得打断退场。卸载清理见下方空 deps effect。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flatTree, startIndex, endIndex, filter]);

    // 卸载时清理退场定时器（唯一的定时器清理点）
    useEffect(() => {
      return () => {
        if (motionTimerRef.current != null) {
          window.clearTimeout(motionTimerRef.current);
          motionTimerRef.current = null;
        }
      };
    }, []);

    // ARIA tree pattern 键盘漫游
    const handleRowKeyDown = useCallback(
      (e: React.KeyboardEvent, idx: number, node: TreeNode) => {
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const el = e.currentTarget as HTMLElement | null;
          const rect = el?.getBoundingClientRect();
          openRowContextMenu(
            node,
            rect ? rect.left + 8 : 0,
            rect ? rect.bottom : 0,
            el
          );
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          // 目录的 Enter 即切换展开（与单击同义），记录切换意图供动效归因
          if (node.isDir) noteToggle(node.path);
          onSelect(node.path, node.isDir);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (idx < flatTree.length - 1) focusTreeRow(idx + 1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (idx > 0) focusTreeRow(idx - 1);
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          focusTreeRow(0);
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          focusTreeRow(flatTree.length - 1);
          return;
        }
        if (e.key === 'ArrowRight' && node.isDir && !expanded[node.path]) {
          e.preventDefault();
          noteToggle(node.path);
          onToggleExpand(node.path, e as unknown as React.MouseEvent);
          return;
        }
        if (e.key === 'ArrowLeft' && node.isDir && expanded[node.path]) {
          e.preventDefault();
          noteToggle(node.path);
          onToggleExpand(node.path, e as unknown as React.MouseEvent);
        }
      },
      [
        flatTree.length,
        expanded,
        noteToggle,
        onSelect,
        onToggleExpand,
        focusTreeRow,
        openRowContextMenu,
      ]
    );

    // S6：行渲染抽取——正常行与退场快照共用同一 JSX；退场行不带 data-tree-index
    //（FLIP/入场按下标查元素时不被快照干扰）、不带选中/脉冲态、tabIndex -1、aria-hidden。
    const renderTreeRow = (
      node: TreeNode,
      globalIdx: number | null,
      top: number,
      leaving: boolean
    ) => {
      const isSelected =
        !leaving && Boolean(selected && isSameFsPath(node.path, selected));
      const isPulse =
        !leaving &&
        Boolean(pulseTarget && isSameFsPath(node.path, pulseTarget));

      return (
        <div
          key={node.path}
          data-tree-index={leaving ? undefined : (globalIdx ?? undefined)}
          data-tree-leaving={leaving ? 'true' : undefined}
          aria-hidden={leaving ? true : undefined}
          className={`${styles.filesRow} ${isSelected ? styles.isSelected : ''} ${isPulse ? styles.isSelectedPulse || 'isSelectedPulse' : ''}`}
          style={{
            position: 'absolute',
            top: `${top}px`,
            left: 0,
            width: '100%',
            height: `${ITEM_HEIGHT}px`,
            paddingLeft: 4 + node.depth * 10,
            display: 'flex',
            alignItems: 'center',
          }}
          onClick={() => {
            if (node.isDir) noteToggle(node.path);
            onSelect(node.path, node.isDir);
          }}
          onDoubleClick={() => {
            if (node.isDir) noteToggle(node.path);
            onDoubleClick(node.path, node.isDir);
          }}
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openRowContextMenu(node, ev.clientX, ev.clientY, ev.currentTarget);
          }}
          role="treeitem"
          aria-level={node.depth + 1}
          aria-selected={isSelected}
          aria-expanded={
            node.isDir ? (expanded[node.path] ? 'true' : 'false') : undefined
          }
          tabIndex={leaving ? -1 : isSelected ? 0 : -1}
          onKeyDown={(ev) => handleRowKeyDown(ev, globalIdx ?? 0, node)}
        >
          {/* 文件浏览器不显示展开箭头（filesRowTwist 已移除，不占位）：
              单击行 → onSelect（目录即 toggleExpand），键盘 ←/→/Enter 同样可展开折叠；
              展开态由 aria-expanded 暴露。差异面板用自己的 fileNodeToggle，不受影响。 */}
          {node.isDir ? (
            <AppIcon
              name="folder"
              size={14}
              className={`${styles.filesRowIco} ${styles.dir}`}
            />
          ) : (
            <TreeFileIcon name={node.name} />
          )}
          <Tooltip content={node.name}>
            <span className={styles.filesRowName}>{node.name}</span>
          </Tooltip>
          {!node.isDir && gitStatusMap[node.path] ? (
            <span
              className={styles.filesGitStatus}
              style={{
                color:
                  gitStatusMap[node.path] === 'M'
                    ? 'var(--color-warning)'
                    : gitStatusMap[node.path] === 'A'
                      ? 'var(--color-success)'
                      : gitStatusMap[node.path] === 'D'
                        ? 'var(--color-error)'
                        : gitStatusMap[node.path] === '?'
                          ? 'var(--text-tertiary)'
                          : undefined,
              }}
            >
              {gitStatusMap[node.path]}
            </span>
          ) : null}
          {!node.isDir && node.size != null ? (
            <span className={styles.filesRowMeta}>
              {formatSize(node.size)}
            </span>
          ) : null}
        </div>
      );
    };

    // S6：内容高度下限——退场快照按旧 top 渲染在内容区内，高度不得小于其底边，
    // 否则 inner div 的 overflow: hidden 会裁掉正在淡出的行。
    const contentHeight = Math.max(
      totalHeight,
      leavingRows.reduce((m, r) => Math.max(m, r.top + ITEM_HEIGHT), 0)
    );

    return (
      <div
        className={`${styles.filesList} ${styles.filesListPane}`}
        ref={containerRef}
        onScroll={onScroll}
        role="tree"
        aria-label="工作区文件树"
        style={{
          overflowY: 'auto',
          position: 'relative',
          overflowAnchor: 'none',
        }}
      >
        {loading && flatTree.length === 0 ? (
          <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
            加载中…
          </div>
        ) : error && !flatTree.length ? (
          <div
            className={`${styles.filesEmpty} ${styles.filesEmptyCompact} ${styles.filesEmptyErr}`}
            role="alert"
          >
            <div className={styles.filesEmptyTitle}>无法读取目录</div>
            <div className={styles.filesEmptySub}>{error}</div>
          </div>
        ) : flatTree.length === 0 ? (
          <div className={`${styles.filesEmpty} ${styles.filesEmptyCompact}`}>
            {filter.trim() ? '无匹配项' : '空目录'}
          </div>
        ) : (
          <>
            {error ? (
              <div
                className={styles.filesInlineErr}
                role="alert"
                aria-live="polite"
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 'var(--z-sticky, 10)', // 修正虚构 Token，对齐正典
                }}
              >
                <span className={styles.filesInlineErrText}>{error}</span>
                <Tooltip content="关闭">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.filesInlineErrDismiss}
                    aria-label="关闭错误"
                    onClick={onErrorDismiss}
                    icon={<AppIcon name="x" size={11} />}
                  />
                </Tooltip>
              </div>
            ) : null}

            <div
              style={{
                height: `${contentHeight}px`,
                width: '100%',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {visibleItems.map((e, index) => {
                const globalIdx = startIndex + index;
                return renderTreeRow(e, globalIdx, globalIdx * ITEM_HEIGHT, false);
              })}
              {/* S6 退场快照：折叠时子行在旧 top 处留位淡出，200ms 后由定时器回收 */}
              {leavingRows.map(({ node, top }) =>
                renderTreeRow(node, null, top, true)
              )}
            </div>
          </>
        )}

        {ctxMenu ? (
          <FileTreeContextMenu
            node={ctxMenu.node}
            x={ctxMenu.x}
            y={ctxMenu.y}
            anchorEl={ctxMenu.anchorEl}
            isExpanded={Boolean(expanded[ctxMenu.node.path])}
            fileOpeners={fileOpeners ?? []}
            onClose={() => setCtxMenu(null)}
            onOpen={(p, isDir) => {
              setCtxMenu(null);
              onSelect(p, isDir);
            }}
            onCopyPath={
              onCopyPath
                ? (p, mode) => {
                    setCtxMenu(null);
                    onCopyPath(p, mode);
                  }
                : undefined
            }
          />
        ) : null}
      </div>
    );
  }
);
