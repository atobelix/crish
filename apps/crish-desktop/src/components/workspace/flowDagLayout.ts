/**
 * FlowDagView 纯函数层（T-D-12 前端侧，DAG-2）。
 *
 * DAG 只读可视化的纯计算面：拓扑分层 / 依赖边生成 / 状态色映射 /
 * 空态判定 / 计数文案 / 快照载荷洗白。零副作用、零 DOM 依赖，
 * 与 runtimePanelLib 同职责（组件内可派生逻辑抽离，独立单测）。
 *
 * 状态色只映射到 CSS token 变量（禁止裸色值），与 AgentTeamBoard
 * 状态色语义同源（tokens.css 语义角色段）。
 */

/** 节点状态（wire 值与引擎 FlowNodeState 对齐：pending/running/completed/failed/blocked） */
export type DagNodeState = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

/** 五态常量集合（洗白时校验非法状态兜底） */
const DAG_NODE_STATES: readonly DagNodeState[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'blocked',
] as const;

/** DAG 节点（get_flow_snapshot 冻结载荷元素；字段与引擎 flow_declaration 语义对齐） */
export interface DagNode {
  id: string;
  task: string;
  /** 上游依赖节点 id 列表（原始依赖源） */
  dependsOn: string[];
  /** 并行节点标记（同层内可同时执行的节点） */
  parallel: boolean;
  /** 复合节点标记（由主 Agent 汇总的子任务组） */
  isComposite: boolean;
  state: DagNodeState;
  /** 子 Agent run 运行实例 id（运行中/已结束节点有值） */
  subagentRunId?: string | null;
}

/** 依赖边（from 上游 → to 下游） */
export interface DagEdge {
  from: string;
  to: string;
}

/** 状态 → 语义色 token 变量映射（五态；颜色只经 token 声明） */
const STATE_COLOR_VARS: Readonly<Record<DagNodeState, string>> = Object.freeze({
  pending: 'var(--text-tertiary)', // 灰：待执行（对齐 AgentTeamBoard 默认灰点）
  running: 'var(--color-info)', // 蓝：执行中
  completed: 'var(--color-success)', // 绿：已完成
  failed: 'var(--color-error)', // 红：已失败
  blocked: 'var(--color-warning)', // 橙：已阻塞（节点整体降透明度，见样式层）
});

/** 状态 → 中文短标签 */
const STATE_LABELS: Readonly<Record<DagNodeState, string>> = Object.freeze({
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '已失败',
  blocked: '已阻塞',
});

/**
 * 拓扑分层：节点 → 层级数组（层级 = 最长依赖链深度）。
 *
 * - 无依赖节点归第 0 层；依赖第 k 层节点 → 至少第 k+1 层；
 * - 同层节点保持声明顺序（输入数组序，不重排）；
 * - 并行节点天然同层（parallel 标记不参与分层计算）；
 * - 宽容策略：依赖未知节点 / 自依赖 / 依赖环 → 该条依赖不参与层深
 *   （环防护防死循环，脏数据不炸渲染）。
 */
export function layerNodes(nodes: DagNode[]): DagNode[][] {
  const byId = new Map<string, DagNode>();
  for (const n of nodes) {
    if (n && typeof n.id === 'string') byId.set(n.id, n);
  }
  const layerOf = new Map<string, number>();

  const resolveLayer = (id: string, stack: readonly string[]): number => {
    const cached = layerOf.get(id);
    if (cached != null) return cached;
    const node = byId.get(id);
    if (!node) return 0;
    if (stack.includes(id)) return -1; // 环：该路径无效（回退信号）
    let max = 0;
    let sawCycle = false;
    for (const dep of node.dependsOn || []) {
      if (typeof dep !== 'string' || !byId.has(dep) || dep === node.id) {
        continue; // 未知 / 自依赖：宽容忽略
      }
      const depth = resolveLayer(dep, [...stack, id]);
      if (depth < 0) {
        sawCycle = true; // 依赖落入环路径：本节点也视为环路径
        continue;
      }
      max = Math.max(max, depth + 1);
    }
    if (sawCycle) return -1; // 环内节点整体归 0 层（不缓存，回退由调用方兜底）
    layerOf.set(id, max);
    return max;
  };

  const layers: DagNode[][] = [];
  for (const n of nodes) {
    // 环路径（-1）与正常路径统一取最大(0, l)：环内节点归 0 层
    const l = resolveLayer(n.id, []);
    (layers[Math.max(0, l)] ??= []).push(n);
  }
  return layers;
}

