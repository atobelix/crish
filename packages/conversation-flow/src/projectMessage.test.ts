/**
 * projectMessage / projectPurposes / extractPendingApprovals 手写夹具。
 * 不用 demo-data，不造 purpose/plan 块协议。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PURPOSE_WINDOW_MS,
  extractPendingApprovals,
  projectMessage,
  projectPurposes,
} from './index';
import type { ProjectToolCallInput, PurposeNode } from './types';

const T0 = 1_700_000_000_000;

function tc(
  partial: Partial<ProjectToolCallInput> &
    Pick<ProjectToolCallInput, 'id' | 'name'>,
): ProjectToolCallInput {
  return {
    status: 'success',
    ...partial,
  };
}

function purposesOf(nodes: { kind: string }[]): PurposeNode[] {
  return nodes.filter((n): n is PurposeNode => n.kind === 'purpose');
}

describe('projectMessage：无工具助手', () => {
  it('无工具、无思考 → 只有 text 节点', () => {
    const { nodes, pendingApprovals } = projectMessage({
      id: 'a1',
      sender: 'assistant',
      text: '已经看过类型定义。',
    });
    expect(pendingApprovals).toEqual([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'text',
      id: 'a1-text',
      content: '已经看过类型定义。',
      tone: 'primary',
    });
  });

  it('有思考无工具 → thinking + text，无 Purpose', () => {
    const { nodes } = projectMessage({
      id: 'a2',
      sender: 'assistant',
      thinking: '先核对导出再回答。',
      text: '结论如下。',
    });
    expect(nodes.map((n) => n.kind)).toEqual(['thinking', 'text']);
    expect(purposesOf(nodes)).toHaveLength(0);
    const think = nodes[0];
    expect(think?.kind).toBe('thinking');
    if (think?.kind === 'thinking') {
      expect(think.preview.length).toBeLessThanOrEqual(48);
      expect(think.content).toBe('先核对导出再回答。');
    }
  });
});

describe('projectMessage：用户气泡', () => {
  it('用户消息只出一条 text，不编进助手 Purpose 树', () => {
    const { nodes, pendingApprovals } = projectMessage({
      id: 'u1',
      sender: 'user',
      text: '帮我看类型',
      toolCalls: [
        tc({
          id: 'should-ignore',
          name: 'read_file',
          startedAt: T0,
          arguments: JSON.stringify({ path: 'src/a.ts' }),
        }),
      ],
    });
    expect(pendingApprovals).toEqual([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({
      kind: 'text',
      id: 'u1',
      content: '帮我看类型',
      tone: 'primary',
    });
    expect(purposesOf(nodes)).toHaveLength(0);
  });
});

describe('projectPurposes：30s 窗与 inspect 合并', () => {
  it('两笔同窗 inspect 合成 1 个 Purpose', () => {
    const tools = [
      tc({
        id: 'r1',
        name: 'read_file',
        startedAt: T0,
        arguments: JSON.stringify({ path: 'src/types.ts' }),
        explanation: '核对导出类型',
      }),
      tc({
        id: 'r2',
        name: 'open_file',
        startedAt: T0 + 8_000,
        arguments: JSON.stringify({ path: 'src/index.ts' }),
        explanation: '核对导出类型',
      }),
    ];
    const purposes = projectPurposes(tools);
    expect(purposes).toHaveLength(1);
    expect(purposes[0]?.kind).toBe('purpose');
    expect(purposes[0]?.primary).toBe('核对导出类型');
    expect(purposes[0]?.actions).toHaveLength(2);
    expect(purposes[0]?.actions.map((a) => a.id)).toEqual(['r1', 'r2']);
    expect(purposes[0]?.actions[0]?.verb).toBe('已查看');
    expect(DEFAULT_PURPOSE_WINDOW_MS).toBe(30_000);
  });

  it('无 explanation 时同窗 inspect 仍合成 1 个（humanize 回退动词族）', () => {
    const purposes = projectPurposes([
      tc({
        id: 'i1',
        name: 'read_file',
        startedAt: T0,
        arguments: JSON.stringify({ path: 'a.ts' }),
      }),
      tc({
        id: 'i2',
        name: 'read_file',
        startedAt: T0 + 12_000,
        arguments: JSON.stringify({ path: 'b.ts' }),
      }),
    ]);
    expect(purposes).toHaveLength(1);
    expect(purposes[0]?.actions).toHaveLength(2);
    expect(purposes[0]?.primary).toMatch(/查看/);
  });

  it('超时 30s 外拆成两个 Purpose', () => {
    const purposes = projectPurposes([
      tc({
        id: 'r1',
        name: 'read_file',
        startedAt: T0,
        explanation: '核对导出类型',
        arguments: JSON.stringify({ path: 'a.ts' }),
      }),
      tc({
        id: 'r2',
        name: 'read_file',
        startedAt: T0 + 30_001,
        explanation: '核对导出类型',
        arguments: JSON.stringify({ path: 'b.ts' }),
      }),
    ]);
    expect(purposes).toHaveLength(2);
    expect(purposes[0]?.actions.map((a) => a.id)).toEqual(['r1']);
    expect(purposes[1]?.actions.map((a) => a.id)).toEqual(['r2']);
  });

  it('窗边界 30_000ms 仍合并', () => {
    const purposes = projectPurposes([
      tc({
        id: 'r1',
        name: 'read_file',
        startedAt: T0,
        explanation: '核对导出类型',
      }),
      tc({
        id: 'r2',
        name: 'read_file',
        startedAt: T0 + 30_000,
        explanation: '核对导出类型',
      }),
    ]);
    expect(purposes).toHaveLength(1);
    expect(purposes[0]?.actions).toHaveLength(2);
  });
});

describe('projectPurposes：无时间戳不走 30s 窗', () => {
  it('无时间戳 + 同一归一 explanation → 合成 1 个 Purpose', () => {
    const purposes = projectPurposes([
      tc({
        id: 'r1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/a.ts' }),
        explanation: '核对导出类型',
      }),
      tc({
        id: 'r2',
        name: 'run_terminal_cmd',
        arguments: JSON.stringify({ command: 'tsc --noEmit' }),
        explanation: '正在核对导出类型',
      }),
    ]);
    expect(purposes).toHaveLength(1);
    expect(purposes[0]?.primary).toBe('核对导出类型');
    expect(purposes[0]?.actions.map((a) => a.id)).toEqual(['r1', 'r2']);
  });

  it('无时间戳 + 不同 explanation → 分 Purpose', () => {
    const purposes = projectPurposes([
      tc({
        id: 'r1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/a.ts' }),
        explanation: '核对导出类型',
      }),
      tc({
        id: 'r2',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/b.ts' }),
        explanation: '阅读实现细节',
      }),
    ]);
    expect(purposes).toHaveLength(2);
    expect(purposes[0]?.actions.map((a) => a.id)).toEqual(['r1']);
    expect(purposes[1]?.actions.map((a) => a.id)).toEqual(['r2']);
    expect(purposes[0]?.primary).toBe('核对导出类型');
    expect(purposes[1]?.primary).toBe('阅读实现细节');
  });

  it('无时间戳 + 无 explanation 同动词族不合并（禁止整条合成）', () => {
    const purposes = projectPurposes([
      tc({
        id: 'i1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'a.ts' }),
      }),
      tc({
        id: 'i2',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'b.ts' }),
      }),
    ]);
    expect(purposes).toHaveLength(2);
    expect(purposes[0]?.actions.map((a) => a.id)).toEqual(['i1']);
    expect(purposes[1]?.actions.map((a) => a.id)).toEqual(['i2']);
  });
});

describe('pending_approval 不进 Purpose 树', () => {
  it('extractPendingApprovals 抽出；projectPurposes 跳过', () => {
    const tools: ProjectToolCallInput[] = [
      tc({
        id: 'r1',
        name: 'read_file',
        startedAt: T0,
        explanation: '核对导出类型',
        arguments: JSON.stringify({ path: 'a.ts' }),
      }),
      tc({
        id: 'p1',
        name: 'run_terminal_cmd',
        status: 'pending_approval',
        startedAt: T0 + 1_000,
        arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }),
        approvalMeta: { risk: 'high' },
      }),
      tc({
        id: 'r2',
        name: 'read_file',
        startedAt: T0 + 2_000,
        explanation: '核对导出类型',
        arguments: JSON.stringify({ path: 'b.ts' }),
      }),
    ];

    const pending = extractPendingApprovals(tools);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'p1',
      toolName: 'run_terminal_cmd',
      command: 'rm -rf /tmp/x',
      risk: 'high',
    });

    const purposes = projectPurposes(tools);
    expect(purposes).toHaveLength(1);
    expect(purposes[0]?.actions.map((a) => a.id)).toEqual(['r1', 'r2']);
    expect(
      purposes[0]?.actions.some((a) => a.status === 'pending_approval'),
    ).toBe(false);

    const projected = projectMessage({
      id: 'a3',
      sender: 'assistant',
      text: '需要你确认后再跑。',
      toolCalls: tools,
    });
    expect(projected.pendingApprovals).toHaveLength(1);
    expect(purposesOf(projected.nodes)).toHaveLength(1);
    expect(projected.nodes.some((n) => n.kind === 'text')).toBe(true);
  });
});

describe('包边界', () => {
  it('源码不依赖 desktop / block-paper / reference', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'),
    );
    const banned =
      /from\s+['"][^'"]*(apps\/crish-desktop|@crish\/block-paper|block-paper-contract|reference\/)/;
    for (const name of files) {
      const src = readFileSync(join(here, name), 'utf8');
      const imports = src
        .split('\n')
        .filter((line) => /^\s*import\s/.test(line))
        .join('\n');
      expect(imports, name).not.toMatch(banned);
    }
  });
});
