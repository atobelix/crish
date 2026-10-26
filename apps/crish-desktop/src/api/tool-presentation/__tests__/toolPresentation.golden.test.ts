/**
 * P5 T-P5-10 · ToolPresentation SSOT 25 种工具黄金用例与 5 大去重规则契约测试。
 */

import { describe, expect, it } from 'vitest';
import type { FileDiff, MessageToolCall } from '../../../store/types';
import {
  buildToolPresentation,
  resolveToolPresentation,
  TOOL_PRESENTATION_REGISTRY,
} from '../toolPresentationModel';

describe('ToolPresentation SSOT 黄金用例契约', () => {
  it('真实复现 1：列出目录 crates 完全去重，渲染文本零重复子串', () => {
    const tc: MessageToolCall = {
      id: 'tc-1',
      name: 'list_dir',
      arguments: JSON.stringify({ path: 'crates' }),
      status: 'success',
    };
    const pres = resolveToolPresentation(tc, '列出目录 crates');
    expect(pres.label).toBe('列出目录 crates');
    expect(pres.target).toBeUndefined();
    expect(pres.iconName).toBe('folder-01');
  });

  it('真实复现 2：搜索「pub async fn run」消解 Grep 冗余', () => {
    const tc: MessageToolCall = {
      id: 'tc-2',
      name: 'grep_search',
      arguments: JSON.stringify({ query: 'pub async fn run' }),
      status: 'success',
    };
    const pres = resolveToolPresentation(tc, '搜索「pub async fn run」');
    expect(pres.label).toBe('搜索「pub async fn run」');
    expect(pres.target).toBeUndefined();
    expect(pres.iconName).toBe('search-01');
  });

  it('真实复现 3：写入 inventory.json 携带 diff 且消解修改动词', () => {
    const tc: MessageToolCall = {
      id: 'tc-3',
      name: 'multi_replace_file_content',
      arguments: JSON.stringify({ target_file: 'inventory.json' }),
      diffs: [{ add: 32, del: 0 } as unknown as FileDiff],
      status: 'success',
    };
    const pres = resolveToolPresentation(tc, '写入 inventory.json');
    expect(pres.label).toBe('写入 inventory.json');
    expect(pres.target).toBeUndefined();
    expect(pres.meta).toHaveLength(1);
    expect(pres.meta[0]!.text).toBe('+32 -0');
  });

  it('未包含对象的意图：正确保留独立 target', () => {
    const tc: MessageToolCall = {
      id: 'tc-4',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/main.rs' }),
      status: 'success',
    };
    const pres = resolveToolPresentation(tc, '读取核心入口');
    expect(pres.label).toBe('读取核心入口');
    expect(pres.target).toEqual({
      text: 'main.rs',
      kind: 'path',
      clickable: true,
      tooltip: 'src/main.rs',
    });
  });

  it('25 种工具黄金用例全量覆盖且渲染文本零重复子串', () => {
    expect(Object.keys(TOOL_PRESENTATION_REGISTRY)).toHaveLength(25);

    const goldenCases: Array<{
      name: string;
      args: Record<string, unknown>;
      exp: string;
      output?: string;
      diffs?: unknown[];
      expectedLabel: string;
      expectedTargetText?: string;
      expectedMetaText?: string;
    }> = [
      {
        name: 'list_dir',
        args: { path: 'crates' },
        exp: '列出目录 crates',
        expectedLabel: '列出目录 crates',
        expectedTargetText: undefined,
      },
      {
        name: 'grep_search',
        args: { query: 'pub async fn run' },
        exp: '搜索「pub async fn run」',
        expectedLabel: '搜索「pub async fn run」',
        expectedTargetText: undefined,
      },
      {
        name: 'multi_replace_file_content',
        args: { target_file: 'inventory.json' },
        exp: '写入 inventory.json',
        diffs: [{ add: 32, del: 0 }],
        expectedLabel: '写入 inventory.json',
        expectedTargetText: undefined,
        expectedMetaText: '+32 -0',
      },
      {
        name: 'read_file',
        args: { path: 'src/main.rs' },
        exp: '读取入口代码',
        expectedLabel: '读取入口代码',
        expectedTargetText: 'main.rs',
      },
      {
        name: 'write_file',
        args: { path: 'config.json' },
        exp: '',
        expectedLabel: '写入文件',
        expectedTargetText: 'config.json',
      },
      {
        name: 'run_command',
        args: { CommandLine: 'cargo test' },
        exp: '运行自动化测试',
        expectedLabel: '运行自动化测试',
        expectedTargetText: 'cargo test',
      },
      {
        name: 'file_stat',
        args: { path: 'large.bin' },
        exp: '',
        output: '12.4 MB',
        expectedLabel: '查看文件属性',
        expectedTargetText: 'large.bin',
        expectedMetaText: '12.4 MB',
      },
      {
        name: 'fuzzy_find',
        args: { pattern: '*.rs' },
        exp: '查找 Rust 源码',
        expectedLabel: '查找 Rust 源码',
        expectedTargetText: undefined,
      },
      {
        name: 'diff_text',
        args: { path: 'a.txt' },
        exp: '',
        expectedLabel: '差异对比',
        expectedTargetText: 'a.txt',
      },
      {
        name: 'delete_file',
        args: { path: 'temp.log' },
        exp: '删除临时文件 temp.log',
        expectedLabel: '删除临时文件 temp.log',
        expectedTargetText: undefined,
      },
      {
        name: 'delete_dir',
        args: { path: 'dist' },
        exp: '',
        expectedLabel: '删除目录',
        expectedTargetText: 'dist',
      },
      {
        name: 'run_subagent',
        args: { prompt: '代码审计' },
        exp: '启动子代理进行代码审计',
        expectedLabel: '启动子代理进行代码审计',
        expectedTargetText: undefined,
      },
      {
        name: 'wait_subagents',
        args: { task_ids: ['t-1'] },
        exp: '',
        expectedLabel: '等待子代理',
        expectedTargetText: '1 个任务',
      },
      {
        name: 'kill_subagent',
        args: { task_id: 't-1' },
        exp: '',
        expectedLabel: '终止子代理',
        expectedTargetText: 't-1',
      },
      {
        name: 'send_message',
        args: { recipient: 't-1' },
        exp: '',
        expectedLabel: '向子代理发送消息',
        expectedTargetText: 't-1',
      },
      {
        name: 'set_timer',
        args: { duration_seconds: 100 },
        exp: '设置 100 秒提醒',
        expectedLabel: '设置 100 秒提醒',
        expectedTargetText: undefined,
      },
      {
        name: 'cancel_timer',
        args: { timer_id: 'tm-1' },
        exp: '',
        expectedLabel: '取消定时器',
        expectedTargetText: 'tm-1',
      },
      {
        name: 'create_workflow',
        args: { cron: '0 9 * * *' },
        exp: '注册每日早报工作流',
        expectedLabel: '注册每日早报工作流',
        expectedTargetText: undefined,
      },
      {
        name: 'resolve_output_dir',
        args: { folder: 'docs' },
        exp: '',
        expectedLabel: '解析产出目录',
        expectedTargetText: 'docs',
      },
      {
        name: 'project_tree',
        args: { max_depth: 3 },
        exp: '生成工程结构树',
        expectedLabel: '生成工程结构树',
        expectedTargetText: undefined,
      },
      {
        name: 'search_context',
        args: { query: 'auth' },
        exp: '检索压缩记忆',
        expectedLabel: '检索压缩记忆',
        expectedTargetText: 'auth',
      },
      {
        name: 'decompress_context',
        args: { block_id: 'b-1' },
        exp: '',
        expectedLabel: '还原记忆原文',
        expectedTargetText: 'b-1',
      },
      {
        name: 'note_query_blocks',
        args: { keyword: '规范' },
        exp: '查询笔记区块',
        expectedLabel: '查询笔记区块',
        expectedTargetText: '规范',
      },
      {
        name: 'read_url_content',
        args: { url: 'https://docs.rs' },
        exp: '查阅官方文档',
        expectedLabel: '查阅官方文档',
        expectedTargetText: 'docs.rs',
      },
      {
        name: 'call_mcp_tool',
        args: { server: 'git', tool: 'diff' },
        exp: '',
        expectedLabel: 'MCP [git:diff]',
        expectedTargetText: undefined,
      },
    ];

    expect(goldenCases).toHaveLength(25);

    for (const [idx, c] of goldenCases.entries()) {
      const tc: MessageToolCall = {
        id: `golden-${idx}`,
        name: c.name,
        arguments: JSON.stringify(c.args),
        status: 'success',
        ...(c.output !== undefined ? { output: c.output } : {}),
        ...(c.diffs !== undefined ? { diffs: c.diffs as FileDiff[] } : {}),
      };
      const pres = buildToolPresentation(tc, c.exp);
      expect(pres.label, `tool #${idx + 1} (${c.name}) label`).toBe(
        c.expectedLabel
      );
      expect(pres.target?.text, `tool #${idx + 1} (${c.name}) target`).toBe(
        c.expectedTargetText
      );
      if (c.expectedMetaText) {
        expect(pres.meta.map((m) => m.text)).toContain(c.expectedMetaText);
      }
      // 刚性不变量：当 target 存在时，label 绝不重复包含 target.text
      if (pres.target?.text && pres.target.text !== '.') {
        const cleanTarget = pres.target.text.replace(
          /^["'「『]+|["'」』]+$/g,
          ''
        );
        expect(pres.label.toLowerCase()).not.toContain(
          cleanTarget.toLowerCase()
        );
      }
    }
  });

  it('未识别工具退化至 misc 兜底并安全提取 target', () => {
    const tc: MessageToolCall = {
      id: 'tc-unknown',
      name: 'unknown_tool_xyz',
      arguments: JSON.stringify({ path: 'packages/core/index.ts', extra: 1 }),
      status: 'success',
    };
    const pres = resolveToolPresentation(tc, '');
    expect(pres.kind).toBe('misc');
    expect(pres.label).toBe('调用工具');
    expect(pres.iconName).toBe('wrench');
    expect(pres.target).toEqual({
      text: 'index.ts',
      kind: 'path',
      clickable: true,
      tooltip: 'packages/core/index.ts',
    });

    const tcKv: MessageToolCall = {
      id: 'tc-unknown-kv',
      name: 'unknown_tool_xyz',
      arguments: JSON.stringify({ customKey: 'alpha-value' }),
      status: 'success',
    };
    const presKv = resolveToolPresentation(tcKv, '');
    expect(presKv.label).toBe('调用工具');
    expect(presKv.target?.text).toBe('customkey: alpha-value');
  });

  it('失败态工具调用优先提取第一行错误输出并截断 60 字符', () => {
    const longError =
      '[ERROR] [fs_error] Permission denied when opening protected configuration file at /etc/restricted/secret.conf';
    const tc: MessageToolCall = {
      id: 'tc-err',
      name: 'read_file',
      arguments: JSON.stringify({ path: '/etc/restricted/secret.conf' }),
      output: `${longError}\n  at readFileSync (node:fs:450:3)`,
      status: 'error',
    };
    const pres = resolveToolPresentation(tc, '读取受保护配置');
    expect(pres.status).toBe('error');
    expect(pres.label).toBe('读取受保护配置');
    expect(pres.target).toBeDefined();
    expect(pres.target!.kind).toBe('text');
    expect(pres.target!.clickable).toBe(false);
    expect(pres.target!.text.startsWith('[')).toBe(false);
    expect(pres.target!.text.length).toBeLessThanOrEqual(61); // 60 字符 + '…'
  });

  it('元数据预算截断：严格按照 Diff > 次要量度 > 耗时 优先级保留最多 2 项', () => {
    const tc: MessageToolCall = {
      id: 'tc-meta',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/app.tsx' }),
      output:
        'path: src/app.tsx\nlines: 240\nstartLine: 1, endLine: 80\n---\nconst a = 1;',
      diffs: [
        { additions: 12, deletions: 4, filePath: 'src/app.tsx', changes: [] },
      ],
      durationMs: 450,
      status: 'success',
    };
    const pres = resolveToolPresentation(tc, '');
    expect(pres.meta).toHaveLength(2);
    expect(pres.meta[0]!.type).toBe('diff');
    expect(pres.meta[0]!.text).toBe('+12 -4');
    expect(pres.meta[1]!.type).toBe('metric');
    expect(pres.meta[1]!.text).toBe('L1–80 / 240 行');
  });
});
