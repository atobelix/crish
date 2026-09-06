/**
 * 跨会话滚动位置与视口记忆恢复注册表 (chatScrollRegistry)
 *
 * 依据: docs/linear-chat-stream-convergence/03-维度详案-单一滚动宿主与PagingAnchor视口防抖.md §1.4, §1.5
 * 遵循: docs/linear-chat-stream-convergence/00-线性对话流与极简交互系统重构总方案.md
 *
 * 核心设计特性:
 * 1. 契约精简与 SSOT:
 *    - SessionScrollSnapshot 承载视口物理偏移 (scrollTop)、语义锚点 (observedTopKey, observedTopOffset)、吸底标志 (isAtBottom) 与时间戳。
 * 2. 内存安全与 LRU 自动淘汰:
 *    - 内置基于原生 Map 插入时序的严格 O(1) LRU 机制（默认上限 50 个活跃会话）。
 *    - 访问（读取 / 写入）时自动重排至最新；容量满额时自动逐出最久未访问会话条目，杜绝多会话长期运行下的内存泄漏。
 * 3. Live 流式生成态状态判定与优先贴底:
 *    - 提供 isSessionLive(sessionId) 接口，支持内部 Set 标记及外部 Predicate 注入。
 *    - 若会话处于 live 流式进行中，切回恢复时优先推荐贴底 (isAtBottom = true)，保证最新流式 Token 与思考链实时可见；
 *    - 若为静态历史会话，返回精确快照，实现 0 像素跳动的无损定位。
 * 4. 纯函数与单例双模导出:
 *    - 提供 saveSessionScroll, restoreSessionScroll, clearSessionScroll, clearAllSessionScroll, isSessionLive 等纯函数，同时导出 chatScrollRegistry 单例。
 */

/**
 * 会话滚动位置快照契约 (DIM-02 §1.4)
 */
export interface SessionScrollSnapshot {
  /** 视口绝对滚动像素偏移 */
  scrollTop: number;
  /** 视口顶部首个可见语义节点的唯一标识 (anchor key / node id) */
  observedTopKey?: string;
  /** 顶部可见节点相对视口顶部的像素偏移量（通常为负值或 0） */
  observedTopOffset?: number;
  /** 切出时视口是否已吸附在最底部 */
  isAtBottom: boolean;
  /** 快照记录时间戳 (ms) */
  timestamp: number;
  /** 可选实测高度快照 (nodeId -> height)，供首帧高精度切片复原 */
  heightSnapshot?: Record<string, number>;
}

/**
 * 恢复滚动快照配置选项
 */
export interface RestoreSessionScrollOptions {
  /** 是否覆盖默认的 live 判定逻辑 */
  overrideLive?: boolean;
  /** 当无缓存记录但会话为 live 时，是否兜底返回贴底快照（默认 false） */
  fallbackToBottomIfLive?: boolean;
}

/**
 * 注册表初始化配置
 */
export interface ChatScrollRegistryOptions {
  /** 最大缓存会话数量，超出按 LRU 逐出（默认 50） */
  maxSessions?: number;
  /** 可选外部 live 状态判定函数 */
  livePredicate?: (sessionId: string) => boolean;
}

/**
 * 跨会话滚动位置与视口记忆恢复注册表类
 */
export class ChatScrollRegistry {
  private records = new Map<string, SessionScrollSnapshot>();
  private liveSessions = new Set<string>();
  private maxSessionsLimit: number;
  private customLivePredicate: ((sessionId: string) => boolean) | null = null;

  constructor(options?: ChatScrollRegistryOptions) {
    this.maxSessionsLimit =
      options?.maxSessions && options.maxSessions > 0 ? options.maxSessions : 50;
    if (options?.livePredicate) {
      this.customLivePredicate = options.livePredicate;
    }
  }

  /**
   * 当前缓存记录条数
   */
  public get size(): number {
    return this.records.size;
  }

  /**
   * 当前最大允许会话数量
   */
  public get maxSessions(): number {
    return this.maxSessionsLimit;
  }

  /**
   * 调整最大允许会话数量，若新容量小于当前条数则立即裁剪
   */
  public set maxSessions(limit: number) {
    if (limit <= 0) return;
    this.maxSessionsLimit = limit;
    this.enforceLRULimit();
  }

  /**
   * 保存会话滚动状态快照
   * 若该会话已存在，更新并移动至 LRU 头部（最新）；
   * 若超限，逐出最久未访问的条目。
   */
  public save(sessionId: string, snapshot: SessionScrollSnapshot): void {
    if (!sessionId || typeof sessionId !== 'string' || !snapshot) {
      return;
    }

    // 防御性克隆快照，隔离外部引用篡改
    const sanitizedSnapshot: SessionScrollSnapshot = {
      scrollTop: Number.isFinite(snapshot.scrollTop) ? snapshot.scrollTop : 0,
      observedTopKey: snapshot.observedTopKey,
      observedTopOffset: Number.isFinite(snapshot.observedTopOffset)
        ? snapshot.observedTopOffset
        : undefined,
      isAtBottom: Boolean(snapshot.isAtBottom),
      timestamp: Number.isFinite(snapshot.timestamp) ? snapshot.timestamp : Date.now(),
      heightSnapshot: snapshot.heightSnapshot ? { ...snapshot.heightSnapshot } : undefined,
    };

    if (this.records.has(sessionId)) {
      this.records.delete(sessionId);
    } else if (this.records.size >= this.maxSessionsLimit) {
      // 达到容量上限，逐出最久未使用的条目（Map 的第一个 key）
      const oldestKey = this.records.keys().next().value;
      if (oldestKey !== undefined) {
        this.records.delete(oldestKey);
      }
    }

    this.records.set(sessionId, sanitizedSnapshot);
  }

