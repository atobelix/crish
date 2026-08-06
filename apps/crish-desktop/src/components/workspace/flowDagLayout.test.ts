// @vitest-environment jsdom
/**
 * flowDagLayout 纯函数层单测（T-D-12 前端侧，DAG-2）。
 *
 * 覆盖点：
 * - 拓扑分层：三节点链 [0,1,2]、并行节点同层、输入序保持；
 * - 宽容策略：未知依赖 / 自依赖 / 依赖环不炸（环防护）；
 * - 依赖边生成：有效边 + 未知 / 自引用过滤；
 * - 状态色五态映射（token 变量）+ 中文标签；
 * - 空态判定（null / undefined / 空数组）；
 * - 计数文案（label + ariaLabel）；
 * - 快照载荷洗白（非法状态兜底 pending / 缺失字段兜底 / 跳过不可渲染项）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildEdges,
  dagCountLabel,
  dagEmpty,
  layerNodes,
  sanitizeDagNodes,
  stateColorVar,
  stateLabel,
  type DagNode,
  type DagNodeState,
} from './flowDagLayout';

/** 测试节点构造：id + 可选依赖（其余字段取无害默认） */
function node(id: string, over: Partial<DagNode> = {}): DagNode {
  return {
    id,
    task: `任务 ${id}`,
    dependsOn: [],
    parallel: false,
    isComposite: false,
    state: 'pending',
    ...over,
  };
}

