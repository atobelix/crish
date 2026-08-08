// packages/shared-types/src/type-drift.test.ts
// F8-09~F8-13：手写类型与生成 schema 的编译期契约对照（F8-43 盲区补全）
//
// 背景（docs/organization/audit/F8-shared-generated-audit.md §2.2）：
// 生成 schema 与 Rust serde 由 registry_drift.rs + 生成管线锁定，漂移全部
// 集中在手写类型（events.ts / tool.ts）：
// - F8-09：AgentEndReason 手写 4 值缺 'stopped'（Rust AgentEndReason::Stopped 已存在）；
// - F8-10：approval-resolved 语义错位——实际 wire 为 toolCallId 必填 +
//   decision 字符串三值（approved/denied/expired），手写类型却是
//   requestId 必填 + PermissionDecision 对象形态；
// - F8-11：ProviderDiagnostic.phase 缺 'invalid-tool-call'（生成 11 值）；
// - F8-12：ProviderErrorKind 名集陈旧（旧 12 值 vs 生成 13 值 kebab-case）；
// - F8-13：ContextCompressionPolicyMetadata/HandoffMetadata.providerRetry
//   固化为字面量 false（Rust 一旦发 true 类型拒绝）。
//
// 断言方式：satisfies 构造 wire 形态（编译期红）+ @ts-expect-error 断言
// 非法形态被拒（防漂移回归）+ expectTypeOf 手写↔生成类型相等（杜绝双源）。
// 红绿验证：`npm run typecheck`（shared-types 项目含 src 下测试文件）。

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentEndReason as GeneratedAgentEndReason,
  ApprovalDecision as GeneratedApprovalDecision,
  ProviderDiagnosticPhase as GeneratedProviderDiagnosticPhase,
  ProviderErrorKind as GeneratedProviderErrorKind,
} from './generated/engine/types';
import type { AgentDomainEvent, DiagnosticDomainEvent } from './events';
import type {
  ContextCompressionHandoffMetadata,
  ContextCompressionPolicyMetadata,
  ProviderDiagnostic,
} from './tool';

type AgentEndEvent = Extract<AgentDomainEvent, { type: 'agent-end' }>;
type ApprovalResolvedEvent = Extract<
  DiagnosticDomainEvent,
  { type: 'approval-resolved' }
>;

describe('F8-09：agent-end.reason 含 stopped（Rust AgentEndReason::Stopped 已存在）', () => {
  it('手写 AgentDomainEvent 接受 wire 值 stopped（编译期）', () => {
    const ev = {
      type: 'agent-end',
      sessionId: 'sess-1',
      timestamp: '2026-08-08T00:00:00.000Z',
      reason: 'stopped',
    } satisfies AgentEndEvent;
    expect(ev.reason).toBe('stopped');
  });

  it('手写 reason 联合与生成 AgentEndReason 相等（杜绝双源漂移）', () => {
    expectTypeOf<AgentEndEvent['reason']>().toEqualTypeOf<
      GeneratedAgentEndReason
    >();
  });
});

describe('F8-10：approval-resolved 语义对齐 wire（toolCallId 必填 + decision 字符串三值）', () => {
  it('手写 DiagnosticDomainEvent 接受 wire 形态（编译期）', () => {
    const ev = {
      type: 'approval-resolved',
      sessionId: 'sess-1',
      toolCallId: 'call-1',
      requestId: 'req-1',
      decision: 'approved',
      timestamp: '2026-08-08T00:00:00.000Z',
    } satisfies ApprovalResolvedEvent;
    expect(ev.decision).toBe('approved');
  });

  it('decision 联合与生成 ApprovalDecision 相等', () => {
    expectTypeOf<ApprovalResolvedEvent['decision']>().toEqualTypeOf<
      GeneratedApprovalDecision
    >();
  });

  it('toolCallId 必填：缺 toolCallId 的旧形态（仅 requestId）必须被类型拒绝', () => {
    // 反向契约：若 BadShape 意外可赋值给 approval-resolved（漂移回归），
    // 条件类型解析为 'expected-rejection'，与 never 不等 → typecheck 红
    type BadShapeMissingToolCallId = {
      type: 'approval-resolved';
      sessionId: string;
      requestId: string;
      decision: 'approved';
      timestamp: string;
    };
    expectTypeOf<
      BadShapeMissingToolCallId extends ApprovalResolvedEvent
        ? 'expected-rejection'
        : never
    >().toEqualTypeOf<never>();
  });

  it('decision 为字符串三值：嵌套对象形态（旧 PermissionDecision）必须被类型拒绝', () => {
    type BadShapeNestedDecision = {
      type: 'approval-resolved';
      sessionId: string;
      toolCallId: string;
      decision: { behavior: 'allow' };
      timestamp: string;
    };
    expectTypeOf<
      BadShapeNestedDecision extends ApprovalResolvedEvent
        ? 'expected-rejection'
        : never
    >().toEqualTypeOf<never>();
  });
});

