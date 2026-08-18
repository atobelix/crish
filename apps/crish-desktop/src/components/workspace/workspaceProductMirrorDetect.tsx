/**
 * CONN-E2′ · Workspace 产品 detect 默装策略（夹具 re-export）
 *
 * 策略常量给扩展叶用，不再有产品 Host 组件。
 * 实现：`extensions/note-paper/productMirrorPolicy`
 *
 * EmptyState 组件默认仍 false（CONN-E2 / CONN-C2 会计门不回退）。
 *
 * 策略字面 WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE = true
 * 产品 IPC 走 createTauriNoteMirrorIpc。
 *
 * ≠ 重做 CONN-E3 调度整包
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 默认双开 poll+OS
 * X-05 禁静默盖 unpushed 不回退
 * 无 Tauri 禁止 mock 当产品默认、禁止造假 drift report
 *
 * 删 Host ≠ 打开完成 ≠ 关 EL。
 */

export {
  WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE,
  createProductNoteMirrorIpc,
  resolveWorkspaceProductEmptyMirrorProps,
  type CreateProductNoteMirrorIpcOptions,
  type WorkspaceProductEmptyMirrorProps,
} from '../../extensions/note-paper/productMirrorPolicy';
