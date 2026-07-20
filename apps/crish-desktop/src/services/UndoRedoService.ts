/**
 * UndoRedoService —— 撤销/重做系统
 *
 * 职责：
 * - 每个会话独立撤销栈（undoStacks / redoStacks）
 * - 撤销栈大小限制 20 步
 * - undo() 弹出最近操作 → 调用对应的逆操作函数 → 将操作推入 redo 栈
 * - redo() 从 redo 栈弹出 → 重新执行 → 推入 undo 栈
 * - 通过 eventBus 广播 undo:performed / redo:performed 事件
 * - 通过 ToastBus 显示撤销/重做结果
 */

import { messageSnapshots } from '../api/MessageSnapshots';
import { eventBus } from './EventBus';
import { toastBus } from './ToastBus';
import { useSessionStore, getActiveSessionId } from '../store/sessionStore';
import {
  archiveSession,
  unarchiveSession,
  pinMessage,
  unpinMessage,
  withdrawMessage,
} from '../api/storeAccess';

export interface UndoableAction {
  id: string;
  type: 'withdraw' | 'regenerate' | 'archive' | 'unarchive' | 'pin' | 'unpin' | 'delete-message' | 'edit-message';
  sessionId: string;
  description: string;
  timestamp: number;
  undoData: any;
  redoData: any;
}

type ActionHandler = (action: UndoableAction) => Promise<boolean>;

const MAX_STACK_SIZE = 20;

export class UndoRedoService {
  private static instance: UndoRedoService;

  private undoStacks = new Map<string, UndoableAction[]>();
  private redoStacks = new Map<string, UndoableAction[]>();

  private constructor() {}

  static getInstance(): UndoRedoService {
    if (!UndoRedoService.instance) {
      UndoRedoService.instance = new UndoRedoService();
    }
    return UndoRedoService.instance;
  }

  // ── Public API ────────────────────────────────────────────────────

  record(action: Omit<UndoableAction, 'id' | 'timestamp'>): void {
    const full: UndoableAction = {
      ...action,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    let stack = this.undoStacks.get(action.sessionId);
    if (!stack) {
      stack = [];
      this.undoStacks.set(action.sessionId, stack);
    }

    stack.push(full);

    if (stack.length > MAX_STACK_SIZE) {
      stack.shift();
    }

    this.redoStacks.delete(action.sessionId);
  }

  async undo(): Promise<boolean> {
    const sessionId = getActiveSessionId();
    if (!sessionId) return false;

    const stack = this.undoStacks.get(sessionId);
    if (!stack || stack.length === 0) return false;

    const action = stack.pop()!;
    if (stack.length === 0) this.undoStacks.delete(sessionId);

    const handler = this.getUndoHandler(action.type);
    if (!handler) {
      this.pushRedo(sessionId, action);
      return false;
    }

    try {
      const success = await handler(action);
      if (success) {
        this.pushRedo(sessionId, action);
        toastBus.info(`已撤销：${action.description}`);
        eventBus.emit('undo:performed', {
          sessionId,
          actionType: action.type,
          description: action.description,
        }, 'ui');
      } else {
        this.pushUndo(sessionId, action);
      }
      return success;
    } catch {
      this.pushUndo(sessionId, action);
      return false;
    }
  }

  async redo(): Promise<boolean> {
    const sessionId = getActiveSessionId();
    if (!sessionId) return false;

    const stack = this.redoStacks.get(sessionId);
    if (!stack || stack.length === 0) return false;

    const action = stack.pop()!;
    if (stack.length === 0) this.redoStacks.delete(sessionId);

    const handler = this.getRedoHandler(action.type);
    if (!handler) {
      this.pushUndo(sessionId, action);
      return false;
    }

    try {
      const success = await handler(action);
      if (success) {
        this.pushUndo(sessionId, action);
        toastBus.info(`已重做：${action.description}`);
        eventBus.emit('redo:performed', {
          sessionId,
          actionType: action.type,
          description: action.description,
        }, 'ui');
      } else {
        this.pushRedo(sessionId, action);
      }
      return success;
    } catch {
      this.pushRedo(sessionId, action);
      return false;
    }
  }

  canUndo(): boolean {
    const sessionId = getActiveSessionId();
    if (!sessionId) return false;
    const stack = this.undoStacks.get(sessionId);
    return stack !== undefined && stack.length > 0;
  }

  canRedo(): boolean {
    const sessionId = getActiveSessionId();
    if (!sessionId) return false;
    const stack = this.redoStacks.get(sessionId);
    return stack !== undefined && stack.length > 0;
  }

  getUndoDescription(): string | null {
    const sessionId = getActiveSessionId();
    if (!sessionId) return null;
    const stack = this.undoStacks.get(sessionId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1]?.description ?? null;
  }

