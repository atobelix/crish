/**
 * sessionSubtreeModel — Stage 01 正交三子树物理拆分与内置双标量版本代数槽位核心纯逻辑模型
 *
 * 核心职责 (FINAL-PLAN-STAGE-01-STATE-RERENDER):
 * 1. 正交三子树物理拓扑 (metaById + messagesBySessionId + agentsBySessionId + sessionOrder)
 * 2. 内置寄存器级双标量代数槽位 (metaEpochById + messageEpochById)，支持 ((prev + 1) | 0) 32位整型原子递增
 * 3. 零反射固定 Schema 元数据提取与比对，流式推流期间 metaById 引用 100% 恒定不变 (===)
 * 4. 集合论 3-Way Subtree Merge 无损增量恢复算法 (performThreeWaySubtreeMerge)
 * 5. 三道物理增量写屏障与 CAS 世代版本号守卫协调器 (SessionPersistenceCoordinator)
 */

import {
  EMPTY_AGENTS,
  EMPTY_MESSAGES,
  extractSessionMeta,
  type SessionMeta,
} from './persistenceConstants';
import type { SessionAgent, SessionMessage, SessionState } from './types';

export {
  EMPTY_AGENTS,
  EMPTY_MESSAGES,
  extractSessionMeta,
  performThreeWaySubtreeMerge,
  SessionPersistenceCoordinator,
  type PersistCoordinatorState,
  type SessionMeta,
  type SessionMetaExtensions,
  type SotaPersistPayload,
  type SubtreeMergeInput,
  type SubtreeMergeResult,
} from './persistenceConstants';

/** 正交三子树与内置双标量版本代数槽位核心切片 */
export interface SessionSubtreeSlice {
  metaById: Record<string, SessionMeta>;
  sessionOrder: string[];
  messagesBySessionId: Record<string, SessionMessage[]>;
  agentsBySessionId: Record<string, SessionAgent[]>;
  metaEpochById: Record<string, number>;
  messageEpochById: Record<string, number>;
}

/** 创建初始空正交三子树切片 */
export function createInitialSubtreeSlice(): SessionSubtreeSlice {
  return {
    metaById: {},
    sessionOrder: [],
    messagesBySessionId: {},
    agentsBySessionId: {},
    metaEpochById: {},
    messageEpochById: {},
  };
}

/** 32 位有符号整型原子自增算子: ((prev + 1) | 0) */
export function bumpEpochScalar(prev: number | undefined): number {
  return ((prev ?? 0) + 1) | 0;
}

