/**
 * CrossTabCoordinator —— 跨标签页协调器
 *
 * 职责：
 * - 使用 BroadcastChannel 在多个标签页间同步状态
 * - 通过 localStorage 进行 leader 选举（防止重复连接 daemon）
 * - 通过 eventBus 广播跨标签事件
 *
 * 依赖：
 * - EventBus（单例，事件广播）
 *
 * 导出单例 crossTabCoordinator
 */

import { eventBus } from './EventBus';

const LEADER_KEY = 'crish_cross_tab_leader';
const CHANNEL_NAME = 'crish-cross-tab';

export interface CrossTabMessage {
  type: 'leader-elected' | 'leader-lost' | 'sync-request' | 'sync-broadcast';
  payload?: unknown;
  timestamp: number;
  tabId: string;
}

class CrossTabCoordinator {
  private tabId: string;
  private channel: BroadcastChannel | null = null;
  private isLeader = false;
  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.tabId = crypto.randomUUID();
  }

  getTabId(): string {
    return this.tabId;
  }

  isLeaderTab(): boolean {
    return this.isLeader;
  }

  init(): void {
    if (this.started) return;
    this.started = true;

    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (ev: MessageEvent<CrossTabMessage>) => {
        this.handleMessage(ev.data);
      };
    } catch {
      // BroadcastChannel not supported — degrade gracefully
    }

    this.electLeader();
    this.startTimers();
  }

  destroy(): void {
    this.started = false;
    this.stopTimers();
    if (this.isLeader) {
      try { localStorage.removeItem(LEADER_KEY); } catch { /* ignore */ }
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  private electLeader(): void {
    try {
      const current = localStorage.getItem(LEADER_KEY);
      if (!current) {
        localStorage.setItem(LEADER_KEY, this.tabId);
        this.isLeader = true;
        this.emitLeaderElected();
      } else {
        this.isLeader = current === this.tabId;
      }
    } catch {
      // localStorage unavailable — degrade
    }
  }

  private startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.isLeader) {
        try { localStorage.setItem(LEADER_KEY, this.tabId); } catch { /* ignore */ }
      }
    }, 5000);

    this.checkTimer = setInterval(() => {
      try {
        const current = localStorage.getItem(LEADER_KEY);
        if (!current && !this.isLeader) {
          localStorage.setItem(LEADER_KEY, this.tabId);
          this.isLeader = true;
          this.emitLeaderElected();
        } else if (current === this.tabId && !this.isLeader) {
          this.isLeader = true;
          this.emitLeaderElected();
        } else if (current && current !== this.tabId && this.isLeader) {
          this.isLeader = false;
          eventBus.emit('cross-tab:leader-lost', { tabId: this.tabId, newLeader: current }, 'cross-tab');
        }
      } catch { /* ignore */ }
    }, 3000);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
  }

  private emitLeaderElected(): void {
    eventBus.emit('cross-tab:leader-elected', { tabId: this.tabId }, 'cross-tab');
    this.broadcast({ type: 'leader-elected', payload: { tabId: this.tabId }, timestamp: Date.now() });
  }

  private broadcast(msg: Omit<CrossTabMessage, 'tabId'>): void {
    if (this.channel) {
      try {
        this.channel.postMessage({ ...msg, tabId: this.tabId } as CrossTabMessage);
      } catch { /* ignore */ }
    }
  }

  private handleMessage(msg: CrossTabMessage): void {
    if (msg.tabId === this.tabId) return;

    if (msg.type === 'leader-elected') {
      if (this.isLeader) {
        this.isLeader = false;
        eventBus.emit('cross-tab:leader-lost', { tabId: this.tabId, newLeader: msg.tabId }, 'cross-tab');
      }
    }
  }
}

export const crossTabCoordinator = new CrossTabCoordinator();
