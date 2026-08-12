/**
 * note-doc-written — 笔记写后读回通知总线（CONN-G1 / CONN-G2）
 *
 * 目的：笔记写路径成功 applied 后，同 docId 的 Strict 轨 hydrate
 * 可自动 reload（refresh 语义），**不**改 StrictPanel JSX 结构。
 *
 * ## 写路径 → source（钉清）
 * | source | 写路径 | 通知条件 |
 * |--------|--------|----------|
 * | `send_to_note` | chat → note 桥 `dispatchSendToNote` | sink 成功且 applied=true（幂等重放不通知） |
 * | `product_apply` | 产品 `note_apply_ops` 适配（slash / mdPrefix 共用后端） | IPC ok 且 applied>0 |
 *
 * ## 纪律
 * - 本模块仅 pub/sub；**不**持有块树权威
 * - 仅写成功且实际 applied 时由桥层 / 产品 apply 适配 notify
 *   （幂等重放 / 流未完成 / sink 拒 / applied=0 **不** 通知）
 * - note-paper 只读订阅；chat 不经本总线写树
 *
 * ## 诚实边界
 * - **≠ EL-08**；**≠ EL-01**；**≠ 打开完成（G-HYD）**
 * - Skeleton 双轨保留（本总线默认只接 Strict hydrate）
 * - 本总线 **≠** 假关打开完成；写后读回 ≠ 权威已同步证明
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 写成功来源（CONN-G1/G2）。
 * - `send_to_note`：chat 投递笔记（G1）
 * - `product_apply`：产品 Strict apply（`note_apply_ops` / slash·mdPrefix 写锥后端，G2）
 *
 * 扩展纪律：新写路径成功 applied 后须 notify 并在此枚举钉清；
 * 禁止静默写树却不发总线（Strict 投影会旧）。
 */
export type NoteDocWrittenSource = 'send_to_note' | 'product_apply';

/** 写成功后的轻量事件（跨 chat→note / 产品 apply→Strict 读回触发） */
export type NoteDocWrittenEvent = {
  /** 被写入的文档 id */
  docId: string;
  /** 可选：幂等 intentId（审计 / 调试） */
  intentId?: string;
  /** 写路径来源；见 `NoteDocWrittenSource` 表 */
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
 * - G1：桥层在 dispatchSendToNote 成功且 applied=true 时调用
 * - G2：`adaptNoteApplyOpsIpcAsApplyOps` 在 IPC ok 且 applied>0 时调用
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
