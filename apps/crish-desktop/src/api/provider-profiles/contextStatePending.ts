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
 * 去重双保险：模块级 lastRecordedSignature（文本未变化不覆盖暂存，防
 * 「编辑 profile 列表也注入」噪音）+ 引擎侧 group_id 去重。
 */

import { getPermissionMode, getAppSettings } from '../storeAccess';
import { useSessionStore } from '../../store/sessionStore';

/** 暂存键（取走即清空；载荷为 { sessionId, text } 会话寻址 JSON） */
export const PENDING_CONTEXT_STATE_KEY = 'crish_pending_context_state_v1';

/** 上一次记录的快照签名（模块级去重：状态未变化不重新写入） */
let lastRecordedSignature: string | undefined;

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

/** 读思考档位（settings 同步面；经 storeAccess 封装，禁直连 store） */
function readThinkingLevel(): string {
  try {
    return String(getAppSettings()?.defaultThinkingLevel || '').trim();
  } catch {
    return '';
  }
}

/**
 * 获取当前状态快照的结构化字段
 */
export function readContextStateSnapshot(): {
  model: string;
  profile: string;
  permission: string;
  thinking: string;
} {
  return {
    model: readActiveModelId(),
    profile: readActiveProfileId(),
    permission: getPermissionMode(),
    thinking: readThinkingLevel(),
  };
}

/**
 * 生成 context-state 快照纯数据与文本（纯函数，可测）。
 *
 * 文本形态：「当前已切换到模型 {model}（服务商 {profile}）。权限模式：
 * {permission}。思考档位：{thinking}。」——逐段可省略（读不到/空则跳过
 * 该段），模型为空时整体返回 null（无可注入的状态告知）。
 */
export function buildContextStateSnapshot(): Omit<ContextStatePayload, 'sessionId'> | null {
  const model = readActiveModelId();
  const profile = readActiveProfileId();
  const permission = getPermissionMode();
  const thinking = readThinkingLevel();
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
  if (thinking && thinking !== 'default' && thinking !== 'off') {
    parts.push(`思考档位：${thinking}`);
  }
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
export function buildContextStateText(): string {
  return buildContextStateSnapshot()?.text || '';
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
    }
    if (!raw) {
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
 * 产生器入口：在 emitUiEvent('profiles-changed') 处调用——生成当前
 * 状态快照结构化载荷，并按会话寻址暂存（状态未变化则保持既有暂存；
 * 失败静默——感知注入是尽力而为面，不阻断状态切换本身）。
 */
export function recordPendingContextState(): void {
  try {
    const snapshot = buildContextStateSnapshot();
    if (!snapshot) return;
    const text = snapshot.text;
    const sid = useSessionStore.getState().activeSessionId || '';
    // 会话级去重：文本与当前会话上次一致 → 不重新写入
    const lastSig = lastRecordedSignaturesBySession.get(sid);
    if (text === lastSig) return;
    lastRecordedSignaturesBySession.set(sid, text);

    // 发送前绝不提前显示也不注入系统上下文：无论用户变动多少次模型/权限，
    // 仅暂存最新状态，直到用户正式发送消息时才由 streamSession 顺带携带注入
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
  // 如果会话刚从草稿晋升，尝试读取草稿暂存
  if (!stash && sid) {
    stash = readStash('__pending_draft__');
  }
  if (!stash) return undefined;
  if (
    stash.sessionId &&
    stash.sessionId !== sid &&
    stash.sessionId !== '__pending_draft__'
  ) {
    // 绑定他会话：本次不消费，保留快照供目标会话消费
    return undefined;
  }
  // 匹配成功才消费并清除暂存
  clearStash(sid);
  if (stash.sessionId === '__pending_draft__') {
    clearStash('__pending_draft__');
  }
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
