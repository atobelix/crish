import { useLayoutStore } from './layoutStore';
import { useSessionStore } from './sessionStore';
import { useWorkspaceStore } from './workspaceStore';
import { useSettingsUiStore } from './settingsUiStore';
import { useTerminalStore } from './terminalStore';
import { useWorkerStore } from './workerStore';
import { usePermissionStore } from './permissionStore';
import { useSettingsStore } from './settingsStore';
import { initStoreAccess } from '../api/storeAccess';
import { MessageSnapshots } from '../api/MessageSnapshots';
import { bindMessageSnapshotsOps } from './messageSnapshotsBridge';
import { logger, toErrMeta } from '../services/LoggerService';
import { initTabModeProjection } from './tabModeApply';
import { sharedSessionStreamManager } from '../hooks/chat-stream/sessionStreamManager';
import { sessionDraftManager } from '../api/draft/sessionDraftManager';
import { bindDraftManagerForEviction } from './sessionDeleteTransition';

// ── Store update frequency logging ──
const _counters = new Map<string, number>();
const _STORE_NAMES = [
  'layoutStore',
  'sessionStore',
  'workspaceStore',
  'settingsUiStore',
  'terminalStore',
  'workerStore',
  'permissionStore',
  'settingsStore',
];
let _freqInterval: ReturnType<typeof setInterval> | null = null;

/**
 * R-13（T5.4，08-detail 6.4）：订阅者计数 + 重渲染范围统计。
 * 包装各 store 的 subscribe：统计活跃订阅者数与订阅回调执行次数
 * （一次 set 触发多少组件重渲染的近似口径）。仅 dev overlay/日志消费。
 */
type SubscribeFn = (
  listener: (state: unknown, prev: unknown) => void
) => () => void;
const _subscriberStats = new Map<
  string,
  () => { active: number; invocations: number }
>();

function _wrapSubscriberCounting(
  store: { subscribe: SubscribeFn },
  name: string
): void {
  const orig = store.subscribe.bind(store);
  let active = 0;
  let invocations = 0;
  store.subscribe = ((listener: (state: unknown, prev: unknown) => void) => {
    active++;
    const wrapped = (state: unknown, prev: unknown) => {
      invocations++;
      listener(state, prev);
    };
    const unsub = orig(wrapped);
    return () => {
      active = Math.max(0, active - 1);
      unsub();
    };
  }) as SubscribeFn;
  _subscriberStats.set(name, () => ({ active, invocations }));
}

/** 订阅者/重渲染范围统计读取面（dev overlay 消费；快照语义） */
export function getStoreFreqStats(): Record<
  string,
  { activeSubscribers: number; subscriberInvocations: number }
> {
  const out: Record<
    string,
    { activeSubscribers: number; subscriberInvocations: number }
  > = {};
  for (const [name, read] of _subscriberStats) {
    const s = read();
    out[name] = {
      activeSubscribers: s.active,
      subscriberInvocations: s.invocations,
    };
  }
  return out;
}

function _setupFrequencyLogging(): void {
  if (process.env.NODE_ENV !== 'development') return;
  _freqInterval = setInterval(() => {
    for (const name of _STORE_NAMES) {
      const count = _counters.get(name) ?? 0;
      const sub = _subscriberStats.get(name)?.() ?? null;
      if (count > 0 || (sub && sub.active > 0)) {
        logger.debug(
          `[StoreFreq] ${name}: ${count} updates in last 60s` +
            (sub
              ? `, subscribers=${sub.active}, invocations=${sub.invocations}`
              : ''),
          { module: 'perf' }
        );
      }
      _counters.set(name, 0);
    }
  }, 60000);
}

function _teardownFrequencyLogging(): void {
  if (_freqInterval !== null) {
    clearInterval(_freqInterval);
    _freqInterval = null;
  }
}

export function bootstrapStores(): () => void {
  const unsubs: (() => void)[] = [];
  _setupFrequencyLogging();

  // Note: Facade stores share the same underlying LayoutStore instance in Phase 0/1,
  // so no inter-store subscribe sync is required. Single listener for frequency metrics:
  unsubs.push(
    useLayoutStore.subscribe(() => {
      _counters.set('layoutStore', (_counters.get('layoutStore') ?? 0) + 1);
    })
  );
  // R-13（T5.4）：订阅者计数 + 重渲染范围统计（dev overlay 消费面）
  _wrapSubscriberCounting(useLayoutStore, 'layoutStore');
  // T11 域 store：独立实例，各计各的
  const domainHooks = [
    useTerminalStore,
    useWorkerStore,
    usePermissionStore,
    useSettingsStore,
  ] as const;
  unsubs.push(
    ...domainHooks.map((hook, i) =>
      hook.subscribe(() => {
        const name = _STORE_NAMES[4 + i]!;
        _counters.set(name, (_counters.get(name) ?? 0) + 1);
      })
    )
  );
  for (let i = 0; i < domainHooks.length; i++) {
    _wrapSubscriberCounting(domainHooks[i]!, _STORE_NAMES[4 + i]!);
  }

  initStoreAccess(useSessionStore, useWorkspaceStore, useSettingsUiStore);

  unsubs.push(initTabModeProjection());

  // 快照桥接线（P0-1）：注入真实 MessageSnapshots 单例，恢复撤回/归档前的破坏性操作数据保护。
  // 注入点固定本处（模块图稳定后，AppBootstrap 调用），禁止在 store 定义期 import MessageSnapshots（init 环）。
  try {
    const snapshots = new MessageSnapshots();
    bindMessageSnapshotsOps({
      save: (sessionId, entry, options) =>
        snapshots.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
        }),
      clearSession: (sessionId) => snapshots.clearSession(sessionId),
    });
    if (process.env.NODE_ENV === 'development') {
      logger.debug('[Snapshots] bridge bound', { module: 'store' });
    }
  } catch (err) {
    logger.warn(
      '[Snapshots] bridge bind failed — snapshot protection disabled',
      {
        module: 'store',
        err: toErrMeta(err),
      }
    );
  }

  // Double-Lock 墓碑与存活探针（E3-01）：为流式调度器注入会话在 Store 中的存活判定闭包
  sharedSessionStreamManager.bindSessionAliveOracle((sessionId: string) => {
    const state = useSessionStore.getState();
    return Boolean(
      state.sessionsById[sessionId] ||
      state.sessions?.some((s) => s.id === sessionId)
    );
  });
  unsubs.push(() => {
    sharedSessionStreamManager.bindSessionAliveOracle(null);
  });

  // 草稿管理器驱逐单向解耦（E3-04）：为 store 会话删除注入草稿管理器实例
  bindDraftManagerForEviction(sessionDraftManager);
  unsubs.push(() => {
    bindDraftManagerForEviction(null);
  });

  return () => {
    _teardownFrequencyLogging();
    for (const fn of unsubs) {
      fn();
    }
  };
}
