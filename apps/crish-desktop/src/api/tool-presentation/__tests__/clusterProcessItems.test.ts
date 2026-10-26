/**
 * P5 T-P5-10 · clusterProcessItems 过程簇相邻同类聚合纯函数测试套件。
 */

import { describe, expect, it } from 'vitest';
import type { MessageToolCall } from '../../../store/types';
import {
  clusterProcessItems,
  flattenClusteredTools,
  isSameClusterKind,
} from '../clusterProcessItems';
import type { AssistantTimelineItem } from '../toolPresentationTypes';

function makeToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  overrides?: Partial<MessageToolCall>
): MessageToolCall {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
    status: 'success',
    ...overrides,
  };
}

describe('clusterProcessItems 过程簇聚合契约', () => {
  it('相邻同类工具聚合为 ProcessCluster（默认 defaultExpanded: false 收起为单行摘要）', () => {
    const calls: MessageToolCall[] = [
      makeToolCall(
        'r-1',
        'read_file',
        { path: 'src/a.ts' },
        { durationMs: 200 }
      ),
      makeToolCall(
        'r-2',
        'read_file',
        { path: 'src/b.ts' },
        { durationMs: 250 }
      ),
      makeToolCall(
        'r-3',
        'read_file',
        { path: 'src/c.ts' },
        { durationMs: 300 }
      ),
      makeToolCall(
        'r-4',
        'read_file',
        { path: 'src/d.ts' },
        { durationMs: 200 }
      ),
      makeToolCall(
        'r-5',
        'read_file',
        { path: 'src/e.ts' },
        { durationMs: 250 }
      ),
    ];

    const clusters = clusterProcessItems(calls);
    expect(clusters).toHaveLength(1);

    const cluster = clusters[0]!;
    expect(cluster.kind).toBe('process_cluster');
    expect(cluster.clusterKind).toBe('read');
    expect(cluster.isSingle).toBe(false);
    expect(cluster.defaultExpanded).toBe(false);
    expect(cluster.totalDurationMs).toBe(1200);
    expect(cluster.presentation.label).toBe('读取 5 个文件');
    expect(cluster.summaryLabel).toBe('读取 5 个文件 · 耗时 1.2s');
    expect(cluster.tools).toHaveLength(5);
    expect(cluster.items).toEqual(calls);
  });

  it('不同类工具调用保持时序独立不跨类别合并（Read -> Grep -> Read）', () => {
    const tRead1 = makeToolCall('t-1', 'read_file', { path: 'src/first.ts' });
    const tGrep = makeToolCall('t-2', 'grep_search', { query: 'useStore' });
    const tRead2 = makeToolCall('t-3', 'read_file', { path: 'src/second.ts' });

    expect(isSameClusterKind(tRead1, tGrep)).toBe(false);
    expect(isSameClusterKind(tRead1, tRead2)).toBe(true);

    const clusters = clusterProcessItems([tRead1, tGrep, tRead2]);
    expect(clusters).toHaveLength(3);
    expect(clusters[0]!.clusterKind).toBe('read');
    expect(clusters[0]!.tools).toEqual([tRead1]);
    expect(clusters[1]!.clusterKind).toBe('search');
    expect(clusters[1]!.tools).toEqual([tGrep]);
    expect(clusters[2]!.clusterKind).toBe('read');
    expect(clusters[2]!.tools).toEqual([tRead2]);
  });

  it('单工具段退化为单项簇直接呈现原 ToolPresentation（绝不生成「列出 1 个目录」）', () => {
    const singleList = makeToolCall(
      't-list',
      'list_dir',
      { path: 'crates' },
      { explanation: '列出目录 crates' }
    );

    const clusters = clusterProcessItems([singleList]);
    expect(clusters).toHaveLength(1);

    const c = clusters[0]!;
    expect(c.isSingle).toBe(true);
    expect(c.summaryLabel).not.toContain('1 个');
    expect(c.presentation.label).toBe('列出目录 crates');
    expect(c.presentation.target).toBeUndefined();
    expect(c.items).toEqual([singleList]);
  });

  it('正逆向对称与交错时间线顺序稳定性验证', () => {
    const t1 = makeToolCall('t-1', 'read_file', { path: 'a.rs' });
    const t2 = makeToolCall('t-2', 'read_file', { path: 'b.rs' });
    const t3 = makeToolCall('t-3', 'grep_search', { query: 'fn main' });
    const t4 = makeToolCall('t-4', 'grep_search', { query: 'struct Config' });
    const t5 = makeToolCall('t-5', 'run_command', {
      CommandLine: 'cargo check',
    });

    const timeline: AssistantTimelineItem[] = [
      { kind: 'thought', key: 'th-1', content: '先读取源码并检索入口' },
      {
        kind: 'tools',
        key: 'tools-1',
        items: [
          { kind: 'single', tc: t1 },
          { kind: 'single', tc: t2 },
          { kind: 'single', tc: t3 },
          { kind: 'single', tc: t4 },
        ],
      },
      { kind: 'text', key: 'txt-1', content: '阶段结论' },
      {
        kind: 'tools',
        key: 'tools-2',
        items: [{ kind: 'single', tc: t5 }],
      },
    ];

    const clustered = clusterProcessItems(timeline);
    expect(clustered.map((item) => item.kind)).toEqual([
      'thought',
      'process_cluster', // t1 + t2 (read x2)
      'process_cluster', // t3 + t4 (search x2)
      'text',
      'process_cluster', // t5 (shell x1)
    ]);

    const readCluster = clustered[1]!;
    const searchCluster = clustered[2]!;
    const shellCluster = clustered[4]!;
    if (
      readCluster.kind === 'process_cluster' &&
      searchCluster.kind === 'process_cluster' &&
      shellCluster.kind === 'process_cluster'
    ) {
      expect(readCluster.summaryLabel).toBe('读取 2 个文件');
      expect(searchCluster.summaryLabel).toBe('检索 2 次');
      expect(shellCluster.isSingle).toBe(true);
      expect(shellCluster.presentation.label).toBe('运行命令');
      expect(shellCluster.presentation.target?.text).toBe('cargo check');
    }

    // 逆向还原：工具顺序与引用 100% 保持不变
    const restored = flattenClusteredTools(clustered);
    expect(restored).toEqual([t1, t2, t3, t4, t5]);
  });

  it('边界与异常状态冒泡：空数组安全返回，running 与 error 状态准确聚合', () => {
    expect(clusterProcessItems([])).toEqual([]);

    const calls: MessageToolCall[] = [
      makeToolCall(
        's-1',
        'run_command',
        { command: 'npm run lint' },
        { status: 'success' }
      ),
      makeToolCall(
        's-2',
        'run_command',
        { command: 'npm run test' },
        { status: 'error' }
      ),
      makeToolCall(
        's-3',
        'run_command',
        { command: 'npm run build' },
        { status: 'running' }
      ),
    ];

    const clusters = clusterProcessItems(calls);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.hasError).toBe(true);
    expect(clusters[0]!.hasRunning).toBe(true);
    expect(clusters[0]!.presentation.status).toBe('running');
    expect(clusters[0]!.summaryLabel).toBe('运行 3 条命令');
  });
});
