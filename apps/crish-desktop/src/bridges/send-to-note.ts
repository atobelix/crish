/**
 * send_to_note 薄桥（W5-B · B-06/B-07 · Round6 NoteTransport）
 *
 * surface=chat 完成态 → 显式 Intent → note-paper 写路径
 * （默认 NoteTransport；mock sink 仍兼容）。
 *
 * 纪律（dual-engine-surface §5 / §8.1）：
 * - 唯一允许「知两边」的薄适配；业务组件不得直接互相 import store
 * - 只传 **markdown 字符串快照** + 元数据；禁止 lines[] 引用过桥
 * - 流未完成默认 **拒绝**（assertStreamCompleted）
 * - 失败返回 Result，**不**假装已写树；幂等 intentId 不双插
 * - 禁止 onStreamEnd 静默缝合
 *
 * surface 标注：本模块是跨界桥，非第三权威面。
 * Intent / Mode：契约单源（`@crish/block-paper-contract`）；本文件只 re-export + 构造/派发。
 */

import {
  isSendToNoteIntent,
  type SendToNoteIntent,
  type SendToNoteMode,
} from '@crish/block-paper-contract';
import { resolveNoteTransport, type NoteTransport } from '../api/noteApi';
import {
  EDITOR_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER,
  type EditorSurface,
} from '../components/note-paper/editorSurface';
import { notifyNoteDocWritten } from './note-doc-written';

export type { NoteTransport };

// Surface：契约单源；桌面别名走 editorSurface（禁止本文件再写死字面量）
export {
  EDITOR_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER,
  type EditorSurface,
};

// Intent / Mode：契约单源；守卫同引用 re-export（禁止本文件再写一套形状）
export type { SendToNoteIntent, SendToNoteMode };
export { isSendToNoteIntent };

// ---------------------------------------------------------------------------
// Intent / Result
// ---------------------------------------------------------------------------

export type SendToNoteRejectCode =
  | 'stream_not_completed'
  | 'invalid_markdown'
  | 'invalid_message_id'
  | 'invalid_doc_id'
  | 'sink_reject'
  | 'cancelled';

export type SendToNoteSuccess = {
  ok: true;
  intentId: string;
  /** 是否实际写入（幂等重放时可为 false） */
  applied: boolean;
  /** mock / 后续 RS 返回的块 id */
  blockIds?: string[];
};

export type SendToNoteFailure = {
  ok: false;
  intentId: string;
  code: SendToNoteRejectCode;
  reason: string;
};

export type SendToNoteResult = SendToNoteSuccess | SendToNoteFailure;

// ---------------------------------------------------------------------------
// Sink 契约（可注入 mock；未来接 RS apply_md_fragment）
// ---------------------------------------------------------------------------

export type SendToNoteSinkResult = {
  ok: boolean;
  reason?: string;
  blockIds?: string[];
};

/**
 * 写路径接收端。仅接受已构造的 Intent；不得读 lines[]。
 * 失败时必须保证块树零半写（sink 侧契约）。
 */
export type SendToNoteSink = (
  intent: SendToNoteIntent
) => Promise<SendToNoteSinkResult>;

// ---------------------------------------------------------------------------
// 流完成守卫
// ---------------------------------------------------------------------------

/**
 * 流未完成默认拒绝（§5.4 钉死）。
 * 仅 `completed` 放行；其余（streaming / pending / error / undefined）拒绝。
 */
export function assertStreamCompleted(
  status: string | null | undefined
): { ok: true } | { ok: false; code: 'stream_not_completed'; reason: string } {
  if (status === 'completed') {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'stream_not_completed',
    reason: `send_to_note：流未完成（status=${String(status ?? 'undefined')}），默认拒绝写入笔记`,
  };
}

// ---------------------------------------------------------------------------
// Intent 构造（只接受 markdown 字符串）
// ---------------------------------------------------------------------------

export type BuildSendToNoteInput = {
  messageId: string;
  /**
   * 发送瞬间的 Markdown **字符串快照**。
   * 类型上仅为 string；禁止传入 lines 数组引用（运行时亦拒绝 Array）。
   */
  markdown: string;
  docId: string;
  /** 幂等键；缺省自动生成 */
  intentId?: string;
  mode?: SendToNoteMode;
  origin?: 'user' | 'agent';
  parentId?: string;
  afterBlockId?: string;
};

let intentSeq = 0;

/** 测试用：重置 intentId 序列 */
export function resetSendToNoteIntentSeqForTests(): void {
  intentSeq = 0;
}

function nextIntentId(): string {
  intentSeq += 1;
  return `stn-${Date.now().toString(36)}-${intentSeq}`;
}

