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

/** 判定注入项是否为 context-state 纯状态微提示 */
export function isContextStateInjection(
  injection: Partial<MessageContextInjection> | undefined
): boolean {
  if (!injection) return false;
  const meta = injection.metadata as Record<string, unknown> | undefined;
  if (meta?.mode === 'context-state') {
    return true;
  }
  const title = injection.title || '';
  return title === '上下文状态切换' || title === '状态切换';
}

/**
 * 判定消息是否为纯上下文状态切换载体消息（PureCarrier）。
 * 必须满足全称命题：除了合法的 context-state 注入项外，绝对不包含任何有效业务数据。
 */
export function isContextStateCarrierMessage(
  msg: SessionMessage | undefined | null
): boolean {
  if (!msg || msg.sender !== 'assistant') return false;

  // 1. 基础消息正文与流式内容防御：若存在非空正文，绝非纯载体
  if ((msg.text || '').trim().length > 0) return false;

  // 2. 工具调用防御：若包含任何工具调用记录，绝非纯载体
  if (msg.toolCalls && msg.toolCalls.length > 0) return false;

  // 3. 深度推理思维链防御：若包含传统思考字段或多轮思考数组，绝非纯载体
  if ((msg.thinking || '').trim().length > 0) return false;
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) return false;

  // 4. 多模态资产与附件防御：若包含图片或文件附件，绝非纯载体
  if (msg.images && msg.images.length > 0) return false;
  if (msg.attachments && msg.attachments.length > 0) return false;

  // 5. 错误诊断信息防御：若包含运行时错误详情，绝非纯载体
  if (msg.errorDetail) return false;

  const blocks = msg.blocks || [];
  const injections = msg.injections || [];
  const hasBlocks = blocks.length > 0;
  const hasInjections = injections.length > 0;

  // 6. 空白消息防御：既无 blocks 也无 injections 的完全空消息不是合法状态载体
  if (!hasBlocks && !hasInjections) return false;

  // 7. Blocks 纯度验证：若存在 blocks，所有块必须是 context_injection 类型
  if (hasBlocks && !blocks.every((b) => b.type === 'context_injection')) {
    return false;
  }

  // 8. 容错查表与 injections 纯度全称命题验证（杜绝 .some() 误伤）
  const allInjectionsState =
    !hasInjections || injections.every((inj) => isContextStateInjection(inj));

  const allBlocksState =
    !hasBlocks ||
    blocks.every((b) => {
      // 容错查表：如果 b.injection 未展开内联，到 msg.injections 中按 id 索引
      const inj = b.injection || injections.find((i) => i.id === b.id);
      return isContextStateInjection(inj);
    });

  // 必须合取：两者均满足 context-state 纯度
  return allBlocksState && allInjectionsState;
}

/** 判定消息是否为注入卡片可挂载宿主（「最新可挂载消息」语义） */
export function isInjectionMountableMessage(
  msg: SessionMessage | undefined
): boolean {
  if (!msg || msg.sender !== 'assistant') return false;
  // 进行中的助手消息：注入随当前 Turn 进入上下文
  if (msg.status === 'processing' || msg.status === 'queued') return true;
  // 已收口消息不回溯改写（但若该消息仅为纯 context-state 注入载体，支持原地更新复用）
  if (msg.status === 'completed' || msg.status === 'error') {
    return isContextStateCarrierMessage(msg);
  }
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

/**
 * 从消息列表尾部向前查找最新可挂载消息（无则返回 undefined）。
 * 若最新载体消息仅承载过时的 context-state，支持原地替换复用，
 * 保证整个会话在同一轮次中仅保留最新生效的状态，根除多次切换模型造成的堆叠。
 */
export function findInjectionMountTarget(
  messages: SessionMessage[]
): SessionMessage | undefined {
  if (messages.length === 0) return undefined;

  // 会话最新尾部消息：如果仅承载过时的 context-state，优先原地替换复用
  const lastMsg = messages[messages.length - 1];
  if (isContextStateCarrierMessage(lastMsg)) {
    return lastMsg;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.sender === 'user') break;
    if (isInjectionMountableMessage(m)) return m;
  }
  return undefined;
}

