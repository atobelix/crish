# note-paper 挂载壳（**双轨：W5-B-S Skeleton ∥ W5-B Strict**）

> **挂载 ≠ 交付**。Workbench 可打开预览壳 / Strict 投影 **不等于** EL-01 / EL-08 关闭，也不等于「块工作区已完成」或「打开文档完成」（真打开叙事依赖 W1-H）。  
> 挂载冒充交付 = **S5 事故**（`plans/08` §0.2）。  
> **可演示 ≠ EL-01/EL-08**；**≠ W5-C 隔离全关**。

## 双轨声明

| 项           | Skeleton（W5-B-S）                    | Strict（W5-B）                                                       |
| ------------ | ------------------------------------- | -------------------------------------------------------------------- |
| **包 ID**    | `W5-B-S`（`W5B_SKELETON_PACKAGE_ID`） | `W5-B`（`W5B_STRICT_PACKAGE_ID`）                                    |
| **轨**       | `data-track="skeleton"`               | `data-track="strict"`                                                |
| **入口**     | `NotePaperPanel`                      | `NotePaperStrictPanel`                                               |
| **数据**     | 静默假数据 / Memory 半 transport      | **hydrate 后投影**（fixture 或 `adaptNoteTransportAsHydrate`）       |
| **合法交付** | 预览壳 + 假数据可点                   | 可注入 hydrate + 加载/空/错误三态；**方向**子集可证伪                |
| **禁止**     | 去 `-S` 冒充 Strict                   | 把 Skeleton 常量改成 W5-B；假数据 chrome 关 EL                       |
| **≠**        | 任何 EL；打开完成                     | 同上 + **≠** 产品 IPC 默认真路径已挂（诚实：默认仍需注入 transport） |

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

| 有                                                                    | 无（诚实未做）                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `NotePaperStrictPanel` + `data-package-id=W5-B` / `data-track=strict` | Workbench 产品默认强制 Strict hydrate 挂载           |
| `NoteHydrateTransport` + fixture / `adaptNoteTransportAsHydrate`      | `DocSession::hydrate` 产品 IPC 专用命令（依赖 W1-H） |
| 加载 / 空 / 错误 / 成功三态 UI + vitest（`w5b_strict_*`）             | e2e / EL-01 / EL-08 关闭                             |
| 边界句钉死可演示≠EL · ≠W5-C · S5                                      | 宣称「打开完成 / 块工作区完成」                      |

## 可运行 / 可测入口

1. **Skeleton 空态按钮**：`WorkspaceEmptyState` → `open-note-paper-preview` → 静默假数据壳
2. **Skeleton 半 transport**：`<NotePaperPanel transport={createMemoryNoteTransport()} />`
3. **Strict hydrate fixture**：
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
4. _*Strict 经已有 note_* 形状_*：
   ```tsx
   <NotePaperStrictPanel
     docId="doc-1"
     hydrateTransport={adaptNoteTransportAsHydrate(createMemoryNoteTransport())}
   />
   ```
5. **测名**：
   - Skeleton：`NotePaperPanel.test.tsx` / `w5bSkeleton.test.ts` / `WorkspaceEmptyState.w5bs.test.tsx`
   - Strict：`NotePaperStrictPanel.test.tsx` / `hydrateProjection.test.ts` / `w5bStrict.test.ts`（`w5b_strict_*`）
   - 边界：`note-paper.boundary.test.ts`（禁 EditorStore；两轨共用）

## 半 transport / hydrate 形状

- Skeleton API：`noteApi.ts` → `createMemoryNoteTransport` / `createTauriNoteTransport`
- Strict API：`hydrateProjection.ts` → `NoteHydrateTransport` / fixture / adapt
- 禁止：静默 onStreamEnd 写笔记；假数据关 EL-01；Skeleton 常量冒充 Strict

## 相关

- 规格：`docs/block-workspace-architecture/plans/specs/dual-engine-surface.md` §5 / §8（B-09）
- 索引：`plans/09` W5-B / W5-B-S；`plans/08` §0.2
- 呈现内核：`packages/block-paper`（chrome + silentFixture + leaves）
- 契约：`packages/block-paper-contract`