export type BuildSendToNoteResult =
  | { ok: true; intent: SendToNoteIntent }
  | { ok: false; code: SendToNoteRejectCode; reason: string; intentId: string };

/**
 * 构造 SendToNoteIntent。
 * - 仅接受 markdown 字符串；Array / 非 string → invalid_markdown
 * - 空 messageId / docId → 对应拒绝码
 * - **不**调用 sink；失败时不假装已写树
 */
export function buildSendToNoteIntent(
  input: BuildSendToNoteInput
): BuildSendToNoteResult {
  const intentId =
    typeof input.intentId === 'string' && input.intentId.length > 0
      ? input.intentId
      : nextIntentId();

  if (typeof input.messageId !== 'string' || input.messageId.length === 0) {
    return {
      ok: false,
      code: 'invalid_message_id',
      reason: 'send_to_note：messageId 必须为非空字符串',
      intentId,
    };
  }

  if (typeof input.docId !== 'string' || input.docId.length === 0) {
    return {
      ok: false,
      code: 'invalid_doc_id',
      reason: 'send_to_note：docId 必须为非空字符串',
      intentId,
    };
  }

  // 硬拒绝 lines[] / 非 string：类型 + 运行时双保险（B-07）
  const md: unknown = input.markdown;
  if (typeof md !== 'string') {
    return {
      ok: false,
      code: 'invalid_markdown',
      reason: Array.isArray(md)
        ? 'send_to_note：禁止传入 lines[] 数组引用；须 markdown 字符串快照'
        : 'send_to_note：markdown 必须为字符串快照',
      intentId,
    };
  }

  const intent: SendToNoteIntent = {
    type: 'send_to_note',
    intentId,
    source: {
      surface: EDITOR_SURFACE_CHAT,
      messageId: input.messageId,
      markdown: md,
    },
    target: {
      surface: EDITOR_SURFACE_NOTE_PAPER,
      docId: input.docId,
      mode: input.mode ?? 'apply_md_fragment',
    },
    origin: input.origin ?? 'user',
  };

  if (input.parentId !== undefined && input.parentId.length > 0) {
    intent.target.parentId = input.parentId;
  }
  if (input.afterBlockId !== undefined && input.afterBlockId.length > 0) {
    intent.target.afterBlockId = input.afterBlockId;
  }

  return { ok: true, intent };
}

// ---------------------------------------------------------------------------
// 派发（幂等 + Result）
// ---------------------------------------------------------------------------

export type DispatchSendToNoteOptions = {
  /** 消息流状态；非 completed 则拒绝（默认守卫） */
  streamStatus?: string | null;
  /**
   * 幂等缓存：intentId → 首次结果。
   * 缺省使用模块内默认 Map（单测可注入独立 Map）。
   */
  idempotencyCache?: Map<string, SendToNoteResult>;
  /**
   * 笔记通路（Round6）。优先于模块默认 transport；
   * 与 `sink` 同时存在时 **sink 优先**（兼容既有 mock）。
   */
  transport?: NoteTransport;
};

const defaultIdempotency = new Map<string, SendToNoteResult>();

/** 测试用：清空默认幂等缓存 */
export function clearSendToNoteIdempotencyForTests(): void {
  defaultIdempotency.clear();
}

function isSendToNoteSink(value: unknown): value is SendToNoteSink {
  return typeof value === 'function';
}

/**
 * 将 NoteTransport 适配为 SendToNoteSink（内部复用；也供 UI 显式注入）。
 */
export function createSinkFromNoteTransport(
  transport: NoteTransport
): SendToNoteSink {
  return async (intent) => {
    const outcome = await transport.sendToNote({
      intentId: intent.intentId,
      markdown: intent.source.markdown,
      docId: intent.target.docId,
      messageId: intent.source.messageId,
      parentId: intent.target.parentId,
      afterBlockId: intent.target.afterBlockId,
      mode: intent.target.mode,
      origin: intent.origin,
    });
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    // 幂等 hit：仍 ok，但 blockIds 来自首次；桥层用 applied 区分
    return { ok: true, blockIds: [...outcome.blockIds] };
  };
}

/**
 * 校验流状态 → 构造 Intent（若未给）或使用已构造 Intent → sink / transport。
 *
 * 调用形态（兼容）：
 * - `dispatchSendToNote(input, sink, options?)` — 既有 mock sink
 * - `dispatchSendToNote(input, options)` — 走 options.transport / 默认 NoteTransport
 * - `dispatchSendToNote(input)` — `resolveNoteTransport` → 模块默认 /
 *   `createDefaultNoteTransport()`（Tauri 真 note_* / 无 Tauri → Memory）
 *
 * 幂等：同 intentId 第二次返回首次结果，不二次写。
 * 单测请 inject sink 或 Memory transport，勿依赖隐式 Tauri。
 */
