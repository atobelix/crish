import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Tauri 后端通信桥接层
 * 封装所有与 Rust 后端的交互
 */

// 类型定义
export interface RunTaskRequest {
  prompt: string;
  runId?: string;
  mode?: string;
  maxRounds?: number;
}

export interface WorkbenchEvent {
  type: string;
  runId?: string;
  [key: string]: any;
}

export interface WorkbenchStatus {
  activeRuns: number;
  [key: string]: any;
}

/**
 * Tauri Bridge 类
 */
export class TauriBridge {
  private eventListeners: Map<string, UnlistenFn[]> = new Map();

  /**
   * 运行任务（流式）
   */
  async runTask(request: RunTaskRequest): Promise<void> {
    try {
      await invoke('workbench_run_task_stream', {
        request: {
          prompt: request.prompt,
          runId: request.runId,
          mode: request.mode,
          maxRounds: request.maxRounds,
        },
      });
    } catch (error) {
      console.error('运行任务失败:', error);
      throw error;
    }
  }

  /**
   * 取消运行中的任务
   */
  async cancelRun(runId: string): Promise<void> {
    try {
      const result = await invoke('workbench_cancel_run', { runId });
      console.log('任务已取消:', result);
    } catch (error) {
      console.error('取消任务失败:', error);
      throw error;
    }
  }

  /**
   * 获取工作台状态
   */
  async getStatus(): Promise<WorkbenchStatus> {
    try {
      return await invoke('workbench_status');
    } catch (error) {
      console.error('获取状态失败:', error);
      throw error;
    }
  }

  /**
   * 监听运行事件
   */
  async onRunEvent(callback: (event: WorkbenchEvent) => void): Promise<UnlistenFn> {
    const unlisten = await listen<WorkbenchEvent>('workbench-run-event', (event) => {
      callback(event.payload);
    });

    this.addListener('workbench-run-event', unlisten);
    return unlisten;
  }

  /**
   * 监听快照事件
   */
  async onSnapshot(callback: (event: WorkbenchEvent) => void): Promise<UnlistenFn> {
    const unlisten = await listen<WorkbenchEvent>('workbench-run-snapshot', (event) => {
      callback(event.payload);
    });

    this.addListener('workbench-run-snapshot', unlisten);
    return unlisten;
  }

  /**
   * 监听 Goal 事件
   */
  async onGoalEvent(callback: (event: WorkbenchEvent) => void): Promise<UnlistenFn> {
    const unlisten = await listen<WorkbenchEvent>('workbench-goal-event', (event) => {
      callback(event.payload);
    });

    this.addListener('workbench-goal-event', unlisten);
    return unlisten;
  }

  /**
   * 批准工具调用
   */
  async approveToolCall(toolCallId: string): Promise<void> {
    try {
      await invoke('workbench_approve_tool', { toolCallId });
    } catch (error) {
      console.error('批准工具调用失败:', error);
      throw error;
    }
  }

  /**
   * 拒绝工具调用
   */
  async denyToolCall(toolCallId: string): Promise<void> {
    try {
      await invoke('workbench_deny_tool', { toolCallId });
    } catch (error) {
      console.error('拒绝工具调用失败:', error);
      throw error;
    }
  }

  /**
   * 清理所有事件监听器
   */
  cleanup() {
    this.eventListeners.forEach((listeners) => {
      listeners.forEach((unlisten) => unlisten());
    });
    this.eventListeners.clear();
  }

  private addListener(event: string, unlisten: UnlistenFn) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(unlisten);
  }
}

// 全局单例
export const tauriBridge = new TauriBridge();
