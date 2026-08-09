/**
 * sessionLocalStorage / sessionRustDb 共用的子代理截断标志工具（P18 / AA-07）。
 *
 * 独立成模块的原因与 sessionQuota.ts 同款：sessionRustDb 的 hydrate 链与
 * sessionLocalStorage 互相 import（编排关系），标志函数若留在其中一方会形成
 * 环形依赖（depcruise no-circular 门禁必红）。抽离共享纯函数后双方均只依赖
 * 本模块（处置口径同 cacheMetricsCompute / sessionQuota 先例）。
 *
 * 背景（P18）：SESSION_AGENTS_SAVE_CAP=40 曾是子代理落盘硬上限，第 41 个起的
 * agent 及其消息在保存时被静默截断（LS 与 SQLite 两侧一致），无提示无留痕。
 * 修复后 SQLite 主路径全量保存（不丢数据），CAP 退化为 localStorage 配额
 * 保护线——LS 镜像被截断落盘时必须留痕（不再静默），后续全量写成功时清除
 * （恢复策略）。标志自身的读写也 try/catch：quota 耗尽时标志可能写不进，
 * 但绝不允许抛错污染保存主流程。
 */

import {
  SESSION_AGENTS_TRUNCATED_PREFIX,
  type AgentsTruncationRecord,
} from './sessionPersistenceTypes';
import { asNonEmptyString } from './sessionQuota';

/** 截断标志 localStorage key（导出供删除/清理路径复用）。 */
export function agentsTruncationKey(sessionId: string): string {
  return SESSION_AGENTS_TRUNCATED_PREFIX + sessionId;
}

/**
 * 置位会话级 agents 截断标志（LS 镜像截断落盘后调用）。
 * 值 = AgentsTruncationRecord JSON：保留 total/saved/cap 事实，hydrate 链可读。
 */
export function markAgentsTruncated(
  sessionId: string,
  record: AgentsTruncationRecord
): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  try {
    localStorage.setItem(agentsTruncationKey(id), JSON.stringify(record));
  } catch {
    /* quota / private mode */
  }
}

/** 读取会话级 agents 截断事实记录（无记录 / 坏 JSON → null）。 */
export function readAgentsTruncation(
  sessionId: string
): AgentsTruncationRecord | null {
  const id = asNonEmptyString(sessionId);
  if (!id) return null;
  try {
    const raw = localStorage.getItem(agentsTruncationKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AgentsTruncationRecord>;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.cap !== 'number' ||
      typeof parsed.total !== 'number' ||
      typeof parsed.saved !== 'number'
    ) {
      return null;
    }
    return {
      cap: parsed.cap,
      total: parsed.total,
      saved: parsed.saved,
      // 仅本模块写入的标志，at 恒存在；缺失视为 0（留痕时间不可用）
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

/** 会话是否存在 agents 截断标志（hydrate / UI 数据面读取）。 */
export function hasAgentsTruncation(sessionId: string): boolean {
  const id = asNonEmptyString(sessionId);
  if (!id) return false;
  try {
    return localStorage.getItem(agentsTruncationKey(id)) !== null;
  } catch {
    return false;
  }
}

/** 清除会话级 agents 截断标志（全量写成功即恢复）。 */
export function clearAgentsTruncation(sessionId: string): void {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  try {
    localStorage.removeItem(agentsTruncationKey(id));
  } catch {
    /* ignore */
  }
}
