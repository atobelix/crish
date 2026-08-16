/**
 * 跨层契约测试：审批 UI 链路（审计建议补全）。
 *
 * 链路：工具 requires_approval → approval-requested 事件 → 前端状态机挂起
 * → 用户 approve/deny（engineApproveTool/engineDenyTool 直发）→
 * approval-resolved 事件 → 工具放行重试（tool-end 收尾）。
 *
 * 层：真实 EventRouter + 真实 ApprovalFlowMachine + 真实 engineApproveTool /
 * engineDenyTool，仅 mock transport（getTransport().send 直发
 * core_approve_tool / core_deny_tool）。TS 侧 mock 即可，不需要真 Rust 引擎。
 *
 * 断言：事件顺序（mock.invocationCallOrder）与状态机快照流转。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventRouter } from './EventRouter';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { engineApproveTool, engineDenyTool } from './ApprovalHandler';
import type { StreamState } from './handlers/streamState';
import type { StreamCallbacks } from '../chatApi';
import { usePermissionStore } from '../../store/permissionStore';

const { fakeTransport } = vi.hoisted(() => {
  const fakeTransport = {
    send: vi.fn(async () => undefined),
  };
  return { fakeTransport };
});

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
}));

const RUN_ID = 'run-contract';

function makeEnv() {
  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
  const callbacks: StreamCallbacks = {
    onChunk: vi.fn(),
    onThought: vi.fn(),
    onComplete: vi.fn(),
    onToolStart: vi.fn(),
    onToolSuccess: vi.fn(),
    onToolError: vi.fn(),
    onToolPendingApproval: vi.fn(),
    onApprovalResolved: vi.fn(),
  };
  const finish = vi.fn();
  const tryResumeFinish = vi.fn();
  const approvalFlow = new ApprovalFlowMachine();
  const router = new EventRouter(
    state,
    approvalFlow,
    callbacks,
    RUN_ID,
    finish,
    tryResumeFinish,
    fakeTransport,
    'session-contract'
  );
  return { router, state, callbacks, approvalFlow, finish, tryResumeFinish };
}

// 平铺事件形状（与 daemon IPC 对齐：顶层 type/runId/sequence + 载荷字段）
const toolStartEvent = (id: string) => ({
  type: 'tool-start',
  runId: RUN_ID,
  sequence: 1,
  id,
  name: 'shell_command',
});

const approvalRequestedEvent = (id: string, command: string) => ({
  type: 'approval-requested',
  runId: RUN_ID,
  sequence: 2,
  request: {
    toolCallId: id,
    toolName: 'shell_command',
    parameters: { command },
    summary: '运行命令',
  },
});

const approvalResolvedEvent = (id: string, decision: string, sequence = 3) => ({
  type: 'approval-resolved',
  runId: RUN_ID,
  sequence,
  toolCallId: id,
  decision,
});

const toolEndEvent = (id: string, output = 'ok') => ({
  type: 'tool-end',
  runId: RUN_ID,
  sequence: 4,
  toolCallId: id,
  output,
});

const runTerminalEvent = () => ({
  type: 'run-terminal',
  runId: RUN_ID,
  sequence: 9,
  terminal: 'completed',
});

beforeEach(() => {
  fakeTransport.send.mockReset();
  usePermissionStore.setState({
    permissionMode: 'ask',
    planModeEnabled: false,
    commandPermissions: [],
  });
});

describe('审批链路契约：工具 requires_approval → 挂起 → 用户裁决 → 放行/拒绝', () => {
  it('允许全链路：approval-requested 挂起 → approve → approval-resolved → tool-end 放行完成', async () => {
    const { router, callbacks, approvalFlow } = makeEnv();

    // 1. 工具开始执行（首 try）
    router.onMsg(toolStartEvent('tc-1'));
    expect(approvalFlow.snapshot().inflightCount).toBe(1);

    // 2. 工具 requires_approval → approval-requested → 状态机挂起
    router.onMsg(approvalRequestedEvent('tc-1', 'node build.js'));
    expect(approvalFlow.snapshot().pendingCount).toBe(1);
    expect(approvalFlow.hasPending()).toBe(true);
    expect(approvalFlow.shouldBlockTerminal()).toBe(true);
    expect(callbacks.onToolPendingApproval).toHaveBeenCalledWith(
      'tc-1',
      'shell_command',
      'node build.js',
      '运行命令',
      expect.any(Object)
    );

    // 3. 用户 approve → transport 直发 core_approve_tool
    await engineApproveTool('tc-1');
    expect(fakeTransport.send).toHaveBeenCalledWith('core_approve_tool', {
      toolCallId: 'tc-1',
      scope: 'project',
    });

    // 4. approval-resolved（放行）→ pending 清除、inflight 保留（工具继续跑）
    router.onMsg(approvalResolvedEvent('tc-1', 'approved'));
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    expect(approvalFlow.snapshot().inflightCount).toBe(1);
    expect(approvalFlow.shouldBlockTerminal()).toBe(true);
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-1', 'allow');

    // 5. tool-end：放行后工具执行完成（重试收尾）
    router.onMsg(toolEndEvent('tc-1'));
    expect(approvalFlow.snapshot().inflightCount).toBe(0);
    expect(approvalFlow.shouldBlockTerminal()).toBe(false);
    expect(callbacks.onToolSuccess).toHaveBeenCalledWith(
      'tc-1',
      'ok',
      undefined
    );

    // 6. 事件顺序契约：start → pending → approve 命令 → resolved → 工具完成
    const order = [
      callbacks.onToolStart.mock.invocationCallOrder[0],
      callbacks.onToolPendingApproval.mock.invocationCallOrder[0],
      fakeTransport.send.mock.invocationCallOrder[0],
      callbacks.onApprovalResolved.mock.invocationCallOrder[0],
      callbacks.onToolSuccess.mock.invocationCallOrder[0],
    ];
    expect(order.every((n) => Number.isFinite(n))).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('拒绝全链路：deny → approval-resolved denied → pending+inflight 同步摘除，工具不执行', async () => {
    const { router, callbacks, approvalFlow } = makeEnv();

    router.onMsg(toolStartEvent('tc-2'));
    router.onMsg(approvalRequestedEvent('tc-2', 'node build.js'));
    expect(approvalFlow.shouldBlockTerminal()).toBe(true);

    // 用户拒绝 → transport 直发 core_deny_tool
    await engineDenyTool('tc-2');
    expect(fakeTransport.send).toHaveBeenCalledWith('core_deny_tool', {
      toolCallId: 'tc-2',
    });

    // approval-resolved（拒绝）→ 清 pending 并摘 inflight（该工具不会执行）
    router.onMsg(approvalResolvedEvent('tc-2', 'denied'));
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-2', 'deny');
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    expect(approvalFlow.snapshot().inflightCount).toBe(0);
    expect(approvalFlow.shouldBlockTerminal()).toBe(false);
    expect(callbacks.onToolSuccess).not.toHaveBeenCalled();
  });

  it('approval-resolved decision=expired 视同拒绝（审批超时按拒绝处理）', () => {
    const { router, callbacks, approvalFlow } = makeEnv();
    router.onMsg(approvalRequestedEvent('tc-6', 'node build.js'));
    router.onMsg(approvalResolvedEvent('tc-6', 'expired'));
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-6', 'deny');
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    expect(approvalFlow.snapshot().inflightCount).toBe(0);
    expect(approvalFlow.shouldBlockTerminal()).toBe(false);
  });

  it('approval-resolved 双到达：状态机幂等 noop（不重复放行）', () => {
    const { router, approvalFlow } = makeEnv();
    router.onMsg(approvalRequestedEvent('tc-5', 'node build.js'));
    router.onMsg(approvalResolvedEvent('tc-5', 'approved'));
    expect(approvalFlow.lastTransition()?.outcome).toBe('applied');
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    // 同 sequence 重复 = 同事件重放：消费侧 per-run 去重拦截（04 §5.1-1，
    // EventRouter.buildEventDedupeKey），状态机不重复触达（防御前移到事件层）
    router.onMsg(approvalResolvedEvent('tc-5', 'approved'));
    expect(approvalFlow.lastTransition()?.outcome).toBe('applied');
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    // 不同 sequence 的重复 resolve（引擎对同一 toolCallId 重新 emit）：
    // 事件层键不同不拦截，状态机 double_resolve 幂等防御仍生效
    router.onMsg(approvalResolvedEvent('tc-5', 'approved', 5));
    expect(approvalFlow.lastTransition()?.outcome).toBe('noop');
    expect(approvalFlow.lastTransition()?.reason).toBe('double_resolve');
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
  });
});

describe('审批链路契约：挂起期间 run-terminal 的 defer / 收口', () => {
  it('挂起期间 run-terminal 被 defer（不提前收口），deny 后 finish(false)', () => {
    const { router, approvalFlow, finish, callbacks } = makeEnv();
    router.onMsg(toolStartEvent('tc-3'));
    router.onMsg(approvalRequestedEvent('tc-3', 'node build.js'));

    // run 结束事件在审批挂起期间到达：defer 终态，不 finish
    router.onMsg(runTerminalEvent());
    expect(finish).not.toHaveBeenCalled();
    expect(approvalFlow.isDeferredTerminal()).toBe(true);
    expect(approvalFlow.shouldBlockTerminal()).toBe(true);

    // 用户拒绝 → 清空 pending → 补发 deferred 收口
    router.onMsg(approvalResolvedEvent('tc-3', 'denied'));
    expect(callbacks.onApprovalResolved).toHaveBeenCalledWith('tc-3', 'deny');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(false);
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    expect(approvalFlow.snapshot().inflightCount).toBe(0);
  });

  it('挂起期间 run-terminal 被 defer，allow 后经 tryResumeFinish 续跑收口', () => {
    const { router, approvalFlow, finish, tryResumeFinish } = makeEnv();
    router.onMsg(toolStartEvent('tc-4'));
    router.onMsg(approvalRequestedEvent('tc-4', 'node build.js'));
    router.onMsg(runTerminalEvent());
    expect(finish).not.toHaveBeenCalled();

    // 用户允许 → 不清 inflight（工具继续跑），sawRunTerminal 触发续跑收口
    router.onMsg(approvalResolvedEvent('tc-4', 'approved'));
    expect(finish).not.toHaveBeenCalled();
    expect(tryResumeFinish).toHaveBeenCalledTimes(1);
    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    expect(approvalFlow.snapshot().inflightCount).toBe(1);
  });
});

describe('审批链路契约：白名单 = 批准记忆（P1 权限归一 D1，前端二次决策 1→0）', () => {
  it('白名单命中：仍进入挂起展示审批卡，不再自动直发引擎批准命令', () => {
    usePermissionStore.setState({ commandPermissions: ['git status'] });
    const { router, callbacks, approvalFlow } = makeEnv();

    router.onMsg(toolStartEvent('tc-w'));
    router.onMsg({
      type: 'approval-requested',
      runId: RUN_ID,
      sequence: 2,
      request: {
        toolCallId: 'tc-w',
        toolName: 'shell_command',
        parameters: { command: 'git status --short' },
        summary: '运行命令',
      },
    });

    // P1：白名单仅为批准记忆（remember）——命中不再自动放行，
    // 一律挂起展示审批卡片，让用户在 UI 明确批准
    expect(approvalFlow.snapshot().pendingCount).toBe(1);
    expect(approvalFlow.hasPending()).toBe(true);
    expect(callbacks.onToolPendingApproval).toHaveBeenCalledWith(
      'tc-w',
      'shell_command',
      'git status --short',
      '运行命令',
      expect.any(Object)
    );
    // 不直发引擎批准命令（裁决唯一入口 = 用户 approve 按钮）
    expect(fakeTransport.send).not.toHaveBeenCalled();
    // 文案不再带「白名单自动允许」（onToolStart 兜底路径同样无此标注）
    expect(callbacks.onToolStart).not.toHaveBeenCalledWith(
      'tc-w',
      'shell_command',
      'git status --short',
      expect.stringContaining('白名单自动允许')
    );
  });

  it('危险命令白名单命中同样挂起等用户确认（引擎权威裁决，不读前端风险表）', () => {
    usePermissionStore.setState({ commandPermissions: ['rm'] });
    const { router, callbacks, approvalFlow } = makeEnv();

    router.onMsg(approvalRequestedEvent('tc-h', 'rm -rf /tmp/x'));

    expect(fakeTransport.send).not.toHaveBeenCalled();
    expect(approvalFlow.snapshot().pendingCount).toBe(1);
    expect(approvalFlow.hasPending()).toBe(true);
    expect(callbacks.onToolPendingApproval).toHaveBeenCalledWith(
      'tc-h',
      'shell_command',
      'rm -rf /tmp/x',
      '运行命令',
      expect.any(Object)
    );
  });

  it('plan 模式：不弹审批，直接 onToolStart（只读规划语义）', () => {
    usePermissionStore.setState({
      permissionMode: 'plan',
      planModeEnabled: true,
    });
    const { router, callbacks, approvalFlow } = makeEnv();

    router.onMsg(approvalRequestedEvent('tc-p', 'npm install lodash'));

    expect(approvalFlow.snapshot().pendingCount).toBe(0);
    expect(callbacks.onToolPendingApproval).not.toHaveBeenCalled();
    expect(fakeTransport.send).not.toHaveBeenCalled();
    expect(callbacks.onToolStart).toHaveBeenCalledWith(
      'tc-p',
      'shell_command',
      'npm install lodash',
      '运行命令'
    );
  });
});
