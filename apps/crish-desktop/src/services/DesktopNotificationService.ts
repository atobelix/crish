/**
 * 桌面 OS 通知服务（2026-11-03 托盘/通知批；批 C 第 1 件补前台通道）
 *
 * 分类口径（与移动端推送场景表同源，桌面侧收敛为四类）：
 * - `approval` 必达：审批请求 / 需要人工介入——不可关；
 * - `failure` 必达：run 失败、运行异常、子代理失败、后台工具/任务
 *   失败与卡死、安全拦截——不可关；
 * - `completion` 可关：run 完成/取消、子代理完成、后台工具/任务
 *   完成——受 prefs `notify_on_task_done`（默认开）；
 * - `scheduled` 计划触发：定时器/cron——桌面默认关，不上屏开关，
 *   本服务直接不发（仅作代码口径归类）。
 * 总开关 prefs `desktop_notifications_enabled`（默认开）一票否决全体。
 *
 * 到达面三岔（反馈路由宪法 docs/guides/feedback-routing.md §2，服务层
 * 单点裁决，生产者只管映射事件、不感知焦点）：
 * 1. 聚焦且正在看该会话（activeSessionId 命中）→ **静默**：用户已亲眼
 *    看到终态，任何弹窗都是打扰；同时按业务键记已达，事后不补发；
 * 2. 聚焦但不在该会话（或事件无会话归属）→ **应用内呈现**（toast 通道，
 *    按 dedupe 键登记条目，会话打开时可退休）；
 * 3. 未聚焦 / 最小化 / **托盘隐藏**（isVisible=false）→ **OS 通知**。
 * 这是与托盘批的耦合点：窗口进托盘后所有终态都走 OS 通知，不留黑洞。
 *
 * 去重：业务键（runId / toolCallId / taskId 派生）同一终态只达一次
 * （任一到达面计达，含静默亲见）。
 *
 * 打开即退休（retireSession）：用户打开某会话时，退休该会话的应用内
 * 条目（即时 dismiss）并清掉其 OS 通知点击路由映射——退休按既有业务
 * 键/会话映射反查，不新造键体系。OS 通知横幅本身在桌面插件层无按 id
 * 撤销能力，退休范围以应用内面为界（宪法 §2 登记）；`seen` 去重集刻意
 * 不随退休清除，终态只达一次的语义不重置。
 *
 * 点击回焦：发送时把 sessionId 放入 extra 载荷并登记 id→session
 * 映射；插件 onAction 回调命中后恢复主窗口（show + unminimize +
 * focus）并发 `open-chat` UI 事件跳到对应会话。
 *
 * 产生点：chat-bridge 的 dispatchEvent 统一观察（见
 * desktopNotificationObserver.ts），不在各 handler 内散接。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { getPreference } from '../api/preferences/preferencesClient';
import { emitUiEvent } from '../api/uiEvents';
import { getActiveSessionId } from '../store/sessionStore';
import { logger } from './LoggerService';
import { ToastStore } from './toast/ToastStore';

export type DesktopNotificationCategory =
  'approval' | 'failure' | 'completion' | 'scheduled';

export interface DesktopNotificationRequest {
  category: DesktopNotificationCategory;
  /** 业务去重键（同一终态只发一次） */
  dedupeKey: string;
  title: string;
  body: string;
  /** 点击通知时跳转的会话（缺失则只回焦窗口） */
  sessionId?: string;
}

/** 到达裁决结果（notifyRouted 的可观测口径；notify() 为其布尔简写） */
export type DesktopNotificationOutcome =
  | 'sent' // 已走 OS 通知
  | 'presented' // 已走应用内呈现
  | 'silent-viewing' // 聚焦且正在看该会话：亲见即达，静默
  | 'blocked'; // 任一门拦截（分类/开关/去重/权限/呈现失败）

export interface DesktopNotificationDeps {
  isMasterEnabled: () => Promise<boolean>;
  isCompletionEnabled: () => Promise<boolean>;
  /** true = 用户正在看主窗口（聚焦 + 可见 + 未最小化） */
  probeUserWatching: () => Promise<boolean>;
  /** 用户当前正在看的会话（store activeSessionId）；未知 → undefined */
  probeActiveSessionId: () => string | undefined;
  ensurePermission: () => Promise<boolean>;
  send: (req: DesktopNotificationRequest, id: number) => Promise<void>;
  /** 应用内呈现一条（toast 通道）；返回条目 id 供退休，失败 → undefined */
  presentInApp: (req: DesktopNotificationRequest) => string | undefined;
  /** 退休一条应用内条目 */
  dismissInApp: (entryId: string) => void;
  /** 点击通知回焦 + 跳会话 */
  onClicked: (sessionId?: string) => void;
}

