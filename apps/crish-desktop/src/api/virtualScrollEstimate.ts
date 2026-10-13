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

/** PureCarrier 消息内容基线高度（px，对齐 DEF-11） */
export const ESTIMATE_CARRIER_CONTENT_PX = 20;

/** 用户消息单行最小高度（px） */
export const ESTIMATE_USER_MIN_ROW_PX = 44;
/** 用户消息行高（px） */
export const ESTIMATE_USER_LINE_HEIGHT_PX = 20;
/** 用户消息单行字数折行基准 */
export const ESTIMATE_USER_CHARS_PER_LINE = 35;
/** 用户消息单项附件估高（px） */
export const ESTIMATE_ATTACHMENT_ITEM_HEIGHT_PX = 44;
/** 用户消息最大高度截断保护（px） */
export const ESTIMATE_USER_MAX_HEIGHT_PX = 1000;
/** 用户消息正文与附件间距（px） */
export const ESTIMATE_USER_ATTACHMENT_GAP_PX = 4;

/** 思维链折叠行高度（px，严格与 ReasoningRow.module.css 24px 硬件级隔离对齐，DIM-03 §1.1） */
export const ESTIMATE_COLLAPSED_THOUGHT_HEIGHT_PX = 24;
/** 工具调用卡片折叠态基础高度（px，与 FoldableToolGroup 严格同构） */
export const ESTIMATE_COLLAPSED_TOOL_HEIGHT_PX = 36;
/** 结构化文本块内边距与垂直节奏底值（px） */
export const ESTIMATE_TEXT_BLOCK_PADDING_PX = 8;
/** 降级非结构化纯文本行垂直衬垫补偿（px） */
export const ESTIMATE_FALLBACK_TEXT_PADDING_PX = 12;
/** 上下文注入状态条基础高度（px） */
export const ESTIMATE_CONTEXT_INJECTION_HEIGHT_PX = 44;
/** Markdown 正文文本行高（px） */
export const ESTIMATE_TEXT_LINE_HEIGHT_PX = 22;
/** 正文文本平均每行字符数折行基准 */
export const ESTIMATE_TEXT_CHARS_PER_LINE = 38;
/** 助手消息单项最小保底高度（px） */
export const ESTIMATE_ASSISTANT_MIN_HEIGHT_PX = 50;
/** 单条消息估算最大保护上限（px） */
export const ESTIMATE_MESSAGE_MAX_HEIGHT_PX = 10000;

/**
 * 结构化多步骤消息高度估算模型（误差收敛至 ≤15%）
 */
export function estimateTimelineMessageHeight(msg: SessionMessage): number {
  // PureCarrier：20px 内容 + 紧凑行距。禁止再走 Math.max(h, 100) 保底（DEF-11）。
  if (isContextStateCarrierMessage(msg)) {
    return ESTIMATE_CARRIER_CONTENT_PX + CHAT_ROW_GAP_COMPACT_PX;
  }

  // 用户消息：气泡紧凑，单行约 44px，长文按字数折行 + 附件高度
  if (msg.sender === 'user') {
    const text = msg.text || '';
    const lines = text ? text.split('\n') : [];
    let visualLines = 0;
    for (const line of lines) {
      visualLines += Math.max(
        1,
        Math.ceil(line.length / ESTIMATE_USER_CHARS_PER_LINE)
      );
    }
    const textHeight = Math.max(
      ESTIMATE_USER_LINE_HEIGHT_PX,
      visualLines * ESTIMATE_USER_LINE_HEIGHT_PX
    );
    const attachCount =
      (msg.attachments?.length || 0) + (msg.images?.length || 0);
    const attachHeight =
      attachCount > 0 ? attachCount * ESTIMATE_ATTACHMENT_ITEM_HEIGHT_PX : 0;
    return Math.min(
      Math.max(
        textHeight +
          attachHeight +
          ESTIMATE_USER_ATTACHMENT_GAP_PX +
          META_SLOT_PX +
          CHAT_ROW_GAP_PX,
        ESTIMATE_USER_MIN_ROW_PX
      ),
      ESTIMATE_USER_MAX_HEIGHT_PX
    );
  }

  // 默认行距 + 操作栏槽位（所有助手行都在正文下方占位，不再是行内浮层）
  let h = CHAT_ROW_GAP_PX + META_SLOT_PX;
  const blocks = msg.blocks || [];

  if (blocks.length > 0) {
    for (const b of blocks) {
      if (b.type === 'thought') {
        // 思考块：默认收起折叠状态严格为 24px (DIM-03 §1.1)
        h += ESTIMATE_COLLAPSED_THOUGHT_HEIGHT_PX;
      } else if (b.type === 'tool_call') {
        // 工具卡片：默认折叠状态约 28-36px（展开时约 130px）
        h += ESTIMATE_COLLAPSED_TOOL_HEIGHT_PX;
      } else if (b.type === 'context_injection') {
        // 上下文注入卡片紧凑单行约 44px
        h += ESTIMATE_CONTEXT_INJECTION_HEIGHT_PX;
      } else if (b.type === 'text') {
        const text = b.content || (b as { text?: string }).text || '';
        const lines = text ? text.split('\n') : [];
        let visualLines = 0;
        for (const line of lines) {
          visualLines += Math.max(
            1,
            Math.ceil(line.length / ESTIMATE_TEXT_CHARS_PER_LINE)
          );
        }
        // 文本块：段落垂直节奏与折行
        h += Math.max(
          ESTIMATE_COLLAPSED_TOOL_HEIGHT_PX - ESTIMATE_TEXT_BLOCK_PADDING_PX,
          ESTIMATE_TEXT_BLOCK_PADDING_PX +
            visualLines * ESTIMATE_TEXT_LINE_HEIGHT_PX
        );
      }
    }
  } else {
    // 降级文本估算
    const thinkLen = (msg.thinking || '').trim().length;
    if (thinkLen > 0) {
      h += ESTIMATE_COLLAPSED_THOUGHT_HEIGHT_PX;
    }
    if (msg.toolCalls?.length) {
      h += msg.toolCalls.length * ESTIMATE_COLLAPSED_TOOL_HEIGHT_PX;
    }
    if (msg.injections?.length) {
      h += msg.injections.length * ESTIMATE_CONTEXT_INJECTION_HEIGHT_PX;
    }
    const text = msg.text || '';
    const lines = text ? text.split('\n') : [];
    let visualLines = 0;
    for (const line of lines) {
      visualLines += Math.max(
        1,
        Math.ceil(line.length / ESTIMATE_TEXT_CHARS_PER_LINE)
      );
    }
    h += Math.max(
      ESTIMATE_COLLAPSED_TOOL_HEIGHT_PX,
      ESTIMATE_FALLBACK_TEXT_PADDING_PX +
        visualLines * ESTIMATE_TEXT_LINE_HEIGHT_PX
    );
  }

  return Math.min(
    Math.max(h, ESTIMATE_ASSISTANT_MIN_HEIGHT_PX),
    ESTIMATE_MESSAGE_MAX_HEIGHT_PX
  );
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
