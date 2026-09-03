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
  isInjectionMountableMessage,
  makeInjectionCarrierMessage,
} from '../sessionInjectionMount';
import type {
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
