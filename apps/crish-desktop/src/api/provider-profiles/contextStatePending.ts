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
import { contextInjectionDispatcher } from '../contextInjectionDispatcher';
import { estimateTextTokens } from '../../utils/tokenEstimator';

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
 * 生成 context-state 快照文本（纯函数，可测）。
 *
 * 文本形态：「当前已切换到模型 {model}（服务商 {profile}）。权限模式：
 * {permission}。思考档位：{thinking}。」——逐段可省略（读不到/空则跳过
 * 该段），模型为空时整体返回空串（无可注入的状态告知）。
 */
export function buildContextStateText(): string {
  const model = readActiveModelId();
  const profile = readActiveProfileId();
  const permission = getPermissionMode();
  const thinking = readThinkingLevel();
  if (!model && !profile) return '';
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
  return parts.join('。') + '。';
}

/** 会话寻址暂存载荷（sessionId 空 = 未绑定会话，任意下一 run 可消费） */
interface ContextStateStash {
  sessionId: string;
  text: string;
}

function readStash(): ContextStateStash | null {
  try {
    const raw = localStorage.getItem(PENDING_CONTEXT_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ContextStateStash;
    if (typeof parsed?.text === 'string') return parsed;
    // 旧版纯文本载荷兼容：视为未绑定会话
    return { sessionId: '', text: raw };
  } catch {
    return null;
  }
}

function writeStash(stash: ContextStateStash): void {
  try {
    localStorage.setItem(PENDING_CONTEXT_STATE_KEY, JSON.stringify(stash));
  } catch {
    /* swallow-ok: 暂存失败不影响状态切换本身 */
  }
}

function clearStash(): void {
  try {
    localStorage.removeItem(PENDING_CONTEXT_STATE_KEY);
  } catch {
    /* swallow-ok */
  }
}

/**
 * 产生器入口：在 emitUiEvent('profiles-changed') 处调用——生成当前
 * 状态快照文本，向活跃会话派发 workspace_env 可见卡片，并按会话寻址
 * 暂存（状态未变化则保持既有暂存；失败静默——感知注入是尽力而为面，
 * 不阻断状态切换本身）。
 */
export function recordPendingContextState(): void {
  try {
    const text = buildContextStateText();
    if (!text) return;
    // 模块级去重：文本与上次一致 → 不重新写入（编辑 profile 列表但
    // 活动模型/权限/档位未变时不产生注入；切换后重复 emit 也幂等）
    if (text === lastRecordedSignature) return;
    lastRecordedSignature = text;

    const sid = useSessionStore.getState().activeSessionId || '';
    // 可见卡片：状态切换在对话流中直接呈现（所见即所知；无活跃会话
    // 时仅暂存 wire，卡片随下次进入对话的会话派发）
    if (sid) {
      const content = `[系统上下文注入 · 状态切换]\n\n${text}`;
      contextInjectionDispatcher.inject(sid, {
        kind: 'workspace_env',
        title: '🔄 上下文状态切换',
        summary: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        status: 'injected',
        source: 'system_event',
        content,
        tokenEstimate: estimateTextTokens(content),
        metadata: { mode: 'context-state' },
      });
    }
    writeStash({ sessionId: sid, text });
  } catch {
    /* swallow-ok: 记录失败不影响状态切换本身 */
  }
}

/**
 * 取走暂存的 context-state 文本（ConnectionLifecycle 发起 run-task 时
 * 调用）——取走即清空；仅当暂存绑定会话为空或与当前会话一致时消费
 * （跨会话串扰根除：会话 A 产生的状态告知不会被会话 B 的 run 取走）。
 */
export function takePendingContextState(currentSessionId?: string | null): string | undefined {
  const stash = readStash();
  if (!stash) return undefined;
  clearStash();
  if (stash.sessionId && stash.sessionId !== (currentSessionId || '')) {
    // 绑定他会话：本次不消费（该会话的 run 会取走）
    return undefined;
  }
  return stash.text;
}

/** 测试重置（去重签名与暂存键） */
export function resetPendingContextStateForTest(): void {
  lastRecordedSignature = undefined;
  clearStash();
}
