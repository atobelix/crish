/**
 * workflowRunner 测试（T-CF-14 前端去幽灵化）：
 * - createWorkflow 不再恒 false、listWorkflows 不再恒空——真实 invokeCmd IPC；
 * - mock invoke 断言 wire 形状（命令名 + 参数 camelCase）；
 * - delete-workflow 成功返回 null，须经 invokeResult 三态区分成败。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tauriInvoke', () => ({
  invokeCmd: vi.fn(),
  invokeResult: vi.fn(),
}));

import { invokeCmd, invokeResult } from '../tauriInvoke';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  triggerWorkflow,
  updateWorkflow,
} from './workflowRunner';

const mockedInvoke = vi.mocked(invokeCmd);
const mockedInvokeResult = vi.mocked(invokeResult);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvokeResult.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listWorkflows', () => {
  it('读真实列表：mock invoke 返回 wire 数组 → 解析为 WorkflowDefinition', async () => {
    mockedInvoke.mockResolvedValue([
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
    ]);
    const list = await listWorkflows();
    expect(mockedInvoke).toHaveBeenCalledWith('list-workflows');
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
    mockedInvoke.mockResolvedValue(null);
    const list = await listWorkflows();
    expect(list).toEqual([]);
  });

  it('非法载荷（非数组）降级空表，不抛', async () => {
    mockedInvoke.mockResolvedValue({ weird: true });
    const list = await listWorkflows();
    expect(list).toEqual([]);
  });
});

describe('createWorkflow', () => {
  it('不再恒 false：invoke 返回 { workflow } → ok:true 且带回 workflow', async () => {
    mockedInvoke.mockResolvedValue({
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
    });
    const res = await createWorkflow({
      name: '巡检',
      prompt: '巡检工作区',
      schedule: { type: 'manual' },
      enabled: true,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('create-workflow', {
      name: '巡检',
      prompt: '巡检工作区',
      schedule: { type: 'manual' },
      enabled: true,
    });
    expect(res.ok).toBe(true);
    expect(res.workflow?.id).toBe('cron-1');
  });

  it('cron 调度原样下发（表达式透传）', async () => {
    mockedInvoke.mockResolvedValue({
      workflow: {
        id: 'cron-2',
        name: 'cron 任务',
        prompt: 'x',
        enabled: true,
        schedule: { type: 'cron', expression: '0 9 * * *' },
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    });
    const res = await createWorkflow({
      name: 'cron 任务',
      prompt: 'x',
      schedule: { type: 'cron', expression: '0 9 * * *' },
    });
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create-workflow',
      expect.objectContaining({ schedule: { type: 'cron', expression: '0 9 * * *' } })
    );
    expect(res.ok).toBe(true);
  });

  it('invoke 缺失 → ok:false + 错误文案（引擎未就绪）', async () => {
    mockedInvoke.mockResolvedValue(null);
    const res = await createWorkflow({ name: 'x', prompt: 'y' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不可用');
  });
});

describe('updateWorkflow', () => {
  it('workflowId + 部分补丁走 update-workflow', async () => {
    mockedInvoke.mockResolvedValue({
      workflow: {
        id: 'cron-1',
        name: '新名',
        prompt: '旧提示',
        enabled: true,
        schedule: { type: 'manual' },
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    });
    const res = await updateWorkflow('cron-1', { name: '新名', enabled: true });
    expect(mockedInvoke).toHaveBeenCalledWith('update-workflow', {
      workflowId: 'cron-1',
      name: '新名',
      enabled: true,
    });
    expect(res.ok).toBe(true);
    expect(res.workflow?.name).toBe('新名');
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
});

describe('triggerWorkflow', () => {
  it('ok:true 且透传 runId/sessionId（引擎触发路径产出）', async () => {
    mockedInvoke.mockResolvedValue({ runId: 'run-42', sessionId: 'ses-7' });
    const res = await triggerWorkflow('cron-1');
    expect(mockedInvoke).toHaveBeenCalledWith('trigger-workflow', {
      workflowId: 'cron-1',
    });
    expect(res).toMatchObject({ ok: true, runId: 'run-42', sessionId: 'ses-7' });
  });

  it('runId 为空时仍 ok（触发已注入 steering 面）', async () => {
    mockedInvoke.mockResolvedValue({ runId: null, sessionId: null });
    const res = await triggerWorkflow('cron-1');
    expect(res.ok).toBe(true);
    expect(res.runId).toBeUndefined();
  });

  it('invoke 缺失 → ok:false', async () => {
    mockedInvoke.mockResolvedValue(null);
    const res = await triggerWorkflow('cron-1');
    expect(res.ok).toBe(false);
  });
});

describe('listWorkflowRuns', () => {
  it('读真实运行历史（可按 workflowId 过滤）', async () => {
    mockedInvoke.mockResolvedValue([
      {
        workflowId: 'cron-1',
        runId: 'cron-1-fire-1',
        sessionId: null,
        scheduledFor: '2026-08-05T00:00:00.000Z',
        startedAt: '2026-08-05T00:00:00.000Z',
        status: 'pending',
        error: null,
      },
    ]);
    const runs = await listWorkflowRuns('cron-1');
    expect(mockedInvoke).toHaveBeenCalledWith('list-workflow-runs', {
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
    mockedInvoke.mockResolvedValue([]);
    await listWorkflowRuns();
    expect(mockedInvoke).toHaveBeenCalledWith('list-workflow-runs', {});
  });
});
