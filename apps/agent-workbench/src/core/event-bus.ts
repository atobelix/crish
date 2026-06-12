/**
 * 事件总线 - 用于组件间通信
 * 轻量级、高性能的发布-订阅模式
 */

type EventCallback<T = any> = (data: T) => void;

export class EventBus {
  private events: Map<string, Set<EventCallback>> = new Map();

  /**
   * 订阅事件
   */
  on<T = any>(event: string, callback: EventCallback<T>): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event)!.add(callback);

    // 返回取消订阅函数
    return () => this.off(event, callback);
  }

  /**
   * 订阅一次性事件
   */
  once<T = any>(event: string, callback: EventCallback<T>): void {
    const wrapper = (data: T) => {
      callback(data);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  /**
   * 取消订阅
   */
  off(event: string, callback: EventCallback): void {
    this.events.get(event)?.delete(callback);
  }

  /**
   * 发布事件
   */
  emit<T = any>(event: string, data?: T): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      callbacks.forEach((callback) => callback(data));
    }
  }

  /**
   * 清除所有事件监听器
   */
  clear(): void {
    this.events.clear();
  }

  /**
   * 清除特定事件的所有监听器
   */
  clearEvent(event: string): void {
    this.events.delete(event);
  }
}

// 全局事件总线
export const eventBus = new EventBus();

// 常用事件名称常量
export const Events = {
  // 消息相关
  MESSAGE_SENT: 'message:sent',
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_STREAMING: 'message:streaming',

  // 工具调用相关
  TOOL_CALL_PENDING: 'tool:pending',
  TOOL_CALL_APPROVED: 'tool:approved',
  TOOL_CALL_DENIED: 'tool:denied',
  TOOL_CALL_COMPLETED: 'tool:completed',

  // 会话相关
  SESSION_CREATED: 'session:created',
  SESSION_SWITCHED: 'session:switched',
  SESSION_CLEARED: 'session:cleared',

  // UI 相关
  SIDEBAR_TOGGLE: 'ui:sidebar:toggle',
  SETTINGS_OPEN: 'ui:settings:open',
  SETTINGS_CLOSE: 'ui:settings:close',

  // 系统相关
  ERROR: 'system:error',
  NOTIFICATION: 'system:notification',

  // 资源管理器相关
  EXPLORER_OPEN_FILE: 'explorer:open-file',
  EXPLORER_LOCATE_FILE: 'explorer:locate-file',

  // 标签相关
  TAB_OPEN: 'tab:open',
  TAB_CLOSE: 'tab:close',
} as const;