/**
 * 依赖边生成：dependsOn 展开为边表（from → to）。
 * 只保留指向有效节点、且非自引用的依赖（宽容忽略脏数据）。
 */
export function buildEdges(nodes: DagNode[]): DagEdge[] {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (n && typeof n.id === 'string') ids.add(n.id);
  }
  const edges: DagEdge[] = [];
  for (const n of nodes) {
    for (const dep of n.dependsOn || []) {
      if (typeof dep === 'string' && dep !== n.id && ids.has(dep)) {
        edges.push({ from: dep, to: n.id });
      }
    }
  }
  return edges;
}

/**
 * 状态 → 语义色 token 变量映射（组件以 CSS var 字符串内联使用，
 * 不引入任何裸色值；blocked 的降透明度由样式层 .nodeBlocked 处理）。
 */
export function stateColorVar(state: DagNodeState): string {
  return STATE_COLOR_VARS[state] ?? STATE_COLOR_VARS.pending;
}

/** 状态 → 中文短标签（节点 meta 展示 / aria 文案） */
export function stateLabel(state: DagNodeState): string {
  return STATE_LABELS[state] ?? STATE_LABELS.pending;
}

/**
 * 空态判定：无节点 / 尚未获取到快照（null / undefined）→ 空，
 * 区段不渲染（对齐 SecurityAuditSection 空态隐藏噪音语义）。
 */
export function dagEmpty(nodes: DagNode[] | null | undefined): boolean {
  return !nodes || nodes.length === 0;
}

/**
 * 计数文案：区段头可见计数 + 读屏播报。
 * 形如「5 节点 · 2 层」/「编排图共 5 个节点、2 层」。
 */
export function dagCountLabel(nodes: DagNode[]): {
  label: string;
  ariaLabel: string;
} {
  const n = nodes.length;
  const l = layerNodes(nodes).length;
  return {
    label: `${n} 节点 · ${l} 层`,
    ariaLabel: `编排图共 ${n} 个节点、${l} 层`,
  };
}

/** 快照载荷形状（get_flow_snapshot 冻结返回：{ nodes: [...] }） */
export interface FlowSnapshotPayload {
  nodes?: DagNode[];
}

/** 字段级默认值（洗白兜底用） */
const PENDING: DagNodeState = 'pending';

/**
 * 快照载荷洗白：宽容解析引擎返回，非法 / 缺失字段逐项兜底，
 * 保证渲染层永远拿到形状合法的节点列表（脏数据不炸）。
 *
 * - 载荷非对象 / nodes 非数组 → []（空态，不渲染）；
 * - 节点非对象 / id 缺失或非字符串 → 跳过（不可渲染）；
 * - task 缺失 → 空串（组件回退展示 id）；
 * - dependsOn 非数组 → []；parallel / isComposite 非布尔 → false；
 * - state 不在五态内 → pending（安全兜底）；
 * - subagentRunId 非字符串 → 省略。
 */
export function sanitizeDagNodes(raw: unknown): DagNode[] {
  const nodes = (raw as FlowSnapshotPayload)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: DagNode[] = [];
  for (const item of nodes) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as unknown as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const state =
      typeof o.state === 'string' &&
      (DAG_NODE_STATES as readonly string[]).includes(o.state)
        ? (o.state as DagNodeState)
        : PENDING;
    const node: DagNode = {
      id: o.id,
      task: typeof o.task === 'string' ? o.task : '',
      dependsOn: Array.isArray(o.dependsOn)
        ? o.dependsOn.filter(
            (d): d is string => typeof d === 'string' && d.length > 0
          )
        : [],
      parallel: o.parallel === true,
      isComposite: o.isComposite === true,
      state,
    };
    if (typeof o.subagentRunId === 'string' && o.subagentRunId) {
      node.subagentRunId = o.subagentRunId;
    }
    out.push(node);
  }
  return out;
}
