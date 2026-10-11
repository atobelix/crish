/**
 * context-state 感知注入：前端产生器 + 会话寻址暂存/取走面（详案 I1-α②
 * 扩展点 A · 详案 02 §3.2 / 评审 02 §2.3 会话化修订）。
 *
 * 职责边界（17 审计纪律）：
 * - **只**承载「状态切换发生」的感知注入（模型/服务商/权限/思考档位
 *   切换的**快照文本**）——进会话时间线（经 PendingMessageQueue 下一
 *   run 边界注入 seq）；
 * - 配置/偏好本身（profile 存储、主题、布局等）留在独立配置带，**不进**
 *   本通道（禁止把配置文件整体塞进消息流）。
 *
 * 会话隔离修订（评审 02 §2.3）：废除「全局单键被随机会话取走」的跨会话
 * 串扰——暂存载荷携带产生时刻的活跃会话 id，take 时仅当目标会话匹配
 * （或暂存未绑定会话）才消费；产生瞬间同时经 ContextInjectionDispatcher
 * 向活跃会话派发 workspace_env 可见卡片（所见即所知）。引擎侧
 * group_id=context-state 去重与 run-task contextState 参数保持不变。
 *
 * 去重双保险：会话级 lastRecordedSignaturesBySession（文本未变化不覆盖暂存，防
 * 「编辑 profile 列表也注入」噪音）+ 引擎侧 group_id 去重。
 */

import { getPermissionMode } from '../storeAccess';
import {
  getSessionThinkingTitle,
  loadModelThinkingPref,
  getLastSentContextSignature,
} from '../SessionRuntimeRegistry';
import { contextInjectionDispatcher } from '../contextInjectionDispatcher';
import { getSessionStoreState, isPendingDraft } from '../../store/storeAccess';

/** 暂存键（取走即清空；载荷为 { sessionId, text } 会话寻址 JSON） */
export const PENDING_CONTEXT_STATE_KEY = 'crish_pending_context_state_v1';

/** 读活动模型 id（直读 localStorage，与 profileStore 同键；不反向
 * import profileStore——避免产生器 ↔ profileStore 循环依赖） */
function readActiveModelId(): string {
  try {
    return localStorage.getItem('crish_active_model_id') || '';
  } catch {
    return '';
  }
}

/** 读活动服务商 id（同键直读） */
function readActiveProfileId(): string {
  try {
    return localStorage.getItem('crish_active_profile_id') || '';
  } catch {
    return '';
  }
}

