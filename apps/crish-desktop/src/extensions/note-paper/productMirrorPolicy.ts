/**
 * CONN-E2′ · 产品 detect 默装策略
 *
 * 策略常量给扩展叶用，不再有产品 Host 组件。
 *
 * EmptyState **组件默认仍 false**（CONN-E2 / CONN-C2 会计门不回退）。
 *
 * ≠ 重做 CONN-E3 调度整包（mirrorDetectSchedule / useMirrorDetectProduct）
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 默认双开 poll+OS
 * ≠ 改 EmptyState 组件 enableProductPaperList 默认（C2 会计门）
 * ≠ W3-P · ≠ EL-01（PaperList 默开 ≠ 完成）
 * X-05 禁静默盖 unpushed 不回退
 * 无 Tauri **禁止** mock 当产品默认、**禁止**造假 drift report
 *
 * 删 Host ≠ 打开完成 ≠ 关 EL。
 */

import { isNoteTauriRuntime } from '../../api/noteApi';
import {
  createTauriNoteMirrorIpc,
  type NoteMirrorIpc,
} from '../../api/noteMirrorIpc';

/** 产品宿主写死：Workspace 空态默开 detect 调度（≠ EmptyState 组件默认） */
export const WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE = true as const;

export type CreateProductNoteMirrorIpcOptions = {
  /** 测用覆盖；省略则 `isNoteTauriRuntime()` */
  isTauriRuntime?: boolean;
};

/**
 * 产品 mirror IPC：有 Tauri → tauri-ipc；否则 undefined。
 * **禁止** 用 `createMockNoteMirrorIpc` 当产品默认。
 */
export function createProductNoteMirrorIpc(
  options?: CreateProductNoteMirrorIpcOptions
): NoteMirrorIpc | undefined {
  const tauri =
    options?.isTauriRuntime !== undefined
      ? options.isTauriRuntime
      : isNoteTauriRuntime();
  if (!tauri) return undefined;
  return createTauriNoteMirrorIpc();
}

export type WorkspaceProductEmptyMirrorProps = {
  enableMirrorDetectSchedule: true;
  mirrorIpc: NoteMirrorIpc | undefined;
};

/** 产品 Workspace 空态 mirror 装配（写死策略 + 产品 IPC） */
export function resolveWorkspaceProductEmptyMirrorProps(
  options?: CreateProductNoteMirrorIpcOptions
): WorkspaceProductEmptyMirrorProps {
  return {
    enableMirrorDetectSchedule: WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE,
    mirrorIpc: createProductNoteMirrorIpc(options),
  };
}
