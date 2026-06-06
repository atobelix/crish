/**
 * 应用全局状态管理
 * 使用简单的观察者模式，避免引入重量级状态库
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  streaming?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
  output?: string;
  status: 'pending' | 'approved' | 'denied' | 'completed';
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  workingDirectory?: string;
}

export interface AppStateData {
  currentSession: Session | null;
  sessions: Session[];
  activeRunId: string | null;
  isStreaming: boolean;
  pendingApproval: ToolCall | null;
}

type Listener<T = any> = (data: T) => void;

/**
 * 状态管理类
 */
export class AppState {
  private state: AppStateData = {
    currentSession: null,
    sessions: [],
    activeRunId: null,
    isStreaming: false,
    pendingApproval: null,
  };

  private listeners: Map<string, Set<Listener>> = new Map();

  /**
   * 获取完整状态
   */
  getState(): Readonly<AppStateData> {
    return this.state;
  }

  /**
   * 订阅状态变化
   */
  subscribe<K extends keyof AppStateData>(
    key: K,
    listener: Listener<AppStateData[K]>
  ): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener);

    // 返回取消订阅函数
    return () => {
      this.listeners.get(key)?.delete(listener);
    };
  }

  /**
   * 更新状态
   */
  setState<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    this.state[key] = value;
    this.notify(key, value);
  }

  /**
   * 部分更新状态
   */
  patchState(patch: Partial<AppStateData>): void {
    Object.entries(patch).forEach(([key, value]) => {
      const k = key as keyof AppStateData;
      this.state[k] = value as any;
      this.notify(k, value);
    });
  }

  /**
   * 创建新会话
   */
  createSession(title: string = '新对话'): Session {
    const session: Session = {
      id: `session-${Date.now()}`,
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.state.sessions.unshift(session);
    this.setState('currentSession', session);
    this.notify('sessions', this.state.sessions);

    return session;
  }

  /**
   * 添加消息到当前会话
   */
  addMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage {
    if (!this.state.currentSession) {
      this.createSession();
    }

    const newMessage: ChatMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
    };

    this.state.currentSession!.messages.push(newMessage);
    this.state.currentSession!.updatedAt = Date.now();

    this.notify('currentSession', this.state.currentSession);
    return newMessage;
  }

  /**
   * 更新消息内容（用于流式更新）
   */
  updateMessage(messageId: string, updates: Partial<ChatMessage>): void {
    if (!this.state.currentSession) return;

    const message = this.state.currentSession.messages.find((m) => m.id === messageId);
    if (message) {
      Object.assign(message, updates);
      this.notify('currentSession', this.state.currentSession);
    }
  }

  /**
   * 设置待审批的工具调用
   */
  setPendingApproval(toolCall: ToolCall | null): void {
    this.setState('pendingApproval', toolCall);
  }

  /**
   * 切换会话
   */
  switchSession(sessionId: string): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (session) {
      this.setState('currentSession', session);
    }
  }

  /**
   * 清除当前会话
   */
  clearCurrentSession(): void {
    this.setState('currentSession', null);
  }

  private notify<K extends keyof AppStateData>(key: K, value: AppStateData[K]): void {
    const listeners = this.listeners.get(key);
    if (listeners) {
      listeners.forEach((listener) => listener(value));
    }
  }
}

// 全局单例
export const appState = new AppState();
