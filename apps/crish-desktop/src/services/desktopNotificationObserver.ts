/**
 * 桌面通知产生点（2026-11-03 托盘/通知批）
 *
 * 接线面：chat-bridge 的 `dispatchEvent` 是全部引擎事件的唯一汇聚
 * 点——run 终态/运行异常、审批请求、子代理终态、后台工具结算、壳
 * 后台任务终态都经它分发。本观察器在分发前旁路观察（只读信封，
 * 异常自吞，绝不影响分发本身），把事件映射为
 * [DesktopNotificationRequest] 交 [desktopNotificationService]
 * 过门发送。不在各 handler 内散接，避免多轨。
 *
 * run 终态的双面现实（2026-11-03 活验钉死）：本地 run 的前端事件
 * 流止于 `agent-end`（reason=stop 为自然完成，error 为失败，
 * stopped/aborted 为取消，max-turns 为上限收口）；`run-terminal`
 * 只出现在 run 层管理的运行（如数据面）上，且与 agent-end 先后
 * 到达同一分发点。两面都映射，并以会话+终态类的 10 秒互斥窗防
 * 同一 run 双发。
 *
 * 文案口径与 Rust push 侧同源：人类可识别名优先——会话标题（store
 * 现成字段）/ 任务命令原文（本模块从 task-started 事件流缓存）/
 * 工具名在前，裸 id 只进去重键、永不作正文。
 *
 * 批 C 增补（2026-11-03）：①失败类正文一律经失败分类表出文案
 * （failureBodyText），后端原始错误串不进通知面；②本模块同时接线
 * 「打开即退休」——订阅会话 store 的 activeSessionId 变更，打开某
 * 会话即调 DesktopNotificationService.retireSession 退休其条目。
 * 到达面三岔（静默亲见/应用内/OS）由服务层单点裁决，见
 * DesktopNotificationService 文件头与 docs/guides/feedback-routing.md。
 */
import type { BridgeEventEnvelope } from '../api/chat-bridge/handlers/eventParser';
import { presentFailure } from '../api/userFacingErrors';
import { t } from '../i18n';
import { logger } from './LoggerService';
import { useSessionStore } from '../store/sessionStore';
import {
  desktopNotificationService,
  type DesktopNotificationRequest,
} from './DesktopNotificationService';
import {
  clip,
  failureBodyText,
  resolveSessionTitle,
} from './desktopNotificationText';

type LooseRecord = Record<string, unknown>;

const TASK_COMMAND_CACHE_CAP = 128;

/** 任务 id → 命令原文（task-started 事件流观察，终态文案用） */
const taskCommands = new Map<string, string>();

