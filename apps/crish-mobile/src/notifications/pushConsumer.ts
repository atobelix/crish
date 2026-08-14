// 推送消费接线（R3-04 部分 2）：WsGateway events.push（含推送载荷）→ 通知层分发
// - 帧识别：events.push.body.event 双态——普通事件信封（AgentEventEnvelope，type/sessionId
//   面，FeedBridge/terminal/approval 各自消费）vs 推送消息（PushMessage，schemaVersion/
//   eventType/dedupeKey 面，桌面 schema.rs ws_push_body 直推形态）；区分字段 =
//   schemaVersion === 1（普通事件信封无此键，M6 §10.5）；
// - 分发（D7 §6.4 / §7.2-7.3）：先 ingestPushIntoStore（双通道收敛点，同 dedupeKey
//   幂等覆盖，前台/后台一致）→ 按 AppState 路由：
//   · 前台（active）：只入应用内通知中心，不弹系统通知（与 foreground handler 同语义，
//     避免双通知——D7 §7.2「竞态去重」）；
//   · 后台/最小化（background/inactive）：scheduleNotificationAsync 系统通知（Android
//     四类渠道立即呈现，iOS 无渠道即时时展示）；
// - 双通道去重（D7 §6.4-2 / §3.4.1）：PresentedKeyTracker 记录已呈现 dedupeKey（24h TTL，
//   有界内存）——同键二次到达只呈现一条；呈现失败撤回去重登记（重推可再尝试，审批不能漏）；
//   离开配对态清表（新配对会话允许重呈现）；
// - 点击链路：系统通知 content.data 写扁平白名单字段（对齐 normalizeSystemNotification
//   消费面）——点击后 handleNotificationResponse 归一 → 幂等 ingest → markRead → 深链导航
//   （deepLink.ts 已交付，无需重做）；
// - Expo Go 降级（P0-1 DEF-5）：expo-notifications 经 expoNotificationsFacade 安全
//   包装（动态加载 + 调用容错）——系统通知面不可用 → 后台呈现返回空串（不呈现），
//   应用内 ingest 恒保留（分发降级为仅应用内），不抛错不阻塞连接。
import { AppState, type AppStateStatus } from 'react-native';
import { scheduleNotificationAsyncSafe } from './expoNotificationsFacade';
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { authStore } from '@/domain/store/authStore';
import { ingestPushIntoStore } from './foreground';
import { TARGET_ID_PARAM_KEYS } from './foreground';
import { channelIdOf } from './channels';
import type { PushMessage, PushTarget } from './types';

// ── 载荷读取（对齐 foreground.ts asString/asNumber 风格，不猜测） ──

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ── 帧识别：推送 vs 普通事件（schema.rs 区分字段） ──────────────────────────

/**
 * 推送载荷识别：events.push.body.event 是否为 PushMessage（schema v1 直推形态）。
 * 区分字段：schemaVersion === 1（PushMessage 独有；普通事件信封是 type 面，无此键，
 * M6 §10.5 / schema.rs ws_push_body）——三重校验（版本 + eventType + dedupeKey）齐备才识别。
 */
export function recognizePushPayload(v: unknown): boolean {
  const obj = asRecord(v);
  if (!obj) return false;
  if (obj['schemaVersion'] !== 1) return false;
  const eventType = obj['eventType'];
  const dedupeKey = obj['dedupeKey'];
  return (
    typeof eventType === 'string' &&
    eventType.length > 0 &&
    typeof dedupeKey === 'string' &&
    dedupeKey.length > 0
  );
}

/** target 解析（screen/sessionId/params；params 非字符串值丢弃不猜测，schema.rs PushTarget） */
function parseTarget(v: unknown): PushTarget {
  const obj = asRecord(v);
  const params: Record<string, string> = {};
  if (obj) {
    const rawParams = asRecord(obj['params']);
    if (rawParams) {
      for (const [key, value] of Object.entries(rawParams)) {
        const s = asString(value);
        if (s) params[key] = s;
      }
    }
  }
  return {
    screen: asString(obj?.['screen']) ?? '',
    sessionId: asString(obj?.['sessionId']),
    params,
  };
}

/**
 * 帧载荷 → PushMessage（识别 + 宽容解析：必填面识别失败 → null 丢弃；
 * 可选字段缺省回退，与 normalizeSystemNotification 同风格）。非推送载荷一律 null。
 */
