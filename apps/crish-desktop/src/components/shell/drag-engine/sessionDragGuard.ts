/**
 * sessionDragGuard.ts — 跨域拖拽分屏互斥守门状态机
 * 
 * 核心原则：
 * 1. 单窗口单会话自裂变拦截（当全树仅 1 个活动 Chat 叶且拖拽当前活动会话时，禁止分屏）；
 * 2. 多窗口或拖拽历史非活动会话时，完全放行分屏与跨叶迁移；
 * 3. 纯函数设计，可独立测试。
 */

import type { LayoutTree } from '../../../store/layout-tree/types';
import { collectLeaves } from '../../../store/layout-tree/layoutTreeQuery';
import { activeSessionIdOf } from '../../../store/layout-tree/sessionTabModel';

export type PaneDropRegion = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface GuardEvaluation {
  allowed: boolean;
  reason?: 'SINGLE_LEAF_SELF_SPLIT_BLOCKED' | 'ALREADY_ACTIVE' | 'OK';
}

/**
 * 形式化互斥规则判定谓词
 * 
 * @param tree 全局二叉树
 * @param draggedSessionId 当前正在被拖拽的会话 ID
 * @param targetLeafId 指针悬停的目标叶 ID
 * @param region 悬停区域（边缘 22% 或者是中心）
 */
export function evaluateSessionSplitGuard(
  tree: LayoutTree,
  draggedSessionId: string,
  targetLeafId: string,
  region: PaneDropRegion
): GuardEvaluation {
  if (!tree?.root || !draggedSessionId || !targetLeafId) {
    return { allowed: false, reason: 'OK' };
  }

  const chatLeaves = collectLeaves(tree.root).filter((l) => l.panelId === 'chat');
  const leafCount = chatLeaves.length;

  if (leafCount === 1) {
    const singleLeaf = chatLeaves[0]!;
    const activeSid = activeSessionIdOf(singleLeaf);

    // 核心守门：当全局只有 1 个窗口，且拖拽的是当前打开的激活会话时，禁止向右自自分裂
    if (activeSid === draggedSessionId) {
      return {
        allowed: false,
        reason: 'SINGLE_LEAF_SELF_SPLIT_BLOCKED',
      };
    }
  }

  // 中心合并到已经激活该会话的叶子
  if (region === 'center') {
    const targetLeaf = chatLeaves.find((l) => l.id === targetLeafId);
    if (targetLeaf && activeSessionIdOf(targetLeaf) === draggedSessionId) {
      return {
        allowed: false,
        reason: 'ALREADY_ACTIVE',
      };
    }
  }

  return { allowed: true, reason: 'OK' };
}
