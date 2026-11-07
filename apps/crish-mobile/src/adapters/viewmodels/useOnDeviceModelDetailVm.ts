// 本机模型详情视图模型（L2 / IA §3.6）：单模型的状态投影与全部
// 主动作编排。真源各归其位、互不复制：磁盘事实归管理器（订阅 +
// 挂载核对）、已加载归运行时内存（挂载与动作后手动重读，不轮询）、
// 默认归 config.activeModel（只经 store 的 setActiveModel 写，
// 不新增字段）。已加载模型的删除先释放上下文，释放失败中止删
// 文件并把原因留在 actionErrorText（IA §3.4）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes,
  type OnDeviceModelManager,
  type OnDeviceModelState,
} from '@/adapters/onDevice/onDeviceModelManager';
import type { OnDeviceModelSpec } from '@/adapters/onDevice/onDeviceModelCatalog';
import {
  DEFAULT_ON_DEVICE_CONTEXT_SIZE,
  type OnDeviceRuntime,
} from '@/adapters/onDevice/onDeviceChatClient';
import {
  getOnDeviceModelManager,
  getOnDeviceRuntime,
} from '@/adapters/onDevice/onDeviceWiring';
import { ON_DEVICE_PROVIDER_ID } from '@/adapters/onDevice/onDeviceProviderSync';
import { localChatStore } from '@/domain/store/localChatStore';

/** 从目录 id 解析量化标签（如 ...-q4_k_m → Q4_K_M）；解析不出返回 null，不编造 */
export function onDeviceQuantLabel(spec: OnDeviceModelSpec): string | null {
  const match = /[-_](q\d+(?:_k)?(?:_[a-z0-9]+)?)$/i.exec(spec.id);
  return match ? match[1]!.toUpperCase() : null;
}

/** 下载源仓库名（详情「来源」行）：取第一源 URL 的仓库段，解析不出返回 null */
export function onDeviceSourceRepo(spec: OnDeviceModelSpec): string | null {
  const url = spec.urls[0];
  if (!url) return null;
  const match = /^https?:\/\/[^/]+\/(.+?)\/resolve\//.exec(url);
  return match ? match[1]! : null;
}

function actionErrorOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown; detail?: unknown };
    if (typeof record.message === 'string' && record.message !== '') {
      return record.message;
    }
    if (typeof record.detail === 'string' && record.detail !== '') {
      return record.detail;
    }
  }
  return '操作失败';
}

export interface OnDeviceModelDetailVm {
  /** id 是否在目录中（false = 不在目录：诚实空态，无下载动作） */
  readonly found: boolean;
  readonly spec: OnDeviceModelSpec | null;
  readonly state: OnDeviceModelState | null;
  readonly usageBytes: number;
  readonly usageText: string;
  /** 完整文件大小文案（目录 size，与真实占用分开标注） */
  readonly sizeText: string;
  readonly quantLabel: string | null;
  /** 是否有可用的断点续传凭据（决定主动作是「继续下载」还是「重新下载」） */
  readonly resumeAvailable: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly isDefault: boolean;
  readonly busy: boolean;
  readonly actionErrorText: string | null;
  /** 生效上下文长度（目录 inference.contextSize，缺省 = 客户端默认 4096；只读展示） */
  readonly contextSize: number;
  readonly sourceRepo: string | null;
  readonly refresh: () => Promise<void>;
  readonly download: () => void;
  readonly cancelDownload: () => Promise<void>;
  readonly removeModel: () => Promise<void>;
  readonly removeIncomplete: () => Promise<void>;
  readonly load: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly setAsDefault: () => void;
}

