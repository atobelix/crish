// Composer 上下文视图模型（G1）：快捷条（项目/权限）与展开行模型钮的数据面。
// - 项目：复用文件页同一数据面（GatewayFilesRepository.listWorkspaces /
//   switchWorkspace，filesWiring.getFilesContext 注入）；活动根的唯一真源是
//   filesStore.activeWorkspaceRoot（与文件页共享）——切换经 resetWorkspace
//   落店，后续发起的 run 解析「当前工作区」时自然落到新项目（useQuickRunVm
//   的 workspace 解析读 filesStore）。本 VM 不复制文件页的目录 bootstrap
//   语义（那是文件页装载职责），只做：标签解析 + 列表拉取 + 切换。
// - 权限：读 settingsStore 的 composer 组（持久化偏好），写入经 setPermissionMode；
//   规范化走 domain/pure/permissionMode（桌面三档口径）。
// - 模型：现行移动端无任何模型状态可读（G2/W-B 两端点 GET /v1/models、
//   POST /v1/models/active 尚未落地）——只给缺省表述常量，G2 到来时在此接
//   真数据（见 ModelSheet 文件头对接点），禁止编造型号。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceEntry } from '@crish/shared-types';
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

/** 模型钮缺省标签（桌面「全局默认模型」语义的移动端口径；G2 接真名后替换） */
export const COMPOSER_MODEL_LABEL = '默认模型';

export type ComposerWorkspacesStatus = 'idle' | 'loading' | 'loaded' | 'error';

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
  /** 模型钮标签（现行恒为缺省表述，G2 接入点） */
  modelLabel: string;
}

function errorCodeOf(e: unknown): string {
  return e instanceof FilesCommandError ? e.code : 'internal';
}

export function useComposerContextVm(
  contextOverride?: FilesContext | null
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

  const ctxOf = useCallback(
    (): FilesContext | null => contextOverride ?? getFilesContext(),
    [contextOverride]
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
    modelLabel: COMPOSER_MODEL_LABEL,
  };
}
