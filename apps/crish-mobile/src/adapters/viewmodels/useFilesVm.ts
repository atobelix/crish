// 文件浏览视图模型（R2-06b，M4 §2.2.2 页面唯一数据入口）：
// - 读：filesStore 树态（cwd/history/dirs/sortMode/activeWorkspaceRoot）+
//   connectionStore 相位（未连接 → 四态「未连接」错误态，任务书）；
// - 驱动：接线上下文（仓库 + 目录/预览缓存，filesWiring 单例或测试注入）；
//   cwd 变化 → 未加载层自动拉取（先查目录缓存 TTL 30s，F4 §5.2）；首次进入
//   无工作区 → 拉工作区列表 → 自动切活动根（F4-F02 复授权校验）；
// - 竞态防护：per-dir 序号（seq），过期响应丢弃（快速进出目录不串扰，X4-1）；
// - 本地 UI 态：密度三档 44/48/56（默认 48，R2UX-06-01；设置联动可后置）、
//   下拉刷新 refreshing、工作区列表装载态、切换中 busy（防双点）。
//
// 只读纪律：本文件只调用 filesStore 动作（filesStore.ts 公开面），不修改 domain。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '@/domain/types/domain';
import { filesStore } from '@/domain/store/filesStore';
import type {
  DirLoadState,
  DirLoadStatus,
  DirSortMode,
} from '@/domain/store/filesReducers';
import type { WorkspaceEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import { useFilesStore } from '@/adapters/hooks/useFilesStore';
import { dirCacheKey } from '@/domain/store/filesCache';
import {
  getFilesContext,
  joinRelPath,
  workspaceNameOf,
  type FilesContext,
} from '@/adapters/wiring/filesWiring';
import { FilesCommandError } from '@/adapters/wiring/filesRepository';
import {
  getObservationWiring,
  ensureObservationWiring,
} from '@/adapters/wiring/observationWiring';

// ── 常量与类型 ────────────────────────────────────────────────────────────

/** 行高密度三档（R2UX-06-01：固定行高 44/48/56，默认 48） */
export const ROW_DENSITIES = [44, 48, 56] as const;
export type RowDensity = (typeof ROW_DENSITIES)[number];
/** 默认密度（任务书：默认 48；设置联动可后置） */
export const DEFAULT_ROW_DENSITY: RowDensity = 48;

/** 工作区列表装载态（WorkspaceSwitcher 数据面） */
export type WorkspacesStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** 空目录态（dirs 缺省占位：未加载 = idle，F4 四态数据面） */
const IDLE_DIR_STATE: DirLoadState = { status: 'idle', entries: [] };

/** 异常 → 协议错误码（F4 附录 B 映射面在 UI 层；未知异常 → internal） */
export function errorCodeOf(e: unknown): string {
  return e instanceof FilesCommandError ? e.code : 'internal';
}

/** 首次进入 / 重连后自动装载（bootstrap）用工作区选择：active 优先，无则首个 */
export function pickBootstrapWorkspace(
  workspaces: readonly WorkspaceEntry[]
): WorkspaceEntry | undefined {
  return workspaces.find((w) => w.active) ?? workspaces[0];
}

export interface FilesVm {
  /** 连接是否就绪（phase === 'ready'；否则四态投影「未连接」错误态） */
  connected: boolean;
  /** 活动工作区根（null = 未装载，bootstrap 中/失败） */
  activeWorkspaceRoot: string | null;
  /** 工作区展示名（路径叶名；null = 未装载） */
  workspaceName: string | null;
  /** 当前浏览目录（相对路径，'' = 工作区根） */
  cwd: string;
  /** 导航栈（栈顶 = cwd，X4-6 手势返回/面包屑一致性） */
  history: string[];
  canGoBack: boolean;
  /** 当前层条目（dirs[cwd] 已排序；未加载 = 空数组） */
  entries: readonly FileEntry[];
  /** 当前层装载态（idle/loading/loaded/error，R2UX-06-07 四态数据面） */
  status: DirLoadStatus;
  /** 展示用错误码（工作区错误优先，其次当前层错误；null = 无错误） */
  errorCode: string | null;
  sortMode: DirSortMode;
  /** 行高密度（44/48/56，默认 48） */
  density: RowDensity;
  /** 下拉刷新进行中 */
  refreshing: boolean;
  /** 工作区切换中（防双点，F2 §9.3-3） */
  switchingWorkspace: boolean;
  /** 工作区列表（null = 未拉取；F4-F01） */
  workspaces: readonly WorkspaceEntry[] | null;
  workspacesStatus: WorkspacesStatus;
  workspacesError: string | null;
  /** 进入目录（push 导航，F4 §6.2） */
  enterDir: (dir: string) => void;
  /** 返回上级（pop 导航，X4-6） */
  back: () => void;
  /** 面包屑跳转：导航栈截断到指定深度 */
  jumpTo: (index: number) => void;
  setSortMode: (mode: DirSortMode) => void;
  setDensity: (density: RowDensity) => void;
  /** 下拉刷新：失效当前层缓存 + 重拉 */
  refresh: () => void;
  /** 错误态重试：重拉当前层 */
  retry: () => void;
  /** 未连接重试：拉起观测接线并重连 */
  retryConnect: () => void;
  /** 打开工作区选择器（列表未拉取则拉取） */
  openWorkspaceList: () => void;
  /** 切换工作区：switchWorkspace → resetWorkspace → 重载根目录（F4-F02） */
  switchWorkspace: (root: string) => void;
}

export function useFilesVm(contextOverride?: FilesContext | null): FilesVm {
  // ── store 订阅（适配层唯一绑定入口） ───────────────────────────────────
  const phase = useConnectionStore((s) => s.phase);
  const connected = phase === 'ready';
  const tree = useFilesStore((s) => ({
    cwd: s.cwd,
    history: s.history,
    sortMode: s.sortMode,
    activeWorkspaceRoot: s.activeWorkspaceRoot,
    dirs: s.dirs,
  }));

  // ── 本地态 ──────────────────────────────────────────────────────────────
  const [density, setDensity] = useState<RowDensity>(DEFAULT_ROW_DENSITY);
  const [refreshing, setRefreshing] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [workspaces, setWorkspaces] = useState<
    readonly WorkspaceEntry[] | null
  >(null);
  const [workspacesStatus, setWorkspacesStatus] =
    useState<WorkspacesStatus>('idle');
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  /** 上下文（测试注入优先；缺省走接线单例） */
  const ctxOf = useCallback(
    () => contextOverride ?? getFilesContext(),
    [contextOverride]
  );

  /** per-dir 请求序号（竞态防护：过期响应丢弃，X4-1 防串扰） */
  const seqRef = useRef(new Map<string, number>());
  /** 工作区切换 busy（防双点） */
  const switchingRef = useRef(false);
  /** bootstrap 重试触发（工作区错误态重试：无活动根时递增强制重新装载） */
  const [bootstrapNonce, setBootstrapNonce] = useState(0);

  // ── 目录加载（缓存优先 + seq 竞态防护） ────────────────────────────────
  const loadDir = useCallback(
    async (dir: string, force: boolean): Promise<void> => {
      const ctx = ctxOf();
      if (!ctx) return; // 未接线：保持现状（未连接态由 connectionStore 投影）
      const st = filesStore.getState();
      const root = st.activeWorkspaceRoot ?? '';
      const key = dirCacheKey(root, dir);

      if (!force) {
        const cached = ctx.dirCache.get(key);
        if (cached) {
          const nowMs = Date.now();
          filesStore.getState().markDirLoaded(
            dir,
            cached.map((e) => ({
              ...e,
              relPath: joinRelPath(dir, e.name),
              receivedAtMs: nowMs,
            })),
            nowMs
          );
          return;
        }
      } else {
        ctx.dirCache.invalidate(key); // 下拉刷新：先失效缓存（F4 附录 A）
      }

      const seq = (seqRef.current.get(dir) ?? 0) + 1;
      seqRef.current.set(dir, seq);
      filesStore.getState().markDirLoading(dir);
      try {
        const res = await ctx.repository.listDir({
          path: dir,
          ...(root ? { workspaceRoot: root } : {}),
        });
        if (seqRef.current.get(dir) !== seq) return; // 过期响应丢弃
        const nowMs = Date.now();
        ctx.dirCache.set(key, res.entries);
        filesStore.getState().markDirLoaded(
          dir,
          res.entries.map((e) => ({
            ...e,
            relPath: joinRelPath(dir, e.name),
            receivedAtMs: nowMs,
          })),
          nowMs
        );
      } catch (e) {
        if (seqRef.current.get(dir) !== seq) return;
        filesStore.getState().markDirError(dir, errorCodeOf(e));
      }
    },
    [ctxOf]
  );

  // ── 工作区 bootstrap（首次进入 / 重连后自动装载，F4-F02） ─────────────
  useEffect(() => {
    if (phase !== 'ready' || tree.activeWorkspaceRoot) return;
    const ctx = ctxOf();
    if (!ctx) return;
    let cancelled = false;
    void (async () => {
      setWorkspacesStatus('loading');
      setWorkspaceError(null);
      try {
        const res = await ctx.repository.listWorkspaces();
        if (cancelled) return;
        setWorkspaces(res.workspaces);
        setWorkspacesStatus('loaded');
        const target = pickBootstrapWorkspace(res.workspaces);
        if (!target) return; // 无已授权工作区 → 空态引导（F4 §6.1）
        const switched = await ctx.repository.switchWorkspace({
          path: target.root,
        });
        if (cancelled) return;
        setWorkspaces((prev) =>
          prev
            ? prev.map((w) => ({
                ...w,
                active: w.root === switched.activeRoot,
              }))
            : prev
        );
        filesStore.getState().resetWorkspace(switched.activeRoot);
      } catch (e) {
        if (cancelled) return;
        setWorkspacesStatus('error');
        setWorkspaceError(errorCodeOf(e)); // 未授权/未连接 → 错误态（F4-F03）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, tree.activeWorkspaceRoot, bootstrapNonce, ctxOf]);

  // ── cwd 变化 → 未加载层自动拉取（懒加载，F4-F11） ─────────────────────
  useEffect(() => {
    if (phase !== 'ready' || !tree.activeWorkspaceRoot) return;
    const cur = tree.dirs[tree.cwd];
    if (!cur || cur.status === 'idle') {
      void loadDir(tree.cwd, false);
    }
  }, [tree.cwd, phase, tree.activeWorkspaceRoot, tree.dirs, loadDir]);

  // ── 动作 ────────────────────────────────────────────────────────────────

  const enterDir = useCallback((dir: string) => {
    filesStore.getState().enterDir(dir);
  }, []);

  const back = useCallback(() => {
    filesStore.getState().goBack();
  }, []);

  /** 面包屑跳转：goBack 循环截断导航栈到指定深度（reducer 无跳转动作，
   *   pop 幂等：根层原地不动，X4-6 栈一致性） */
  const jumpTo = useCallback((index: number) => {
    let st = filesStore.getState();
    while (st.history.length - 1 > index) {
      st.goBack();
      st = filesStore.getState();
    }
  }, []);

  const setSortMode = useCallback((mode: DirSortMode) => {
    filesStore.getState().setSortMode(mode);
  }, []);

  const refresh = useCallback(() => {
    const dir = filesStore.getState().cwd;
    setRefreshing(true);
    void (async () => {
      try {
        await loadDir(dir, true);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [loadDir]);

  const retry = useCallback(() => {
    const st = filesStore.getState();
    if (!st.activeWorkspaceRoot) {
      setWorkspaceError(null);
      setBootstrapNonce((n) => n + 1); // 无活动根 → 重新走 bootstrap
      return;
    }
    void loadDir(st.cwd, false);
  }, [loadDir]);

  const retryConnect = useCallback(() => {
    const wiring = getObservationWiring() ?? ensureObservationWiring();
    wiring?.client.connect();
    if (!filesStore.getState().activeWorkspaceRoot) {
      setBootstrapNonce((n) => n + 1); // 重连就绪后触发 bootstrap
    }
  }, []);

  const openWorkspaceList = useCallback(() => {
    if (workspaces === null) {
      void (async () => {
        const ctx = ctxOf();
        if (!ctx) return;
        setWorkspacesStatus('loading');
        setWorkspacesError(null);
        try {
          const res = await ctx.repository.listWorkspaces();
          setWorkspaces(res.workspaces);
          setWorkspacesStatus('loaded');
        } catch (e) {
          setWorkspacesStatus('error');
          setWorkspacesError(errorCodeOf(e));
        }
      })();
    }
  }, [workspaces, ctxOf]);

  const switchWorkspace = useCallback(
    (root: string) => {
      if (switchingRef.current) return; // 防双点
      const ctx = ctxOf();
      if (!ctx) return;
      switchingRef.current = true;
      setSwitchingWorkspace(true);
      setWorkspaceError(null);
      void (async () => {
        try {
          const res = await ctx.repository.switchWorkspace({ path: root });
          setWorkspaces((prev) =>
            prev
              ? prev.map((w) => ({ ...w, active: w.root === res.activeRoot }))
              : prev
          );
          filesStore.getState().resetWorkspace(res.activeRoot);
        } catch (e) {
          setWorkspaceError(errorCodeOf(e));
        } finally {
          switchingRef.current = false;
          setSwitchingWorkspace(false);
        }
      })();
    },
    [ctxOf]
  );

  // ── 派生 ────────────────────────────────────────────────────────────────
  const dirState = tree.dirs[tree.cwd] ?? IDLE_DIR_STATE;
  const errorCode = workspaceError ?? dirState.errorCode ?? null;

  const canGoBack = tree.history.length > 1;
  const workspaceName = useMemo(
    () =>
      tree.activeWorkspaceRoot
        ? workspaceNameOf(tree.activeWorkspaceRoot)
        : null,
    [tree.activeWorkspaceRoot]
  );

  return {
    connected,
    activeWorkspaceRoot: tree.activeWorkspaceRoot,
    workspaceName,
    cwd: tree.cwd,
    history: tree.history,
    canGoBack,
    entries: dirState.entries,
    status: dirState.status,
    errorCode,
    sortMode: tree.sortMode,
    density,
    refreshing,
    switchingWorkspace,
    workspaces,
    workspacesStatus,
    workspacesError,
    enterDir,
    back,
    jumpTo,
    setSortMode,
    setDensity,
    refresh,
    retry,
    retryConnect,
    openWorkspaceList,
    switchWorkspace,
  };
}
