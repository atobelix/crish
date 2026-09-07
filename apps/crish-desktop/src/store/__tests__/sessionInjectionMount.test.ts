/**
 * apps/crish-desktop/src/store/__tests__/sessionInjectionMount.test.ts
 * 注入挂载纯函数契约（维度二 + C1 持久化内联）：
 * - 可挂载宿主判定（进行中助手消息 / 空正文载体）；
 * - appendInjectionToMessage 写 injections + context_injection 块，且
 *   载荷内联进块（C1：Rust 仅持久化 blocks_json，内联保证重载恢复）；
 * - 同 id 幂等：不重复写块、不重复注入；
 * - makeInjectionCarrierMessage 构造含内联载荷的载体消息。
 */
import { describe, expect, it } from 'vitest';
import {
  appendInjectionToMessage,
  findInjectionMountTarget,
  isContextStateCarrierMessage,
  isInjectionMountableMessage,
  makeInjectionCarrierMessage,
} from '../sessionInjectionMount';
import type {
  ContextStateMetadata,
  MessageContextInjection,
  SessionMessage,
} from '../types';

function makeInjection(over: Partial<MessageContextInjection> = {}): MessageContextInjection {
  return {
    id: 'inj-1',
    kind: 'rule',
    title: '规则注入',
    summary: 'AGENTS.md',
    status: 'injected',
    source: 'rule_loader',
    content: '必须使用 UTF-8 无 BOM',
    timestamp: 1,
    ...over,
  };
}

function makeMessage(over: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: 'm1',
    sender: 'assistant',
    text: '',
    timestamp: 1,
    ...over,
  };
}

describe('isInjectionMountableMessage / findInjectionMountTarget', () => {
  it('进行中 / 排队助手消息可挂载', () => {
    expect(
      isInjectionMountableMessage(makeMessage({ status: 'processing' }))
    ).toBe(true);
    expect(
      isInjectionMountableMessage(makeMessage({ status: 'queued' }))
    ).toBe(true);
  });

  it('已收口 / 有正文 / 有工具调用的消息不可挂载（不回溯改写）', () => {
    expect(
      isInjectionMountableMessage(makeMessage({ status: 'completed' }))
    ).toBe(false);
    expect(
      isInjectionMountableMessage(makeMessage({ text: '有正文' }))
    ).toBe(false);
    expect(
      isInjectionMountableMessage(
        makeMessage({ toolCalls: [{ id: 't1' } as never] })
      )
    ).toBe(false);
  });

  it('findInjectionMountTarget 从尾部向前找最新可挂载消息', () => {
    const msgs = [
      makeMessage({ id: 'a', status: 'completed' }),
      makeMessage({ id: 'b', status: 'queued' }),
    ];
    expect(findInjectionMountTarget(msgs)?.id).toBe('b');
    expect(findInjectionMountTarget([])).toBeUndefined();
  });
});

describe('appendInjectionToMessage 持久化内联（C1）', () => {
  it('写 injections + context_injection 块且载荷内联进块', () => {
    const msg = makeMessage();
    const inj = makeInjection();
    appendInjectionToMessage(msg, inj);

    expect(msg.injections).toEqual([inj]);
    expect(msg.blocks).toHaveLength(1);
    const block = msg.blocks![0]!;
    expect(block.type).toBe('context_injection');
    expect(block.id).toBe('inj-1');
    // C1 契约：块内联载荷（Rust 仅持久化 blocks_json → 重载经 b.injection 恢复）
    expect(block.injection).toEqual(inj);
  });

  it('同 id 幂等：不重复写块、不重复注入，原地更新载荷', () => {
    const msg = makeMessage();
    appendInjectionToMessage(msg, makeInjection());
    const updated = makeInjection({ title: '更新后的标题' });
    appendInjectionToMessage(msg, updated);

    expect(msg.injections).toHaveLength(1);
    expect(msg.injections![0]!.title).toBe('更新后的标题');
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks![0]!.injection?.title).toBe('更新后的标题');
  });

  it('makeInjectionCarrierMessage 载体含内联载荷', () => {
    const inj = makeInjection();
    const carrier = makeInjectionCarrierMessage(inj);
    expect(carrier.id).toBe('ctx-carrier-inj-1');
    expect(carrier.sender).toBe('assistant');
    expect(carrier.blocks![0]!.injection).toEqual(inj);
  });
});