/**
 * 向目标消息挂载注入项：
 * - context-state 注入项：执行原地覆盖更新（Replace/Update in-place），杜绝
 *   在同一宿主消息中连续追加多条陈旧、过时的模型切换记录；
 * - 常规注入项：写 injections（同 id 原地更新防重注入）并补 context_injection 块。
 */
export function appendInjectionToMessage(
  msg: SessionMessage,
  injection: MessageContextInjection
): void {
  if (!msg.injections) msg.injections = [];
  if (!msg.blocks) msg.blocks = [];

  const isContextState = isContextStateInjection(injection);

  if (isContextState) {
    // 状态切换元数据原地更新防堆叠（解决 5 条连续堆叠的根本病灶）：
    // 检查宿主消息既有 injections / blocks，若已有 mode === 'context-state'，执行原地覆盖更新
    const existingIdx = msg.injections.findIndex(
      (x) => x.id === injection.id || isContextStateInjection(x)
    );
    let oldId: string | undefined;
    if (existingIdx >= 0) {
      oldId = msg.injections[existingIdx]?.id;
      const prevInj = msg.injections[existingIdx];
      const mergedMetadata = {
        ...(prevInj?.metadata || {}),
        ...(injection.metadata || {}),
      };
      msg.injections[existingIdx] = {
        ...prevInj,
        ...injection,
        metadata: mergedMetadata,
      };
      // 清理可能存在的历史重复 context-state 注入项
      msg.injections = msg.injections.filter(
        (x, idx) => idx === existingIdx || !isContextStateInjection(x)
      );
    } else {
      msg.injections.push(injection);
    }

    const existingBlockIdx = msg.blocks.findIndex(
      (b) =>
        b.type === 'context_injection' &&
        (b.id === injection.id ||
          (oldId !== undefined && b.id === oldId) ||
          isContextStateInjection(b.injection))
    );

    if (existingBlockIdx >= 0) {
      const prevBlock = msg.blocks[existingBlockIdx];
      const prevInj = prevBlock?.injection;
      const mergedInj: MessageContextInjection = {
        ...(prevInj || injection),
        ...injection,
        metadata: {
          ...(prevInj?.metadata || {}),
          ...(injection.metadata || {}),
        },
      };
      msg.blocks[existingBlockIdx] = {
        ...prevBlock,
        type: 'context_injection',
        id: injection.id,
        injection: mergedInj,
      };
      // 清理可能存在的历史重复 context-state 块
      msg.blocks = msg.blocks.filter(
        (b, idx) =>
          idx === existingBlockIdx ||
          !(b.type === 'context_injection' && isContextStateInjection(b.injection))
      );
    } else {
      msg.blocks.push({
        type: 'context_injection',
        id: injection.id,
        injection,
      });
    }
    // 浅拷贝确保 React.memo / selector 比对感知更新
    msg.injections = [...msg.injections];
    msg.blocks = [...msg.blocks];
    return;
  }

  // 常规注入项（非 context-state）：按 id 幂等更新
  const existingIdx = msg.injections.findIndex((x) => x.id === injection.id);
  if (existingIdx >= 0) {
    msg.injections[existingIdx] = injection;
  } else {
    msg.injections.push(injection);
  }

  const existingBlock = msg.blocks.find(
    (b) => b.type === 'context_injection' && b.id === injection.id
  );
  if (existingBlock) {
    existingBlock.injection = injection;
  } else {
    const block: MessageTimelineBlock = {
      type: 'context_injection',
      id: injection.id,
      injection,
    };
    msg.blocks.push(block);
  }
  msg.injections = [...msg.injections];
  msg.blocks = [...msg.blocks];
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
