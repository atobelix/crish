/**
 * context-state 感知注入产生器测试（详案 I1-α② 扩展点 A）：
 * - 快照文本组装（模型/服务商/权限/思考档位逐段可省略）；
 * - 暂存/取走语义（取走即清空——本次 run 消费后不重复注入）；
 * - 模块级去重（状态未变化不覆盖暂存，编辑 profile 列表不产生注入）；
 * - 与 profileStore 的 emitUiEvent('profiles-changed') 接线点。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextStateText,
  PENDING_CONTEXT_STATE_KEY,
  recordPendingContextState,
  resetPendingContextStateForTest,
  takePendingContextState,
} from './contextStatePending';

vi.mock('../storeAccess', () => ({
  getPermissionMode: () => 'ask',
  getAppSettings: () => ({ defaultThinkingLevel: 'high' }),
}));

describe('contextStatePending（I1-α② context-state 产生器）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetPendingContextStateForTest();
  });

  afterEach(() => {
    resetPendingContextStateForTest();
  });

  it('buildContextStateText：模型 + 服务商 + 权限 + 思考档位全量快照文本', () => {
    localStorage.setItem('crish_active_model_id', 'deepseek-v4-flash');
    localStorage.setItem('crish_active_profile_id', 'p1');
    const text = buildContextStateText();
    expect(text).toContain('当前已切换到模型 deepseek-v4-flash（服务商 p1）');
    expect(text).toContain('权限模式：ask');
    expect(text).toContain('思考档位：high');
  });

  it('buildContextStateText：无活动模型/服务商 → 空串（无可注入状态告知）', () => {
    expect(buildContextStateText()).toBe('');
  });

  it('record → take：暂存后取走即清空（本次 run 消费后不重复注入，携带结构化字段）', () => {
    localStorage.setItem('crish_active_model_id', 'deepseek-v4-flash');
    recordPendingContextState();
    expect(localStorage.getItem(PENDING_CONTEXT_STATE_KEY)).toContain(
      '当前已切换到模型 deepseek-v4-flash'
    );
    const taken = takePendingContextState();
    expect(taken).toBeDefined();
    expect(taken?.model).toBe('deepseek-v4-flash');
    expect(taken?.permission).toBe('ask');
    expect(taken?.thinking).toBe('high');
    expect(taken?.text).toContain('当前已切换到模型 deepseek-v4-flash');
    expect(takePendingContextState()).toBeUndefined();
    expect(localStorage.getItem(PENDING_CONTEXT_STATE_KEY)).toBeNull();
  });

  it('模块级去重：状态未变化重复 record 不覆盖暂存（编辑列表不产生注入）', () => {
    localStorage.setItem('crish_active_model_id', 'm1');
    recordPendingContextState();
    const first = localStorage.getItem(PENDING_CONTEXT_STATE_KEY);
    // 同状态再 record：签名一致 → 不重新写入
    recordPendingContextState();
    expect(localStorage.getItem(PENDING_CONTEXT_STATE_KEY)).toBe(first);
  });

  it('状态变化后 record 覆盖暂存（连切两次只保留最新快照）', () => {
    localStorage.setItem('crish_active_model_id', 'm1');
    recordPendingContextState();
    localStorage.setItem('crish_active_model_id', 'm2');
    recordPendingContextState();
    const taken = takePendingContextState();
    expect(taken?.model).toBe('m2');
    expect(taken?.text).toContain('m2');
    expect(taken?.text).not.toContain('m1');
  });

  it('结构化暂存载荷包含全部必要字段：model, profile, permission, thinking, text', () => {
    localStorage.setItem('crish_active_model_id', 'qwen-2.5-max');
    localStorage.setItem('crish_active_profile_id', 'aliyun');
    recordPendingContextState();
    const taken = takePendingContextState();
    expect(taken).toEqual({
      sessionId: '',
      model: 'qwen-2.5-max',
      profile: 'aliyun',
      permission: 'ask',
      thinking: 'high',
      text: '当前已切换到模型 qwen-2.5-max（服务商 aliyun）。权限模式：ask。思考档位：high。',
    });
  });
});
