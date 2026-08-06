/**
 * flowDagStore 快照入列测试（T-D-12 前端侧，DAG-2）。
 *
 * 覆盖点：
 * - pushNodes 入列：nodes 整列替换 + snapshotAt 更新；
 * - pushNodes(null) 空态落库（未获取到数据）；
 * - reset 清空。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowDagStore } from './flowDagStore';
import type { DagNode } from './flowDagLayout';

function node(id: string, over: Partial<DagNode> = {}): DagNode {
  return {
    id,
    task: `任务 ${id}`,
    dependsOn: [],
    parallel: false,
    isComposite: false,
    state: 'running',
    ...over,
  };
}

beforeEach(() => {
  useFlowDagStore.getState().reset();
});

describe('useFlowDagStore', () => {
  it('初始态：nodes 为 null（尚未获取），snapshotAt 为 null', () => {
    const s = useFlowDagStore.getState();
    expect(s.nodes).toBeNull();
    expect(s.snapshotAt).toBeNull();
  });

  it('pushNodes 入列：节点列表整列替换 + 更新时间戳', () => {
    const s = useFlowDagStore.getState();
    s.pushNodes([node('a'), node('b')]);
    const after = useFlowDagStore.getState();
    expect(after.nodes).toHaveLength(2);
    expect(after.nodes!.map((n) => n.id)).toEqual(['a', 'b']);
    expect(after.snapshotAt).toBeGreaterThan(0);
  });

  it('再次入列整列替换（不做增量合并）', () => {
    const s = useFlowDagStore.getState();
    s.pushNodes([node('a')]);
    s.pushNodes([node('x'), node('y')]);
    const after = useFlowDagStore.getState();
    expect(after.nodes!.map((n) => n.id)).toEqual(['x', 'y']);
  });

  it('pushNodes(null) 空态落库（查询失败时兜底）', () => {
    const s = useFlowDagStore.getState();
    s.pushNodes([node('a')]);
    s.pushNodes(null);
    const after = useFlowDagStore.getState();
    expect(after.nodes).toBeNull();
    expect(after.snapshotAt).not.toBeNull();
  });

  it('reset 清空为初始态', () => {
    const s = useFlowDagStore.getState();
    s.pushNodes([node('a')]);
    s.reset();
    const after = useFlowDagStore.getState();
    expect(after.nodes).toBeNull();
    expect(after.snapshotAt).toBeNull();
  });
});

describe('轮询身份抖动防护（pushNodes 引用复用）', () => {
  it('同内容两次 pushNodes（全新数组）→ nodes 引用 === 不变，snapshotAt 仍更新', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const s = useFlowDagStore.getState();
      s.pushNodes([node('a'), node('b')]);
      const first = useFlowDagStore.getState().nodes;
      expect(useFlowDagStore.getState().snapshotAt).toBe(1000);

      // 模拟 3s 轮询：内容相同但引用全新的数组再次入列
      vi.setSystemTime(2000);
      s.pushNodes([node('a'), node('b')]);
      const after = useFlowDagStore.getState();
      expect(after.nodes).toBe(first);
      expect(after.snapshotAt).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('内容变化 → 新引用（引用复用仅限内容级相等）', () => {
    vi.useFakeTimers();
    try {
      const s = useFlowDagStore.getState();
      s.pushNodes([node('a')]);
      const first = useFlowDagStore.getState().nodes;

      s.pushNodes([node('a'), node('b')]);
      const after = useFlowDagStore.getState();
      expect(after.nodes).not.toBe(first);
      expect(after.nodes!.map((n) => n.id)).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushNodes(null) 连续两次：nodes 保持 null 且 snapshotAt 更新（空数据入列语义保持）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const s = useFlowDagStore.getState();
      s.pushNodes(null);
      vi.setSystemTime(2000);
      s.pushNodes(null);
      const after = useFlowDagStore.getState();
      expect(after.nodes).toBeNull();
      expect(after.snapshotAt).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });
});
