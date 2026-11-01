// Composer 上下文视图模型（G1）：快捷条（项目/权限）与展开行模型钮的数据面。
// - 项目：复用文件页同一数据面（GatewayFilesRepository.listWorkspaces /
//   switchWorkspace，filesWiring.getFilesContext 注入）；活动根的唯一真源是
//   filesStore.activeWorkspaceRoot（与文件页共享）——切换经 resetWorkspace
//   落店，后续发起的 run 解析「当前工作区」时自然落到新项目（useQuickRunVm
//   的 workspace 解析读 filesStore）。本 VM 不复制文件页的目录 bootstrap
//   语义（那是文件页装载职责），只做：标签解析 + 列表拉取 + 切换。
// - 权限：读 settingsStore 的 composer 组（持久化偏好），写入经 setPermissionMode；
//   规范化走 domain/pure/permissionMode（桌面三档口径）。
// - 模型（G2/W-B 落地）：经模型域仓库（GatewayModelsRepository.listModels /
//   setActiveModel，modelsWiring.getModelsContext 注入）读写桌面统一模型树
//   的全局默认——语义对照：任务书 GET /v1/models ≡ C38 listModels、
//   POST /v1/models/active ≡ C39 setActiveModel（现行命令面为 WS remote.*
//   命令面，与项目命令同形态）；用户裁决 Q3：切换 = 改桌面全局默认（含桌面
//   端生效），不是手机本地覆盖。本 VM 只做：标签解析 + 列表拉取 + 切换，
//   数据不可达时标签回退缺省表述并呈未连接/错误态，禁止编造型号。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActiveModelInfo,
  ModelEntry,
  WorkspaceEntry,
} from '@crish/shared-types';
import type { PermissionMode } from '@/domain/pure/permissionMode';
import {
  coercePermissionMode,
  permissionModeOption,
} from '@/domain/pure/permissionMode';
import { workspaceNameOf } from '@/domain/pure/workspacePath';
import { filesStore } from '@/domain/store/filesStore';
import { settingsStore } from '@/domain/store/settingsStore';
import {
  useConnectionStore,
  useSettingsStore,
} from '@/adapters/hooks/useAppStore';
import { useFilesStore } from '@/adapters/hooks/useFilesStore';
import { FilesCommandError } from '@/adapters/wiring/filesRepository';
import {
  getFilesContext,
  type FilesContext,
} from '@/adapters/wiring/filesWiring';
import { ModelsCommandError } from '@/adapters/wiring/modelsRepository';
import {
  getModelsContext,
  type ModelsContext,
} from '@/adapters/wiring/modelsWiring';
import { modelRefKey } from '@/domain/repositories/modelCommands';

/** 模型钮缺省标签（桌面未设置全局默认 / 数据不可达时的诚实回退表述） */
export const COMPOSER_MODEL_LABEL = '默认模型';

export type ComposerWorkspacesStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** 模型列表状态（与项目列表同四态口径） */
export type ComposerModelsStatus = ComposerWorkspacesStatus;

export interface ComposerContextVm {
  connected: boolean;
  /** 快捷条项目胶囊标签（活动工作区名） */
  workspaceLabel: string;
  /** WorkspaceSheet 数据面（未拉取为 null） */
  workspaces: readonly WorkspaceEntry[] | null;
  workspacesStatus: ComposerWorkspacesStatus;
  /** Sheet 勾选根：filesStore 活动根优先，回退列表 active 标记 */
  activeWorkspaceRoot: string | null;
  switchingWorkspace: boolean;
  workspacesError: string | null;
  /** 打开项目 Sheet 时调用：列表缺失或活动根已漂移才刷新 */
  openWorkspaceList: () => void;
  selectWorkspace: (root: string) => void;
  retryWorkspaces: () => void;
  /** 权限档（已规范化）与胶囊短名 */
  permissionMode: PermissionMode;
  permissionLabel: string;
  setPermissionMode: (mode: PermissionMode) => void;
  /** 模型钮标签（真实全局默认显示名；未设置/数据不可达时回退缺省表述） */
  modelLabel: string;
  /** ModelSheet 数据面（未拉取为 null） */
  models: readonly ModelEntry[] | null;
  modelsStatus: ComposerModelsStatus;
  /** 当前全局默认（桌面真源投影；未设置/未拉取为 null） */
  activeModel: ActiveModelInfo | null;
  /** Sheet 勾选键：modelRefKey(providerId, modelId)；无默认 = null */
  activeModelId: string | null;
  /**
   * 活动模型视觉能力（G5b）：C38 投影 vision 标记（统一模型树
   * modalities.input 含 image，与引擎出站守卫同口径）。仅当活动模型
   * 在可选集中且标记 true 时为 true；未设置默认 / 列表未达 / 条目
   * 缺失一律 false（fail-closed，与桌面 checkModelVisionSupport 未确认
   * 即 false 同姿态）——false 时图片在组装层降级为元数据文本，绝不
   * 带图硬发（引擎对非视觉模型带图是整单拒绝而非降级）。
   */
  activeModelVisionSupported: boolean;
  switchingModel: boolean;
  modelsError: string | null;
  /** 打开模型 Sheet 时调用：列表缺失或上次失败才刷新 */
  openModelList: () => void;
  /** 切换全局默认：成功返回 true 且标签/列表态即时更新；失败返回 false 并把错误码落 modelsError（现状不漂移） */
  selectModel: (providerId: string, modelId: string) => Promise<boolean>;
  retryModels: () => void;
}