function asRecord(value: unknown): LooseRecord {
  return value && typeof value === 'object' ? (value as LooseRecord) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface NotificationMappingContext {
  /** 会话标题（store 现成字段；空缺时回落无名文案） */
  sessionTitle?: string;
  /** 任务命令原文（task-started 缓存；同上） */
  taskCommand?: string;
}

/**
 * 信封 → 通知请求（纯函数，可测）。返回 null = 该事件不产生桌面
 * 通知（过程态/诊断类/未拦截的安全审计等）。
 */
export function buildNotificationRequest(
  envelope: BridgeEventEnvelope,
  ctx: NotificationMappingContext
): DesktopNotificationRequest | null {
  const ev: LooseRecord =
    envelope.kind === 'engine'
      ? asRecord(envelope.event)
      : asRecord(envelope.raw);
  const sessionId = str(ev.sessionId);

  switch (envelope.type) {
    case 'approval-requested': {
      const req = asRecord(ev.request);
      const raw = asRecord(envelope.kind === 'engine' ? envelope.raw : ev);
      const toolCallId =
        str(req.toolCallId) ?? str(raw.toolCallId) ?? 'unknown';
      const toolName = str(req.toolName) ?? 'command';
      const summary =
        str(req.summary) ??
        str(req.reason) ??
        str(asRecord(raw.request).summary);
      return {
        category: 'approval',
        dedupeKey: `approval:${toolCallId}`,
        title: t('settings.notification.content.approvalTitle'),
        body: clip(summary ? `${toolName}：${summary}` : toolName),
        sessionId,
      };
    }
    case 'run-terminal': {
      const terminal = str(ev.terminal);
      const runId = str(ev.runId) ?? 'unknown';
      const error = str(ev.error);
      if (terminal === 'failed') {
        return {
          category: 'failure',
          dedupeKey: `run:${runId}:failed`,
          title: t('settings.notification.content.runFailed'),
          body: failureBodyText(error, ctx.sessionTitle),
          sessionId,
        };
      }
      if (terminal === 'completed' || terminal === 'cancelled') {
        const isDone = terminal === 'completed';
        return {
          category: 'completion',
          dedupeKey: `run:${runId}:${terminal}`,
          title: t(
            isDone
              ? 'settings.notification.content.runCompleted'
              : 'settings.notification.content.runCancelled'
          ),
          body: ctx.sessionTitle
            ? t(
                isDone
                  ? 'settings.notification.content.namedCompleted'
                  : 'settings.notification.content.namedCancelled',
                { name: ctx.sessionTitle }
              )
            : '',
          sessionId,
        };
      }
      return null;
    }
    case 'agent-end': {
      // 本地 run 的真实终态面（见模块头）：reason 决定类别
      const reason = str(ev.reason);
      const ts = str(ev.timestamp) ?? '';
      const dedupeKey = `agent-end:${sessionId ?? ''}:${ts}`;
      if (reason === 'error') {
        const error = str(ev.error);
        return {
          category: 'failure',
          dedupeKey,
          title: t('settings.notification.content.runFailed'),
          body: failureBodyText(error, ctx.sessionTitle),
          sessionId,
        };
      }
      if (reason === 'aborted' || reason === 'stopped') {
        return {
          category: 'completion',
          dedupeKey,
          title: t('settings.notification.content.runCancelled'),
          body: ctx.sessionTitle
            ? t('settings.notification.content.namedCancelled', {
                name: ctx.sessionTitle,
              })
            : '',
          sessionId,
        };
      }
      // 'stop'（自然完成）/ 'max-turns'（上限收口）/ 未知 → 完成类
      return {
        category: 'completion',
        dedupeKey,
        title: t('settings.notification.content.runCompleted'),
        body: ctx.sessionTitle
          ? t('settings.notification.content.namedCompleted', {
              name: ctx.sessionTitle,
            })
          : '',
        sessionId,
      };
    }
    case 'runtime-error': {
      const error = str(ev.error) ?? '';
      return {
        category: 'failure',
        dedupeKey: `runtime-error:${sessionId ?? ''}:${error.slice(0, 64)}`,
        title: t('settings.notification.content.runtimeError'),
        // 原始错误串不内联：命中分类表出家族说明，未命中只留标题
        body: clip(presentFailure(error)?.guidance ?? ''),
        sessionId,
      };
    }
    case 'runtime-intervention-required': {
      const reason = str(ev.reason) ?? str(ev.message) ?? '';
      return {
        category: 'approval',
        dedupeKey: `intervention:${sessionId ?? ''}:${reason.slice(0, 64)}`,
        title: t('settings.notification.content.intervention'),
        body: clip(reason),
        sessionId,
      };
    }
    case 'subagent-ended': {
      const status = str(ev.status);
      const subagentId = str(ev.subagentId) ?? 'unknown';
      const summary = str(ev.summary);
      if (status === 'failed') {
        return {
          category: 'failure',
          dedupeKey: `subagent:${subagentId}:failed`,
          title: t('settings.notification.content.subagentFailed'),
          body: clip(summary ?? ''),
          sessionId,
        };
      }
      if (status === 'completed' || status === 'cancelled') {
        return {
          category: 'completion',
          dedupeKey: `subagent:${subagentId}:ended`,
          title: t('settings.notification.content.subagentCompleted'),
          body: clip(summary ?? ''),
          sessionId,
        };
      }
      return null;
    }
    case 'tool-settled': {
      const status = str(ev.status);
      const callId = str(ev.callId) ?? 'unknown';
      const toolName = str(ev.toolName) ?? '';
      if (status === 'error' || status === 'outcome-unknown') {
        return {
          category: 'failure',
          dedupeKey: `tool:${callId}:${status}`,
          title: t('settings.notification.content.toolFailed'),
          body: clip(toolName),
          sessionId,
        };
      }
      if (status === 'ok' || status === 'cancelled') {
        return {
          category: 'completion',
          dedupeKey: `tool:${callId}:${status}`,
          title: t('settings.notification.content.toolCompleted'),
          body: clip(toolName),
          sessionId,
        };
      }
      return null;
    }
    case 'task-completed': {
      const taskId = str(ev.taskId) ?? 'unknown';
      return {
        category: 'completion',
        dedupeKey: `task:${taskId}:completed`,
        title: t('settings.notification.content.taskCompleted'),
        body: clip(ctx.taskCommand ?? ''),
        sessionId,
      };
    }
    case 'task-failed': {
      const taskId = str(ev.taskId) ?? 'unknown';
      const exitCode = ev.exitCode;
      return {
        category: 'failure',
        dedupeKey: `task:${taskId}:failed`,
        title: t('settings.notification.content.taskFailed'),
        body: clip(
          ctx.taskCommand ??
            (typeof exitCode === 'number' ? `exit code ${exitCode}` : '')
        ),
        sessionId,
      };
    }
    case 'task-killed': {
      const taskId = str(ev.taskId) ?? 'unknown';
      return {
        category: 'completion',
        dedupeKey: `task:${taskId}:killed`,
        title: t('settings.notification.content.taskTerminated'),
        body: clip(ctx.taskCommand ?? ''),
        sessionId,
      };
    }
    case 'task-suspicious': {
      const taskId = str(ev.taskId) ?? 'unknown';
      return {
        category: 'failure',
        dedupeKey: `task:${taskId}:suspicious`,
        title: t('settings.notification.content.taskStuck'),
        body: clip(ctx.taskCommand ?? ''),
        sessionId,
      };
    }
    case 'security-audit': {
      const decision = str(ev.decision);
      if (decision !== 'blocked' && decision !== 'denied') return null;
      const targets = Array.isArray(ev.targets) ? ev.targets : [];
      const toolCallId = str(ev.toolCallId);
      return {
        category: 'failure',
        dedupeKey: `security:${sessionId ?? ''}:${toolCallId ?? str(ev.operation) ?? ''}`,
        title: t('settings.notification.content.securityBlocked'),
        body: clip(str(targets[0]) ?? ''),
        sessionId,
      };
    }
    case 'timer-fired':
    case 'cron-fired': {
      // 计划触发类：桌面默认关——归类为 scheduled，服务层直接不发
      const id = str(ev.timerId) ?? str(ev.cronId) ?? 'unknown';
      return {
        category: 'scheduled',
        dedupeKey: `scheduled:${envelope.type}:${id}`,
        title: '',
        body: clip(str(ev.prompt) ?? ''),
        sessionId,
      };
    }
    default:
      return null;
  }
}

/** run 双终态互斥窗：同一会话同类终态 10 秒内只发一次（见模块头） */
const RUN_END_SUPPRESS_MS = 10_000;
const recentRunEnds = new Map<
  string,
  { at: number; kind: 'completed' | 'failed' | 'cancelled' }
>();

function runEndKindOf(
  type: string,
  ev: LooseRecord
): 'completed' | 'failed' | 'cancelled' | null {
  if (type === 'run-terminal') {
    const terminal = str(ev.terminal);
    return terminal === 'completed' ||
      terminal === 'failed' ||
      terminal === 'cancelled'
      ? terminal
      : null;
  }
  if (type === 'agent-end') {
    const reason = str(ev.reason);
    if (reason === 'error') return 'failed';
    if (reason === 'aborted' || reason === 'stopped') return 'cancelled';
    return 'completed';
  }
  return null;
}

/** 返回 true = 与刚发过的同类终态重复（同一 run 的双面），应抑制 */
function isDuplicateRunEnd(
  sessionId: string,
  kind: 'completed' | 'failed' | 'cancelled'
): boolean {
  const now = Date.now();
  const prev = recentRunEnds.get(sessionId);
  if (prev && prev.kind === kind && now - prev.at < RUN_END_SUPPRESS_MS) {
    return true;
  }
  recentRunEnds.set(sessionId, { at: now, kind });
  if (recentRunEnds.size > TASK_COMMAND_CACHE_CAP) {
    const oldest = recentRunEnds.keys().next().value;
    if (oldest !== undefined) recentRunEnds.delete(oldest);
  }
  return false;
}

let clickHandlingInitStarted = false;

let retireWatchStarted = false;

/**
 * 打开即退休接线（批 C 第 1 件）：会话 store 的 activeSessionId 变更
 * （点开/切换到某会话）→ 退休该会话的应用内通知条目与 OS 点击路由。
 * 与点击回调同为懒启动（首个事件时）；订阅面不可用时静默跳过，
 * 绝不影响事件分发。
 */
function ensureRetireWatch(): void {
  if (retireWatchStarted) return;
  retireWatchStarted = true;
  try {
    if (typeof useSessionStore?.subscribe !== 'function') return;
    useSessionStore.subscribe((state, prevState) => {
      const current = state.activeSessionId;
      if (current && current !== prevState.activeSessionId) {
        desktopNotificationService.retireSession(current);
      }
    });
  } catch {
    // 观察面故障不影响分发（同 observeBridgeEventForNotification 口径）
  }
}

/**
 * dispatch 热路径观察入口：维护任务命令缓存 → 映射 → 过门发送。
 * 全程异常自吞——观察面故障绝不影响事件分发。
 */
export function observeBridgeEventForNotification(
  envelope: BridgeEventEnvelope
): void {
  try {
    // 点击回焦回调一次性注册（首个事件时懒启动，先于任何发送）
    if (!clickHandlingInitStarted) {
      clickHandlingInitStarted = true;
      void desktopNotificationService.initClickHandling();
    }
    // 打开即退休订阅（同为首个事件时懒启动）
    ensureRetireWatch();
    const ev: LooseRecord =
      envelope.kind === 'engine'
        ? asRecord(envelope.event)
        : asRecord(envelope.raw);
    if (envelope.type === 'task-started') {
      const taskId = str(ev.taskId);
      const command = str(ev.command);
      if (taskId && command) {
        taskCommands.set(taskId, command);
        if (taskCommands.size > TASK_COMMAND_CACHE_CAP) {
          const oldest = taskCommands.keys().next().value;
          if (oldest !== undefined) taskCommands.delete(oldest);
        }
      }
      return;
    }
    const taskId = str(ev.taskId);
    const request = buildNotificationRequest(envelope, {
      sessionTitle: resolveSessionTitle(str(ev.sessionId)),
      taskCommand: taskId ? taskCommands.get(taskId) : undefined,
    });
    if (
      taskId &&
      (envelope.type === 'task-completed' ||
        envelope.type === 'task-failed' ||
        envelope.type === 'task-killed')
    ) {
      taskCommands.delete(taskId);
    }
    if (request) {
      // run 双终态（agent-end / run-terminal）同会话同类互斥，后到者抑制
      const endKind = runEndKindOf(envelope.type, ev);
      const endSession = str(ev.sessionId);
      if (endKind && endSession && isDuplicateRunEnd(endSession, endKind)) {
        logger.debug(
          `[desktop-notifications] run 双终态抑制 ${envelope.type}/${endKind}`,
          { module: 'desktop-notifications' }
        );
        return;
      }
      logger.debug(
        `[desktop-notifications] 候选事件 ${envelope.type} → ${request.category}/${request.dedupeKey}`,
        { module: 'desktop-notifications' }
      );
      void desktopNotificationService.notify(request);
    }
  } catch (err) {
    // 观察面故障只记 debug 日志，绝不影响事件分发（见模块头）
    logger.debug('[desktop-notifications] 观察器异常（已吞）', {
      module: 'desktop-notifications',
      err:
        err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : { message: String(err) },
    });
  }
}
