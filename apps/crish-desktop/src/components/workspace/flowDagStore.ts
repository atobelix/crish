/**
 * 编排图快照 store（T-D-12 前端侧，DAG-2）。
 *
 * get_flow_snapshot 轮询结果入列，FlowDagView 订阅渲染——
 * 「查询 → store → 组件」链路，与 securityAuditStore 同模式。
 *
 * - nodes：最近一次快照节点；null = 尚未获取到任何数据（与「空声明」
 *   区分：空声明 → []，不渲染；未获取 → null，同样不渲染）；
 * - 事件驱动刷新为二期增强（本期不扩展 subagent 事件信封）；
 * - 只读展示面：store 只承载数据面，无任何写入动作。
 */
import { create } from 'zustand';
import type { DagNode } from './flowDagLayout';

interface FlowDagState {
  /** 最近一次快照节点列表（null = 尚未获取到数据） */
  nodes: DagNode[] | null;
  /** 最近一次快照落库时间（epoch ms；空数据入列同样更新时间） */
  snapshotAt: number | null;
  /** 快照数据入列（整列替换：轮询结果幂等全量，无增量合并） */
  pushNodes: (nodes: DagNode[] | null) => void;
  /** 清空（测试 / 手动重置用） */
  reset: () => void;
}

export const useFlowDagStore = create<FlowDagState>((set) => ({
  nodes: null,
  snapshotAt: null,

  pushNodes: (nodes) =>
    set({ nodes, snapshotAt: Date.now() }),

  reset: () => set({ nodes: null, snapshotAt: null }),
}));