export async function dispatchSendToNote(
  intentOrInput: SendToNoteIntent | BuildSendToNoteInput,
  sinkOrOptions?: SendToNoteSink | DispatchSendToNoteOptions,
  maybeOptions?: DispatchSendToNoteOptions
): Promise<SendToNoteResult> {
  let sink: SendToNoteSink | undefined;
  let options: DispatchSendToNoteOptions = {};

  if (isSendToNoteSink(sinkOrOptions)) {
    sink = sinkOrOptions;
    options = maybeOptions ?? {};
  } else if (sinkOrOptions && typeof sinkOrOptions === 'object') {
    options = sinkOrOptions;
  }

  // sink 优先；否则 transport → 模块默认 → createDefaultNoteTransport
  const resolvedSink: SendToNoteSink =
    sink ??
    createSinkFromNoteTransport(
      resolveNoteTransport(options.transport ?? null)
    );

  const cache = options.idempotencyCache ?? defaultIdempotency;

  // 先解析 intentId，便于流未完成时仍返回稳定 id
  const peekIntentId = (): string => {
    if (
      intentOrInput &&
      typeof intentOrInput === 'object' &&
      'intentId' in intentOrInput &&
      typeof intentOrInput.intentId === 'string' &&
      intentOrInput.intentId.length > 0
    ) {
      return intentOrInput.intentId;
    }
    return nextIntentId();
  };

  // 流完成守卫（可跳过：若调用方已 assert 且未传 streamStatus）
  if (options.streamStatus !== undefined) {
    const gate = assertStreamCompleted(options.streamStatus);
    if (!gate.ok) {
      return {
        ok: false,
        intentId: peekIntentId(),
        code: gate.code,
        reason: gate.reason,
      };
    }
  }

  let intent: SendToNoteIntent;
  if (
    intentOrInput &&
    typeof intentOrInput === 'object' &&
    'type' in intentOrInput &&
    intentOrInput.type === 'send_to_note'
  ) {
    intent = intentOrInput;
  } else {
    const built = buildSendToNoteIntent(intentOrInput as BuildSendToNoteInput);
    if (!built.ok) {
      return {
        ok: false,
        intentId: built.intentId,
        code: built.code,
        reason: built.reason,
      };
    }
    intent = built.intent;
  }

  // 再次守卫 markdown 形状（防手写 Intent 绕过）
  if (typeof intent.source.markdown !== 'string') {
    return {
      ok: false,
      intentId: intent.intentId,
      code: 'invalid_markdown',
      reason: 'send_to_note：Intent.source.markdown 必须为字符串快照',
    };
  }

  const cached = cache.get(intent.intentId);
  if (cached) {
    // 幂等重放：不二次 sink / transport
    if (cached.ok) {
      return { ...cached, applied: false };
    }
    return { ...cached };
  }

  try {
    const sinkResult = await resolvedSink(intent);
    if (!sinkResult.ok) {
      const fail: SendToNoteFailure = {
        ok: false,
        intentId: intent.intentId,
        code: 'sink_reject',
        reason: sinkResult.reason ?? 'send_to_note：sink 拒绝（块树应零半写）',
      };
      // 失败缓存：避免 sink 侧副作用重试；调用方可 clear 后换 id 重试
      cache.set(intent.intentId, fail);
      return fail;
    }

    const success: SendToNoteSuccess = {
      ok: true,
      intentId: intent.intentId,
      applied: true,
    };
    if (sinkResult.blockIds !== undefined) {
      success.blockIds = [...sinkResult.blockIds];
    }
    cache.set(intent.intentId, success);
    // CONN-G1：写后通知同 doc Strict hydrate 读回（幂等重放 applied=false 不通知）
    notifyNoteDocWritten({
      docId: intent.target.docId,
      intentId: intent.intentId,
      source: 'send_to_note',
    });
    return success;
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.message
        : `send_to_note：sink 抛错（${String(err)}）`;
    const fail: SendToNoteFailure = {
      ok: false,
      intentId: intent.intentId,
      code: 'sink_reject',
      reason,
    };
    cache.set(intent.intentId, fail);
    return fail;
  }
}

// ---------------------------------------------------------------------------
// Mock sink（成功 / 失败可配置）— 实现拆至 send-to-note-mock-sink.ts
// ---------------------------------------------------------------------------

export type { MockSendToNoteSink } from './send-to-note-mock-sink';
export { createMockSendToNoteSink } from './send-to-note-mock-sink';
