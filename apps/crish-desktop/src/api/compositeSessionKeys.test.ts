/**
 * 复合会话键 SSOT 契约测试（api/compositeSessionKeys.ts）。
 *
 * 钉死四件事：
 * 1. 形状逐字节兼容（迁移自 streamTextBatcher / streamingStoreCore /
 *    streamDirectDomEngine / dualLatchProtocol 的历史实现，严禁漂移）；
 * 2. 空会话归一语义（`__default__` 变体与纯拼接变体的分工）；
 * 3. 三段工具键的解析往返（first/last `::` 切分，messageId 允许含 `::`）；
 * 4. 前缀清理语义（startsWith 批量驱逐契约）。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPOSITE_KEY_SEPARATOR,
  DEFAULT_SESSION_ID,
  parseSessionMessageToolKey,
  sessionMessageKey,
  sessionMessageKeyOrDefault,
  sessionMessageKeyPrefix,
  sessionMessageToolKey,
  subagentDeltaKey,
} from './compositeSessionKeys';

describe('compositeSessionKeys SSOT', () => {
  it('分隔符与默认会话标识保持既有契约', () => {
    expect(COMPOSITE_KEY_SEPARATOR).toBe('::');
    expect(DEFAULT_SESSION_ID).toBe('__default__');
  });

  it('sessionMessageKey：纯拼接（等价原 streamStoreKey / streamBatchKey）', () => {
    expect(sessionMessageKey('s1', 'm1')).toBe('s1::m1');
    // 空会话不做归一（历史行为：产出 `::m1` 形状）
    expect(sessionMessageKey('', 'm1')).toBe('::m1');
  });

  it('sessionMessageKeyOrDefault：空会话归一为 __default__（等价原 makeSlotKey / makeDualLatchKey）', () => {
    expect(sessionMessageKeyOrDefault('s1', 'm1')).toBe('s1::m1');
    expect(sessionMessageKeyOrDefault('', 'm1')).toBe('__default__::m1');
    expect(sessionMessageKeyOrDefault('__default__', 'm1')).toBe(
      '__default__::m1'
    );
  });

  it('sessionMessageKeyPrefix：startsWith 批量清理契约', () => {
    expect(sessionMessageKeyPrefix('s1')).toBe('s1::');
    const key = sessionMessageKey('s1', 'm1');
    expect(key.startsWith(sessionMessageKeyPrefix('s1'))).toBe(true);
    expect(key.startsWith(sessionMessageKeyPrefix('s2'))).toBe(false);
  });

  it('sessionMessageToolKey：三段键（等价原 streamToolBatchKey）', () => {
    expect(sessionMessageToolKey('s1', 'm1', 't1')).toBe('s1::m1::t1');
  });

  it('parseSessionMessageToolKey：first/last 切分往返（messageId 允许含 ::）', () => {
    expect(parseSessionMessageToolKey('s1::m1::t1')).toEqual({
      sessionId: 's1',
      messageId: 'm1',
      toolId: 't1',
    });
    // messageId 含 :: 的极端场景：first 切会话、last 切工具，中段完整保留
    expect(parseSessionMessageToolKey('s1::m::1::t1')).toEqual({
      sessionId: 's1',
      messageId: 'm::1',
      toolId: 't1',
    });
    // 缺段 → null
    expect(parseSessionMessageToolKey('s1::m1')).toBeNull();
    expect(parseSessionMessageToolKey('s1')).toBeNull();
    expect(parseSessionMessageToolKey('')).toBeNull();
  });

  it('subagentDeltaKey：子代理维度聚合键', () => {
    expect(subagentDeltaKey('s1', 'agent-7')).toBe('s1::agent-7');
  });

  it('往返一致性：构造 → 解析 → 构造 恒等', () => {
    const key = sessionMessageToolKey('sess', 'msg', 'tool');
    const parsed = parseSessionMessageToolKey(key);
    expect(parsed).not.toBeNull();
    const roundTrip = sessionMessageToolKey(
      parsed!.sessionId,
      parsed!.messageId,
      parsed!.toolId
    );
    expect(roundTrip).toBe(key);
  });
});