  /**
   * 读取并恢复会话滚动状态
   * - 命中缓存时将其重排至 LRU 最新位置；
   * - 若会话正处于 live 流式生成中，优先推荐贴底（isAtBottom = true）；
   * - 若为静态历史会话，返回精确快照。
   */
  public restore(
    sessionId: string,
    options?: RestoreSessionScrollOptions
  ): SessionScrollSnapshot | undefined {
    if (!sessionId || typeof sessionId !== 'string') {
      return undefined;
    }

    const cached = this.records.get(sessionId);

    // 未命中缓存情况
    if (!cached) {
      const isLive = options?.overrideLive ?? this.isSessionLive(sessionId);
      if (options?.fallbackToBottomIfLive && isLive) {
        return {
          scrollTop: 0,
          isAtBottom: true,
          timestamp: Date.now(),
        };
      }
      return undefined;
    }

    // 命中缓存：LRU 时序更新（删除后重插至末尾，代表最新被访问）
    this.records.delete(sessionId);
    this.records.set(sessionId, cached);

    const isLive = options?.overrideLive ?? this.isSessionLive(sessionId);
    if (isLive) {
      // 处于 live 流式进行中：优先推荐贴底，保持最新 Token 视口跟随
      return {
        ...cached,
        isAtBottom: true,
        heightSnapshot: cached.heightSnapshot ? { ...cached.heightSnapshot } : undefined,
      };
    }

    // 静态历史会话：返回精确物理快照副本
    return {
      ...cached,
      heightSnapshot: cached.heightSnapshot ? { ...cached.heightSnapshot } : undefined,
    };
  }

  /**
   * 仅预览快照（不更新 LRU 访问次序，供测试与调试诊断使用）
   */
  public peek(sessionId: string): SessionScrollSnapshot | undefined {
    const cached = this.records.get(sessionId);
    if (!cached) return undefined;
    return {
      ...cached,
      heightSnapshot: cached.heightSnapshot ? { ...cached.heightSnapshot } : undefined,
    };
  }

  /**
   * 检查指定会话是否存在滚动快照
   */
  public has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  /**
   * 清除指定会话的滚动快照
   */
  public clear(sessionId: string): void {
    if (!sessionId) return;
    this.records.delete(sessionId);
  }

  /**
   * 清除所有会话滚动快照
   */
  public clearAll(): void {
    this.records.clear();
  }

  /**
   * 判断会话是否处于 live 流式生成进行中
   */
  public isSessionLive(sessionId: string): boolean {
    if (!sessionId || typeof sessionId !== 'string') return false;
    if (this.customLivePredicate?.(sessionId)) return true;
    return this.liveSessions.has(sessionId);
  }

  /**
   * 标记或取消标记会话的 live 状态
   */
  public setSessionLive(sessionId: string, isLive: boolean): void {
    if (!sessionId || typeof sessionId !== 'string') return;
    if (isLive) {
      this.liveSessions.add(sessionId);
    } else {
      this.liveSessions.delete(sessionId);
    }
  }

  /**
   * 清空 live 会话状态标记
   * 若传 sessionId 则只清除该会话；未传则清空全部 live 标记
   */
  public clearSessionLive(sessionId?: string): void {
    if (sessionId) {
      this.liveSessions.delete(sessionId);
    } else {
      this.liveSessions.clear();
    }
  }

  /**
   * 注入外部 live 状态判定函数（如对接 Assembler 状态机或会话管理器）
   */
  public setLivePredicate(predicate: ((sessionId: string) => boolean) | null): void {
    this.customLivePredicate = predicate;
  }

  /**
   * 获取当前缓存内按 LRU 从旧到新排列的所有 sessionId（供调试与测试验证）
   */
  public getLRUKeys(): string[] {
    return Array.from(this.records.keys());
  }

  /**
   * 完全重置并销毁（清空记录、live 标记与外部判定函数）
   */
  public dispose(): void {
    this.records.clear();
    this.liveSessions.clear();
    this.customLivePredicate = null;
  }

  private enforceLRULimit(): void {
    while (this.records.size > this.maxSessionsLimit) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === undefined) break;
      this.records.delete(oldestKey);
    }
  }
}

// 默认全局单例实例
export const chatScrollRegistry = new ChatScrollRegistry();

// 导出纯函数契约 (DIM-02 §1.4)
export function saveSessionScroll(
  sessionId: string,
  snapshot: SessionScrollSnapshot
): void {
  chatScrollRegistry.save(sessionId, snapshot);
}

export function restoreSessionScroll(
  sessionId: string,
  options?: RestoreSessionScrollOptions
): SessionScrollSnapshot | undefined {
  return chatScrollRegistry.restore(sessionId, options);
}

export function clearSessionScroll(sessionId: string): void {
  chatScrollRegistry.clear(sessionId);
}

export function clearAllSessionScroll(): void {
  chatScrollRegistry.clearAll();
}

export function isSessionLive(sessionId: string): boolean {
  return chatScrollRegistry.isSessionLive(sessionId);
}

export function setSessionLive(sessionId: string, isLive: boolean): void {
  chatScrollRegistry.setSessionLive(sessionId, isLive);
}

export function clearSessionLive(sessionId?: string): void {
  chatScrollRegistry.clearSessionLive(sessionId);
}
