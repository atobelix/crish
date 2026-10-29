/**
 * persistenceConstants — 会话持久化防抖窗口与不可变空数组常量
 *
 * 1. 权威锁定会话持久化防抖窗口为 300ms (FINAL-PLAN-STAGE-01 §5.4)，合并高频流式写入。
 * 2. EMPTY_MESSAGES / EMPTY_AGENTS：冻结的全局空数组，杜绝 fallback [] 导致的引用漂移。
 */

import type { SessionAgent, SessionMessage } from './types';

export const STORAGE_PERSIST_DEBOUNCE_MS = 300;

const emptyMessages: SessionMessage[] = [];
Object.freeze(emptyMessages);
/** 不可变全局空消息数组常量，杜绝 fallback [] 导致的引用漂移 */
export const EMPTY_MESSAGES: SessionMessage[] = emptyMessages;

const emptyAgents: SessionAgent[] = [];
Object.freeze(emptyAgents);
/** 不可变全局空子 Agent 数组常量，杜绝 fallback [] 导致的引用漂移 */
export const EMPTY_AGENTS: SessionAgent[] = emptyAgents;
