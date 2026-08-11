/**
 * send_to_note 薄桥（W5-B · B-06/B-07）
 *
 * surface=chat 完成态 → 显式 Intent → note-paper 写路径（mock sink 可测）。
 *
 * 纪律（dual-engine-surface §5 / §8.1）：
 * - 唯一允许「知两边」的薄适配；业务组件不得直接互相 import store
 * - 只传 **markdown 字符串快照** + 元数据；禁止 lines[] 引用过桥
 * - 流未完成默认 **拒绝**（assertStreamCompleted）
 * - 失败返回 Result，**不**假装已写树；幂等 intentId 不双插
 * - 禁止 onStreamEnd 静默缝合
 *
 * surface 标注：本模块是跨界桥，非第三权威面。
 */

// ---------------------------------------------------------------------------
// Surface 常量（本地；若 contract 后续导出 EditorSurface 可对齐替换）
// ---------------------------------------------------------------------------

export const EDITOR_SURFACE_CHAT = 'chat' as const;
export const EDITOR_SURFACE_NOTE_PAPER = 'note-paper' as const;

export type EditorSurface =
  typeof EDITOR_SURFACE_CHAT | typeof EDITOR_SURFACE_NOTE_PAPER;

// ---------------------------------------------------------------------------
// Intent / Result
// ---------------------------------------------------------------------------

export type SendToNoteMode =
  'insert_blocks' | 'apply_md_fragment' | 'append_to_block';

/** surface=chat 完成态 → 请求写入 note-paper；不得隐式触发 */
export type SendToNoteIntent = {
  type: 'send_to_note';
  /** 幂等键：重复提交不双插 */
  intentId: string;
  source: {
    surface: typeof EDITOR_SURFACE_CHAT;
    messageId: string;
    /** 发送瞬间的 MD 快照；禁止持有 lines[] 引用过桥 */
    markdown: string;
  };
  target: {
    surface: typeof EDITOR_SURFACE_NOTE_PAPER;
    docId: string;
    parentId?: string;
    afterBlockId?: string;
    mode: SendToNoteMode;
  };
  origin: 'user' | 'agent';
};

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
};

const defaultIdempotency = new Map<string, SendToNoteResult>();

/** 测试用：清空默认幂等缓存 */
export function clearSendToNoteIdempotencyForTests(): void {
  defaultIdempotency.clear();
}

/**
 * 校验流状态 → 构造 Intent（若未给）或使用已构造 Intent → sink。
 * 幂等：同 intentId 第二次返回首次结果，不二次 sink。
 */
export async function dispatchSendToNote(
  intentOrInput: SendToNoteIntent | BuildSendToNoteInput,
  sink: SendToNoteSink,
  options: DispatchSendToNoteOptions = {}
): Promise<SendToNoteResult> {
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
    // 幂等重放：不二次 sink
    if (cached.ok) {
      return { ...cached, applied: false };
    }
    return { ...cached };
  }

  try {
    const sinkResult = await sink(intent);
    if (!sinkResult.ok) {
      const fail: SendToNoteFailure = {
        ok: false,
        intentId: intent.intentId,
        code: 'sink_reject',
        reason: sinkResult.reason ?? 'send_to_note：sink 拒绝（块树应零半写）',
      };
      // 失败不缓存为成功；可选缓存失败以便同 id 重放同一错误——此处缓存失败，
      // 避免 sink 侧副作用重试；调用方可 clear 后换 id 重试
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
// Mock sink（成功 / 失败可配置）
// ---------------------------------------------------------------------------

export type MockSendToNoteSink = {
  sink: SendToNoteSink;
  calls: SendToNoteIntent[];
  results: SendToNoteSinkResult[];
  setResult: (result: SendToNoteSinkResult) => void;
  clear: () => void;
};

/**
 * 可审计 mock sink：默认成功；`setResult` 切换失败态。
 * **不**写真实块树。
 */
export function createMockSendToNoteSink(
  initialResult: SendToNoteSinkResult = { ok: true, blockIds: ['mock-b-0001'] }
): MockSendToNoteSink {
  const calls: SendToNoteIntent[] = [];
  const results: SendToNoteSinkResult[] = [];
  let current: SendToNoteSinkResult = { ...initialResult };
  if (initialResult.blockIds) {
    current.blockIds = [...initialResult.blockIds];
  }

  const sink: SendToNoteSink = async (intent) => {
    // 深拷贝 markdown 字符串，证明不持有调用方可变缓冲引用意图
    calls.push({
      ...intent,
      source: { ...intent.source, markdown: String(intent.source.markdown) },
      target: { ...intent.target },
    });
    const r: SendToNoteSinkResult = { ok: current.ok };
    if (current.reason !== undefined) r.reason = current.reason;
    if (current.blockIds !== undefined) r.blockIds = [...current.blockIds];
    results.push(r);
    return r;
  };

  return {
    sink,
    calls,
    results,
    setResult(result) {
      current = { ok: result.ok };
      if (result.reason !== undefined) current.reason = result.reason;
      else delete current.reason;
      if (result.blockIds !== undefined)
        current.blockIds = [...result.blockIds];
      else delete current.blockIds;
    },
    clear() {
      calls.length = 0;
      results.length = 0;
    },
  };
}