/** 浅比较一维数组元素引用一致性 */
export function shallowArrayEqual<T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 浅比较平面对象键值一致性 */
export function shallowRecordEqual<T extends object>(
  a: T | undefined,
  b: T | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as Array<keyof T>;
  if (keysA.length !== Object.keys(b).length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i]!;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

import { isSessionMetaEqual } from './sessionMetaEqual';
export { isSessionMetaEqual };

function updateMessageBlocksForText(
  prev: SessionMessage,
  text: string
): SessionMessage['blocks'] {
  if (!Array.isArray(prev.blocks)) return undefined;
  const prevText = prev.text || '';
  let offset =
    typeof prev.streamTextOffset === 'number' ? prev.streamTextOffset : 0;
  let baseBlocks = prev.blocks;
  if (
    text.length < offset ||
    (prevText &&
      text.length < prevText.length &&
      !prevText.startsWith(text) &&
      !text.startsWith(
        prevText.slice(0, Math.min(prevText.length, text.length))
      ))
  ) {
    offset = 0;
    baseBlocks = prev.blocks.filter((b) => b.type !== 'text');
  }
  const rawSegment = text.length >= offset ? text.slice(offset) : text;
  const segment = offset > 0 ? rawSegment.replace(/^\n+/, '') : rawSegment;
  let lastDelim = -1;
  for (let i = baseBlocks.length - 1; i >= 0; i--) {
    if (
      baseBlocks[i]?.type === 'tool_call' ||
      baseBlocks[i]?.type === 'thought'
    ) {
      lastDelim = i;
      break;
    }
  }
  let targetIdx = -1;
  for (let i = baseBlocks.length - 1; i >= 0; i--) {
    if (baseBlocks[i]?.type === 'text') {
      if (lastDelim === -1 || i > lastDelim) targetIdx = i;
      break;
    }
  }
  const now = Date.now();
  if (targetIdx >= 0) {
    const target = baseBlocks[targetIdx]!;
    const cloned = baseBlocks.slice();
    cloned[targetIdx] = {
      ...target,
      content: segment,
      ...(target.startTime
        ? { durationMs: Math.max(0, now - target.startTime) }
        : {}),
    };
    return cloned;
  }
  return segment.length > 0
    ? [
        ...baseBlocks,
        {
          type: 'text' as const,
          content: segment,
          startTime: now,
          durationMs: 0,
        },
      ]
    : baseBlocks;
}

/** 极速更新单条消息文本（100 Token/s 高频推流专用）：逆序 O(1) 定位，零触碰 metaById / agentsBySessionId / sessionOrder */
export function updateSubtreeMessageText<S extends SessionSubtreeSlice>(
  state: S,
  sessionId: string,
  messageId: string,
  text: string,
  precomputedHtml?: string
): S {
  if (!sessionId || !messageId) return state;
  const list = state.messagesBySessionId[sessionId];
  if (!list?.length) return state;
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.id === messageId) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return state;
  const prev = list[idx]!;
  const htmlChanged =
    precomputedHtml !== undefined && prev.precomputedHtml !== precomputedHtml;
  if (prev.text === text && !htmlChanged) return state;
  const nextBlocks = updateMessageBlocksForText(prev, text);
  const nextList = list.slice();
  nextList[idx] = {
    ...prev,
    text,
    ...(htmlChanged && precomputedHtml !== undefined
      ? { precomputedHtml }
      : {}),
    ...(nextBlocks !== undefined ? { blocks: nextBlocks } : {}),
  };
  return {
    ...state,
    messagesBySessionId: {
      ...state.messagesBySessionId,
      [sessionId]: nextList,
    },
    messageEpochById: {
      ...state.messageEpochById,
      [sessionId]: bumpEpochScalar(state.messageEpochById[sessionId]),
    },
  };
}

/** 极速更新会话元数据（改名/置顶/归档/文件夹移动）：零触碰 messagesBySessionId 与 agentsBySessionId */
export function patchSubtreeSessionMeta<S extends SessionSubtreeSlice>(
  state: S,
  sessionId: string,
  patch: Partial<SessionMeta>
): S {
  const prev = sessionId ? state.metaById[sessionId] : undefined;
  if (!prev) return state;
  const candidate: SessionMeta = Object.freeze({
    ...prev,
    ...patch,
    id: prev.id,
  });
  if (isSessionMetaEqual(prev, candidate)) return state;
  return {
    ...state,
    metaById: { ...state.metaById, [sessionId]: candidate },
    metaEpochById: {
      ...state.metaEpochById,
      [sessionId]: bumpEpochScalar(state.metaEpochById[sessionId]),
    },
  };
}

function bumpChangedEpochs<T>(
  prevMap: Record<string, T>,
  nextMap: Record<string, T>,
  epochs: Record<string, number>
): Record<string, number> {
  if (prevMap === nextMap) return epochs;
  let out = epochs;
  for (const id of Object.keys(nextMap)) {
    if (id in prevMap && nextMap[id] !== prevMap[id]) {
      if (out === epochs) out = { ...epochs };
      out[id] = bumpEpochScalar(epochs[id]);
    }
  }
  return out;
}

/** 同步 Indexed 会话集合与正交三子树状态，严格维持未变子树及未变条目的引用全等 (===) */
export function syncSubtreeFromIndexedState<
  S extends SessionSubtreeSlice & {
    sessions: SessionState[];
    sessionsById: Record<string, SessionState>;
  },
