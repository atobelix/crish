// 快速操作视图模型（R2-05 部分 5：仪表盘发起 run 快捷入口）
//
// - 读：有效模式中央派生反推的远程可用性（CON-2：本 VM 是主页的**远程**
//   提交管线，connected 只作本管线的提交守卫；主页整体的模式判定走
//   selectEffectiveChatMode，未连接时主页改走本地发送，不经本管线）、
//   sessionStore.sessions（最近会话快速选择数据面，前 N 个按 store 排序
//   不变量：pinned → 活动 → updatedAt 降序，F1 §4.4 / F5 §2.1）；
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
} from '@/adapters/RemoteControlFacade';
import { selectEffectiveChatMode } from '@/domain/store/connectionStore';
import { haptics } from '@/adapters/platform/haptics';
import type { RunTaskParams, PermissionMode } from '@crish/shared-types';
import { settingsStore } from '@/domain/store/settingsStore';
import { filesStore } from '@/domain/store/filesStore';
import { runPermissionMode } from '@/domain/pure/permissionMode';
import {
  buildRunPayload,
  checkRunPayloadSizes,
  type ComposerAttachment,
} from '@/domain/pure/attachments';

// ── 常量与派生纯函数（可单测）────────────────────────────────────────────

/** 最近会话快速选择上限（前 N 个最近活跃；store 已排序，直接切片） */
export const RECENT_SESSION_LIMIT = 5;

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
 * - permissionMode 由调用方经 domain/pure/permissionMode 映射后传入（G1 起
 *   读 settingsStore 的 composer 偏好，不再写死 ask）。映射与桌面现行代码
 *   一致：桌面 UI 三档 id 本身即协议值 ask/smart/full（恒等映射，证据见
 *   permissionMode.ts 文件头）；远程生效口径由桌面执行侧 apply_remote_mode
 *   决定（full → ask），移动端只如实申报所选档位。
 */
export function runTaskParamsOf(
  prompt: string,
  sessionId: string | null,
  permissionMode: PermissionMode,
  cwd?: string
): RunTaskParams {
  return {
    prompt,
    ...(sessionId !== null ? { sessionId } : {}),
    permissionMode,
    ...(cwd ? { cwd } : {}),
  };
}

// ── 反馈状态机 ─────────────────────────────────────────────────────────────

export type QuickRunFeedback =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'success'; runId: string; sessionId: string }
  | { kind: 'error'; code: string; message: string };

export interface QuickRunVm {
  /**
   * 远程管线是否可用（CON-2：中央派生 effectiveChatMode === 'remote'）。
   * 仅作本管线的提交守卫——主页输入的生死由模式路由决定（未连接走
   * 本地模式解封），不再由本字段一刀切。
   */
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
  /** 发起 run（busy 防重入；远程不可用/空 prompt 拒绝——主页已按模式分发，本地模式不会走到本管线，此处仅为防御守卫） */
  submit: () => void;
  /** 以显式文本发起 run（语音输入松开直发：回填与提交同刻，不依赖 prompt 状态时序） */
  submitText: (text: string) => void;
  /**
   * 带附件发起 run（G5b）：domain 组装 content + prompt 附件块（桌面
   * multimodal 同构口径），发送前做总量预检——超限以 cmd.invalid 口径
   * 反馈并阻止发送（不调仓储、不送网关）。附件为空时等价 submitText。
   * 成功清空由宿主在 feedback success 时处理（失败保留已选区）。
   */
  submitWithAttachments: (
    rawText: string,
    attachments: readonly ComposerAttachment[],
    visionSupported: boolean
  ) => void;
}

export function useQuickRunVm(
  contextOverride?: QuickRunContext | null
): QuickRunVm {
  const connected = useConnectionStore(
    (s) => selectEffectiveChatMode(s.phase) === 'remote'
  );
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

  /** 发送管线（文本/附件共用）：busy 防重入 + 反馈状态机 + 成功清输入 */
  const dispatch = useCallback(
    (params: RunTaskParams) => {
      if (busyRef.current) return;
      if (!connected) return;
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
        .runTask(params)
        .then((res) => {
          // 发送被受理 → 成功触感与成功反馈同帧（触觉门面，手感基建批）
          haptics.success();
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
          setFeedback({
            kind: 'error',
            code,
            message: runTaskErrorTextOf(code),
          });
        })
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [connected, ctxOf]
  );

  const submitWithText = useCallback(
    (rawText: string) => {
      const text = rawText.trim();
      if (text.length === 0) return;
      // 权限档提交时刻读取持久化偏好并经单点映射（domain/pure/permissionMode）
      const permissionMode = runPermissionMode(
        settingsStore.getState().get('composer').permissionMode
      );
      const cwd = filesStore.getState().activeWorkspaceRoot ?? undefined;
      dispatch(runTaskParamsOf(text, selectedSessionId, permissionMode, cwd));
    },
    [dispatch, selectedSessionId]
  );

  const submitWithAttachments = useCallback(
    (
      rawText: string,
      attachments: readonly ComposerAttachment[],
      visionSupported: boolean
    ) => {
      if (attachments.length === 0) {
        submitWithText(rawText);
        return;
      }
      if (busyRef.current || !connected) return;
      const payload = buildRunPayload(rawText, attachments, visionSupported);
      if (!payload) {
        submitWithText(rawText);
        return;
      }
      // 发送前预检（与网关钳制同口径）：超限直接拦截，不送达网关才失败
      const sizeCheck = checkRunPayloadSizes(payload);
      if (!sizeCheck.ok) {
        setFeedback({
          kind: 'error',
          code: 'cmd.invalid',
          message: sizeCheck.message,
        });
        return;
      }
      const permissionMode = runPermissionMode(
        settingsStore.getState().get('composer').permissionMode
      );
      dispatch({
        ...runTaskParamsOf(payload.prompt, selectedSessionId, permissionMode),
        content: payload.content as unknown as NonNullable<
          RunTaskParams['content']
        >,
        hasImages: payload.hasImages,
      });
    },
    [connected, dispatch, selectedSessionId, submitWithText]
  );

  const submit = useCallback(() => {
    submitWithText(prompt);
  }, [submitWithText, prompt]);

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
    submitText: submitWithText,
    submitWithAttachments,
  };
}