const DEDUPE_CAP = 512;

export class DesktopNotificationService {
  private readonly deps: DesktopNotificationDeps;
  private readonly seen = new Map<string, true>();
  private nextId = 1;
  private readonly sessionByNotificationId = new Map<number, string>();
  /** 应用内条目登记：sessionId → 条目 id 集（打开即退休的反查表） */
  private readonly inAppEntriesBySession = new Map<string, Set<string>>();

  constructor(deps: DesktopNotificationDeps) {
    this.deps = deps;
  }

  /** 订阅插件点击回调（应用启动后调用一次；失败静默降级为无点击行为） */
  async initClickHandling(): Promise<void> {
    try {
      await onAction((event) => {
        const extra = (event.notification?.extra ?? {}) as Record<
          string,
          unknown
        >;
        const fromExtra =
          typeof extra.sessionId === 'string' ? extra.sessionId : undefined;
        const id = event.notification?.id;
        const fromMap =
          typeof id === 'number'
            ? this.sessionByNotificationId.get(id)
            : undefined;
        this.deps.onClicked(fromExtra ?? fromMap);
      });
    } catch (err) {
      logger.warn('[desktop-notifications] 点击回调注册失败', {
        module: 'desktop-notifications',
        err:
          err instanceof Error
            ? { message: err.message, stack: err.stack, name: err.name }
            : { message: String(err) },
      });
    }
  }

  /**
   * 尝试送达一条通知（到达面三岔见文件头）。返回 true = 已达任一面
   * （OS 发送或应用内呈现）；静默亲见与任一门拦截返回 false。
   */
  async notify(req: DesktopNotificationRequest): Promise<boolean> {
    const outcome = await this.notifyRouted(req);
    return outcome === 'sent' || outcome === 'presented';
  }

  /** notify 的完整裁决口径（测试与诊断用） */
  async notifyRouted(
    req: DesktopNotificationRequest
  ): Promise<DesktopNotificationOutcome> {
    try {
      // 计划触发类桌面默认关（代码口径归类，不上屏开关）
      if (req.category === 'scheduled') return 'blocked';
      if (!(await this.deps.isMasterEnabled())) {
        logger.debug('[desktop-notifications] 总开关关闭，跳过', {
          module: 'desktop-notifications',
        });
        return 'blocked';
      }
      if (
        req.category === 'completion' &&
        !(await this.deps.isCompletionEnabled())
      ) {
        logger.debug('[desktop-notifications] 完成开关关闭，跳过', {
          module: 'desktop-notifications',
        });
        return 'blocked';
      }
      if (this.seen.has(req.dedupeKey)) return 'blocked';

      // 聚焦三岔：正在看该会话 → 静默亲见；聚焦但不在该会话 → 应用内呈现
      if (await this.deps.probeUserWatching()) {
        const activeSessionId = this.deps.probeActiveSessionId();
        if (
          req.sessionId &&
          activeSessionId &&
          req.sessionId === activeSessionId
        ) {
          // 亲见即达：按业务键记已达，事后（含失焦后）不补发同一终态
          this.remember(req.dedupeKey);
          logger.debug('[desktop-notifications] 正在看该会话，静默', {
            module: 'desktop-notifications',
          });
          return 'silent-viewing';
        }
        const entryId = this.deps.presentInApp(req);
        if (!entryId) return 'blocked';
        this.remember(req.dedupeKey);
        if (req.sessionId) {
          const set =
            this.inAppEntriesBySession.get(req.sessionId) ?? new Set<string>();
          set.add(entryId);
          this.inAppEntriesBySession.set(req.sessionId, set);
        }
        return 'presented';
      }

      // 失焦/托盘隐藏 → OS 通知
      if (!(await this.deps.ensurePermission())) {
        logger.debug('[desktop-notifications] 通知权限未授予，跳过', {
          module: 'desktop-notifications',
        });
        return 'blocked';
      }

      const id = this.nextId++;
      this.remember(req.dedupeKey);
      if (req.sessionId) {
        this.sessionByNotificationId.set(id, req.sessionId);
        if (this.sessionByNotificationId.size > DEDUPE_CAP) {
          const oldest = this.sessionByNotificationId.keys().next().value;
          if (oldest !== undefined) this.sessionByNotificationId.delete(oldest);
        }
      }
      await this.deps.send(req, id);
      return 'sent';
    } catch (err) {
      // 通知失败绝不反噬事件主流程（调用方在 dispatch 热路径上）
      logger.warn(`[desktop-notifications] 发送失败 key=${req.dedupeKey}`, {
        module: 'desktop-notifications',
        err:
          err instanceof Error
            ? { message: err.message, stack: err.stack, name: err.name }
            : { message: String(err) },
      });
      return 'blocked';
    }
  }