export function useOnDeviceModelDetailVm(
  modelId: string,
  managerOverride?: OnDeviceModelManager,
  runtimeOverride?: OnDeviceRuntime
): OnDeviceModelDetailVm {
  const manager = useMemo(
    () => managerOverride ?? getOnDeviceModelManager(),
    [managerOverride]
  );
  const runtime = useMemo(
    () => runtimeOverride ?? getOnDeviceRuntime(),
    [runtimeOverride]
  );
  const spec = useMemo(
    () => manager.spec(modelId) ?? null,
    [manager, modelId]
  );
  const [state, setState] = useState<OnDeviceModelState | null>(
    () => manager.lastKnownState(modelId) ?? null
  );
  const [usageBytes, setUsageBytes] = useState(0);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(() =>
    runtime.loadedModelId()
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionErrorText, setActionErrorText] = useState<string | null>(null);
  const computeIsDefault = useCallback((): boolean => {
    const active = localChatStore.getState().config.activeModel;
    return (
      active?.providerId === ON_DEVICE_PROVIDER_ID &&
      active?.modelId === modelId
    );
  }, [modelId]);
  const [isDefault, setIsDefault] = useState<boolean>(computeIsDefault);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!spec) return;
    const [next, usage, resume] = await Promise.all([
      manager.check(modelId),
      manager.usageBytes(modelId),
      manager.hasResumeCredential(modelId),
    ]);
    if (!aliveRef.current) return;
    setState(next);
    setUsageBytes(usage);
    setResumeAvailable(resume);
    setLoadedId(runtime.loadedModelId());
    setLoading(runtime.isLoading());
  }, [manager, modelId, runtime, spec]);

  // 挂载：订阅本模型事件流 + 核对一次（运行时已加载只在此时与
  // 动作后重读，不轮询）
  useEffect(() => {
    const unsubscribe = manager.subscribe((incoming) => {
      if (incoming.modelId !== modelId) return;
      setState(incoming);
      void manager.usageBytes(modelId).then((usage) => {
        if (aliveRef.current) setUsageBytes(usage);
      });
    });
    void refresh();
    return unsubscribe;
  }, [manager, modelId, refresh]);

  // 默认标记跟随 store（别处改默认时本页同步，不自存一份）
  useEffect(() => {
    const update = (): void => setIsDefault(computeIsDefault());
    update();
    return localChatStore.subscribe(update);
  }, [computeIsDefault]);

  const download = useCallback(() => {
    setBusy(true);
    setActionErrorText(null);
    void manager
      .ensureReady(modelId, () => undefined)
      .then(async (final) => {
        if (!aliveRef.current) return;
        setState(final);
        await refresh();
      })
      .finally(() => {
        if (aliveRef.current) setBusy(false);
      });
  }, [manager, modelId, refresh]);

  const cancelDownload = useCallback(async () => {
    await manager.cancelDownload(modelId);
    await refresh();
  }, [manager, modelId, refresh]);

  const removeModel = useCallback(async () => {
    setActionErrorText(null);
    setBusy(true);
    try {
      if (runtime.loadedModelId() === modelId) {
        // 已加载：先释放上下文；释放失败抛错中止，绝不带着活上下文删文件
        await runtime.releaseLoaded();
        if (aliveRef.current) setLoadedId(runtime.loadedModelId());
      }
      await manager.remove(modelId);
      await refresh();
    } catch (error) {
      if (aliveRef.current) setActionErrorText(actionErrorOf(error));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [manager, modelId, runtime, refresh]);

  const removeIncomplete = useCallback(async () => {
    setActionErrorText(null);
    await manager.removeIncomplete(modelId);
    await refresh();
  }, [manager, modelId, refresh]);

  const load = useCallback(async () => {
    setActionErrorText(null);
    setLoading(true);
    try {
      await runtime.loadModel(modelId);
    } catch (error) {
      if (aliveRef.current) setActionErrorText(actionErrorOf(error));
    } finally {
      if (aliveRef.current) {
        setLoadedId(runtime.loadedModelId());
        setLoading(runtime.isLoading());
      }
    }
  }, [modelId, runtime]);

  const release = useCallback(async () => {
    setActionErrorText(null);
    try {
      await runtime.releaseLoaded();
    } catch (error) {
      if (aliveRef.current) setActionErrorText(actionErrorOf(error));
    } finally {
      if (aliveRef.current) setLoadedId(runtime.loadedModelId());
    }
  }, [runtime]);

  const setAsDefault = useCallback(() => {
    localChatStore.getState().setActiveModel(ON_DEVICE_PROVIDER_ID, modelId);
  }, [modelId]);

  return {
    found: spec !== null,
    spec,
    state,
    usageBytes,
    usageText: formatBytes(usageBytes),
    sizeText: spec ? formatBytes(spec.size) : '',
    quantLabel: spec ? onDeviceQuantLabel(spec) : null,
    resumeAvailable,
    loaded: loadedId !== null && loadedId === modelId,
    loading,
    isDefault,
    busy,
    actionErrorText,
    contextSize:
      spec?.inference?.contextSize ?? DEFAULT_ON_DEVICE_CONTEXT_SIZE,
    sourceRepo: spec ? onDeviceSourceRepo(spec) : null,
    refresh,
    download,
    cancelDownload,
    removeModel,
    removeIncomplete,
    load,
    release,
    setAsDefault,
  };
}

export default useOnDeviceModelDetailVm;
