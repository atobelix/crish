// 本机模型管理视图模型（O4）：O2 管理器状态的只读投影 + 下载/删除
// 编排 + 每次状态落定后回写内置供应商条目（onDeviceProviderSync）。
// 状态源只有管理器一处：挂载 checkAll、下载走 ensureReady 的 onState
// 流式回调、删除后重查——不另造轮询（与 SettingsVoiceView 的 ASR
// 管理面同纪律）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes,
  type OnDeviceModelState,
} from '@/adapters/onDevice/onDeviceModelManager';
import {
  ON_DEVICE_MODEL_CATALOG,
  type OnDeviceModelSpec,
} from '@/adapters/onDevice/onDeviceModelCatalog';
import { getOnDeviceModelManager } from '@/adapters/onDevice/onDeviceWiring';
import { syncOnDeviceProvider } from '@/adapters/onDevice/onDeviceProviderSync';

/** 单个目录模型的管理面投影（纯数据，视图直接渲染） */
export interface OnDeviceModelRow {
  readonly id: string;
  /** 展示名（目录 displayName） */
  readonly name: string;
  /** 体积文案（如「1.0 GB」；下载前预告与占用展示同一真值） */
  readonly sizeText: string;
  /** 许可证说明（如「Apache-2.0 开源许可」） */
  readonly licenseLabel: string;
  /** 许可警示（仅 Qwen2.5-3B 带 Qwen Research License 警示） */
  readonly licenseWarning?: string;
  /** 是否为默认推荐档（1.5B） */
  readonly recommended: boolean;
  /** 管理器原始状态（null = 尚未查得） */
  readonly state: OnDeviceModelState | null;
  /** 状态文案：读取中 / 未下载 / 下载中 x% / 校验中 / 已就绪 / 下载失败 */
  readonly statusText: string;
  /** 下载进度文案（管理器 progressText，仅下载中出现） */
  readonly progressText?: string;
  /** 下载进度 0..1（仅下载中出现） */
  readonly progressFraction?: number;
  /** 失败原因（管理器 error.message，仅失败时出现） */
  readonly errorText?: string;
  /** 失败是否可重试（空间不足等为 true；未知模型为 false） */
  readonly canRetry: boolean;
  /** 本行是否有进行中的下载/删除（防重复触发） */
  readonly busy: boolean;
  /** 本地实际占用（含 .part 半成品；未下载为 0） */
  readonly usageBytes: number;
}

export interface OnDeviceModelsVm {
  readonly rows: readonly OnDeviceModelRow[];
  /** 全部目录模型本地占用合计文案（如「2.1 GB」；为 0 时「0 B」） */
  readonly totalUsageText: string;
  /** 已就绪模型数（列表特殊行/页头摘要用） */
  readonly readyCount: number;
  /** 触发下载（或失败重试）：走管理器 ensureReady，完成后回写条目 */
  readonly download: (modelId: string) => void;
  /** 删除模型文件并回写条目（活动模型回退由 store 自愈兜底） */
  readonly removeModel: (modelId: string) => Promise<void>;
  /** 重新全量核对（checkAll + 占用 + 同步） */
  readonly refresh: () => Promise<void>;
}

/** 管理器状态 → 状态文案（与 ASR 管理面 modelStatusLabel 同口径） */
export function onDeviceStatusText(state: OnDeviceModelState | null): string {
  if (state === null) return '读取中';
  switch (state.kind) {
    case 'ready':
      return '已就绪';
    case 'missing':
      return '未下载';
    case 'downloading':
      return `下载中 ${Math.round(state.overallFraction * 100)}%`;
    case 'verifying':
      return '校验中';
    case 'error':
      return '下载失败';
  }
}