  /**
   * 打开即退休：退休某会话的全部应用内条目并清其 OS 点击路由映射。
   * 由会话打开面（activeSessionId 变更）在观察器接线调用。
   */
  retireSession(sessionId: string): void {
    const entries = this.inAppEntriesBySession.get(sessionId);
    if (entries) {
      for (const entryId of entries) {
        try {
          this.deps.dismissInApp(entryId);
        } catch {
          // 单条退休失败不阻断其余条目与主流程
        }
      }
      this.inAppEntriesBySession.delete(sessionId);
    }
    for (const [id, sid] of this.sessionByNotificationId) {
      if (sid === sessionId) this.sessionByNotificationId.delete(id);
    }
  }

  private remember(key: string): void {
    this.seen.set(key, true);
    if (this.seen.size > DEDUPE_CAP) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

async function probeUserWatchingDefault(): Promise<boolean> {
  try {
    const win = getCurrentWindow();
    const [focused, visible, minimized] = await Promise.all([
      win.isFocused(),
      win.isVisible(),
      win.isMinimized(),
    ]);
    return focused && visible && !minimized;
  } catch {
    // 探针失败（非 Tauri 环境等）：按「未在看」处理，让发送层再兜底
    return false;
  }
}

let permissionGrantedCache: boolean | null = null;

async function ensurePermissionDefault(): Promise<boolean> {
  if (permissionGrantedCache) return true;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    permissionGrantedCache = granted;
    return granted;
  } catch {
    return false;
  }
}

async function refocusMainWindow(sessionId?: string): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setFocus();
  } catch {
    // 回焦失败静默（窗口可能已退出）
  }
  if (sessionId) {
    emitUiEvent('open-chat', { sessionId });
  }
}

/** 生产依赖（prefs + Tauri 窗口探针 + 插件发送 + toast 应用内通道） */
export function createDefaultDesktopNotificationDeps(): DesktopNotificationDeps {
  return {
    isMasterEnabled: async () => {
      try {
        return await getPreference('desktop_notifications_enabled');
      } catch {
        return true; // 读偏好失败按默认开（与 schema 默认一致）
      }
    },
    isCompletionEnabled: async () => {
      try {
        return await getPreference('notify_on_task_done');
      } catch {
        return true;
      }
    },
    probeUserWatching: probeUserWatchingDefault,
    probeActiveSessionId: () => {
      try {
        return getActiveSessionId() || undefined;
      } catch {
        return undefined;
      }
    },
    ensurePermission: ensurePermissionDefault,
    send: async (req, id) => {
      sendNotification({
        id,
        title: req.title,
        body: req.body,
        extra: req.sessionId ? { sessionId: req.sessionId } : {},
      });
    },
    presentInApp: (req) => {
      // 应用内面 = 既有 toast 单例通道（宪法 §2）：类别 → 变体映射
      // failure=error / approval=warning / completion=success；
      // 条目 id 由业务去重键派生（不新造键体系），供打开即退休反查。
      const type =
        req.category === 'failure'
          ? 'error'
          : req.category === 'approval'
            ? 'warning'
            : 'success';
      return ToastStore.show(req.body || req.title, {
        id: `attention:${req.dedupeKey}`,
        type,
        ...(req.body ? { title: req.title } : {}),
      });
    },
    dismissInApp: (entryId) => {
      ToastStore.dismiss(entryId);
    },
    onClicked: (sessionId) => {
      void refocusMainWindow(sessionId);
    },
  };
}

/** 进程内单例（dispatch 观察面与启动接线共用） */
export const desktopNotificationService = new DesktopNotificationService(
  createDefaultDesktopNotificationDeps()
);
