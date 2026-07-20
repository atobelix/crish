/**
 * 按会话隔离的运行时状态容器。
 * 非 Zustand store，使用 Map<string, SessionRuntimeState> 管理。
 *
 * 职责：
 * - diffFiles：按会话隔离的 diff 状态
 * - attachments：按会话隔离的附件
 * - chatMainSurface：主面板视图模式
 * - fileCompareModes：文件对比模式
 * - composerDraft：草稿暂存
 * - scrollPosition / lastActivePanelTab：UI 恢复
 */

import type { FileDiff } from '../store/types';

export interface Attachment {
  id: string;
  name: string;
  mime?: string;
  dataUrl?: string;
  text?: string;
  size?: number;
}

/** 按会话隔离的运行时状态 */
export interface SessionRuntimeState {
  sessionId: string;
  diffFiles: FileDiff[];
  chatMainSurface: 'chat' | 'scheduled' | null;
  attachments: Attachment[];
  fileCompareModes: Record<string, 'split' | 'unified'>;
  composerDraft: string;
  scrollPosition: number;
  lastActivePanelTab: string | null;
}

export class SessionRuntimeRegistry {
  private activeIdResolver?: () => string;

  /** 注册活动会话 ID 获取器，打破循环依赖 */
  registerActiveIdResolver(resolver: () => string): void {
    this.activeIdResolver = resolver;
  }

  /** 会话运行时状态映射 */
  private states = new Map<string, SessionRuntimeState>();

  /** 引用计数映射 */
  private refCounts = new Map<string, number>();

  /**
   * 获取指定会话的运行态。
   * 不存在时自动创建默认值并返回。
   */
  get(sessionId: string): SessionRuntimeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = this.createDefault(sessionId);
      this.states.set(sessionId, state);
    }
    return state;
  }

  /** 检查指定会话是否存在运行态 */
  exists(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  /** 保存指定会话的部分运行时状态 */
  save(sessionId: string, partial: Partial<SessionRuntimeState>): void {
    const existing = this.get(sessionId);
    Object.assign(existing, partial);
  }

  /** 删除指定会话的运行态（会话删除时清理） */
  remove(sessionId: string): void {
    this.states.delete(sessionId);
    this.refCounts.delete(sessionId);
  }

  /** 引用计数 +1 */
  retain(sessionId: string): void {
    this.refCounts.set(sessionId, (this.refCounts.get(sessionId) ?? 0) + 1);
  }

  /** 引用计数 -1；减至 0 时自动清理运行态 */
  release(sessionId: string): void {
    const count = this.refCounts.get(sessionId);
    if (count === undefined || count <= 1) {
      this.remove(sessionId);
    } else {
      this.refCounts.set(sessionId, count - 1);
    }
  }

  /** 读取当前活动会话的运行态；无活动会话时返回 null */
  getActiveState(): SessionRuntimeState | null {
    if (!this.activeIdResolver) return null;
    const activeId = this.activeIdResolver();
    if (!activeId) return null;
    return this.get(activeId);
  }

  /** 清空所有运行态 */
  clearAll(): void {
    this.states.clear();
    this.refCounts.clear();
  }

  /** 创建默认运行时状态 */
  private createDefault(sessionId: string): SessionRuntimeState {
    return {
      sessionId,
      diffFiles: [],
      chatMainSurface: null,
      attachments: [],
      fileCompareModes: {},
      composerDraft: '',
      scrollPosition: 0,
      lastActivePanelTab: null,
    };
  }
}

/** 全局单例 */
export const sessionRuntimeRegistry = new SessionRuntimeRegistry();