  getRedoDescription(): string | null {
    const sessionId = getActiveSessionId();
    if (!sessionId) return null;
    const stack = this.redoStacks.get(sessionId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1]?.description ?? null;
  }

  clearSession(sessionId: string): void {
    this.undoStacks.delete(sessionId);
    this.redoStacks.delete(sessionId);
  }

  clearAll(): void {
    this.undoStacks.clear();
    this.redoStacks.clear();
  }

  // ── Stack helpers ─────────────────────────────────────────────────

  private pushUndo(sessionId: string, action: UndoableAction): void {
    let stack = this.undoStacks.get(sessionId);
    if (!stack) {
      stack = [];
      this.undoStacks.set(sessionId, stack);
    }
    stack.push(action);
    if (stack.length > MAX_STACK_SIZE) stack.shift();
  }

  private pushRedo(sessionId: string, action: UndoableAction): void {
    let stack = this.redoStacks.get(sessionId);
    if (!stack) {
      stack = [];
      this.redoStacks.set(sessionId, stack);
    }
    stack.push(action);
    if (stack.length > MAX_STACK_SIZE) stack.shift();
  }

  // ── Handler registry ──────────────────────────────────────────────

  private getUndoHandler(type: UndoableAction['type']): ActionHandler | null {
    switch (type) {
      case 'withdraw':
      case 'regenerate':
      case 'delete-message':
      case 'edit-message':
        return this.handleUndoSnapshotRestore.bind(this);
      case 'archive':
        return this.handleUndoArchive.bind(this);
      case 'unarchive':
        return this.handleUndoUnarchive.bind(this);
      case 'pin':
        return this.handleUndoPin.bind(this);
      case 'unpin':
        return this.handleUndoUnpin.bind(this);
      default:
        return null;
    }
  }

  private getRedoHandler(type: UndoableAction['type']): ActionHandler | null {
    switch (type) {
      case 'withdraw':
      case 'regenerate':
      case 'delete-message':
      case 'edit-message':
        return this.handleRedoWithdraw.bind(this);
      case 'archive':
        return this.handleRedoArchive.bind(this);
      case 'unarchive':
        return this.handleRedoUnarchive.bind(this);
      case 'pin':
        return this.handleRedoPin.bind(this);
      case 'unpin':
        return this.handleRedoUnpin.bind(this);
      default:
        return null;
    }
  }

  // ── Undo handlers ─────────────────────────────────────────────────

  private async handleUndoSnapshotRestore(action: UndoableAction): Promise<boolean> {
    const snapshot = messageSnapshots.undo(action.sessionId);
    if (!snapshot) return false;

    useSessionStore.setState((state) => {
      const sess = state.sessionsById[action.sessionId];
      if (!sess) return;
      sess.messages = snapshot.messages;
      if (snapshot.pinnedMessageIds && snapshot.pinnedMessageIds.length > 0) {
        sess.pinnedMessageIds = [...snapshot.pinnedMessageIds];
      } else {
        delete sess.pinnedMessageIds;
      }
    });

    return true;
  }

  private async handleUndoArchive(action: UndoableAction): Promise<boolean> {
    unarchiveSession(action.sessionId);
    return true;
  }

  private async handleUndoUnarchive(action: UndoableAction): Promise<boolean> {
    archiveSession(action.sessionId);
    return true;
  }

  private async handleUndoPin(action: UndoableAction): Promise<boolean> {
    const messageId = action.undoData?.messageId;
    if (!messageId) return false;
    unpinMessage(action.sessionId, messageId);
    return true;
  }

  private async handleUndoUnpin(action: UndoableAction): Promise<boolean> {
    const messageId = action.undoData?.messageId;
    if (!messageId) return false;
    pinMessage(action.sessionId, messageId);
    return true;
  }

  // ── Redo handlers ─────────────────────────────────────────────────

  private async handleRedoWithdraw(action: UndoableAction): Promise<boolean> {
    const messageId = action.redoData?.messageId;
    if (!messageId) return false;
    withdrawMessage('', action.sessionId, messageId);
    return true;
  }

  private async handleRedoArchive(action: UndoableAction): Promise<boolean> {
    archiveSession(action.sessionId);
    return true;
  }

  private async handleRedoUnarchive(action: UndoableAction): Promise<boolean> {
    unarchiveSession(action.sessionId);
    return true;
  }

  private async handleRedoPin(action: UndoableAction): Promise<boolean> {
    const messageId = action.redoData?.messageId;
    if (!messageId) return false;
    pinMessage(action.sessionId, messageId);
    return true;
  }

  private async handleRedoUnpin(action: UndoableAction): Promise<boolean> {
    const messageId = action.redoData?.messageId;
    if (!messageId) return false;
    unpinMessage(action.sessionId, messageId);
    return true;
  }
}

/** 全局单例 */
export const undoRedoService = UndoRedoService.getInstance();
