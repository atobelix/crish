# note-paper 挂载壳（W5-B）

> **挂载 ≠ 交付**。Workbench 可打开本预览壳 **不等于** EL-01 / EL-08 关闭，也不等于「块工作区已完成」。

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

| 有                                 | 无                                      |
| ---------------------------------- | --------------------------------------- |
| `NotePaperPanel` 静默假数据壳      | 真实 DocSession / RS apply 产品接线     |
| `SendToNoteButton` + mock sink     | 消息气泡默认挂载（可后续接线）          |
| `noteApi` + Memory `NoteTransport` | Tauri `note_*` 命令产品接线（另 Agent） |
| 桥默认走 NoteTransport；sink 兼容  | onStreamEnd 静默写笔记（禁止）          |
| 边界静态扫描（禁 EditorStore）     | A-SURF 全表关闭（W5-C）                 |
| Workspace 空态「打开预览壳」入口   | 宣称块工作区已完成                      |

## Round6 通路

- API：`apps/crish-desktop/src/api/noteApi.ts`
  - 命令常量：`note_document_apply_md` / `note_query_blocks` / `note_send_to_note`
  - `createMemoryNoteTransport()`：单测与预览壳写后 query
  - `createTauriNoteTransport()`：有 core 时 invoke；missing → 结构化失败
- 桥：`dispatchSendToNote(input, { transport })` 或 `setDefaultNoteTransport(mem)`
- 面板：`<NotePaperPanel transport={mem} refreshToken={n} />` 演示 apply → 刷新

## 相关

- 规格：`docs/block-workspace-architecture/plans/specs/dual-engine-surface.md` §5 / §8
- 呈现内核：`packages/block-paper`（chrome + silentFixture + leaves）
- 契约：`packages/block-paper-contract`