/** 读本会话思考档位 Title（yaml 字典 key）。优先会话显式设定，回退模型持久偏好。无则空串。 */
function readThinkingLevel(targetSessionId?: string): string {
  try {
    const sid = (targetSessionId || getSessionStoreState().activeSessionId || '').trim();
    const title =
      (sid ? getSessionThinkingTitle(sid) : null) ??
      loadModelThinkingPref(readActiveProfileId(), readActiveModelId());
    return typeof title === 'string' ? title.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 获取当前状态快照的结构化字段
 */
export function readContextStateSnapshot(targetSessionId?: string): {
  model: string;
  profile: string;
  permission: string;
  thinking: string;
} {
  return {
    model: readActiveModelId(),
    profile: readActiveProfileId(),
    permission: getPermissionMode(),
    thinking: readThinkingLevel(targetSessionId),
  };
}

/**
 * 生成 context-state 快照纯数据与文本（纯函数，可测）。
 *
 * 文本形态：「当前已切换到模型 {model}（服务商 {profile}）。权限模式：
 * {permission}。思考档位：{thinking}。」——逐段可省略（读不到/空则跳过
 * 该段），模型为空时整体返回 null（无可注入的状态告知）。
 */
export function buildContextStateSnapshot(
  targetSessionId?: string
): Omit<ContextStatePayload, 'sessionId'> | null {
  const model = readActiveModelId();
  const profile = readActiveProfileId();
  const permission = getPermissionMode();
  const thinking = readThinkingLevel(targetSessionId);
  if (!model && !profile) return null;
  const parts: string[] = [];
  if (model) {
    parts.push(
      profile
        ? `当前已切换到模型 ${model}（服务商 ${profile}）`
        : `当前已切换到模型 ${model}`
    );
  }
  if (permission) parts.push(`权限模式：${permission}`);
  if (thinking) parts.push(`思考档位：${thinking}`);
  const text = parts.join('。') + '。';
  return {
    model,
    ...(profile ? { profile } : {}),
    ...(permission ? { permission } : {}),
    ...(thinking ? { thinking } : {}),
    text,
  };
}

/** 生成 context-state 快照文本（兼容旧接口） */
export function buildContextStateText(targetSessionId?: string): string {
  return buildContextStateSnapshot(targetSessionId)?.text || '';
}

/** 会话寻址暂存结构化载荷（SSOT 单一真理源） */
export interface ContextStatePayload {
  sessionId: string;
  model: string;
  profile?: string;
  permission?: string;
  thinking?: string;
  text: string;
}

/** 会话隔离签名记录表（sessionId -> lastSignature） */
const lastRecordedSignaturesBySession = new Map<string, string>();

function getSessionStashKey(sessionId: string): string {
  const safeId = (sessionId || '').trim() || '__global__';
  return `${PENDING_CONTEXT_STATE_KEY}:${safeId}`;
}

function readStash(sessionId?: string): ContextStatePayload | null {
  try {
    let raw: string | null = null;
    if (sessionId) {
      const key = getSessionStashKey(sessionId);
      raw = localStorage.getItem(key);
    } else {
      raw = localStorage.getItem(PENDING_CONTEXT_STATE_KEY);
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === 'string') {
      return {
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
        model: typeof parsed.model === 'string' ? parsed.model : '',
        ...(parsed.profile ? { profile: String(parsed.profile) } : {}),
        ...(parsed.permission ? { permission: String(parsed.permission) } : {}),
        ...(parsed.thinking ? { thinking: String(parsed.thinking) } : {}),
        text: parsed.text,
      };
    }
    // 旧版纯文本载荷兼容：视为未绑定会话
    return { sessionId: '', model: '', text: raw };
  } catch {
    return null;
  }
}

function writeStash(stash: ContextStatePayload): void {
  try {
    const json = JSON.stringify(stash);
    localStorage.setItem(PENDING_CONTEXT_STATE_KEY, json);
    if (stash.sessionId) {
      const key = getSessionStashKey(stash.sessionId);
      localStorage.setItem(key, json);
    }
  } catch {
    /* swallow-ok: 暂存失败不影响状态切换本身 */
  }
}

function clearStash(sessionId?: string): void {
  try {
    localStorage.removeItem(PENDING_CONTEXT_STATE_KEY);
    if (sessionId) {
      const key = getSessionStashKey(sessionId);
      localStorage.removeItem(key);
    }
  } catch {
    /* swallow-ok */
  }
}

/**
 * @deprecated 切换时不再即时派发提示卡片。居中提示必须在用户点击发送后才带上，且位于用户消息上方。
 */
export function dispatchInstantContextStateNotification(
  _targetSessionId?: string | null
): void {
  // no-op: 严格遵守用户裁决，切换瞬间不向消息流追加任何卡片
}

/**
 * 产生器入口：在切换模型、思考档位或权限时调用——
 * 仅记录该会话待发送的结构化上下文状态快照；
 * 严格纪律（用户裁决）：切换发生瞬间绝对不向对话流注入任何卡片；
 * 仅在用户点击发送按钮后，由 flushContextStateBeforeSend 带上并置于用户发送的消息上方。
 */
export function recordPendingContextState(targetSessionId?: string): void {
  try {
    const store = getSessionStoreState();
    const sid = (targetSessionId || store.activeSessionId || '').trim();
    if (!sid) {
      // 无活跃会话时不记录无主暂存，防止污染后续会话
      return;
    }
    const snapshot = buildContextStateSnapshot(sid);
    if (!snapshot) return;
    const text = snapshot.text;

    // 检查是否切回了本会话上一次真实发送时的状态（切出去又切回来不重复弹提示）
    const lastSentSig = getLastSentContextSignature(sid);
    if (lastSentSig && text === lastSentSig) {
      clearStash(sid);
      lastRecordedSignaturesBySession.delete(sid);
      return;
    }

    // 会话级去重：文本与当前会话上次待发送快照一致 → 不重复写入
    const lastSig = lastRecordedSignaturesBySession.get(sid);
    if (text === lastSig) return;
    lastRecordedSignaturesBySession.set(sid, text);

    writeStash({
      sessionId: sid,
      model: snapshot.model,
      ...(snapshot.profile ? { profile: snapshot.profile } : {}),
      ...(snapshot.permission ? { permission: snapshot.permission } : {}),
      ...(snapshot.thinking ? { thinking: snapshot.thinking } : {}),
      text,
    });
  } catch {
    /* swallow-ok: 记录失败不影响状态切换本身 */
  }
}

/**
 * 取走暂存的 context-state 结构化数据（ConnectionLifecycle 发起 run-task 时
 * 调用）——取走即清空；仅当暂存绑定会话为空或与当前会话一致时消费
 * （跨会话串扰根除：会话 A 产生的状态告知不会被会话 B 的 run 取走）。
 */
export function takePendingContextState(
  currentSessionId?: string | null
): ContextStatePayload | undefined {
  const sid = (currentSessionId || '').trim();
  let stash = readStash(sid);
  // 如果当前 sid 没有专属暂存，且当前是从草稿晋升或新建会话：检查全局暂存是否属于草稿态产生的
  if (!stash && sid) {
    const globalStash = readStash();
    if (
      globalStash &&
      (!globalStash.sessionId ||
        isPendingDraft(globalStash.sessionId) ||
        globalStash.sessionId === '__pending_draft__' ||
        globalStash.sessionId.startsWith('draft-'))
    ) {
      stash = globalStash;
    }
  }
  if (!stash) return undefined;
  const isDraftOrigin =
    !stash.sessionId ||
    isPendingDraft(stash.sessionId) ||
    stash.sessionId === '__pending_draft__' ||
    stash.sessionId.startsWith('draft-');
  if (stash.sessionId && stash.sessionId !== sid && !isDraftOrigin) {
    // 绑定他真实会话：本次不消费，保留快照供目标会话消费
    return undefined;
  }
  // 匹配成功才消费并清除暂存
  clearStash(sid);
  if (stash.sessionId) {
    clearStash(stash.sessionId);
    lastRecordedSignaturesBySession.delete(stash.sessionId);
  }
  clearStash();
  lastRecordedSignaturesBySession.delete(sid);
  lastRecordedSignaturesBySession.delete('');
  lastRecordedSignaturesBySession.delete('__pending_draft__');
  return stash;
}

/** 测试重置（去重签名与暂存键） */
export function resetPendingContextStateForTest(): void {
  lastRecordedSignaturesBySession.clear();
  try {
    localStorage.removeItem(PENDING_CONTEXT_STATE_KEY);
  } catch {
    /* swallow-ok */
  }
}
