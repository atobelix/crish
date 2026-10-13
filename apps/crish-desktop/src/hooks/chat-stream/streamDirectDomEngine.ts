/**
 * StreamDirect 双轨直通流式引擎（DOM-Bypass Pipeline）。
 *
 * 落实《00-前端性能全景优化总方案》§三.1 与 Wave 4 (W4-1)：
 * 在活跃尾部助手消息流式输出期间，Token 追加 100% 绕过 React 调度器与 VDOM 调和，
 * 直通底层原生 DOM `Text.prototype.appendData`，单次追加时间复杂度严格为 O(delta.length)。
 */

export const STREAM_DIRECT_DEFAULT_MAX_SLOTS = 256;

export interface StreamDirectEngineOptions {
  /** 最大并发驻留槽位数（长会话资源有界性红线，默认 256） */
  maxSlots?: number;
}

interface StreamDirectSlot {
  readonly sessionId: string;
  readonly messageId: string;
  accumulatedText: string;
  readonly targets: Set<Text>;
  chunkCount: number;
}

/**
 * 生成 StreamDirect 复合作用域键：`${sessionId}::${messageId}`。
 */
export function makeStreamDirectScopeKey(
  sessionId: string,
  messageId: string
): string {
  return `${sessionId}::${messageId}`;
}

export class StreamDirectDomEngine {
  private readonly maxSlots: number;
  private readonly slots = new Map<string, StreamDirectSlot>();
  private readonly sessionScopes = new Map<string, Set<string>>();

  public constructor(options?: StreamDirectEngineOptions) {
    const configured = options?.maxSlots ?? STREAM_DIRECT_DEFAULT_MAX_SLOTS;
    this.maxSlots =
      configured > 0 ? configured : STREAM_DIRECT_DEFAULT_MAX_SLOTS;
  }

