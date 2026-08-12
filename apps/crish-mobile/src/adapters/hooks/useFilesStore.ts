// 文件域 store 订阅绑定（R2-06b 适配层）：领域层 vanilla filesStore → React 组件
// 订阅的唯一入口（对齐 useAppStore 模式，M4 §2.5 裁决修正 8；files 域新增独立
// 文件，不改动既有 useAppStore 的既有域绑定）
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { filesStore, type FilesState } from '@/domain/store/filesStore';

export const useFilesStore = <T>(selector: (s: FilesState) => T): T =>
  useStore(filesStore, useShallow(selector));
