# note-paper 挂载壳（**双轨：W5-B-S Skeleton ∥ W5-B Strict**）

> **挂载 ≠ 交付**。Workbench 可打开预览壳 / Strict 投影 **不等于** EL-01 / EL-08 关闭，也不等于「块工作区已完成」或「打开文档完成」（真打开叙事依赖 W1-H）。  
> 挂载冒充交付 = **S5 事故**（`plans/08` §0.2）。  
> **可演示 ≠ EL-01/EL-08**；**≠ W5-C 隔离全关**。

## 双轨声明

| 项           | Skeleton（W5-B-S）                    | Strict（W5-B）                                                     |
| ------------ | ------------------------------------- | ------------------------------------------------------------------ |
| **包 ID**    | `W5-B-S`（`W5B_SKELETON_PACKAGE_ID`） | `W5-B`（`W5B_STRICT_PACKAGE_ID`）                                  |
| **轨**       | `data-track="skeleton"`               | `data-track="strict"`                                              |
| **入口**     | `NotePaperPanel`                      | `NotePaperStrictPanel`                                             |
| **数据**     | 静默假数据 / Memory 半 transport      | **hydrate 后投影**（fixture 或 `adaptNoteTransportAsHydrate`）     |
| **合法交付** | 预览壳 + 假数据可点                   | 可注入 hydrate + 加载/空/错误三态；**方向**子集可证伪              |
| **禁止**     | 去 `-S` 冒充 Strict                   | 把 Skeleton 常量改成 W5-B；假数据 chrome 关 EL                     |
| **≠**        | 任何 EL；打开完成                     | 同上 + **≠** 真 DocSession IPC 默认已挂（空态默认 fixture 可演示） |

## 双 surface

| Surface ID   | 职责                       | 本目录                                     |
| ------------ | -------------------------- | ------------------------------------------ |
| `chat`       | 行级流式 / 消息缓冲        | **不**实现；聊天页继续既有 markdown-editor |
| `note-paper` | 块纸面投影 / chrome 预览壳 | **本目录**                                 |

常量见 `editorSurface.ts`（`chat` \| `note-paper`）。禁止第三权威面。

## 禁止静默缝合

- AI 流式 token **只**走行级缓冲；**禁止**每 token 写块树
- 完成态 **不得** 因 `onStreamEnd` 默认写入当前笔记
- chat → note 仅经显式 **`send_to_note`** Intent（`src/bridges/send-to-note.ts`）
- 桥只传 **markdown 字符串快照**，禁止 `lines[]` 引用过桥
- 失败返回 Result，块树零半写

## 本波交付边界

### W5-B-S Skeleton（已交付，保留）

| 有                              | 无                                      |
| ------------------------------- | --------------------------------------- |
| `NotePaperPanel` 静默假数据壳   | 真实 DocSession / RS apply **产品默认** |
| Memory 半 transport 投影 + 刷新 | 默认真 Tauri hydrate「打开完成」叙事    |
| `WorkspaceEmptyState` 可点入口  | 宣称块工作区 / EL-01 / EL-08 关闭       |
| `SendToNoteButton` + mock sink  | 消息气泡默认挂载（可后续接线）          |
| 边界静态扫描（禁 EditorStore）  | A-SURF 全表关闭（W5-C）                 |
| DOM `data-package-id="W5-B-S"`  | 去 `-S` 冒充 Strict                     |

### W5-B Strict（本包方向 · 与 Skeleton 并存）

| 有                                                                                     | 无（诚实未做）                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `NotePaperStrictPanel` + `data-package-id=W5-B` / `data-track=strict`                  | 真 `DocSession::hydrate` 产品 IPC **默认路径**（W1-H） |
| `NoteHydrateTransport` + fixture / `adaptNoteTransportAsHydrate`                       | e2e / EL-01 / EL-08 关闭                               |
| **`NoteHydrateIpc` + `note_document_hydrate` 命令形状**（可注入；mock/Tauri 契约测）   | **产品空态默认仍 fixture**（未切 tauri-ipc 为默认）    |
| **产品空态默认入口**：`WorkspaceEmptyState` → `open-note-paper-strict`（fixture 演示） | 宣称「打开完成 / 块工作区完成」                        |
| `W5B_PRODUCT_DEFAULT_EMPTY_TRACK='strict'` + `preferredNotePaperTrack` 可切            | 气泡默认挂按钮 / stream 产品链（W5-B′）                |
| 加载 / 空 / 错误 / 成功三态 UI + vitest（`w5b_strict_*` / `w5b_product_empty_*`）      | 把 fixture 伪装成 `tauri-ipc`                          |
| 边界句钉死可演示≠EL · ≠W5-C · S5                                                       | —                                                      |