  /**
   * 注册活跃流式消息的底层 DOM `Text` 节点。
   * - 若影子缓冲中已有累积文本，立即同步对齐 `textNode.data`；
   * - 若槽位为空且传入了 `initialContent`，则以 `initialContent` 初始化影子缓冲并同步 `textNode.data`；
   * - 返回幂等的注销函数。
   */
  public registerTarget(
    sessionId: string,
    messageId: string,
    textNode: Text,
    initialContent?: string
  ): () => void {
    if (!sessionId || !messageId || !textNode) {
      return () => {};
    }

    const key = makeStreamDirectScopeKey(sessionId, messageId);
    let slot = this.slots.get(key);

    if (!slot) {
      this.enforceSlotCapacity();
      slot = {
        sessionId,
        messageId,
        accumulatedText: initialContent ?? '',
        targets: new Set<Text>(),
        chunkCount: 0,
      };
      this.slots.set(key, slot);
      this.indexSessionKey(sessionId, key);
    } else if (slot.accumulatedText.length === 0 && initialContent) {
      slot.accumulatedText = initialContent;
    }

    // 清理该槽位中已脱离 DOM 树的陈旧节点，防止分屏切换或重挂载残留
    for (const existing of slot.targets) {
      if (existing !== textNode && !existing.isConnected) {
        slot.targets.delete(existing);
      }
    }

    slot.targets.add(textNode);

    if (textNode.data !== slot.accumulatedText) {
      textNode.data = slot.accumulatedText;
    }

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = this.slots.get(key);
      if (!current) return;
      current.targets.delete(textNode);
      if (
        current.targets.size === 0 &&
        current.accumulatedText.length === 0 &&
        current.chunkCount === 0
      ) {
        this.removeSlotByKey(key, sessionId);
      }
    };
  }

  /**
   * 将增量 `delta` 追加到内存影子缓冲，并对所有已注册且仍连接在 DOM（`textNode.isConnected`）
   * 的 `Text` 节点直接调用原生 `textNode.appendData(delta)`（O(delta.length)，0 次 React VDOM 调和）。
   *
   * @returns 是否命中至少一个处于连接状态的直通 `Text` 目标节点
   */
  public appendChunk(
    sessionId: string,
    messageId: string,
    delta: string
  ): boolean {
    if (!sessionId || !messageId) return false;

    const key = makeStreamDirectScopeKey(sessionId, messageId);
    let slot = this.slots.get(key);
    if (!slot) {
      this.enforceSlotCapacity();
      slot = {
        sessionId,
        messageId,
        accumulatedText: delta || '',
        targets: new Set<Text>(),
        chunkCount: delta ? 1 : 0,
      };
      this.slots.set(key, slot);
      this.indexSessionKey(sessionId, key);
      return false;
    }

    if (delta.length > 0) {
      slot.accumulatedText += delta;
      slot.chunkCount += 1;
    }

    if (slot.targets.size === 0) return false;

    let hitConnectedTarget = false;
    for (const node of slot.targets) {
      if (!node.isConnected) {
        slot.targets.delete(node);
        continue;
      }
      if (delta.length > 0) {
        node.appendData(delta);
      }
      hitConnectedTarget = true;
    }

    return hitConnectedTarget;
  }

  /**
   * 获取当前累积的完整文本（供组件中途重挂载或虚拟滚动回滚入视口时无损恢复）。
   */
  public getAccumulatedText(sessionId: string, messageId: string): string {
    if (!sessionId || !messageId) return '';
    return (
      this.slots.get(makeStreamDirectScopeKey(sessionId, messageId))
        ?.accumulatedText ?? ''
    );
  }

  /**
   * 流结束（Finish）时配合双轨锁存交接协议，返回最终完整文本并释放目标集合与内存缓冲。
   * 注意：释放引用时不清空底层 `TextNode.data`，由 React 持久层单次渲染平滑接管，杜绝单帧白屏闪烁。
   */
  public commitAndRelease(sessionId: string, messageId: string): string {
    if (!sessionId || !messageId) return '';
    const key = makeStreamDirectScopeKey(sessionId, messageId);
    const slot = this.slots.get(key);
    if (!slot) return '';

    const finalText = slot.accumulatedText;
    for (const node of slot.targets) {
      if (node.isConnected && node.data !== finalText) {
        node.data = finalText;
      }
    }
    slot.targets.clear();
    this.removeSlotByKey(key, sessionId);
    return finalText;
  }

  /**
   * 配合三级级联取消总线（Cascade Cancellation Bus），当会话被删除或中止时
   * 一键清理该会话所有流式直通槽位与 DOM 节点引用。
   */
  public abortSession(sessionId: string): void {
    if (!sessionId) return;
    const keys = this.sessionScopes.get(sessionId);
    if (keys) {
      for (const key of keys) {
        this.slots.get(key)?.targets.clear();
        this.slots.delete(key);
      }
      this.sessionScopes.delete(sessionId);
    }
  }

  /**
   * 查询指定消息槽位当前已注册的 `Text` 节点数量（默认自动剔除已断连节点）。
   */
  public getTargetCount(
    sessionId: string,
    messageId: string,
    pruneDisconnected = true
  ): number {
    if (!sessionId || !messageId) return 0;
    const slot = this.slots.get(makeStreamDirectScopeKey(sessionId, messageId));
    if (!slot) return 0;
    if (pruneDisconnected) {
      for (const node of slot.targets) {
        if (!node.isConnected) slot.targets.delete(node);
      }
    }
    return slot.targets.size;
  }

  /**
   * 判断指定消息槽位是否存在内存影子缓冲记录。
   */
  public hasSlot(sessionId: string, messageId: string): boolean {
    if (!sessionId || !messageId) return false;
    return this.slots.has(makeStreamDirectScopeKey(sessionId, messageId));
  }

  /**
   * 获取指定会话下的活跃流式槽位数量。
   */
  public getSessionSlotCount(sessionId: string): number {
    if (!sessionId) return 0;
    return this.sessionScopes.get(sessionId)?.size ?? 0;
  }

  /**
   * 清空全部直通槽位（用于测试隔离或全局重置）。
   */
  public clearAll(): void {
    for (const [, slot] of this.slots) {
      slot.targets.clear();
    }
    this.slots.clear();
    this.sessionScopes.clear();
  }

  private indexSessionKey(sessionId: string, key: string): void {
    let set = this.sessionScopes.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.sessionScopes.set(sessionId, set);
    }
    set.add(key);
  }

  private removeSlotByKey(key: string, sessionId: string): void {
    this.slots.delete(key);
    const set = this.sessionScopes.get(sessionId);
    if (set) {
      set.delete(key);
      if (set.size === 0) this.sessionScopes.delete(sessionId);
    }
  }

  private enforceSlotCapacity(): void {
    if (this.slots.size < this.maxSlots) return;

    for (const [key, slot] of this.slots) {
      let hasConnected = false;
      for (const node of slot.targets) {
        if (node.isConnected) {
          hasConnected = true;
        } else {
          slot.targets.delete(node);
        }
      }
      if (!hasConnected) {
        slot.targets.clear();
        this.removeSlotByKey(key, slot.sessionId);
        if (this.slots.size < this.maxSlots) return;
      }
    }

    const oldestKey = this.slots.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = this.slots.get(oldestKey);
      if (oldest) {
        oldest.targets.clear();
        this.removeSlotByKey(oldestKey, oldest.sessionId);
      }
    }
  }
}

/**
 * 全局共享的 StreamDirect 双轨直通流式引擎默认单例。
 */
export const streamDirectEngine = new StreamDirectDomEngine();