describe('F8-11/12：ProviderDiagnostic phase/errorKind 以生成枚举为准', () => {
  it('phase 接受 invalid-tool-call（生成 11 值，工具调用解析失败诊断）', () => {
    const diag = { phase: 'invalid-tool-call' } satisfies ProviderDiagnostic;
    expect(diag.phase).toBe('invalid-tool-call');
  });

  it('errorKind 接受新 wire 名（payload-too-large / invalid-request / server-error）', () => {
    const a = {
      phase: 'request-error',
      errorKind: 'payload-too-large',
    } satisfies ProviderDiagnostic;
    const b = {
      phase: 'request-error',
      errorKind: 'invalid-request',
    } satisfies ProviderDiagnostic;
    const c = {
      phase: 'request-error',
      errorKind: 'server-error',
    } satisfies ProviderDiagnostic;
    expect([a.errorKind, b.errorKind, c.errorKind]).toEqual([
      'payload-too-large',
      'invalid-request',
      'server-error',
    ]);
  });

  it('errorKind 拒绝旧名 invalid-stream（迁移别名已收敛删除）', () => {
    // 反向契约：旧名若意外回归（漂移回归），条件类型解析为非 never → 红
    type BadShapeLegacyErrorKind = {
      phase: 'request-error';
      errorKind: 'invalid-stream';
    };
    expectTypeOf<
      BadShapeLegacyErrorKind extends ProviderDiagnostic
        ? 'expected-rejection'
        : never
    >().toEqualTypeOf<never>();
  });

  it('phase/errorKind 与生成类型相等', () => {
    expectTypeOf<ProviderDiagnostic['phase']>().toEqualTypeOf<
      GeneratedProviderDiagnosticPhase
    >();
    expectTypeOf<
      NonNullable<ProviderDiagnostic['errorKind']>
    >().toEqualTypeOf<GeneratedProviderErrorKind>();
  });
});

describe('F8-13：providerRetry 为 boolean（Rust 可发 true，可重试压缩）', () => {
  it('ContextCompressionPolicyMetadata.providerRetry 接受 true', () => {
    const meta: ContextCompressionPolicyMetadata = {
      tier: 'proactive',
      action: 'compact',
      forced: true,
      thresholdExceeded: false,
      providerRetry: true,
    };
    expect(meta.providerRetry).toBe(true);
  });

  it('ContextCompressionHandoffMetadata.providerRetry 接受 true（编译期）', () => {
    const meta = {
      trigger: 'auto',
      reason: 'threshold',
      tier: 'proactive',
      action: 'compact',
      providerRetry: true,
      summary: 's',
      compressedMessageCount: 1,
      keptMessageCount: 1,
      tokensBefore: 1,
      tokensAfter: 1,
      thresholdTokens: 2,
      completedTaskSummaries: [],
      pendingTasks: [],
      sessionEvents: [],
      fileSnapshotHints: [],
      recentSuccessfulCommands: [],
      recentFailedDiagnostics: [],
    } satisfies ContextCompressionHandoffMetadata;
    expect(meta.providerRetry).toBe(true);
  });
});