export function parsePushEvent(v: unknown): PushMessage | null {
  if (!recognizePushPayload(v)) return null;
  const obj = asRecord(v)!;
  const dedupeKey = obj['dedupeKey'] as string;
  const severity =
    obj['severity'] === 'critical' || obj['severity'] === 'important'
      ? obj['severity']
      : 'normal';
  return {
    schemaVersion: 1,
    id: asString(obj['id']) ?? `ws:${dedupeKey}`,
    eventType: obj['eventType'] as string,
    seq: asNumber(obj['seq']) ?? 0,
    tsMs: asNumber(obj['tsMs']) ?? Date.now(),
    severity,
    category: asString(obj['category']) ?? 'system',
    title: asString(obj['title']) ?? 'Crish 通知',
    body: asString(obj['body']),
    dedupeKey,
    collapseKey: asString(obj['collapseKey']),
    channelId: asString(obj['channelId']) ?? 'general',
    target: parseTarget(obj['target']),
  };
}

// ── 后台系统通知呈现（scheduleNotificationAsync） ──────────────────────────

/**
 * 系统通知 content.data 扁平白名单字段（对齐 normalizeSystemNotification 消费面：
 * data 必含 dedupeKey + eventType，D7 §6.4-2；深链参数照白名单下发，D7 §6.3）。
 * 点击冷启动经 getLastNotificationResponseAsync / response 监听归一回 PushMessage。
 */
export function pushSystemNotificationData(
  push: PushMessage
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    eventType: push.eventType,
    dedupeKey: push.dedupeKey,
    id: push.id,
    seq: push.seq,
    tsMs: push.tsMs,
    severity: push.severity,
    category: push.category,
    title: push.title,
    body: push.body,
    channelId: push.channelId,
    screen: push.target.screen,
    sessionId: push.target.sessionId,
  };
  if (push.collapseKey) data['collapseKey'] = push.collapseKey;
  for (const key of TARGET_ID_PARAM_KEYS) {
    const v = push.target.params[key];
    if (v) data[key] = v;
  }
  return data;
}

/**
 * 后台/最小化系统通知：立即呈现（trigger 为 ChannelAwareTriggerInput——Android 走
 * 归一四类渠道（Z0 §7.4），iOS 无渠道概念按即时 trigger 呈现）。
 * 返回通知标识（expo 生成 id；测试断言入口）。
 * Expo Go 降级（P0-1 DEF-5）：系统通知面不可用 → 返回空串标识（不呈现——
 * 应用内 ingest 由 handleFrame 先行完成，恒保留；去重登记不撤，与「无呈现」语义一致）。
 */
export async function presentSystemPushAsync(
  push: PushMessage
): Promise<string> {
  const id = await scheduleNotificationAsyncSafe({
    content: {
      title: push.title,
      body: push.body,
      data: pushSystemNotificationData(push),
    },
    trigger: { channelId: channelIdOf(push.channelId) },
  });
  return id ?? '';
}

// ── 双通道去重表（同 dedupeKey 只呈现一条，D7 §6.4-2 / §3.4.1） ─────────────

/** 去重 TTL（D7 §3.4.1：桌面策略引擎 24h Map TTL 同口径——尽力而为，重启丢失可接受） */
export const PRESENT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
/** 去重表容量上限（有界内存；超限逐出最旧条目） */
const MAX_TRACKED_KEYS = 512;

/**
 * 已呈现去重表（dedupeKey → 呈现时刻）：系统通知通道的「同键只呈现一条」登记面。
 * 有界 + TTL 惰性过期；测试可注入独立实例与时钟。
 */
export class PresentedKeyTracker {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = PRESENT_DEDUP_TTL_MS,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly maxEntries: number = MAX_TRACKED_KEYS
  ) {}

  /** 键是否在 TTL 内已呈现（过期条目惰性清理） */
  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (this.nowFn() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** 登记呈现（重复 mark 刷新时刻；超上限逐出最旧条目） */
  mark(key: string): void {
    this.entries.set(key, this.nowFn());
    if (this.entries.size <= this.maxEntries) return;
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, at] of this.entries) {
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }

  /** 撤消登记（呈现失败时调用：同键重推可再尝试） */
  remove(key: string): void {
    this.entries.delete(key);
  }

  /** 清空（离开配对态 / 测试隔离） */
  clear(): void {
    this.entries.clear();
  }

  /** 登记条数（诊断 / 单测断言） */
  size(): number {
    return this.entries.size;
  }
}

/** 共享去重表（PushWiring 默认使用；测试注入独立实例隔离） */
export const presentedPushKeys = new PresentedKeyTracker();

// ── 前台/后台呈现路由（D7 §6.4 分发决策的移动端本地一半） ───────────────────

export type PresentationChannel = 'in-app' | 'system' | 'deduped';

