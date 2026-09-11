/**
 * apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.test.ts
 *
 * 过程段度量聚合与工具动作分类纯逻辑严密单元测试。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyToolAction,
  EXACT_ACTION_TABLE,
} from './toolActionClassifier';
import {
  aggregateProcessMetrics,
  canonicalizeFsPath,
  formatSegmentSummary,
} from './processMetricsEngine';
import type { AssistantTimelineItem } from './toolPresentationTypes';

describe('toolActionClassifier（工具动作分类 SSOT）', () => {
  it('权威注册表全部登记项精准命中', () => {
    for (const [toolName, expectedKind] of Object.entries(EXACT_ACTION_TABLE)) {
      expect(classifyToolAction(toolName)).toBe(expectedKind);
    }
  });

  it('网络工具严密防误判：read_url_content 归 read，web_search 归 search', () => {
    expect(classifyToolAction('read_url_content')).toBe('read');
    expect(classifyToolAction('web_search')).toBe('search');
    expect(classifyToolAction('read_browser_page')).toBe('read');
  });

  it('写侧与删除归 edit：delete_file、trash 统一归 edit', () => {
    expect(classifyToolAction('delete_file')).toBe('edit');
    expect(classifyToolAction('delete_dir')).toBe('edit');
    expect(classifyToolAction('remove_dir')).toBe('edit');
    expect(classifyToolAction('trash')).toBe('edit');
    expect(classifyToolAction('replace_file_content')).toBe('edit');
  });

  it('空值与未知工具保守兜底', () => {
    expect(classifyToolAction('')).toBe('command');
    expect(classifyToolAction(undefined)).toBe('command');
    expect(classifyToolAction('some_custom_cli_runner')).toBe('command');
  });
});

describe('canonicalizeFsPath（路径归一化与去重）', () => {
  it('反斜杠替换为正斜杠', () => {
    expect(canonicalizeFsPath('src\\api\\tool.ts')).toBe('src/api/tool.ts');
  });

  it('Windows 盘符大小写大写归一', () => {
    expect(canonicalizeFsPath('c:/software/conex/test.ts')).toBe('C:/software/conex/test.ts');
    expect(canonicalizeFsPath('C:\\software\\conex\\test.ts')).toBe('C:/software/conex/test.ts');
  });

  it('连续斜杠折叠', () => {
    expect(canonicalizeFsPath('C:/software//conex///test.ts')).toBe('C:/software/conex/test.ts');
  });

  it('空值保护', () => {
    expect(canonicalizeFsPath(null)).toBe('');
    expect(canonicalizeFsPath(undefined)).toBe('');
    expect(canonicalizeFsPath('   ')).toBe('');
  });
});

describe('processMetricsEngine（段度量聚合与摘要生成）', () => {
  it('正确统计并去重读写文件、搜索与命令执行', () => {
    const timelineItems: AssistantTimelineItem[] = [
      {
        id: 'item-1',
        kind: 'tools',
        items: [
          {
            kind: 'single',
            tc: {
              id: 't1',
              name: 'view_file',
              status: 'success',
              args: { AbsolutePath: 'c:/Software/conex/src/index.ts' },
            },
          },
          {
            kind: 'single',
            tc: {
              id: 't2',
              name: 'read_file',
              status: 'success',
              args: { path: 'C:\\Software\\conex\\src\\index.ts' }, // 相同文件不同表达
            },
          },
          {
            kind: 'single',
            tc: {
              id: 't3',
              name: 'write_to_file',
              status: 'success',
              args: { TargetFile: 'c:\\Software\\conex\\src\\app.tsx' },
            },
          },
          {
            kind: 'single',
            tc: {
              id: 't4',
              name: 'grep_search',
              status: 'success',
              args: { Query: 'test' },
            },
          },
          {
            kind: 'single',
            tc: {
              id: 't5',
              name: 'run_command',
              status: 'success',
              args: { CommandLine: 'npm test' },
            },
          },
        ],
      },
    ];

    const metrics = aggregateProcessMetrics(timelineItems);
    expect(metrics.toolCount).toBe(5);
    expect(metrics.readFilesCount).toBe(1); // 去重后仅 1 个文件
    expect(metrics.editFilesCount).toBe(1);
    expect(metrics.searchCount).toBe(1);
    expect(metrics.commandCount).toBe(1);
    expect(metrics.leadAction).toBe('edit');

    const summary = formatSegmentSummary(metrics);
    expect(summary).toBeTruthy();
    expect(summary).toContain('已编辑 1 个文件');
    expect(summary).toContain('已读取 1 个文件');
  });

  it('空步骤安全兜底为默认度量', () => {
    const metrics = aggregateProcessMetrics([]);
    expect(metrics.toolCount).toBe(0);
    expect(metrics.leadAction).toBe('mixed');
    expect(formatSegmentSummary(metrics)).toBe('中间处理过程');
  });
});
