/**
 * R7 审批归属透传 · 解析层测试（生成 parser 严格路径 + eventParserCore
 * 宽容归一两条路径都必须承接 requesterRunId / reason / metadata）。
 *
 * 背景：归属字段曾在五级链路的第一级（生成类型/parser）与第二级
 * （宽容归一逐字段重建 request 时）双双丢失——严格路径靠注册表补字段后
 * 的生成 parser 承接；宽容路径（信封缺 sessionId/timestamp、或 daemon
 * 平铺形状）靠归一器显式带字段。缺省（主 agent 发起）时两条路径的输出
 * 都不得出现这三个键（与引擎 skip_serializing_if 的缺省语义一致）。
 */
import { describe, expect, it } from 'vitest';
import { parseBridgeEvent } from './eventParser';

const REQUEST_WITH_ATTRIBUTION: Record<string, unknown> = {
  id: 'req-1',
  sessionId: 'sess-test',
  cwd: 'C:\\Software\\conex',
  toolCallId: 'tc-1',
  toolName: 'shell',
  parameters: { command: 'npm test' },
  summary: '需要执行测试',
  toolMetadata: {},
  metadata: { arbiter: 'main-agent', timeoutMs: 120000 },
  requesterRunId: 'run-sub-1',
  reason: '需要运行测试套件验证改动',
};

function parseApproval(raw: Record<string, unknown>) {
  const parsed = parseBridgeEvent(raw);
  if (!parsed.ok || parsed.data.kind !== 'engine') {
    throw new Error('fixture must parse as engine event');
  }
  if (parsed.data.event.type !== 'approval-requested') {
    throw new Error('fixture must be approval-requested');
  }
  return parsed.data.event.request;
}

describe('parseBridgeEvent · approval-requested 归属字段（R7）', () => {
  it('严格路径（完整信封）：requesterRunId / reason / metadata 全量承接', () => {
    const request = parseApproval({
      type: 'approval-requested',
      sessionId: 'sess-test',
      timestamp: '2026-11-01T00:00:00.000Z',
      request: REQUEST_WITH_ATTRIBUTION,
    });
    expect(request.requesterRunId).toBe('run-sub-1');
    expect(request.reason).toBe('需要运行测试套件验证改动');
    expect(request.metadata).toEqual({
      arbiter: 'main-agent',
      timeoutMs: 120000,
    });
  });

  it('宽容路径（缺信封 sessionId/timestamp，嵌套 request）：归一后同样承接', () => {
    const request = parseApproval({
      type: 'approval-requested',
      request: REQUEST_WITH_ATTRIBUTION,
    });
    expect(request.requesterRunId).toBe('run-sub-1');
    expect(request.reason).toBe('需要运行测试套件验证改动');
    expect(request.metadata).toEqual({
      arbiter: 'main-agent',
      timeoutMs: 120000,
    });
  });

  it('宽容路径（daemon 平铺形状，request 字段在顶层）：同样承接', () => {
    const request = parseApproval({
      type: 'approval-requested',
      ...REQUEST_WITH_ATTRIBUTION,
    });
    expect(request.requesterRunId).toBe('run-sub-1');
    expect(request.reason).toBe('需要运行测试套件验证改动');
    expect(request.metadata).toEqual({
      arbiter: 'main-agent',
      timeoutMs: 120000,
    });
  });

  it('缺省（主 agent 发起）：两条路径输出都不带 requesterRunId / reason / metadata 键', () => {
    const { metadata, requesterRunId, reason, ...bare } =
      REQUEST_WITH_ATTRIBUTION;
    void metadata;
    void requesterRunId;
    void reason;
    const strict = parseApproval({
      type: 'approval-requested',
      sessionId: 'sess-test',
      timestamp: '2026-11-01T00:00:00.000Z',
      request: bare,
    });
    expect(strict).not.toHaveProperty('requesterRunId');
    expect(strict).not.toHaveProperty('reason');
    expect(strict).not.toHaveProperty('metadata');

    const lenient = parseApproval({
      type: 'approval-requested',
      request: bare,
    });
    expect(lenient).not.toHaveProperty('requesterRunId');
    expect(lenient).not.toHaveProperty('reason');
    expect(lenient).not.toHaveProperty('metadata');
  });

  it('宽容路径：requesterRunId 非字符串时按缺省处理（不带键，其余字段仍承接）', () => {
    // requesterRunId 类型错误 → 严格 parser 拒绝、确定性走宽容归一；
    // 归一层 str() 只收字符串，类型不对即按缺省丢弃（空白串的 trim
    // 语义归桥接层，见 approvalHandlers.requester.test.ts）。
    const request = parseApproval({
      type: 'approval-requested',
      request: { ...REQUEST_WITH_ATTRIBUTION, requesterRunId: 42 },
    });
    expect(request).not.toHaveProperty('requesterRunId');
    expect(request.reason).toBe('需要运行测试套件验证改动');
    expect(request.metadata).toEqual({
      arbiter: 'main-agent',
      timeoutMs: 120000,
    });
  });
});
