/**
 * apps/crish-desktop/src/components/chat-tool-call/__tests__/toolActionResolvers.test.ts
 *
 * 工具调用人性化自然语言动作解析、文件行号超链接与防裸奔 JSON 专门测试
 */

import { describe, it, expect } from 'vitest';
import type { MessageToolCall } from '../../../store/types';
import {
  sanitizeParamText,
  resolveReadFileLineRange,
  formatReadFileParam,
  resolveToolActionAndParam,
  resolveToolSecondaryMeta,
} from '../toolHeaderPresentation';

describe('toolActionResolvers (自然语言意图提炼与防裸奔)', () => {
  describe('任务管理命令人性化 (manage_task)', () => {
    it('精确解析 manage_task: status 为 查看任务状态，参数为 taskId', () => {
      const tc: MessageToolCall = {
        id: 'tc-status',
        name: 'manage_task',
        arguments: JSON.stringify({ action: 'status', taskId: 'task-3' }),
        status: 'running',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('正在查看任务状态');
      expect(res.paramText).toBe('task-3');
      expect(res.isPath).toBe(false);
    });

    it('精确解析 manage_task: read_log 终态为 已读取任务日志，参数为 taskId', () => {
      const tc: MessageToolCall = {
        id: 'tc-log',
        name: 'manage_task',
        arguments: JSON.stringify({
          action: 'read_log',
          taskId: 'task-3',
          maxLines: 25,
        }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已读取任务日志');
      expect(res.paramText).toBe('task-3');
    });

    it('精确解析 manage_task: kill 为 终止任务，参数为 taskId', () => {
      const tc: MessageToolCall = {
        id: 'tc-kill',
        name: 'manage_task',
        arguments: JSON.stringify({ action: 'kill', taskId: 'task-3' }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已终止任务');
      expect(res.paramText).toBe('task-3');
    });

    it('精确解析 manage_task: send_input 为 发送任务输入，参数为 taskId', () => {
      const tc: MessageToolCall = {
        id: 'tc-input',
        name: 'manage_task',
        arguments: JSON.stringify({
          action: 'send_input',
          taskId: 'task-3',
          input: 'yes',
        }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已发送任务输入');
      expect(res.paramText).toBe('task-3');
    });

    it('精确解析 manage_task: list 为 查看任务列表，参数为空', () => {
      const tc: MessageToolCall = {
        id: 'tc-list',
        name: 'manage_task',
        arguments: JSON.stringify({ action: 'list' }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已查看任务列表');
      expect(res.paramText).toBe('');
    });
  });

  describe('定时调度类解析 (schedule)', () => {
    it('解析 schedule 时长参数为 "100 秒"', () => {
      const tc: MessageToolCall = {
        id: 'tc-schedule',
        name: 'schedule',
        arguments: JSON.stringify({ DurationSeconds: 100, Prompt: '定期汇报' }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已设置定时器');
      expect(res.paramText).toBe('100 秒');
    });

    it('解析 cancel_timer 为 取消定时器', () => {
      const tc: MessageToolCall = {
        id: 'tc-cancel',
        name: 'cancel_timer',
        arguments: JSON.stringify({ timerId: 'timer-42' }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已取消定时器');
      expect(res.paramText).toBe('timer-42');
    });
  });

  describe('市场与子任务解析', () => {
    it('解析 search_marketplace', () => {
      const tc: MessageToolCall = {
        id: 'tc-market',
        name: 'search_marketplace',
        arguments: JSON.stringify({ queries: ['git', 'github'] }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已搜索插件市场');
      expect(res.paramText).toBe('"git, github"');
    });

    it('解析 invoke_subagent', () => {
      const tc: MessageToolCall = {
        id: 'tc-agent',
        name: 'invoke_subagent',
        arguments: JSON.stringify({
          Role: 'Code Reviewer',
          Prompt: '评审代码',
        }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已派发子任务');
      expect(res.paramText).toBe('Code Reviewer');
    });
  });

  describe('sanitizeParamText (防原始 JSON 裸奔安全阀)', () => {
    it('过滤各种对象、数组及空 JSON 符号', () => {
      expect(sanitizeParamText('{"foo":"bar"}')).toBe('');
      expect(sanitizeParamText('   {"action":"status"}   ')).toBe('');
      expect(sanitizeParamText('[1, 2, 3]')).toBe('');
      expect(sanitizeParamText('{}')).toBe('');
      expect(sanitizeParamText('[]')).toBe('');
      expect(sanitizeParamText('task-3')).toBe('task-3');
    });
  });

  describe('resolveReadFileLineRange & formatReadFileParam (行号合并与总行数格式化)', () => {
    it('从 output 中精准提取行区间并拼接文件名', () => {
      const tc: MessageToolCall = {
        id: 'tc-read-1',
        name: 'read_file',
        arguments: JSON.stringify({ Path: 'src/LeafDockResizer.test.tsx' }),
        output:
          'path: src/LeafDockResizer.test.tsx\nlines: 415\nstartLine: 1, endLine: 240\n---\nconst x = 1;',
        status: 'success',
      };
      const range = resolveReadFileLineRange(tc);
      expect(range).not.toBeNull();
      expect(range?.rangeStr).toBe('1-240');

      const formatted = formatReadFileParam('LeafDockResizer.test.tsx', range);
      expect(formatted).toBe('LeafDockResizer.test.tsx:1-240');
    });

    it('当无区间时仅返回文件名本身', () => {
      const formatted = formatReadFileParam('index.ts', null);
      expect(formatted).toBe('index.ts');
    });
  });

  describe('resolveToolActionAndParam 整体端到端时态与呈现', () => {
    it('针对 manage_task status 成功状态呈现已查看任务状态与 taskId，零 JSON 裸奔', () => {
      const tc: MessageToolCall = {
        id: 'tc-task-status',
        name: 'manage_task',
        arguments: JSON.stringify({ action: 'status', taskId: 'task-3' }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已查看任务状态');
      expect(res.paramText).toBe('task-3');
    });

    it('针对 manage_task kill 成功状态呈现已终止任务与 taskId', () => {
      const tc: MessageToolCall = {
        id: 'tc-task-kill',
        name: 'manage_task',
        arguments: JSON.stringify({ action: 'kill', taskId: 'task-3' }),
        status: 'success',
      };
      const res = resolveToolActionAndParam(tc, '');
      expect(res.actionText).toBe('已终止任务');
      expect(res.paramText).toBe('task-3');
    });

    it('针对文件读取类：超链接合并行号区间，次要指标呈现纯净总行数', () => {
      const tc: MessageToolCall = {
        id: 'tc-read-range',
        name: 'read_file',
        arguments: JSON.stringify({
          Path: 'apps/crish-desktop/src/LeafDockResizer.test.tsx',
          StartLine: 1,
          EndLine: 240,
        }),
        output:
          'path: apps/crish-desktop/src/LeafDockResizer.test.tsx\nlines: 415\nstartLine: 1, endLine: 240\n---\nconst a = 1;',
        status: 'success',
      };
      const action = resolveToolActionAndParam(
        tc,
        '',
        'apps/crish-desktop/src/LeafDockResizer.test.tsx'
      );
      expect(action.actionText).toBe('已读取');
      expect(action.paramText).toBe('LeafDockResizer.test.tsx:1-240');
      expect(action.isPath).toBe(true);

      const meta = resolveToolSecondaryMeta(tc);
      expect(meta).toBe('共 415 行');
    });

    it('针对全量文件读取：次要指标呈现 214 行，无 "共" 冗余字样', () => {
      const tc: MessageToolCall = {
        id: 'tc-read-full',
        name: 'read_file',
        arguments: JSON.stringify({
          Path: 'apps/crish-desktop/src/useLocalProviderEditVm.ts',
        }),
        output:
          'path: apps/crish-desktop/src/useLocalProviderEditVm.ts\nlines: 214\n---\nexport const x = 1;',
        status: 'success',
      };
      const action = resolveToolActionAndParam(
        tc,
        '',
        'apps/crish-desktop/src/useLocalProviderEditVm.ts'
      );
      expect(action.actionText).toBe('已读取');
      expect(action.paramText).toBe('useLocalProviderEditVm.ts');

      const meta = resolveToolSecondaryMeta(tc);
      expect(meta).toBe('214 行');
    });
  });
});
