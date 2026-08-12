// 文件域目录树状态纯逻辑 reducers（R2-06；M5 §3.1：集合/状态更新纯函数放此处，
// store 动作只做转发，jest 直测）
//
// 对齐依据：
// - F4 §2.2 排序语义：目录优先 + 同级字母序（directory.rs:68-72，桌面已排好，
//   手机端缓存合并/排序模式切换时本地重排兜底）；F4-F13 P1 增加修改时间倒序/大小序；
// - F4-F11 树形浏览（懒展开）：展开目录 = 请求其子列表并缓存
//   （useFileNavigation.expanded 语义，useFileNavigation.ts:54-74）；
// - F4 §5.2 展开态：切换工作区清空、内存态不落盘；X4-6 返回一致性：栈回溯保留展开态；
// - R2UX-06-07 四态数据面：idle（未加载）/loading（加载中）/loaded（已加载）/
//   error（失败可重试）；空态由 loaded + entries.length===0 派生（UI 层文案）。

import type { FileEntry } from '../types/domain';

// ── 状态类型 ──────────────────────────────────────────────────────────────

/** 目录加载四态（R2UX-06-07；空态 = loaded 且 entries 为空，UI 派生） */
export type DirLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** 排序模式（F4 §2.2 默认目录优先+名称序；F4-F13 P1 两种扩展） */
export type DirSortMode = 'name' | 'mtime-desc' | 'size-desc';

/** 单层目录加载态（键 = 该层相对路径，'' = 工作区根） */
export interface DirLoadState {
  status: DirLoadStatus;
  /** loaded 时有效：已按当前 sortMode 排序的条目 */
  entries: FileEntry[];
  /** error 时有效：错误码（F4 附录 B 映射面在 UI 层） */
  errorCode?: string;
  /** loaded 时刻 ms（30s 新鲜度由缓存层负责，此处仅记录） */
  loadedAtMs?: number;
}

/** 目录树状态（F4 §5.2 展开态内存态 + 懒展开缓存 + 导航栈） */
export interface FilesTreeState {
  /** 活动工作区根（切换 → 清空整树，F4 §5.2） */
  activeWorkspaceRoot: string | null;
  /** 当前浏览目录（相对路径；'' = 工作区根） */
  cwd: string;
  /** 导航栈（cwd 为栈顶；X4-6 手势返回/面包屑语义） */
  history: string[];
  /** 已展开目录集合（相对路径；展开 = 已请求子列表并缓存） */
  expanded: string[];
  /** 每层目录加载态（懒展开缓存，F4-F11） */
  dirs: Record<string, DirLoadState>;
  /** 排序模式（默认 name，F4 §2.2） */
  sortMode: DirSortMode;
}

/** 初始树态（无工作区、根目录待加载） */
export function createFilesTreeState(): FilesTreeState {
  return {
    activeWorkspaceRoot: null,
    cwd: '',
    history: [''], // 导航栈含当前目录（栈顶 = cwd，根 = ''）
    expanded: [],
    dirs: {},
    sortMode: 'name',
  };
}

// ── 排序（纯函数，F4 §2.2 / F4-F13） ───────────────────────────────────────

function byName(a: FileEntry, b: FileEntry): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * 条目排序（目录优先恒为主键——桌面 directory.rs:68-72 语义；同级按模式）：
 * - name：字母升序（默认，F4 §2.2）；
 * - mtime-desc：modified（epoch ms 字符串）降序，缺省 0（旧到最末）；
 * - size-desc：size 降序，缺省 0。
 * 注：桌面已保证排序，此函数用于缓存合并与排序模式切换（F4-F13 P1）。
 */
export function sortDirEntries(
  entries: readonly FileEntry[],
  mode: DirSortMode
): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 目录优先
    switch (mode) {
      case 'name':
        return byName(a, b);
      case 'mtime-desc': {
        const ma = Number(a.modified) || 0;
        const mb = Number(b.modified) || 0;
        return mb - ma;
      }
      case 'size-desc':
        return (b.size ?? 0) - (a.size ?? 0);
    }
  });
}

// ── 导航（X4-6 手势返回/面包屑一致性） ─────────────────────────────────────

/**
 * 进入目录（F4 §6.2 push 导航语义）：目录压入导航栈、设为当前；
 * 目标目录在 dirs 中不存在 → 建 idle 占位（等待加载）。
 */