> **可演示 ≠ EL**；空态 Strict 挂载 **≠ 打开完成**；默认 hydrate 为 **fixture**。  
> 真 IPC 方向已交付命令形状 + adapter（`source=tauri-ipc`），**须显式注入**才走；**≠** 产品默认已挂 DocSession hydrate。

## 可运行 / 可测入口

1. **Strict 产品空态（默认）**：`WorkspaceEmptyState` → `open-note-paper-strict` → `NotePaperStrictPanel` + `createEmptyStateStrictDemoTransport`（`source=fixture`）
2. **Skeleton 空态按钮（保留）**：`WorkspaceEmptyState` → `open-note-paper-preview` → 静默假数据壳
3. **可切默认倾向**：`<WorkspaceEmptyState preferredNotePaperTrack="skeleton" />`（两轨入口均保留）
4. **可注入 Strict transport**：`<WorkspaceEmptyState strictHydrateTransport={adaptNoteTransportAsHydrate(...)} />`
5. **Skeleton 半 transport**：`<NotePaperPanel transport={createMemoryNoteTransport()} />`
6. **Strict hydrate fixture（直接挂面板）**：
   ```tsx
   <NotePaperStrictPanel
     docId="doc-1"
     hydrateTransport={createFixtureHydrateTransport({
       'doc-1': {
         rev: 1,
         blocks: [
           makeHydratedBlock({
             id: 'b1',
             flavour: 'paragraph',
             text: '…',
             index: 0,
           }),
         ],
       },
     })}
   />
   ```
7. **Strict 经已有 note 形状**：
   ```tsx
   <NotePaperStrictPanel
     docId="doc-1"
     hydrateTransport={adaptNoteTransportAsHydrate(createMemoryNoteTransport())}
   />
   ```
8. **Strict 经专用 hydrate IPC**（`source=tauri-ipc`；**须注入**，非产品默认）：
   ```tsx
   import {
     createMockNoteHydrateIpc,
     // 或 createTauriNoteHydrateIpc()
   } from '../../api/noteHydrateIpc';
   import { adaptNoteHydrateIpcAsTransport } from './hydrateProjection';

   <NotePaperStrictPanel
     docId="doc-1"
     hydrateTransport={adaptNoteHydrateIpcAsTransport(createMockNoteHydrateIpc({...}))}
   />
   ```
9. **镜像漂移 detect / 三路 import（CONN-E · A-INV-02 产品 IPC）**：
   - wire：`note_detect_mirror_drift` / `note_import_mirror_proposal`
   - 前端：`api/noteMirrorIpc.ts`（mock / Tauri）+ `mirrorThreeWayBridge.ts`
   - **空态默认不展示** StatusBar（CONN-E2 opt-in）；接 report 的方式：
     1. **EmptyState opt-in**（产品空态推荐）：
        ```tsx
        <WorkspaceEmptyState
          wsId={wsId}
          showMirrorDriftBar // 无 report 时 idle「未检测」，不造假
          mirrorDriftReport={report} // 或省略；有值自动挂条
          mirrorWatchSource="injected"
          mirrorUnpushedOpCount={unpushed}
          mirrorIpc={ipc} // 自动 createMirrorThreeWayOnAction
          // 或 onMirrorThreeWay={fn} 优先于 mirrorIpc
        />
        ```
     2. **Strict 直接注入**：`mirrorDriftReport` / `showMirrorDriftBar` / `onMirrorThreeWay`
     3. **detect 后注入**（手动）：
        ```tsx
        const ipc = createTauriNoteMirrorIpc(); // 或 createMockNoteMirrorIpc
        const det = await ipc.detectMirrorDrift({ docId });
        if (det.ok) setReport(detectSuccessToReportView(det));
        <WorkspaceEmptyState
          wsId={wsId}
          mirrorDriftReport={report}
          mirrorIpc={ipc}
          mirrorUnpushedOpCount={unpushed}
        />;
        ```
     4. **CONN-E3 产品 detect 调度**（opt-in；默认关）：
        ```tsx
        <WorkspaceEmptyState
          wsId={wsId}
          mirrorIpc={ipc} // mock 或 createTauriNoteMirrorIpc()
          enableMirrorDetectSchedule // → detectMirrorDrift → report → 条
          // mirrorDetectIntervalMs={30_000} // 可选轮询；省略则仅一次
          mirrorUnpushedOpCount={unpushed}
        />
        // DOM：data-mirror-detect-schedule=0|1
        // 调用序：enable+ipc → useMirrorDetectProduct → runMirrorDetectOnce
        //   → note_detect_mirror_drift → detectSuccessToReportView → StatusBar
        ```
   - **X-05**：StatusBar 在 unpushed>0 时须勾选「显式丢弃」才映射 `drop_unacked`；
     bridge 对 `decision.ok===false` **不**调 import（禁静默盖 unpushed）
   - **诚实未做**：产品 timer poll 与 OS watcher **同时**装配 + 双开 debounce；
     本包 **≠ EL-03**；**≠ inotify 产品满关**；import **不** apply；
     E3 默认 **不** 启调度（关时无 detect timer）
