// run 控制视图模型（R2-05 部分 6：run 详情页控制区）
//
// - 读：connectionStore.phase（未连接 → 禁用态 + 未连接反馈）；
// - 写：pause/resume → runControl（L2 cooperative_stop / L0 continue），cancel →
//   runControl（L3 force_cancel，危险操作：requestCancel 打开确认弹窗，确认后才发送）；
//   发送走接线上下文仓库（buildRunControlRequest 构造 + WsGateway.invoke，
//   注入模式对齐 useQuickRunVm/contextOverride）；
// - busy 防双点（R2UX-04-03 对齐）：发送期间按钮置忙 + busyRef 防重入；
// - paused 本地控制态：事件流无 pause/resume 事件（41 事件无该变体，F3 §2 盘点），
//   paused 由控制回执派生（cooperative_stop 成功 → true；continue 成功 → false；
//   终态事件由 UI 层优先级覆盖，不在此判定）；
// - 反馈：sending/success/error（错误码映射人话文案，M6 §11.3）。
import { useCallback, useRef, useState } from 'react';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import {
  getRunControlContext,
  RUN_CONTROL_ERROR_INTERNAL,
  runControlErrorTextOf,
  RunControlCommandError,
  type RunControlContext,
} from '@/adapters/runControlWiring';
import type { RunControlLevel } from '@crish/shared-types';

// ── 常量与派生纯函数（可单测）────────────────────────────────────────────

/** 控制动作（L2 暂停 / L0 恢复 / L3 取消；L1 soft_inject 本页不承载） */
export type RunControlAction = 'pause' | 'resume' | 'cancel';

/** 动作 → runControl level（C25 L0-L3，commands.rs:330-342；D4 §5.6 分级语义） */
export const RUN_CONTROL_LEVEL_OF_ACTION: Record<
  RunControlAction,
  RunControlLevel | null
> = {
  pause: 'cooperative_stop',
  resume: 'continue',
  // 取消走 runControl L3 force_cancel（D4 §5.6「强制取消」）；C26 cancelRun 为
  // 独立命令面（REST /v1/runs/{id}/cancel），本页统一经 runControl 控制面
  cancel: 'force_cancel',
};

/** 动作文案（按钮 + 反馈共用） */
export const RUN_CONTROL_ACTION_LABEL: Record<RunControlAction, string> = {
  pause: '暂停',
  resume: '恢复',
  cancel: '取消',
};

/** 反馈状态机 */
export type RunControlFeedback =
  | { kind: 'idle' }
  | { kind: 'sending'; action: RunControlAction }
  | { kind: 'success'; action: RunControlAction }
  | { kind: 'error'; action: RunControlAction; code: string; message: string };

/** 成功反馈文案（暂停/恢复/取消） */
export function runControlSuccessText(action: RunControlAction): string {
  switch (action) {
    case 'pause':
      return '已暂停';
    case 'resume':
      return '已恢复';
    case 'cancel':
      return '已取消';
  }
}

/** 发送中文案 */
export function runControlSendingText(action: RunControlAction): string {
  return `${RUN_CONTROL_ACTION_LABEL[action]}中…`;
}

export interface RunControlVm {
  /** 连接是否就绪（phase === 'ready'；否则按钮禁用 + 未连接提示） */
  connected: boolean;
  /** 本地暂停态（cooperative_stop 成功 → true；continue 成功 → false） */
  paused: boolean;
  /** 发送中（防双点：按钮置忙 + 提交重入拒绝） */
  busy: boolean;
  /** 反馈（idle/sending/success/error，携带动作） */
  feedback: RunControlFeedback;
  /** 取消确认弹窗可见（危险操作二次确认，M4 §6.3 / D4 §5.6） */
  confirmVisible: boolean;
  /** 可暂停判定（连接就绪 && 非发送中 && 未暂停） */
  canPause: boolean;
  /** 可恢复判定（连接就绪 && 非发送中 && 已暂停） */
  canResume: boolean;
  /** 可取消判定（连接就绪 && 非发送中 && 非终态由 UI 层隐藏按钮） */
  canCancel: boolean;
  /** L2 暂停（cooperative_stop；单点确认，D4 §5.6） */
  pause: () => void;
  /** L0 恢复（continue） */
  resume: () => void;
  /** 请求取消（打开二次确认弹窗；busy 期间拒绝） */
  requestCancel: () => void;
  /** 关闭确认弹窗（取消/遮罩点击） */
  dismissCancel: () => void;
  /** 确认取消（关闭弹窗 + 发送 L3 force_cancel） */
  confirmCancel: () => void;
}

export function useRunControlVm(
  runId: string,
  sessionId: string,
  contextOverride?: RunControlContext | null
): RunControlVm {
  const connected = useConnectionStore((s) => s.phase === 'ready');
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<RunControlFeedback>({
    kind: 'idle',
  });
  const [confirmVisible, setConfirmVisible] = useState(false);
  /** 发送重入锁（ref 同步防护：pending 期间拒绝二次操作，R2UX-04-03） */
  const busyRef = useRef(false);

  /** 上下文（测试注入优先；缺省走接线单例） */
  const ctxOf = useCallback(
    () => contextOverride ?? getRunControlContext(),
    [contextOverride]
  );

  /** 通用发送（busy 防重入；未连接静默拒绝；接线缺失 → transport.closed 反馈） */
  const send = useCallback(
    (action: RunControlAction) => {
      if (busyRef.current) return;
      if (!connected) return;
      const level = RUN_CONTROL_LEVEL_OF_ACTION[action];
      if (level === null) return;
      const ctx = ctxOf();
      if (!ctx) {
        // 接线未启动（未配对/未装配）：按未连接口径反馈（诚实化，不静默）
        setFeedback({
          kind: 'error',
          action,
          code: 'transport.closed',
          message: runControlErrorTextOf('transport.closed'),
        });
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setFeedback({ kind: 'sending', action });
      void ctx.repository
        .runControl({ level, runId, sessionId })
        .then(() => {
          setFeedback({ kind: 'success', action });
          // 本地暂停态（事件流无 pause/resume 事件，控制回执为 paused 数据面）
          setPaused(action === 'pause');
        })
        .catch((e: unknown) => {
          const code =
            e instanceof RunControlCommandError
              ? e.code
              : RUN_CONTROL_ERROR_INTERNAL;
          setFeedback({
            kind: 'error',
            action,
            code,
            message: runControlErrorTextOf(code),
          });
        })
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [connected, runId, sessionId, ctxOf]
  );

  const pause = useCallback(() => send('pause'), [send]);
  const resume = useCallback(() => send('resume'), [send]);

  const requestCancel = useCallback(() => {
    if (busyRef.current || !connected) return;
    setConfirmVisible(true);
  }, [connected]);

  const dismissCancel = useCallback(() => {
    setConfirmVisible(false);
  }, []);

  const confirmCancel = useCallback(() => {
    setConfirmVisible(false);
    send('cancel');
  }, [send]);

  return {
    connected,
    paused,
    busy,
    feedback,
    confirmVisible,
    canPause: connected && !busy && !paused,
    canResume: connected && !busy && paused,
    canCancel: connected && !busy,
    pause,
    resume,
    requestCancel,
    dismissCancel,
    confirmCancel,
  };
}