/** 目录条目 + 管理器状态 + 占用 → 管理面行投影（纯函数） */
export function onDeviceRowOf(
  spec: OnDeviceModelSpec,
  state: OnDeviceModelState | null,
  usageBytes: number,
  busy: boolean
): OnDeviceModelRow {
  return {
    id: spec.id,
    name: spec.displayName,
    sizeText: formatBytes(spec.size),
    licenseLabel: spec.license.label,
    ...(spec.license.warning !== undefined
      ? { licenseWarning: spec.license.warning }
      : {}),
    recommended: spec.recommended === true,
    state,
    statusText: onDeviceStatusText(state),
    ...(state?.kind === 'downloading'
      ? {
          progressFraction: state.overallFraction,
          ...(state.progressText !== undefined
            ? { progressText: state.progressText }
            : {}),
        }
      : {}),
    ...(state?.kind === 'error' ? { errorText: state.message } : {}),
    canRetry: state?.kind === 'error' ? state.canRetry : false,
    busy,
    usageBytes,
  };
}

export function useOnDeviceModelsVm(): OnDeviceModelsVm {
  const [states, setStates] = useState<Record<string, OnDeviceModelState>>({});
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const setBusy = useCallback((modelId: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return next;
    });
  }, []);

  const applyState = useCallback((state: OnDeviceModelState) => {
    if (!aliveRef.current) return;
    setStates((prev) => ({ ...prev, [state.modelId]: state }));
  }, []);

  const refreshUsage = useCallback(async () => {
    const manager = getOnDeviceModelManager();
    const entries = await Promise.all(
      ON_DEVICE_MODEL_CATALOG.map(
        async (spec) => [spec.id, await manager.usageBytes(spec.id)] as const
      )
    );
    if (!aliveRef.current) return;
    setUsage(Object.fromEntries(entries));
  }, []);

  const refresh = useCallback(async () => {
    const manager = getOnDeviceModelManager();
    const all = await manager.checkAll();
    if (!aliveRef.current) return;
    setStates(Object.fromEntries(all.map((s) => [s.modelId, s])));
    await refreshUsage();
    // 挂载核对即回写：校验失效（文件被外部删除/标记不在案）在此如实
    // 反映到内置条目，选择器不留假可用模型。
    await syncOnDeviceProvider(manager).catch(() => undefined);
  }, [refreshUsage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = useCallback(
    (modelId: string) => {
      const manager = getOnDeviceModelManager();
      setBusy(modelId, true);
      void manager
        .ensureReady(modelId, applyState)
        .then(async (final) => {
          applyState(final);
          await refreshUsage();
          if (final.kind === 'ready') {
            await syncOnDeviceProvider(manager).catch(() => undefined);
          }
        })
        .finally(() => {
          setBusy(modelId, false);
        });
    },
    [applyState, refreshUsage, setBusy]
  );

  const removeModel = useCallback(
    async (modelId: string) => {
      const manager = getOnDeviceModelManager();
      setBusy(modelId, true);
      try {
        await manager.remove(modelId);
        const next = await manager.check(modelId);
        applyState(next);
        await refreshUsage();
        await syncOnDeviceProvider(manager).catch(() => undefined);
      } finally {
        setBusy(modelId, false);
      }
    },
    [applyState, refreshUsage, setBusy]
  );

  const rows = useMemo<readonly OnDeviceModelRow[]>(
    () =>
      ON_DEVICE_MODEL_CATALOG.map((spec) =>
        onDeviceRowOf(
          spec,
          states[spec.id] ?? null,
          usage[spec.id] ?? 0,
          busyIds.has(spec.id)
        )
      ),
    [states, usage, busyIds]
  );

  const totalUsageBytes = useMemo(
    () => Object.values(usage).reduce((sum, n) => sum + n, 0),
    [usage]
  );
  const readyCount = useMemo(
    () => Object.values(states).filter((s) => s.kind === 'ready').length,
    [states]
  );

  return {
    rows,
    totalUsageText: formatBytes(totalUsageBytes),
    readyCount,
    download,
    removeModel,
    refresh,
  };
}
