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

function _setupFrequencyLogging(): void {
  if (process.env.NODE_ENV !== 'development') return;
  _freqInterval = setInterval(() => {
    for (const name of _STORE_NAMES) {
      const count = _counters.get(name) ?? 0;
      if (count > 0) {
        logger.debug(`[StoreFreq] ${name}: ${count} updates in last 60s`, { module: 'perf' });
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
  unsubs.push(useLayoutStore.subscribe(() => {
    _counters.set('layoutStore', (_counters.get('layoutStore') ?? 0) + 1);
  }));
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

  initStoreAccess(
    useSessionStore,
    useWorkspaceStore,
    useSettingsUiStore,
  );

  // 快照桥接线（P0-1）：注入真实 MessageSnapshots 单例，恢复撤回/归档前的破坏性操作数据保护。
  // 注入点固定本处（模块图稳定后，AppBootstrap 调用），禁止在 store 定义期 import MessageSnapshots（init 环）。
  try {
    const snapshots = new MessageSnapshots();
    bindMessageSnapshotsOps({
      save: (sessionId, entry, options) =>
        snapshots.save(sessionId, entry, { afterMessages: options?.afterMessages ?? [] }),
      clearSession: (sessionId) => snapshots.clearSession(sessionId),
    });
    if (process.env.NODE_ENV === 'development') {
      logger.debug('[Snapshots] bridge bound', { module: 'store' });
    }
  } catch (err) {
    logger.warn('[Snapshots] bridge bind failed — snapshot protection disabled', {
      module: 'store',
      err: toErrMeta(err),
    });
  }

  return () => {
    _teardownFrequencyLogging();
    for (const fn of unsubs) {
      fn();
    }
  };
}
