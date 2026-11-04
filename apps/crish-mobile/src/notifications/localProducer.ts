// 本地通知产生器（通知分寸移动批 2026-11-03）：手机本机产生的事件 → 与桌面
// 推送同一条投递链（ingest 应用内通知中心 → 前台仅应用内 / 后台经 prefsGate
// 事件级门禁 + PresentedKeyTracker 去重 → presentSystemPushAsync 系统通知）。
//
// 两个产生点（此前均无产生器，事件发生了也没人知道）：
// 1. 本地模式线程终态：localChatEngine 的 onComplete / onError 回调 →
//    notifyLocalThreadTerminal。事件形态刻意对齐桌面 wire 词汇（eventType
//    run-terminal + severity important/critical），使 prefsGate 的失败分流
//    自动生效：完成归 taskDone 开关、失败归 error 恒放行。用户主动停止
//    （stopLocalChatMessage）不在此列——那是用户在场的操作，不打扰；
//    未配置发送失败也不经此路（发送当场已在页面 error 槽呈现，无 run 发生）。
// 2. 所选桌面设备离线：accountRuntime 的资格门去抖裁决点（已接线目标连续
//    TARGET_MISS_ROUND_LIMIT 轮发现未命中 → 拆线）是运行时既有「设备真离线」
//    边沿，本模块只负责把边沿翻译成通知输入（notifySelectedDeviceOffline），
//    不新造状态机；门禁走 deviceOffline 场景开关（默认关，用户 opt-in）。
//
// 去重键统一加 `local:` 前缀，与桌面帧的 dedupeKey 空间隔离（双通道去重表
// presentedPushKeys 与通知中心 id 都以 dedupeKey 为主键，前缀保证不相撞）。
// 深链 target 留空：本地线程与设备离线在通知深链白名单（notificationMeta）
// 里没有对应路由，route=null 即点击仅标记已读——不伪造跳转。
import { AppState, type AppStateStatus } from 'react-native';
import { ingestPushIntoStore } from './foreground';
import {
  presentSystemPushAsync,
  presentedPushKeys,
  routePresentation,
  type PresentedKeyTracker,
} from './pushConsumer';
import {
  DEVICE_OFFLINE_EVENT_TYPE,
  shouldShowSystemNotificationForPushLive,
} from './prefsGate';
import type { PushMessage, PushSeverity, PushTarget } from './types';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { createLogger } from '@/adapters/platform/logger';

const log = createLogger('push-local');

/** 本地推送输入（PushMessage 的本地构造面；dedupeKey 不带前缀，模块内统一加） */
export interface LocalPushInput {
  /** 事件类型（对齐桌面 wire 词汇，或本地专属如 device-offline） */
  eventType: string;
  /** 级别（P0 critical / P1 important / P2 normal；门禁失败分流读此面） */
  severity: PushSeverity;
  /** 分类（run / system / …，对齐 scene_category 词汇） */
  category: string;
  /** 通道 id（D7 七渠道词汇；呈现时归一为 Z0 四类） */
  channelId: string;
  /** 标题（类标签） */
  title: string;
  /** 正文（人类可识别名优先，不放裸 id；可空） */
  body: string | null;
  /** 去重键（业务唯一；模块内加 `local:` 前缀后作双通道主键） */
  dedupeKey: string;
  /** 深链目标（缺省空目标 = 不跳转） */
  target?: PushTarget;
}

/** 本地产生器依赖（缺省生产实现；测试注入） */
export interface LocalPushDeps {
  /** AppState 读取（缺省 AppState.currentState） */
  getAppState?: () => AppStateStatus;
  /** 系统通知呈现（缺省 presentSystemPushAsync） */
  presentSystem?: (push: PushMessage) => Promise<string>;
  /** 去重表（缺省共享 presentedPushKeys，与远端推送同表同 TTL） */
  tracker?: PresentedKeyTracker;
  /** 时钟（缺省 Date.now） */
  now?: () => number;
}

const EMPTY_TARGET: PushTarget = { screen: '', sessionId: null, params: {} };

/**
 * 本地事件 → 通知投递（与 PushWiring.handleFrame 同语义）：
 * 先 ingest 入应用内通知中心（恒保留）→ 前台仅应用内；后台经去重 +
 * prefsGate 事件级门禁后呈现系统通知（门禁拦截不登记呈现，日后开开关
 * 同键仍可再呈现——本地事件无重推，此条仅为语义与远端一致）。
 */