10. **测名**：

- Skeleton：`NotePaperPanel.test.tsx` / `notePaperSkeletonTrack.test.ts` / `WorkspaceEmptyState.skeleton.test.tsx`
- Strict：`NotePaperStrictPanel.test.tsx` / `hydrateProjection.test.ts` / `notePaperStrictTrack.test.ts`（`w5b_strict_*`）
- **产品入口**：`WorkspaceEmptyState.strict.test.tsx`（`w5b_product_empty_*` / `conn_e2_*` / `conn_e3_*`）
- **hydrate IPC**：`noteHydrateIpc.test.ts`（`note_hydrate_ipc_*`）
- **mirror IPC / 三路桥 / E3 调度**：`noteMirrorIpc.test.ts` / `mirrorThreeWayBridge.test.tsx` /
  `MirrorDriftStatusBar.test.tsx` / `mirrorDetectSchedule.test.ts`（`conn_e3_schedule_*`）
- 边界：`note-paper.boundary.test.ts`（禁 EditorStore；两轨共用）

## 半 transport / hydrate 形状

- Skeleton API：`noteApi.ts` → `createMemoryNoteTransport` / `createTauriNoteTransport`
- Strict API：`hydrateProjection.ts` → `NoteHydrateTransport` / fixture / adapt / `adaptNoteHydrateIpcAsTransport`
- 真 hydrate IPC：`noteHydrateIpc.ts` → `NoteHydrateIpc` / mock / Tauri；wire=`note_document_hydrate`
- 禁止：静默 onStreamEnd 写笔记；假数据关 EL-01；Skeleton 常量冒充 Strict；fixture 伪装 `tauri-ipc`

## 视觉语言（tokens 对齐 · ≠ EL 关）

- **样式单源**：`NotePaperPanel.module.css`（Skeleton + Strict **共用**）
- **主壳 token**：`--bg-card` / `--hairline*` / `--tint-*` / `--space-*` / `--line-height-body` / `--radius-*` / `--color-error*` 等（见 `styles/tokens.css`）
- **纸面感**：card 暖白底 + 静默块行（非 hover 无 chrome）+ 舒适行距；focus 中性 inset，不抢高饱和蓝描边
- **状态面统一**：`.state` + `.stateLoading` / `.stateEmpty` / `.stateError`（Strict 三态与 Skeleton 空/错同语言）
- **落地记录**：`docs/block-workspace-architecture/analysis/visual-align/03-落地记录.md`
- **硬句**：**视觉对齐 ≠ EL-01/EL-08 关闭**；**≠** 换肤成 AFFiNE/AppFlowy；双轨 `data-package-id` / `data-track` 不变

## 相关

- 规格：`docs/block-workspace-architecture/plans/specs/dual-engine-surface.md` §5 / §8（B-09）
- 索引：`plans/09` W5-B / W5-B-S；`plans/08` §0.2
- 呈现内核：`packages/block-paper`（chrome + silentFixture + leaves）
- 契约：`packages/block-paper-contract`
- 视觉：`analysis/visual-align/03-落地记录.md`
