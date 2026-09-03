/**
 * 会话消息注入挂载辅助纯函数（Prompt 注入管线 · 维度二）。
 *
 * 供 sessionCrudActions 的 addContextInjection action 复用：
 * - 判定「最新可挂载消息」宿主语义（进行中助手消息 / 空正文注入载体）；
 * - 向目标消息写 injections 与 context_injection 块；
 * - 无宿主时构造 assistant 载体消息。
 * 无 store 依赖，纯函数可独立单测。
 */
import type {
  MessageContextInjection,
  MessageTimelineBlock,
  SessionMessage,
} from './types';

/** 判定消息是否为注入卡片可挂载宿主（「最新可挂载消息」语义） */
export function isInjectionMountableMessage(
  msg: SessionMessage | undefined
): boolean {
  if (!msg || msg.sender !== 'assistant') return false;
  // 进行中的助手消息：注入随当前 Turn 进入上下文
  if (msg.status === 'processing' || msg.status === 'queued') return true;
  // 已收口消息不回溯改写
  if (msg.status === 'completed' || msg.status === 'error') return false;
  // 无 status 的历史/本地消息：仅空正文注入载体可复用（避免改写成形消息）
  if ((msg.text || '').trim()) return false;
  if (msg.toolCalls && msg.toolCalls.length > 0) return false;
  if ((msg.thinking || '').trim()) return false;
  const blocks = msg.blocks || [];
  return (
    blocks.length > 0 &&
    blocks.every((b) => b.type === 'context_injection')
  );
}

/** 从消息列表尾部向前查找最新可挂载消息（无则返回 undefined） */
export function findInjectionMountTarget(
  messages: SessionMessage[]
): SessionMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isInjectionMountableMessage(m)) return m;
  }
  return undefined;
}

/**
 * 向目标消息挂载注入项：写 injections（同 id 原地更新防重注入）并补
 * context_injection 块（含 id 即可，载荷经 msg.injections 查表）。
 */
export function appendInjectionToMessage(
  msg: SessionMessage,
  injection: MessageContextInjection
): void {
  if (!msg.injections) msg.injections = [];
  const existingIdx = msg.injections.findIndex((x) => x.id === injection.id);
  if (existingIdx >= 0) {
    msg.injections[existingIdx] = injection;
  } else {
    msg.injections.push(injection);
  }
  if (!msg.blocks) msg.blocks = [];
  const existingBlock = msg.blocks.find(
    (b) => b.type === 'context_injection' && b.id === injection.id
  );
  if (existingBlock) {
    // 幂等更新：刷新块内联载荷（同 id 载荷变更时持久化面同步最新值）
    existingBlock.injection = injection;
  } else {
    // 载荷内联进块（C1 最小改造面）：Rust session_messages 仅持久化
    // blocks_json（无 injections_json 列），内联后重载经 timelineNormalizer
    // 的 `|| b.injection` 回退恢复卡片渲染——零新增 DDL，符合
    // 00-总方案 §三.5「复用 session_messages 表」裁决。
    const block: MessageTimelineBlock = {
      type: 'context_injection',
      id: injection.id,
      injection,
    };
    msg.blocks.push(block);
  }
}

/** 无活跃可挂载消息时创建 assistant 载体消息（id 稳定派生自 injection.id） */
export function makeInjectionCarrierMessage(
  injection: MessageContextInjection
): SessionMessage {
  const carrierId = `ctx-carrier-${injection.id}`;
  return {
    id: carrierId,
    sender: 'assistant',
    text: '',
    timestamp: injection.timestamp,
    injections: [injection],
    // 载荷内联进块（持久化/重载恢复，同 appendInjectionToMessage 注记）
    blocks: [
      { type: 'context_injection', id: injection.id, injection },
    ],
  };
}
