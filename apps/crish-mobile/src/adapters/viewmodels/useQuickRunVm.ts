// 快速操作视图模型（R2-05 部分 5：仪表盘发起 run 快捷入口）
//
// - 读：connectionStore.phase（未连接 → 禁用态）、sessionStore.sessions（最近会话
//   快速选择数据面，前 N 个按 store 排序不变量：pinned → 活动 → updatedAt 降序，
//   F1 §4.4 / F5 §2.1）；
// - 写：submit → 接线上下文仓库 runTask（buildRunTaskRequest 构造 + WsGateway.invoke，
//   注入模式对齐 useFilesVm/contextOverride）；成功回执 runId → feedback success
//   （UI 跳转 run 详情）；失败 → 错误码映射人话文案（M6 §11.3）；
// - busy 防双点（R2UX-04-03 对齐）：发送期间按钮置忙 + busyRef 防重入；
// - 首帧预算：本 VM 无挂载期异步拉取（会话来自已水合的 sessionStore），静态表单
//   轻量渲染不阻塞首帧（R2UX-05-10 快速操作区口径）；
// - 派生纯函数导出供单测（排序切片/参数构造不变量）。
import { useCallback, useRef, useState } from 'react';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import {
  useConnectionStore,
  useSessionStore,
} from '@/adapters/hooks/useAppStore';
import {
  getQuickRunContext,
  RUN_TASK_ERROR_INTERNAL,
  runTaskErrorTextOf,
  RunTaskCommandError,
  type QuickRunContext,
} from '@/adapters/quickRunWiring';
import type {
  RunTaskParams,
  PermissionMode,
} from '../../../../../packages/shared-types/src/generated/device/types';

// ── 常量与派生纯函数（可单测）────────────────────────────────────────────

/** 最近会话快速选择上限（前 N 个最近活跃；store 已排序，直接切片） */
export const RECENT_SESSION_LIMIT = 5;

/** 发起 run 默认权限模式（R2-07 B4：permissionMode 缺省 ask；UI 不提供 full-access，D5 §4.6.1） */
export const QUICK_RUN_PERMISSION_MODE: PermissionMode = 'ask';

/**
 * 最近会话切片（F1 §4.4 / F5 §2.1 排序不变量由 sessionStore 保证）：
 * - 过滤已归档（isArchived 不参与快速选择）；
 * - 取前 N 个（pinned → 活动 → updatedAt 降序的头部即「最近活跃」）。
 */
export function recentSessionsOf(
  sessions: readonly SessionSummary[],
  limit: number = RECENT_SESSION_LIMIT
): SessionSummary[] {
  return sessions.filter((s) => s.isArchived !== true).slice(0, limit);
}

/**
 * runTask 参数构造（C24 契约，M6 §4.4.1）：
 * - prompt 必填；sessionId 缺省 = 桌面新建会话（commitDraftIfNeeded 语义）；
 * - permissionMode 恒 ask（R2-07 B4 默认；full-access 被桌面恒降级 ask）。
 */
export function runTaskParamsOf(
  prompt: string,
  sessionId: string | null
): RunTaskParams {
  return {
    prompt,
    ...(sessionId !== null ? { sessionId } : {}),
    permissionMode: QUICK_RUN_PERMISSION_MODE,
  };
}

// ── 反馈状态机 ─────────────────────────────────────────────────────────────

export type QuickRunFeedback =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'success'; runId: string; sessionId: string }
  | { kind: 'error'; code: string; message: string };

export interface QuickRunVm {
  /** 连接是否就绪（phase === 'ready'；否则输入/按钮禁用 + 未连接提示） */
  connected: boolean;
  /** 最近会话（前 N 个最近活跃；空 = 无会话，隐藏选择区） */
  recentSessions: readonly SessionSummary[];
  /** prompt 输入内容 */
  prompt: string;
  /** 选中会话 id（null = 新会话，桌面新建；选中 = 继续该会话） */
  selectedSessionId: string | null;
  /** 发送中（防双点：按钮置忙 + 提交重入拒绝） */
  busy: boolean;
  /** 反馈（idle/sending/success/error；成功携带 runId 供跳转） */
  feedback: QuickRunFeedback;
  /** 可提交判定：连接就绪 && 非发送中 && prompt 非空白 */
  canSubmit: boolean;
  setPrompt: (text: string) => void;
  /** 会话选择切换（同 id 再点取消选择 → 回到新会话） */
  selectSession: (sessionId: string | null) => void;
  /** 发起 run（busy 防重入；未连接/空 prompt 静默拒绝） */
  submit: () => void;
}

export function useQuickRunVm(
  contextOverride?: QuickRunContext | null
): QuickRunVm {
  const connected = useConnectionStore((s) => s.phase === 'ready');
  const sessions = useSessionStore((s) => s.sessions);
  const [prompt, setPromptState] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<QuickRunFeedback>({ kind: 'idle' });
  /** 发送重入锁（ref 同步防护：pending 期间拒绝二次提交，R2UX-04-03） */
  const busyRef = useRef(false);

  /** 上下文（测试注入优先；缺省走接线单例） */
  const ctxOf = useCallback(
    () => contextOverride ?? getQuickRunContext(),
    [contextOverride]
  );

  const setPrompt = useCallback((text: string) => {
    setPromptState(text);
    // 输入变化即清除旧反馈（错误/成功状态不残留，等待新提交）
    setFeedback({ kind: 'idle' });
  }, []);

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedSessionId((cur) => (cur === sessionId ? null : sessionId));
    setFeedback({ kind: 'idle' });
  }, []);

  const submit = useCallback(() => {
    if (busyRef.current) return;
    const text = prompt.trim();
    if (!connected || text.length === 0) return;
    const ctx = ctxOf();
    if (!ctx) {
      // 接线未启动（未配对/未装配）：按未连接口径反馈（诚实化，不静默）
      setFeedback({
        kind: 'error',
        code: 'transport.closed',
        message: runTaskErrorTextOf('transport.closed'),
      });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFeedback({ kind: 'sending' });
    void ctx.repository
      .runTask(runTaskParamsOf(text, selectedSessionId))
      .then((res) => {
        setFeedback({
          kind: 'success',
          runId: res.runId,
          sessionId: res.sessionId,
        });
        setPromptState(''); // 成功回执后清空输入（下次任务再输入）
      })
      .catch((e: unknown) => {
        const code =
          e instanceof RunTaskCommandError ? e.code : RUN_TASK_ERROR_INTERNAL;
        setFeedback({ kind: 'error', code, message: runTaskErrorTextOf(code) });
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, [connected, prompt, selectedSessionId, ctxOf]);

  return {
    connected,
    recentSessions: recentSessionsOf(sessions),
    prompt,
    selectedSessionId,
    busy,
    feedback,
    canSubmit: connected && !busy && prompt.trim().length > 0,
    setPrompt,
    selectSession,
    submit,
  };
}