function errorCodeOf(e: unknown): string {
  return e instanceof FilesCommandError || e instanceof ModelsCommandError
    ? e.code
    : 'internal';
}

export function useComposerContextVm(
  contextOverride?: FilesContext | null,
  modelsContextOverride?: ModelsContext | null
): ComposerContextVm {
  const connected = useConnectionStore((s) => s.phase === 'ready');
  const activeRoot = useFilesStore((s) => s.activeWorkspaceRoot);
  const storedMode = useSettingsStore((s) => s.groups.composer.permissionMode);
  const permissionMode = coercePermissionMode(storedMode);

  const [workspaces, setWorkspaces] = useState<
    readonly WorkspaceEntry[] | null
  >(null);
  const [status, setStatus] = useState<ComposerWorkspacesStatus>('idle');
  const [switching, setSwitching] = useState(false);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const switchingRef = useRef(false);

  const [models, setModels] = useState<readonly ModelEntry[] | null>(null);
  const [modelsStatus, setModelsStatus] =
    useState<ComposerModelsStatus>('idle');
  const [activeModel, setActiveModel] = useState<ActiveModelInfo | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsLoadingRef = useRef(false);
  const switchingModelRef = useRef(false);

  const ctxOf = useCallback(
    (): FilesContext | null => contextOverride ?? getFilesContext(),
    [contextOverride]
  );

  const modelsCtxOf = useCallback(
    (): ModelsContext | null => modelsContextOverride ?? getModelsContext(),
    [modelsContextOverride]
  );

  const loadWorkspaces = useCallback(async () => {
    if (loadingRef.current) return;
    const ctx = ctxOf();
    if (!ctx) return;
    loadingRef.current = true;
    setStatus('loading');
    try {
      const res = await ctx.repository.listWorkspaces();
      setWorkspaces(res.workspaces);
      setWorkspacesError(null);
      setStatus('loaded');
    } catch (e) {
      setWorkspacesError(errorCodeOf(e));
      setStatus('error');
    } finally {
      loadingRef.current = false;
    }
  }, [ctxOf]);

  // 连接就绪后为胶囊标签解析一次列表（只为取名，不做任何切换——自动切换
  // 活动根是文件页 bootstrap 的职责，本 VM 不重复触发）
  useEffect(() => {
    if (connected && workspaces === null && status === 'idle') {
      void loadWorkspaces();
    }
  }, [connected, workspaces, status, loadWorkspaces]);

  const openWorkspaceList = useCallback(() => {
    const listActiveRoot = workspaces?.find((w) => w.active)?.root ?? null;
    const stale =
      workspaces === null ||
      (activeRoot !== null && listActiveRoot !== activeRoot);
    if (stale) void loadWorkspaces();
  }, [workspaces, activeRoot, loadWorkspaces]);

  const selectWorkspace = useCallback(
    (root: string) => {
      if (switchingRef.current) return;
      const ctx = ctxOf();
      if (!ctx) return;
      switchingRef.current = true;
      setSwitching(true);
      void (async () => {
        try {
          const res = await ctx.repository.switchWorkspace({ path: root });
          setWorkspaces((prev) =>
            prev
              ? prev.map((w) => ({ ...w, active: w.root === res.activeRoot }))
              : prev
          );
          setWorkspacesError(null);
          // 活动根唯一真源落店：文件页与后续 run 的工作区解析同步生效
          filesStore.getState().resetWorkspace(res.activeRoot);
        } catch (e) {
          // 切换失败保持现状（标签不漂移、不伪造成功）；错误码供宿主提示
          setWorkspacesError(errorCodeOf(e));
        } finally {
          switchingRef.current = false;
          setSwitching(false);
        }
      })();
    },
    [ctxOf]
  );

  const retryWorkspaces = useCallback(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const loadModels = useCallback(async () => {
    if (modelsLoadingRef.current) return;
    const ctx = modelsCtxOf();
    if (!ctx) return;
    modelsLoadingRef.current = true;
    setModelsStatus('loading');
    try {
      const res = await ctx.repository.listModels();
      setModels(res.models);
      setActiveModel(res.activeModel ?? null);
      setModelsError(null);
      setModelsStatus('loaded');
    } catch (e) {
      setModelsError(errorCodeOf(e));
      setModelsStatus('error');
    } finally {
      modelsLoadingRef.current = false;
    }
  }, [modelsCtxOf]);

  // 连接就绪后为模型钮标签解析一次列表（只读投影，不做任何切换）
  useEffect(() => {
    if (connected && models === null && modelsStatus === 'idle') {
      void loadModels();
    }
  }, [connected, models, modelsStatus, loadModels]);

  const openModelList = useCallback(() => {
    if (models === null || modelsStatus === 'error') {
      void loadModels();
    }
  }, [models, modelsStatus, loadModels]);

  const selectModel = useCallback(
    async (providerId: string, modelId: string): Promise<boolean> => {
      if (switchingModelRef.current) return false;
      const ctx = modelsCtxOf();
      if (!ctx) return false;
      switchingModelRef.current = true;
      setSwitchingModel(true);
      try {
        const res = await ctx.repository.setActiveModel({
          providerId,
          modelId,
        });
        // 成功即以服务端回传为准即时更新：标签（activeModel）与列表对号
        // （active 标记）同步落新全局默认，不等下一次拉取
        setActiveModel(res.activeModel);
        setModels((prev) =>
          prev
            ? prev.map((m) => ({
                ...m,
                active:
                  m.providerId === res.activeModel.providerId &&
                  m.modelId === res.activeModel.modelId,
              }))
            : prev
        );
        setModelsError(null);
        return true;
      } catch (e) {
        // 切换失败保持现状（标签与对号不漂移、不伪造成功）；错误码供 Sheet 提示
        setModelsError(errorCodeOf(e));
        return false;
      } finally {
        switchingModelRef.current = false;
        setSwitchingModel(false);
      }
    },
    [modelsCtxOf]
  );

  const retryModels = useCallback(() => {
    void loadModels();
  }, [loadModels]);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    settingsStore.getState().update('composer', { permissionMode: mode });
  }, []);

  const activeEntry =
    workspaces?.find((w) => w.root === activeRoot) ??
    workspaces?.find((w) => w.active) ??
    null;
  const workspaceLabel = activeEntry
    ? (activeEntry.name ?? workspaceNameOf(activeEntry.root))
    : activeRoot
      ? workspaceNameOf(activeRoot)
      : '工作区';

  return {
    connected,
    workspaceLabel,
    workspaces,
    workspacesStatus: status,
    activeWorkspaceRoot: activeRoot ?? activeEntry?.root ?? null,
    switchingWorkspace: switching,
    workspacesError,
    openWorkspaceList,
    selectWorkspace,
    retryWorkspaces,
    permissionMode,
    permissionLabel: permissionModeOption(permissionMode).shortLabel,
    setPermissionMode,
    modelLabel: activeModel?.displayName ?? COMPOSER_MODEL_LABEL,
    models,
    modelsStatus,
    activeModel,
    activeModelId: activeModel
      ? modelRefKey(activeModel.providerId, activeModel.modelId)
      : null,
    activeModelVisionSupported: Boolean(
      activeModel &&
      models?.some(
        (m) =>
          m.providerId === activeModel.providerId &&
          m.modelId === activeModel.modelId &&
          m.vision === true
      )
    ),
    switchingModel,
    modelsError,
    openModelList,
    selectModel,
    retryModels,
  };
}