describe('状态切换（context-state）原地更新防堆叠（解决连续切换堆叠病灶）', () => {
  function makeContextStateInjection(
    id: string,
    model: string,
    permission = 'ask'
  ): MessageContextInjection {
    return {
      id,
      kind: 'workspace_env',
      title: '上下文状态切换',
      summary: `当前已切换到模型 ${model}`,
      status: 'injected',
      source: 'system_event',
      content: `当前已切换到模型 ${model}。权限模式：${permission}。`,
      timestamp: Date.now(),
      metadata: {
        mode: 'context-state',
        model,
        permission,
      },
    };
  }

  it('appendInjectionToMessage：同一宿主消息多次注入 context-state 时执行原地覆盖更新，绝不堆叠', () => {
    const msg = makeMessage({ id: 'carrier-1' });

    // 模拟连续切换 5 次模型（不同 UUID id）
    const models = ['gpt-4o', 'claude-3-5-sonnet', 'deepseek-v3', 'gemini-2.5-pro', 'o3-mini'];
    for (let i = 0; i < models.length; i++) {
      const inj = makeContextStateInjection(`inj-${i + 1}`, models[i]);
      appendInjectionToMessage(msg, inj);
    }

    // 核心断言：连续切换 5 次后，消息内仅保留最新 1 条注入项与 1 个 block
    expect(msg.injections).toHaveLength(1);
    expect(msg.blocks).toHaveLength(1);

    // 确认保留的是最后一次生效的模型
    const activeInj = msg.injections![0]!;
    expect(activeInj.id).toBe('inj-5');
    expect((activeInj.metadata as ContextStateMetadata)?.model).toBe('o3-mini');
    expect(activeInj.summary).toContain('o3-mini');

    // 确认 block 内联载荷与之一致
    const activeBlock = msg.blocks![0]!;
    expect(activeBlock.id).toBe('inj-5');
    expect((activeBlock.injection?.metadata as ContextStateMetadata)?.model).toBe('o3-mini');
  });

  it('appendInjectionToMessage：宿主已有历史残留多条 context-state 时，覆盖时彻底清理多余项', () => {
    const msg = makeMessage({
      id: 'carrier-dirty',
      injections: [
        makeContextStateInjection('inj-old-1', 'model-1'),
        makeContextStateInjection('inj-old-2', 'model-2'),
      ],
      blocks: [
        {
          type: 'context_injection',
          id: 'inj-old-1',
          injection: makeContextStateInjection('inj-old-1', 'model-1'),
        },
        {
          type: 'context_injection',
          id: 'inj-old-2',
          injection: makeContextStateInjection('inj-old-2', 'model-2'),
        },
      ],
    });

    const newInj = makeContextStateInjection('inj-fresh', 'model-clean');
    appendInjectionToMessage(msg, newInj);

    expect(msg.injections).toHaveLength(1);
    expect(msg.blocks).toHaveLength(1);
    expect((msg.injections![0]!.metadata as ContextStateMetadata)?.model).toBe('model-clean');
    expect((msg.blocks![0]!.injection?.metadata as ContextStateMetadata)?.model).toBe('model-clean');
  });

  it('isContextStateCarrierMessage：精确判定纯状态切换载体消息', () => {
    const carrier = makeInjectionCarrierMessage(
      makeContextStateInjection('inj-1', 'deepseek-chat')
    );
    expect(isContextStateCarrierMessage(carrier)).toBe(true);

    // 有正文：不是纯载体
    expect(isContextStateCarrierMessage({ ...carrier, text: '你好' })).toBe(false);
    // 有工具调用：不是纯载体
    expect(
      isContextStateCarrierMessage({
        ...carrier,
        toolCalls: [{ id: 't1' } as never],
      })
    ).toBe(false);
    // 有思维链：不是纯载体
    expect(isContextStateCarrierMessage({ ...carrier, thinking: 'thinking...' })).toBe(false);
    // 有多轮思考思维链数组：不是纯载体 (DEF-05)
    expect(
      isContextStateCarrierMessage({
        ...carrier,
        thinkingTurns: [{ id: 'turn-1', content: 'thinking...' }],
      })
    ).toBe(false);
    // 有图片：不是纯载体 (DEF-05)
    expect(
      isContextStateCarrierMessage({
        ...carrier,
        images: ['data:image/png;base64,...'],
      })
    ).toBe(false);
    // 有附件：不是纯载体 (DEF-05)
    expect(
      isContextStateCarrierMessage({
        ...carrier,
        attachments: [{ id: 'att-1', name: 'data.csv', size: 100 }],
      })
    ).toBe(false);
    // 有错误诊断详情：不是纯载体 (DEF-05)
    expect(
      isContextStateCarrierMessage({
        ...carrier,
        errorDetail: { message: 'Network error' },
      })
    ).toBe(false);
    // 不是 assistant：不是纯载体
    expect(isContextStateCarrierMessage({ ...carrier, sender: 'user' })).toBe(false);
    // 普通规则注入：不是纯状态切换载体
    const ruleCarrier = makeInjectionCarrierMessage(makeInjection());
    expect(isContextStateCarrierMessage(ruleCarrier)).toBe(false);
    // 容错查表：当 block.injection 未内联展开时按 id 到 injections 查表 (DEF-06)
    const blockLookupCarrier: SessionMessage = {
      id: 'carrier-lookup',
      sender: 'assistant',
      text: '',
      injections: [makeContextStateInjection('inj-state-x', 'deepseek-chat')],
      blocks: [{ type: 'context_injection', id: 'inj-state-x' }],
    };
    expect(isContextStateCarrierMessage(blockLookupCarrier)).toBe(true);
  });

  it('findInjectionMountTarget：最新尾部载体消息仅承载 context-state 时（哪怕 status=completed），支持原地替换', () => {
    const carrier = makeInjectionCarrierMessage(
      makeContextStateInjection('inj-1', 'qwen-max')
    );
    carrier.status = 'completed'; // 模拟被持久化或收口标记为 completed

    const messages = [
      makeMessage({ id: 'u1', sender: 'user', text: '你好' }),
      makeMessage({ id: 'a1', sender: 'assistant', text: '你好！', status: 'completed' }),
      carrier,
    ];

    // 查找目标直接定位到该 carrier，实现同轮次原地替换
    const target = findInjectionMountTarget(messages);
    expect(target?.id).toBe(carrier.id);
  });

  it('findInjectionMountTarget：新轮次已由用户提问开启时，绝不跨轮次回溯修改上一轮的载体', () => {
    const oldCarrier = makeInjectionCarrierMessage(
      makeContextStateInjection('inj-1', 'qwen-max')
    );
    const messages = [
      oldCarrier,
      makeMessage({ id: 'u1', sender: 'user', text: '下一轮的问题' }),
    ];

    // 用户已发送新消息，不能改写上一轮的 carrier
    const target = findInjectionMountTarget(messages);
    expect(target).toBeUndefined();
  });
});
