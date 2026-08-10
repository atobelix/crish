/**
 * workflowRunner 测试（T-CF-14 前端去幽灵化 + 14-T4 错误透传）：
 * - createWorkflow 不再恒 false、listWorkflows 不再恒空——真实 invoke IPC；
 * - mock invoke 断言 wire 形状（命令名 + 参数 camelCase）；
 * - create / update / trigger / list* 走 invokeTyped 三态：missing 未就绪文案、
 *   error 透传原始 message + kind、成功路径形状不变；
 * - delete-workflow 成功返回 null，须经 invokeResult 三态区分成败。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tauriInvoke', () => ({
  invokeResult: vi.fn(),
  invokeTyped: vi.fn(),
}));

import { invokeResult, invokeTyped } from '../tauriInvoke';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  triggerWorkflow,
  updateWorkflow,
} from './workflowRunner';

const mockedInvokeResult = vi.mocked(invokeResult);
const mockedInvokeTyped = vi.mocked(invokeTyped);

beforeEach(() => {
  mockedInvokeResult.mockReset();
  mockedInvokeTyped.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listWorkflows', () => {
  it('读真实列表：mock invoke 返回 wire 数组 → 解析为 WorkflowDefinition', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'cron-0',
          name: '每日检查',
          prompt: '检查仓库状态',
          enabled: true,
          schedule: { type: 'daily', time: '09:30', timezone: 'Asia/Shanghai' },
          createdAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
          nextRunAt: '2026-08-06T01:30:00.000Z',
          lastRunAt: null,
        },
      ],
    });
    const list = await listWorkflows();
    expect(mockedInvokeTyped).toHaveBeenCalledWith('list-workflows');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'cron-0',
      name: '每日检查',
      prompt: '检查仓库状态',
      enabled: true,
      schedule: { type: 'daily', time: '09:30', timezone: 'Asia/Shanghai' },
    });
  });

  it('不再恒空：invoke 缺失时降级空表（旧恒空语义兼容）', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'missing' });
    const list = await listWorkflows();
    expect(list).toEqual([]);
  });

  it('非法载荷（非数组）降级空表，不抛', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'ok', data: { weird: true } });
    const list = await listWorkflows();
    expect(list).toEqual([]);
  });
});

describe('createWorkflow', () => {
  it('不再恒 false：invoke 返回 ok 态 { workflow } → ok:true 且带回 workflow', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: {
        workflow: {
          id: 'cron-1',
          name: '巡检',
          prompt: '巡检工作区',
          enabled: true,
          schedule: { type: 'manual' },
          createdAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
          nextRunAt: null,
          lastRunAt: null,
        },
      },
    });
    const res = await createWorkflow({
      name: '巡检',
      prompt: '巡检工作区',
      schedule: { type: 'manual' },
      enabled: true,
    });
    expect(mockedInvokeTyped).toHaveBeenCalledWith('create-workflow', {
      name: '巡检',
      prompt: '巡检工作区',
      schedule: { type: 'manual' },
      enabled: true,
    });
    expect(res.ok).toBe(true);
    expect(res.workflow?.id).toBe('cron-1');
  });

  it('cron 调度原样下发（表达式透传）', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: {
        workflow: {
          id: 'cron-2',
          name: 'cron 任务',
          prompt: 'x',
          enabled: true,
          schedule: { type: 'cron', expression: '0 9 * * *' },
          createdAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
        },
      },
    });
    const res = await createWorkflow({
      name: 'cron 任务',
      prompt: 'x',
      schedule: { type: 'cron', expression: '0 9 * * *' },
    });
    expect(mockedInvokeTyped).toHaveBeenCalledWith(
      'create-workflow',
      expect.objectContaining({ schedule: { type: 'cron', expression: '0 9 * * *' } })
    );
    expect(res.ok).toBe(true);
  });

  it('missing 态 → ok:false + 不可用文案（引擎未就绪）', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'missing' });
    const res = await createWorkflow({ name: 'x', prompt: 'y' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不可用');
    expect(res.kind).toBeUndefined();
  });

  it('error 态 → 透传原始 message + kind，不再折叠为「命令不可用」', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'error',
      kind: 'InvalidInput',
      message: 'cron 表达式非法：分/时字段越界',
    });
    const res = await createWorkflow({ name: 'x', prompt: 'y' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cron 表达式非法：分/时字段越界');
    expect(res.error).not.toContain('不可用');
    expect(res.kind).toBe('InvalidInput');
  });
});

describe('updateWorkflow', () => {
  it('workflowId + 部分补丁走 update-workflow（ok 态成功）', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: {
        workflow: {
          id: 'cron-1',
          name: '新名',
          prompt: '旧提示',
          enabled: true,
          schedule: { type: 'manual' },
          createdAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
        },
      },
    });
    const res = await updateWorkflow('cron-1', { name: '新名', enabled: true });
    expect(mockedInvokeTyped).toHaveBeenCalledWith('update-workflow', {
      workflowId: 'cron-1',
      name: '新名',
      enabled: true,
    });
    expect(res.ok).toBe(true);
    expect(res.workflow?.name).toBe('新名');
  });

  it('error 态 → 透传原始 message + kind（重名/非法调度不再显示为不可用）', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'error',
      kind: 'InvalidInput',
      message: 'workflow 名称与已有任务重复',
    });
    const res = await updateWorkflow('cron-1', { name: '重名任务' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('workflow 名称与已有任务重复');
    expect(res.error).not.toContain('不可用');
    expect(res.kind).toBe('InvalidInput');
  });
});

describe('deleteWorkflow', () => {
  it('成功（Rust 返回 null）经 invokeResult 三态 → ok:true', async () => {
    mockedInvokeResult.mockResolvedValue({ status: 'ok', data: null });
    const res = await deleteWorkflow('cron-1');
    expect(mockedInvokeResult).toHaveBeenCalledWith('delete-workflow', {
      workflowId: 'cron-1',
    });
    expect(res).toEqual({ ok: true });
  });

  it('命令缺失 → ok:false + 不可用文案', async () => {
    mockedInvokeResult.mockResolvedValue({ status: 'missing' });
    const res = await deleteWorkflow('cron-1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不可用');
  });

  it('error 态 → ok:false + 透传原始 message（示范模式核对）', async () => {
    mockedInvokeResult.mockResolvedValue({
      status: 'error',
      message: '该任务正在运行，无法删除',
    });
    const res = await deleteWorkflow('cron-1');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('该任务正在运行，无法删除');
  });
});

describe('triggerWorkflow', () => {
  it('ok 态：透传 runId/sessionId（引擎触发路径产出），成功路径形状不变', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: { runId: 'run-42', sessionId: 'ses-7' },
    });
    const res = await triggerWorkflow('cron-1');
    expect(mockedInvokeTyped).toHaveBeenCalledWith('trigger-workflow', {
      workflowId: 'cron-1',
    });
    expect(res).toMatchObject({ ok: true, runId: 'run-42', sessionId: 'ses-7' });
  });

  it('runId 为空时仍 ok（触发已注入 steering 面）', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: { runId: null, sessionId: null },
    });
    const res = await triggerWorkflow('cron-1');
    expect(res.ok).toBe(true);
    expect(res.runId).toBeUndefined();
  });

  it('missing 态 → ok:false + 不可用文案', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'missing' });
    const res = await triggerWorkflow('cron-1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不可用');
  });

  it('error 态 → 透传原始 message + kind，且不带 runId/sessionId', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'error',
      kind: 'NotFound',
      message: '未找到 cron-404 对应的任务',
    });
    const res = await triggerWorkflow('cron-404');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('未找到 cron-404 对应的任务');
    expect(res.error).not.toContain('不可用');
    expect(res.kind).toBe('NotFound');
    expect(res.runId).toBeUndefined();
    expect(res.sessionId).toBeUndefined();
  });
});

describe('listWorkflowRuns', () => {
  it('读真实运行历史（可按 workflowId 过滤）', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: [
        {
          workflowId: 'cron-1',
          runId: 'cron-1-fire-1',
          sessionId: null,
          scheduledFor: '2026-08-05T00:00:00.000Z',
          startedAt: '2026-08-05T00:00:00.000Z',
          status: 'pending',
          error: null,
        },
      ],
    });
    const runs = await listWorkflowRuns('cron-1');
    expect(mockedInvokeTyped).toHaveBeenCalledWith('list-workflow-runs', {
      workflowId: 'cron-1',
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      workflowId: 'cron-1',
      runId: 'cron-1-fire-1',
      status: 'pending',
    });
  });

  it('不带过滤参数时不下发 workflowId', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'ok', data: [] });
    await listWorkflowRuns();
    expect(mockedInvokeTyped).toHaveBeenCalledWith('list-workflow-runs', {});
  });
});