>(prev: S, next: S): S {
  if (
    next.sessions === prev.sessions &&
    next.sessionsById === prev.sessionsById
  ) {
    const metaEpochById =
      next.metaEpochById === prev.metaEpochById
        ? bumpChangedEpochs(prev.metaById, next.metaById, prev.metaEpochById)
        : next.metaEpochById;
    const messageEpochById =
      next.messageEpochById === prev.messageEpochById
        ? bumpChangedEpochs(
            prev.messagesBySessionId,
            next.messagesBySessionId,
            prev.messageEpochById
          )
        : next.messageEpochById;
    return metaEpochById === next.metaEpochById &&
      messageEpochById === next.messageEpochById
      ? next
      : { ...next, metaEpochById, messageEpochById };
  }

  const sessionsArr = next.sessions || [];
  const byIdMap = next.sessionsById || {};
  const nextOrder: string[] = [];
  const seen = new Set<string>();
  const entities: SessionState[] = [];
  const pushEntity = (
    id: string | undefined,
    entity: SessionState | undefined
  ) => {
    if (!id || !entity || seen.has(id)) return;
    seen.add(id);
    nextOrder.push(id);
    entities.push(entity);
  };
  for (const item of sessionsArr)
    if (item?.id) pushEntity(item.id, byIdMap[item.id] ?? item);
  for (const id of Object.keys(byIdMap)) pushEntity(id, byIdMap[id]);

  if (entities.length === 0) {
    return prev.sessionOrder.length === 0 &&
      Object.keys(prev.metaById).length === 0
      ? next
      : { ...next, ...createInitialSubtreeSlice() };
  }

  let metaChanged = Object.keys(prev.metaById).length !== entities.length;
  let msgsChanged =
    Object.keys(prev.messagesBySessionId).length !== entities.length;
  let agentsChanged =
    Object.keys(prev.agentsBySessionId).length !== entities.length;
  let metaEpochChanged = false;
  let msgEpochChanged = false;

  const nextMetaById: Record<string, SessionMeta> = {};
  const nextMessagesById: Record<string, SessionMessage[]> = {};
  const nextAgentsById: Record<string, SessionAgent[]> = {};
  const nextMetaEpochs: Record<string, number> = { ...prev.metaEpochById };
  const nextMsgEpochs: Record<string, number> = { ...prev.messageEpochById };

  for (const sess of entities) {
    const { id } = sess;
    const prevMeta = prev.metaById[id];
    const existed =
      prevMeta !== undefined ||
      id in prev.messagesBySessionId ||
      id in prev.sessionsById;
    if (prevMeta && isSessionMetaEqual(prevMeta, sess)) {
      nextMetaById[id] = prevMeta;
    } else {
      nextMetaById[id] = extractSessionMeta(sess);
      metaChanged = true;
      if (existed || !(id in nextMetaEpochs)) {
        nextMetaEpochs[id] = existed
          ? bumpEpochScalar(prev.metaEpochById[id])
          : 0;
        metaEpochChanged = true;
      }
    }

    const currMsgs = Array.isArray(sess.messages)
      ? sess.messages
      : EMPTY_MESSAGES;
    if (prev.messagesBySessionId[id] === currMsgs) {
      nextMessagesById[id] = currMsgs;
    } else {
      nextMessagesById[id] = currMsgs;
      msgsChanged = true;
      if (existed || !(id in nextMsgEpochs)) {
        nextMsgEpochs[id] = existed
          ? bumpEpochScalar(prev.messageEpochById[id])
          : 0;
        msgEpochChanged = true;
      }
    }

    const currAgents =
      Array.isArray(sess.agents) && sess.agents.length > 0
        ? sess.agents
        : EMPTY_AGENTS;
    const prevAgents = prev.agentsBySessionId[id];
    if (
      prevAgents === currAgents ||
      (prevAgents !== undefined && shallowArrayEqual(prevAgents, currAgents))
    ) {
      nextAgentsById[id] = prevAgents;
    } else {
      nextAgentsById[id] = currAgents;
      agentsChanged = true;
    }
  }

  return {
    ...next,
    metaById: metaChanged ? nextMetaById : prev.metaById,
    sessionOrder: shallowArrayEqual(prev.sessionOrder, nextOrder)
      ? prev.sessionOrder
      : nextOrder,
    messagesBySessionId: msgsChanged
      ? nextMessagesById
      : prev.messagesBySessionId,
    agentsBySessionId: agentsChanged ? nextAgentsById : prev.agentsBySessionId,
    metaEpochById: metaEpochChanged ? nextMetaEpochs : prev.metaEpochById,
    messageEpochById: msgEpochChanged ? nextMsgEpochs : prev.messageEpochById,
  };
}
