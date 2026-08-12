/**
 * note-doc-written — 笔记写后读回通知总线（CONN-G1）
 *
 * 目的：`send_to_note` 成功写入后，同 docId 的 Strict 轨 hydrate
 * 可自动 reload（refresh 语义），**不**改 StrictPanel JSX 结构。
 *
 * 纪律：
 * - 本模块仅 pub/sub；**不**持有块树权威
 * - 仅写成功且实际 applied 时由桥层 notify（幂等重放 / 流未完成 / sink 拒 **不** 通知）
 * - note-paper 只读订阅；chat 不经本总线写树
 *
 * 诚实边界：
 * - **≠ EL-08**；**≠ EL-01**；**≠ 打开完成（G-HYD）**
 * - Skeleton 双轨保留（本总线默认只接 Strict hydrate）
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type NoteDocWrittenSource = 'send_to_note';

/** 写成功后的轻量事件（跨 chat→note 读回触发） */
export type NoteDocWrittenEvent = {
  /** 被写入的文档 id */
  docId: string;
  /** 可选：幂等 intentId（审计 / 调试） */
  intentId?: string;
  /** 写路径来源；CONN-G1 现仅 send_to_note */
  source: NoteDocWrittenSource;
};

export type NoteDocWrittenListener = (event: NoteDocWrittenEvent) => void;

// ---------------------------------------------------------------------------
// 总线（模块级；单测可 clear）
// ---------------------------------------------------------------------------

const listeners = new Set<NoteDocWrittenListener>();

/**
 * 订阅笔记写成功事件。
 * @returns 取消订阅函数（Strict hydrate mount 时挂载、unmount 时调用）
 */
export function subscribeNoteDocWritten(
  listener: NoteDocWrittenListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 通知同 doc 读回侧：写已 applied。
 * 桥层在 dispatchSendToNote 成功且 applied=true 时调用。
 */
export function notifyNoteDocWritten(event: NoteDocWrittenEvent): void {
  if (typeof event.docId !== 'string' || event.docId.length === 0) {
    return;
  }
  // 快照迭代，避免 listener 内 unsub 改 Set 导致漏调
  const snapshot = [...listeners];
  for (const listener of snapshot) {
    try {
      listener(event);
    } catch (err) {
      // 单 listener 故障不得阻断其它 Strict 实例读回
      console.error('[note-doc-written] listener error:', err);
    }
  }
}

/** 测试用：清空全部订阅（防测间泄漏） */
export function clearNoteDocWrittenListenersForTests(): void {
  listeners.clear();
}

/** 测试用：当前订阅数 */
export function noteDocWrittenListenerCountForTests(): number {
  return listeners.size;
}
