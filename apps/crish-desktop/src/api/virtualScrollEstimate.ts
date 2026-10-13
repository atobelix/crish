/**
 * 虚拟列表估高（JS 常量）。
 * 不得在运行时读取 CSS 变量或 getComputedStyle：估高只是占位，
 * 与 `--chat-row-gap` / `--chat-row-gap-compact` 的默认值用契约测试锁死。
 */
import type { SessionMessage } from '../store/types';
import { isContextStateCarrierMessage } from '../store/storeAccess';

/** 默认行距，对应 `--chat-row-gap` 默认 16。 */
export const CHAT_ROW_GAP_PX = 16;
/** 载体紧凑行距，对应 `--chat-row-gap-compact` 默认 4。 */
export const CHAT_ROW_GAP_COMPACT_PX = 4;
/** 操作栏槽位：margin-top 4 + min-height 28（.userMeta / .assistantMeta 在文档流中占位）。 */
export const META_SLOT_PX = 32;

/**
 * 结构化多步骤消息高度估算模型（误差收敛至 ≤15%）
 */
export function estimateTimelineMessageHeight(msg: SessionMessage): number {
  // PureCarrier：20px 内容 + 紧凑行距。禁止再走 Math.max(h, 100) 保底（DEF-11）。
  if (isContextStateCarrierMessage(msg)) {
    return 20 + CHAT_ROW_GAP_COMPACT_PX;
  }

  // 用户消息：气泡紧凑，单行约 44px，长文按字数折行 + 附件高度
  if (msg.sender === 'user') {
    const len = msg.text?.length || 0;
    const textHeight = Math.max(24, Math.ceil(len / 35) * 20);
    const attachCount =
      (msg.attachments?.length || 0) + (msg.images?.length || 0);
    const attachHeight = attachCount > 0 ? attachCount * 44 : 0;
    return Math.min(
      Math.max(
        textHeight + attachHeight + 4 + META_SLOT_PX + CHAT_ROW_GAP_PX,
        44
      ),
      1000
    );
  }

  // 默认行距 + 操作栏槽位（所有助手行都在正文下方占位，不再是行内浮层）
  let h = CHAT_ROW_GAP_PX + META_SLOT_PX;
  const blocks = msg.blocks || [];

  if (blocks.length > 0) {
    for (const b of blocks) {
      if (b.type === 'thought') {
        const thoughtLen = (b.content || (b as { text?: string }).text || '')
          .length;
        // 思考块：基础头部 36px，预览文字根据长度增加，受折叠视口最大约束 260px
        h += Math.min(36 + Math.ceil(thoughtLen / 45) * 20, 260);
      } else if (b.type === 'tool_call') {
        // 工具卡片：默认折叠状态约 28-36px（展开时约 130px）
        h += 36;
      } else if (b.type === 'context_injection') {
        // 上下文注入卡片紧凑单行约 44px
        h += 44;
      } else if (b.type === 'text') {
        const len = b.content?.length || 0;
        // 文本块：段落垂直节奏与折行，每 35 字符一整行 22px
        h += Math.max(36, 16 + Math.ceil(len / 35) * 22);
      }
    }
  } else {
    // 降级文本估算
    const thinkLen = (msg.thinking || '').trim().length;
    if (thinkLen > 0) {
      h += Math.min(36 + Math.ceil(thinkLen / 45) * 20, 260);
    }
    if (msg.toolCalls?.length) {
      h += msg.toolCalls.length * 36;
    }
    if (msg.injections?.length) {
      h += msg.injections.length * 44;
    }
    const len = msg.text?.length || 0;
    h += Math.max(48, 20 + Math.ceil(len / 35) * 22);
  }

  return Math.min(Math.max(h, 50), 10000);
}

export function normalizeNonNegInt(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return 0;
  return Math.floor(value);
}

export function normalizeNonNegFloat(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return 0;
  return value;
}

export function normalizePositiveFloat(
  value: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return fallback;
  return value;
}
