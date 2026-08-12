// approvalMappers 单测：事件消费映射（E2E-1 事件流入 / E2E-3 dangerLevel / E2E-11 arbiter 数据层可测部分）
import type {
  EngineApprovalRequestedEvent,
  EngineApprovalResolvedEvent,
} from '../../../../../packages/shared-types/src/generated/engine/events';
import type { PermissionRequest } from '../../../../../packages/shared-types/src/generated/engine/types';
import {
  mapApprovalRequested,
  mapApprovalResolved,
  deriveDangerLevel,
  extractCommand,
  isApprovalEvent,
} from './approvalMappers';
import { APPROVAL_TIMEOUT_MS } from './approvalReducers';

const NOW = 1_800_000_000_000;

function makeRequest(
  overrides: Partial<PermissionRequest> = {}
): PermissionRequest {
  return {
    id: 'approval-call-1',
    sessionId: 's-1',
    cwd: 'C:\\work',
    toolCallId: 'call-1',
    toolName: 'write_file',
    parameters: { path: 'a.ts' },
    summary: 'write a.ts',
    toolMetadata: {},
    ...overrides,
  };
}

function makeRequestedEvent(
  request: PermissionRequest
): EngineApprovalRequestedEvent {
  return {
    type: 'approval-requested',
    sessionId: request.sessionId,
    request,
    timestamp: new Date(NOW).toISOString(),
  };
}

function makeResolvedEvent(
  toolCallId: string,
  decision: EngineApprovalResolvedEvent['decision']
): EngineApprovalResolvedEvent {
  return {
    type: 'approval-resolved',
    sessionId: 's-1',
    toolCallId,
    decision,
    timestamp: new Date(NOW + 100).toISOString(),
  };
}

describe('mapApprovalRequested（E2E-1 事件流入 → 待办）', () => {
  it('契约字段透传 + 本地附加字段推导（receivedAtMs/expiresAt 120s/状态）', () => {
    const event = makeRequestedEvent(makeRequest({ toolCallId: 'call-9' }));
    const item = mapApprovalRequested(event, 'run-42', NOW);
    expect(item.request.toolCallId).toBe('call-9');
    expect(item.runId).toBe('run-42');
    expect(item.receivedAtMs).toBe(NOW);
    expect(item.expiresAt).toBe(NOW + APPROVAL_TIMEOUT_MS);
    expect(item.status).toBe('pending');
    expect(item.decisionStatus).toBe('idle');
    expect(item.decisionBusy).toBe(false);
    expect(item.arbiter).toBe('user');
  });

  it('runId 缺失（实时预览帧）→ null（F2 §2.4）', () => {
    const item = mapApprovalRequested(
      makeRequestedEvent(makeRequest()),
      null,
      NOW
    );
    expect(item.runId).toBeNull();
  });

  it('arbiter=main-agent 透传（E2E-11 数据层：子代理请求只读判定依据）', () => {
    const event = makeRequestedEvent(
      makeRequest({
        metadata: {
          arbiter: 'main-agent',
          requesterRunId: 'sub-3',
          reason: '需要扩展写入范围',
        },
      })
    );
    const item = mapApprovalRequested(event, 'run-main', NOW);
    expect(item.arbiter).toBe('main-agent');
    expect(item.requesterRunId).toBe('sub-3');
    expect(item.reason).toBe('需要扩展写入范围');
  });

  it('metadata 类型错乱宽容：非字符串 arbiter → user 兜底', () => {
    const event = makeRequestedEvent(
      makeRequest({ metadata: { arbiter: 42 as unknown as string } })
    );
    const item = mapApprovalRequested(event, null, NOW);
    expect(item.arbiter).toBe('user');
    expect(item.requesterRunId).toBeUndefined();
  });
});

describe('deriveDangerLevel（F2 §2.2 表：L1 常规 / L2 高风险）', () => {
  it('删除类工具 → L2（删除影响面）', () => {
    expect(deriveDangerLevel(makeRequest({ toolName: 'delete_file' }))).toBe(2);
    expect(deriveDangerLevel(makeRequest({ toolName: 'rm' }))).toBe(2);
  });

  it('命令门禁越界（git push --force / rm -rf）→ L2', () => {
    expect(
      deriveDangerLevel(
        makeRequest({
          toolName: 'command',
          parameters: { command: 'git push --force origin main' },
        })
      )
    ).toBe(2);
    expect(
      deriveDangerLevel(
        makeRequest({
          toolName: 'shell',
          parameters: { command: 'rm -rf ./node_modules' },
        })
      )
    ).toBe(2);
  });

  it('C3 大面积回退 / 命令门禁标记 → L2（F2 §2.2 revertGate 面积）', () => {
    expect(
      deriveDangerLevel(
        makeRequest({
          metadata: { revertGate: true, revertArea: { fileCount: 120 } },
        })
      )
    ).toBe(2);
    expect(
      deriveDangerLevel(makeRequest({ metadata: { requiresApproval: true } }))
    ).toBe(2);
  });

  it('常规工具与普通命令 → L1（E2E-3 数据层：仅 L2 需滑动确认）', () => {
    expect(deriveDangerLevel(makeRequest())).toBe(1);
    expect(
      deriveDangerLevel(
        makeRequest({
          toolName: 'command',
          parameters: { command: 'git status' },
        })
      )
    ).toBe(1);
  });
});

describe('extractCommand（对齐桌面 extractApprovalCommandArgs，F2 §2.2）', () => {
  it('命令类工具取 command 字段', () => {
    expect(
      extractCommand(
        makeRequest({
          toolName: 'command',
          parameters: { command: 'npm test' },
        })
      )
    ).toBe('npm test');
  });

  it('args 数组拼接', () => {
    expect(
      extractCommand(
        makeRequest({
          toolName: 'exec',
          parameters: { args: ['git', 'status'] },
        })
      )
    ).toBe('git status');
  });

  it('非命令类工具不抽取（避免误判普通参数）', () => {
    expect(
      extractCommand(
        makeRequest({ toolName: 'write_file', parameters: { path: 'a.ts' } })
      )
    ).toBeUndefined();
  });
});

describe('mapApprovalResolved（E2E-1 出队 / E2E-4 expired 收敛）', () => {
  it('approved/denied 收敛视图', () => {
    const view = mapApprovalResolved(
      makeResolvedEvent('call-1', 'approved'),
      NOW + 500
    );
    expect(view).toEqual({
      toolCallId: 'call-1',
      decision: 'approved',
      resolvedAtMs: NOW + 500,
    });
  });

  it('expired 决策（引擎补发/对账，F2 §8.3 / R1）：同样收敛为移除语义', () => {
    const view = mapApprovalResolved(
      makeResolvedEvent('call-2', 'expired'),
      NOW + 130_000
    );
    expect(view.decision).toBe('expired');
  });
});

describe('isApprovalEvent（F2 §2.4 事件对判定）', () => {
  it('approval-requested / approval-resolved 命中', () => {
    expect(isApprovalEvent(makeRequestedEvent(makeRequest()))).toBe(true);
    expect(isApprovalEvent(makeResolvedEvent('c', 'approved'))).toBe(true);
  });
});
