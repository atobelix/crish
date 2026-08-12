/**
 * 笔记镜像 detect / import 提案 IPC 契约（A-INV-02 / W2-E 产品装配 · CONN-E · SD-33）
 *
 * ## SD-33 切开（主文件 <400）
 * 实现已拆；本文件保持既有 import 路径（`./noteMirrorIpc` re-export）：
 * - `noteMirrorIpc.types`：命令名 / 请求 / 成功失败 / `NoteMirrorIpc`
 * - `noteMirrorIpc.wire`：snake_case 投影
 * - `noteMirrorIpc.parse`：detect/import 解析 + report 映射
 * - `noteMirrorIpc.mock`：`createMockNoteMirrorIpc`（X-05 契约）
 * - `noteMirrorIpc.tauri`：`createTauriNoteMirrorIpc`
 *
 * ## 命令
 * - wire：`note_detect_mirror_drift`（`NOTE_CMD_DETECT_MIRROR_DRIFT`）
 * - wire：`note_import_mirror_proposal`（`NOTE_CMD_IMPORT_MIRROR_PROPOSAL`）
 *
 * ## 与 UI 关系
 * - detect 成功 → 可映射为 `MirrorDriftReportView` 注入 `MirrorDriftStatusBar`
 * - 三路决策须先经 `resolveThreeWayAction`（X-05），再 `importMirrorProposal`
 * - **不** apply；`applied` 恒 false
 *
 * ## 诚实边界
 * - **≠ EL-03**；**≠ inotify 产品满关**
 * - **未做**：timer poll 与 OS watcher **双开** debounce（E3 仅 opt-in 单路调度）
 * - 空态默认 **不** 注入 report；须显式 detect / E3 调度 / mock 注入
 * - **CONN-E2 默认策略**：产品空态 **默认关** StatusBar（避免空态噪声）；
 *   仅 showMirrorDriftBar / mirrorDriftReport opt-in 才挂；detect/import 仍走本 IPC
 * - **CONN-E3**：`enableMirrorDetectSchedule` + mirrorIpc → `detectMirrorDrift` →
 *   report 喂 StatusBar；默认关时无 detect 定时器（见 mirrorDetectSchedule /
 *   useMirrorDetectProduct）
 * - **SD-33 ≠ EL-03**；切开 ≠ inotify 满关；≠ 重做 E2′ / E3
 */

export {
  NOTE_CMD_DETECT_MIRROR_DRIFT,
  NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
} from './noteMirrorIpc.types';

export type {
  MockMirrorDocState,
  NoteDetectMirrorOutcome,
  NoteDetectMirrorRequest,
  NoteDetectMirrorSuccess,
  NoteImportMirrorKind,
  NoteImportMirrorOutcome,
  NoteImportMirrorRequest,
  NoteImportMirrorSuccess,
  NoteMirrorIpc,
  NoteMirrorIpcFailure,
  NoteMirrorReportFields,
} from './noteMirrorIpc.types';

export {
  detectMirrorReqToWire,
  importMirrorReqToWire,
  wrapDetectMirrorInvokeArgs,
  wrapImportMirrorInvokeArgs,
} from './noteMirrorIpc.wire';

export {
  detectSuccessToReportView,
  parseDetectMirrorOutcome,
  parseImportMirrorOutcome,
} from './noteMirrorIpc.parse';

export { createMockNoteMirrorIpc } from './noteMirrorIpc.mock';

export { createTauriNoteMirrorIpc } from './noteMirrorIpc.tauri';