export function enterDir(state: FilesTreeState, dir: string): FilesTreeState {
  const dirs = ensureDirState(state.dirs, dir);
  return {
    ...state,
    cwd: dir,
    history: [...state.history, dir],
    dirs,
  };
}

/** 返回上级（F4 §6.2 pop 语义）：栈顶即当前目录，弹出后上一级为当前；根层原地不动 */
export function goBack(state: FilesTreeState): FilesTreeState {
  if (state.history.length <= 1) return state;
  const history = state.history.slice(0, -1);
  const cwd = history[history.length - 1]!;
  return { ...state, cwd, history };
}

// ── 展开/收起（F4-F11 懒展开，内存态不落盘） ────────────────────────────────

/** 展开目录（幂等；展开即标记「子列表已请求/可请求」，F4-F11） */
export function expandDir(state: FilesTreeState, dir: string): FilesTreeState {
  if (state.expanded.includes(dir)) return state;
  return { ...state, expanded: [...state.expanded, dir] };
}

/** 收起目录（幂等；不清缓存，X4-6 再展开命中缓存） */
export function collapseDir(
  state: FilesTreeState,
  dir: string
): FilesTreeState {
  if (!state.expanded.includes(dir)) return state;
  return { ...state, expanded: state.expanded.filter((d) => d !== dir) };
}

/** 展开态切换 */
export function toggleDir(state: FilesTreeState, dir: string): FilesTreeState {
  return state.expanded.includes(dir)
    ? collapseDir(state, dir)
    : expandDir(state, dir);
}

// ── 加载态（R2UX-06-07 四态数据面） ────────────────────────────────────────

function ensureDirState(
  dirs: Record<string, DirLoadState>,
  dir: string
): Record<string, DirLoadState> {
  if (dirs[dir]) return dirs;
  return { ...dirs, [dir]: { status: 'idle', entries: [] } };
}

/** 请求开始：loading（四态之一；首次进入/下拉刷新共用） */
export function markDirLoading(
  state: FilesTreeState,
  dir: string
): FilesTreeState {
  const dirs = ensureDirState(state.dirs, dir);
  return {
    ...state,
    dirs: { ...dirs, [dir]: { status: 'loading', entries: [] } },
  };
}

/** 请求成功：loaded（条目按当前 sortMode 排序后写入；空条目即空态派生面） */
export function markDirLoaded(
  state: FilesTreeState,
  dir: string,
  entries: readonly FileEntry[],
  nowMs: number
): FilesTreeState {
  const dirs = ensureDirState(state.dirs, dir);
  return {
    ...state,
    dirs: {
      ...dirs,
      [dir]: {
        status: 'loaded',
        entries: sortDirEntries(entries, state.sortMode),
        loadedAtMs: nowMs,
      },
    },
  };
}

/** 请求失败：error（错误码透传，UI 层映射文案 + 重试入口，R2UX-06-07） */
export function markDirError(
  state: FilesTreeState,
  dir: string,
  errorCode: string
): FilesTreeState {
  const dirs = ensureDirState(state.dirs, dir);
  return {
    ...state,
    dirs: {
      ...dirs,
      [dir]: { status: 'error', entries: [], errorCode },
    },
  };
}

/** 缓存失效（下拉刷新 / 写操作成功后失效上级目录，F4 §5.2）：loaded → idle */
export function invalidateDir(
  state: FilesTreeState,
  dir: string
): FilesTreeState {
  const current = state.dirs[dir];
  if (!current || current.status !== 'loaded') return state;
  return {
    ...state,
    dirs: { ...state.dirs, [dir]: { status: 'idle', entries: [] } },
  };
}

// ── 排序模式 / 工作区 ──────────────────────────────────────────────────────

/** 切换排序模式：已加载层全部按新模式重排（F4-F13 P1） */
export function setSortMode(
  state: FilesTreeState,
  mode: DirSortMode
): FilesTreeState {
  if (state.sortMode === mode) return state;
  const dirs: Record<string, DirLoadState> = {};
  for (const [dir, load] of Object.entries(state.dirs)) {
    dirs[dir] =
      load.status === 'loaded'
        ? { ...load, entries: sortDirEntries(load.entries, mode) }
        : load;
  }
  return { ...state, sortMode: mode, dirs };
}

/** 切换工作区（F4 §5.2：清空展开态与目录缓存；返回初始树态并挂活动根） */
export function resetWorkspace(
  state: FilesTreeState,
  root: string | null
): FilesTreeState {
  return { ...createFilesTreeState(), activeWorkspaceRoot: root };
}