/**
 * AppState → 呈现通道（D7 §6.4「connected + active → 仅应用内」/「connected +
 * background → 本地决定横幅」）：
 * - active（前台）：应用内（ingest 已入中心，不弹系统通知）；
 * - 其余（background/inactive 最小化）：系统通知；同键已呈现 → deduped 跳过。
 */
export function routePresentation(
  appState: AppStateStatus,
  alreadyPresented: boolean
): PresentationChannel {
  if (appState === 'active') return 'in-app';
  return alreadyPresented ? 'deduped' : 'system';
}

// ── 消费接线（events.push 帧 → 通知层分发；与 TerminalWiring 同构） ──────────

export interface PushWiringOptions {
  /** 网关实例（生产 = ReconnectingWsClient.gateway；测试注入 mock） */
  gateway: WsGateway;
  /** AppState 读取（缺省 AppState.currentState；测试注入固定前台/后台） */
  getAppState?: () => AppStateStatus;
  /** 去重表（缺省共享单例；测试注入独立实例隔离） */
  tracker?: PresentedKeyTracker;
  /** 时钟（缺省 Date.now；测试固定时刻） */
  now?: () => number;
  /** 系统通知呈现（缺省 presentSystemPushAsync；测试注入 spy 断言） */
  presentSystem?: (push: PushMessage) => Promise<string>;
}

/**
 * 推送消费接线（R3-04 部分 2）：
 * - attach 订阅 events.push 帧 → 帧识别（推送 vs 普通事件）→ 分发；
 * - 前台 ingest 入应用内通知中心（R2-04e 通知中心联动），后台补系统通知；
 * - 同 dedupeKey 双通道只呈现一条（PresentedKeyTracker）；
 * - 离开配对态清去重表（新配对会话允许重呈现，与 TerminalWiring 生命周期同构）。
 */
export class PushWiring {
  private readonly gateway: WsGateway;
  private readonly getAppStateFn: () => AppStateStatus;
  private readonly tracker: PresentedKeyTracker;
  private readonly nowFn: () => number;
  private readonly presentSystemFn: (push: PushMessage) => Promise<string>;
  private unsubscribers: Array<() => void> = [];

  constructor(opts: PushWiringOptions) {
    this.gateway = opts.gateway;
    this.getAppStateFn = opts.getAppState ?? (() => AppState.currentState);
    this.tracker = opts.tracker ?? presentedPushKeys;
    this.nowFn = opts.now ?? (() => Date.now());
    this.presentSystemFn = opts.presentSystem ?? presentSystemPushAsync;
  }

  /** 订阅推送帧 + 配对生命周期（幂等：重复 attach 先 detach） */
  attach(): void {
    this.detach();
    const unsubPush = this.gateway.on('events.push', (frame) => {
      this.handleFrame(frame);
    });
    // 配对状态离开 paired（unpair/移除本机/令牌过期均落此面）→ 清去重表
    const unsubAuth = authStore.subscribe((state, prev) => {
      if (prev.pairState === 'paired' && state.pairState !== 'paired') {
        this.tracker.clear();
      }
    });
    this.unsubscribers = [unsubPush, unsubAuth];
  }

  /** 退订全部（页面/应用卸载或测试隔离时调用，M4 §8.2 退场即退订） */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /** 帧入口：识别推送载荷 → 双通道收敛 ingest → 按 AppState 分发（含去重） */
  handleFrame(frame: InboundEnvelope): void {
    if (frame.kind !== 'events.push') return;
    const body = asRecord(frame.body);
    const push = parsePushEvent(body?.['event']);
    // 普通事件/畸形载荷 → 宽容跳过（FeedBridge/terminal/approval 各面继续消费，不打断连接）
    if (!push) return;
    // 双通道收敛点：先入应用内通知中心（同 dedupeKey 幂等覆盖；前台/后台一致，
    // R2-04e 通知中心联动）
    ingestPushIntoStore(push, this.nowFn());
    const route = routePresentation(
      this.getAppStateFn(),
      this.tracker.has(push.dedupeKey)
    );
    if (route === 'in-app') return; // 前台：应用内已展示，不弹系统通知（双通道去重）
    if (route === 'deduped') {
      console.debug(
        `[push] 去重跳过（${push.dedupeKey} 已呈现，同键只呈现一条，D7 §6.4-2）`
      );
      return;
    }
    // 后台/最小化：先登记再呈现（防同步重入双呈现）；失败撤消登记（重推可再尝试）
    this.tracker.mark(push.dedupeKey);
    void this.presentSystemFn(push).catch((err: unknown) => {
      this.tracker.remove(push.dedupeKey);
      console.warn(
        `[push] 系统通知呈现失败（${push.dedupeKey}）：${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
}