export function emitLocalPush(
  input: LocalPushInput,
  deps: LocalPushDeps = {}
): void {
  const nowFn = deps.now ?? (() => Date.now());
  const now = nowFn();
  const dedupeKey = `local:${input.dedupeKey}`;
  const push: PushMessage = {
    schemaVersion: 1,
    id: dedupeKey,
    eventType: input.eventType,
    seq: 0,
    tsMs: now,
    severity: input.severity,
    category: input.category,
    title: input.title,
    body: input.body,
    dedupeKey,
    collapseKey: null,
    channelId: input.channelId,
    target: input.target ?? EMPTY_TARGET,
  };
  ingestPushIntoStore(push, now);
  const tracker = deps.tracker ?? presentedPushKeys;
  const getAppState = deps.getAppState ?? (() => AppState.currentState);
  const route = routePresentation(getAppState(), tracker.has(dedupeKey));
  if (route === 'in-app') return;
  if (route === 'deduped') {
    log.debug(`本地通知去重跳过（${dedupeKey} 已呈现）`);
    return;
  }
  if (!shouldShowSystemNotificationForPushLive(push)) {
    log.debug(`本地通知偏好门禁跳过（${dedupeKey} 被场景开关过滤）`);
    return;
  }
  tracker.mark(dedupeKey);
  const present = deps.presentSystem ?? presentSystemPushAsync;
  void present(push).catch((err: unknown) => {
    tracker.remove(dedupeKey);
    log.warn(`本地系统通知呈现失败（${dedupeKey}）`, err);
  });
}

/** 本地线程标题（通知正文用的人类可识别名；占位/派生标题即线程当前名，如实使用） */
function localThreadTitle(threadId: string): string {
  const thread = localChatSessionStore
    .getState()
    .threads.find((t) => t.id === threadId);
  const title = thread?.title.trim();
  return title ? title : '本地对话';
}

/**
 * 本地线程终态通知（localChatEngine 终态钩子调用）：
 * - completed：title「任务已完成」+ 正文线程名（完成类，taskDone 开关管辖）；
 * - failed：title「任务运行失败」+ 正文「线程名：错误首行」（失败类，
 *   error 恒放行；文案口径与桌面 S3/S4 人类名口径一致，不放裸 id）。
 */
export function notifyLocalThreadTerminal(
  args: {
    threadId: string;
    /** 本轮助手消息 id（去重键业务部分：一轮一记，互不覆盖） */
    assistantId: string;
    outcome: 'completed' | 'failed';
    /** 失败时的用户可见错误说明（LocalChatError.message；取首行） */
    errorMessage?: string | null;
  },
  deps: LocalPushDeps = {}
): void {
  const threadTitle = localThreadTitle(args.threadId);
  if (args.outcome === 'completed') {
    emitLocalPush(
      {
        eventType: 'run-terminal',
        severity: 'important',
        category: 'run',
        channelId: 'run',
        title: '任务已完成',
        body: threadTitle,
        dedupeKey: `run-terminal:${args.threadId}:${args.assistantId}`,
      },
      deps
    );
    return;
  }
  const errorLine = args.errorMessage?.split('\n')[0]?.trim();
  emitLocalPush(
    {
      eventType: 'run-terminal',
      severity: 'critical',
      category: 'run',
      channelId: 'run',
      title: '任务运行失败',
      body: errorLine ? `${threadTitle}：${errorLine}` : threadTitle,
      dedupeKey: `run-terminal:${args.threadId}:${args.assistantId}:failed`,
    },
    deps
  );
}

/**
 * 所选桌面设备离线通知（accountRuntime 去抖裁决边沿调用）：
 * 标题带设备名（现成设备名来源 = 设备目录/发现快照的 AccountDevice.name，
 * 由调用方解析后传入；不放裸 deviceId）。门禁走 deviceOffline 场景
 * （默认关）。去重键含离线时刻：每次离线边沿独立成记，flap 恢复后再
 * 离线是新事件、不被 24h 去重误吞。
 */
export function notifySelectedDeviceOffline(
  args: {
    deviceId: string;
    /** 设备展示名（调用方从设备目录/发现快照解析；不得传裸 id） */
    deviceName: string;
    /** 离线边沿时刻（缺省现在；去重键业务部分） */
    offlineAtMs?: number;
  },
  deps: LocalPushDeps = {}
): void {
  const at = args.offlineAtMs ?? (deps.now ?? (() => Date.now()))();
  emitLocalPush(
    {
      eventType: DEVICE_OFFLINE_EVENT_TYPE,
      severity: 'normal',
      category: 'system',
      channelId: 'general',
      title: `${args.deviceName} 已离线`,
      body: null,
      dedupeKey: `device-offline:${args.deviceId}:${at}`,
    },
    deps
  );
}
