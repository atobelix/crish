/**
 * R7 审批归属 · 生成 parser 契约补测。
 *
 * 注册表驱动的 parser.contract.test.ts 已按字段矩阵自动覆盖
 * PermissionRequest 的全部字段（全字段回环 / 可选缺省 / 类型错误拒绝）；
 * 本文件只钉审批语义本身：
 * - requesterRunId / reason 在 parsePermissionRequest 与 parseEngineEvent
 *   两级都不丢；
 * - metadata（含 arbiter）作为 JsonValue 原样透传（arbiter 的类型化提取
 *   在桌面归一/桥接层，不在生成层——Rust 契约里 metadata 本就是自由
 *   Value，生成层不臆造其内部结构）；
 * - 主 agent 发起（字段缺省）时输出不注入这两个键。
 */
import { describe, expect, it } from 'vitest';
import {
  parseEngineEvent,
  parsePermissionRequest,
} from './generated/engine/parser';

const FULL_REQUEST: Record<string, unknown> = {
  id: 'req-1',
  sessionId: 'sess-1',
  cwd: 'C:\\Software\\conex',
  toolCallId: 'tc-1',
  toolName: 'shell',
  parameters: { command: 'npm test' },
  summary: '需要执行测试',
  toolMetadata: { category: 'process' },
  metadata: { arbiter: 'main-agent', timeoutMs: 120000 },
  requesterRunId: 'run-sub-1',
  reason: '需要运行测试套件验证改动',
};

describe('PermissionRequest 审批归属字段（R7）', () => {
  it('parsePermissionRequest：requesterRunId / reason / metadata 全量保留', () => {
    const r = parsePermissionRequest(FULL_REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.requesterRunId).toBe('run-sub-1');
    expect(r.data.reason).toBe('需要运行测试套件验证改动');
    expect(r.data.metadata).toEqual({
      arbiter: 'main-agent',
      timeoutMs: 120000,
    });
  });

  it('parsePermissionRequest：缺省时不注入 requesterRunId / reason 键', () => {
    const { metadata, requesterRunId, reason, ...bare } = FULL_REQUEST;
    void metadata;
    void requesterRunId;
    void reason;
    const r = parsePermissionRequest(bare);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).not.toHaveProperty('requesterRunId');
    expect(r.data).not.toHaveProperty('reason');
    expect(r.data).not.toHaveProperty('metadata');
  });

  it('parseEngineEvent：approval-requested 信封内归属字段不丢', () => {
    const r = parseEngineEvent({
      type: 'approval-requested',
      sessionId: 'sess-1',
      timestamp: '2026-11-01T00:00:00.000Z',
      request: FULL_REQUEST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.type).toBe('approval-requested');
    if (r.data.type !== 'approval-requested') return;
    expect(r.data.request.requesterRunId).toBe('run-sub-1');
    expect(r.data.request.reason).toBe('需要运行测试套件验证改动');
    expect(r.data.request.metadata).toEqual({
      arbiter: 'main-agent',
      timeoutMs: 120000,
    });
  });
});