describe('layerNodes 拓扑分层', () => {
  it('三节点链 a→b→c → 层级 [0,1,2]（验收锚点）', () => {
    const layers = layerNodes([
      node('a'),
      node('b', { dependsOn: ['a'] }),
      node('c', { dependsOn: ['b'] }),
    ]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('并行节点同层（a 派生 b 与 c，b/c 同一层）', () => {
    const layers = layerNodes([
      node('a'),
      node('b', { dependsOn: ['a'], parallel: true }),
      node('c', { dependsOn: ['a'], parallel: true }),
    ]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
  });

  it('同层内保持声明顺序（不重排）', () => {
    const layers = layerNodes([
      node('x'),
      node('b', { dependsOn: ['x'] }),
      node('a'),
      node('c', { dependsOn: ['x'] }),
    ]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([
      ['x', 'a'],
      ['b', 'c'],
    ]);
  });

  it('多层依赖取最深路径（a→b、b→c、a→c → c 在第 2 层）', () => {
    const layers = layerNodes([
      node('a'),
      node('b', { dependsOn: ['a'] }),
      node('c', { dependsOn: ['a', 'b'] }),
    ]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('未知依赖宽容忽略（不炸、仍入 0 层）', () => {
    const layers = layerNodes([node('a', { dependsOn: ['ghost'] })]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([['a']]);
  });

  it('自依赖宽容忽略', () => {
    const layers = layerNodes([node('a', { dependsOn: ['a'] })]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([['a']]);
  });

  it('依赖环防护（a↔b 不死循环，层深有限）', () => {
    const layers = layerNodes([
      node('a', { dependsOn: ['b'] }),
      node('b', { dependsOn: ['a'] }),
    ]);
    expect(layers.map((l) => l.map((n) => n.id))).toEqual([['a', 'b']]);
  });

  it('空数组 → 空层表', () => {
    expect(layerNodes([])).toEqual([]);
  });
});

describe('buildEdges 依赖边生成', () => {
  it('dependsOn 展开为 from→to 边', () => {
    const edges = buildEdges([
      node('a'),
      node('b', { dependsOn: ['a'] }),
      node('c', { dependsOn: ['a', 'b'] }),
    ]);
    expect(edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ]);
  });

  it('未知依赖与自引用边被过滤', () => {
    const edges = buildEdges([
      node('a', { dependsOn: ['ghost', 'a'] }),
    ]);
    expect(edges).toEqual([]);
  });
});

describe('stateColorVar 状态色映射', () => {
  const expectations: ReadonlyArray<[DagNodeState, string]> = [
    ['pending', 'var(--text-tertiary)'],
    ['running', 'var(--color-info)'],
    ['completed', 'var(--color-success)'],
    ['failed', 'var(--color-error)'],
    ['blocked', 'var(--color-warning)'],
  ];

  it('五态 → 语义 token 变量（无裸色值）', () => {
    for (const [state, tokenVar] of expectations) {
      expect(stateColorVar(state)).toBe(tokenVar);
    }
  });
});

describe('stateLabel 中文标签', () => {
  it('五态中文短标签', () => {
    expect(stateLabel('pending')).toBe('待执行');
    expect(stateLabel('running')).toBe('执行中');
    expect(stateLabel('completed')).toBe('已完成');
    expect(stateLabel('failed')).toBe('已失败');
    expect(stateLabel('blocked')).toBe('已阻塞');
  });
});

describe('dagEmpty 空态判定', () => {
  it('null / undefined / 空数组 → 空', () => {
    expect(dagEmpty(null)).toBe(true);
    expect(dagEmpty(undefined)).toBe(true);
    expect(dagEmpty([])).toBe(true);
  });

  it('有节点 → 非空', () => {
    expect(dagEmpty([node('a')])).toBe(false);
  });
});

describe('dagCountLabel 计数文案', () => {
  it('三节点两层的 label 与 aria 文案', () => {
    const { label, ariaLabel } = dagCountLabel([
      node('a'),
      node('b', { dependsOn: ['a'] }),
      node('c', { dependsOn: ['b'] }),
    ]);
    expect(label).toBe('3 节点 · 3 层');
    expect(ariaLabel).toBe('编排图共 3 个节点、3 层');
  });

  it('并行同层：2 节点 1 层', () => {
    const { label } = dagCountLabel([
      node('a'),
      node('b', { dependsOn: ['a'], parallel: true }),
    ]);
    expect(label).toBe('2 节点 · 2 层');
  });
});

describe('sanitizeDagNodes 快照载荷洗白', () => {
  it('合法载荷原样保留', () => {
    const out = sanitizeDagNodes({
      nodes: [
        {
          id: 't1',
          task: '打底方案',
          dependsOn: [],
          parallel: true,
          isComposite: false,
          state: 'completed',
          subagentRunId: 'run-1',
        },
      ],
    });
    expect(out).toEqual([
      {
        id: 't1',
        task: '打底方案',
        dependsOn: [],
        parallel: true,
        isComposite: false,
        state: 'completed',
        subagentRunId: 'run-1',
      },
    ]);
  });

  it('nodes 非数组 / 载荷非对象 → 空数组（空态）', () => {
    expect(sanitizeDagNodes(null)).toEqual([]);
    expect(sanitizeDagNodes({})).toEqual([]);
    expect(sanitizeDagNodes({ nodes: 'x' })).toEqual([]);
    expect(sanitizeDagNodes({ nodes: [null, 42] })).toEqual([]);
  });

  it('缺失字段逐项兜底：task 空串 / dependsOn 空 / state → pending', () => {
    const out = sanitizeDagNodes({ nodes: [{ id: 't1' }] });
    expect(out).toEqual([
      {
        id: 't1',
        task: '',
        dependsOn: [],
        parallel: false,
        isComposite: false,
        state: 'pending',
      },
    ]);
  });

  it('非法 state 兜底 pending；非法布尔兜底 false；非法 runId 省略', () => {
    const out = sanitizeDagNodes({
      nodes: [
        {
          id: 't1',
          task: 'x',
          dependsOn: 'oops',
          parallel: 'yes',
          isComposite: 1,
          state: 'cancelled',
          subagentRunId: 123,
        },
      ],
    });
    expect(out[0]!.state).toBe('pending');
    expect(out[0]!.parallel).toBe(false);
    expect(out[0]!.isComposite).toBe(false);
    expect(out[0]!.subagentRunId).toBeUndefined();
  });

  it('id 缺失 / 非字符串 → 跳过该节点（不可渲染）', () => {
    const out = sanitizeDagNodes({
      nodes: [{ task: '无 id' }, { id: '', task: '空 id' }, { id: 7 }],
    });
    expect(out).toEqual([]);
  });

  it('dependsOn 仅保留非空字符串成员', () => {
    const out = sanitizeDagNodes({
      nodes: [{ id: 't1', dependsOn: ['a', '', 3, 'b'] }],
    });
    expect(out[0]!.dependsOn).toEqual(['a', 'b']);
  });
});
