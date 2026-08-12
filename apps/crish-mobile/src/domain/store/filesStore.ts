// filesStore（R2-06 领域层 store）：vanilla createStore + immer，零 React 依赖
// 纯逻辑在 filesReducers.ts（jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { FileEntry } from '../types/domain';
import {
  createFilesTreeState,
  enterDir,
  goBack,
  expandDir,
  collapseDir,
  toggleDir,
  markDirLoading,
  markDirLoaded,
  markDirError,
  invalidateDir,
  setSortMode,
  resetWorkspace,
} from './filesReducers';
import type { FilesTreeState, DirSortMode } from './filesReducers';

export interface FilesState extends FilesTreeState {
  /** 进入目录（push 导航语义，F4 §6.2）；目标未加载 → idle 占位等待加载 */
  enterDir: (dir: string) => void;
  /** 返回上级（pop 语义，X4-6 手势返回一致性） */
  goBack: () => void;
  /** 展开目录（懒展开：标记子列表已请求/可请求，F4-F11） */
  expandDir: (dir: string) => void;
  /** 收起目录（不清缓存） */
  collapseDir: (dir: string) => void;
  /** 展开态切换 */
  toggleDir: (dir: string) => void;
  /** 目录请求开始（loading，R2UX-06-07 四态数据面） */
  markDirLoading: (dir: string) => void;
  /** 目录请求成功（loaded；按当前 sortMode 排序写入） */
  markDirLoaded: (dir: string, entries: FileEntry[], nowMs?: number) => void;
  /** 目录请求失败（error；错误码透传，UI 层映射文案 + 重试） */
  markDirError: (dir: string, errorCode: string) => void;
  /** 缓存失效（下拉刷新 / 写成功后失效上级目录）：loaded → idle */
  invalidateDir: (dir: string) => void;
  /** 切换排序模式（已加载层重排，F4-F13 P1） */
  setSortMode: (mode: DirSortMode) => void;
  /** 切换工作区（清空整树并挂新活动根，F4 §5.2） */
  resetWorkspace: (root: string | null) => void;
}

function nowDefault(): number {
  return Date.now();
}

// 显式 StoreApi 标注（对齐 approvalStore：immer 中间件组合链推断类型引用外部
// draft 类型无法在导出声明中命名，公共面以 StoreApi<FilesState> 收敛）
export const filesStore: StoreApi<FilesState> = createStore<FilesState>()(
  immer((set) => ({
    ...createFilesTreeState(),

    enterDir: (dir) =>
      set((s) => {
        Object.assign(s, enterDir(s, dir));
      }),

    goBack: () =>
      set((s) => {
        Object.assign(s, goBack(s));
      }),

    expandDir: (dir) =>
      set((s) => {
        Object.assign(s, expandDir(s, dir));
      }),

    collapseDir: (dir) =>
      set((s) => {
        Object.assign(s, collapseDir(s, dir));
      }),

    toggleDir: (dir) =>
      set((s) => {
        Object.assign(s, toggleDir(s, dir));
      }),

    markDirLoading: (dir) =>
      set((s) => {
        Object.assign(s, markDirLoading(s, dir));
      }),

    markDirLoaded: (dir, entries, nowMs = nowDefault()) =>
      set((s) => {
        Object.assign(s, markDirLoaded(s, dir, entries, nowMs));
      }),

    markDirError: (dir, errorCode) =>
      set((s) => {
        Object.assign(s, markDirError(s, dir, errorCode));
      }),

    invalidateDir: (dir) =>
      set((s) => {
        Object.assign(s, invalidateDir(s, dir));
      }),

    setSortMode: (mode) =>
      set((s) => {
        Object.assign(s, setSortMode(s, mode));
      }),

    resetWorkspace: (root) =>
      set((s) => {
        Object.assign(s, resetWorkspace(s, root));
      }),
  }))
);
