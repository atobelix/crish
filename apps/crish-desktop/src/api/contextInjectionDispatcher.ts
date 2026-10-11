/**
 * 统一可见注入派发器（ContextInjectionDispatcher）单例门面。
 *
 * Prompt 注入管线（维度二）：被动直接注入的**唯一写卡入口**——任何业务场景
 * （/schedule、/goal、/grill-me、@file 等，接线归后续轮次）一律经
 * `contextInjectionDispatcher.inject()` 派发可见卡片，禁止绕过本派发器直写
 * `addMessage` / `addContextInjection`（00-总方案 §三：写卡动作单一路径）。
 *
 * 职责：
 * 1. 生成唯一 id（缺省时）与注入时间戳；
 * 2. 默认 status='injected'（已成功注入当前 Turn 上下文）；
 * 3. 经 `useSessionStore.addContextInjection(targetSessionId, injection)`
 *    写入目标会话时间线；
 * 4. 目标会话不存在 / 无可派发会话时告警并返回空串。
 */
import {
  addContextInjection,
  getActiveSessionId,
  getSessionById,
} from './storeAccess';
import type {
  ContextInjectionStatus,
  MessageContextInjection,
} from '../store/types';

/** 派发载荷：除 id/timestamp 由派发器生成外，status 亦允许省略（默认 injected） */
export type ContextInjectionDispatchPayload = Omit<
  MessageContextInjection,
  'id' | 'timestamp' | 'status'
> & {
  id?: string;
  status?: ContextInjectionStatus;
};

/** 生成缺省注入 id（时间戳 + 随机后缀，保证单帧多次派发不碰撞） */
function makeInjectionId(): string {
  return `inj_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export class ContextInjectionDispatcher {
  private static instance: ContextInjectionDispatcher;

  static getInstance(): ContextInjectionDispatcher {
    if (!this.instance) {
      this.instance = new ContextInjectionDispatcher();
    }
    return this.instance;
  }

  /**
   * 向目标会话时间线派发可见注入卡片。
   *
   * @param targetSessionId 目标会话 id；空值回落到 activeSessionId
   * @param payload 注入载荷（id / timestamp / status 可省略，由本方法补全）
   * @returns 最终 injection.id；派发被拒时返回空串
   */
  inject(
    targetSessionId: string,
    payload: ContextInjectionDispatchPayload
  ): string {
    const activeSessionId = getActiveSessionId();
    const rawSid =
      typeof targetSessionId === 'string'
        ? targetSessionId.trim()
        : activeSessionId;
    const sid = rawSid || activeSessionId;
    if (!sid) {
      console.warn(
        '[ContextInjectionDispatcher] Drop injection: No active session'
      );
      return '';
    }
    if (!getSessionById(sid)) {
      console.warn(
        `[ContextInjectionDispatcher] Drop injection: Session not found (${sid})`
      );
      return '';
    }

    const finalId = payload.id || makeInjectionId();
    const fullInjection: MessageContextInjection = {
      ...payload,
      id: finalId,
      timestamp: Date.now(),
      status: payload.status || 'injected',
    };

    addContextInjection(sid, fullInjection);
    return finalId;
  }
}

/** 全局单例（业务接线统一引用本实例） */
export const contextInjectionDispatcher = ContextInjectionDispatcher.getInstance();
