# note-paper 挂载壳（**W5-B-S · Skeleton**）

> **包 ID 必须带 `-S`。** 去 `-S` 冒充 W5-B Strict = 伪完成。  
> **挂载 ≠ 交付**。Workbench 可打开本预览壳 **不等于** EL-01 / EL-08 关闭，也不等于「块工作区已完成」或「打开文档完成」（无 W1-H 产品打开叙事）。  
> 挂载冒充交付 = **S5 事故**（`plans/08` §0.2）。

## 轨声明

| 项           | 值                                                  |
| ------------ | --------------------------------------------------- |
| **包 ID**    | `W5-B-S`（常量 `W5B_SKELETON_PACKAGE_ID`）          |
| **轨**       | Skeleton（`data-track="skeleton"`）                 |
| **合法交付** | NotePaper 预览壳 + 静默假数据 / Memory 半 transport |
| **≠**        | **W5-B Strict**（真数据默认路径依赖 W1-H）          |
| **≠**        | 任何 EL 关闭；「打开完成」；Notion 级块操作         |

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

## 本波交付边界（W5-B-S）

| 有                              | 无                                      |
| ------------------------------- | --------------------------------------- |
| `NotePaperPanel` 静默假数据壳   | 真实 DocSession / RS apply **产品默认** |
| Memory 半 transport 投影 + 刷新 | 默认真 Tauri hydrate「打开完成」叙事    |
| `WorkspaceEmptyState` 可点入口  | 宣称块工作区 / EL-01 / EL-08 关闭       |
| `SendToNoteButton` + mock sink  | 消息气泡默认挂载（可后续接线）          |
| 边界静态扫描（禁 EditorStore）  | A-SURF 全表关闭（W5-C）                 |
| DOM `data-package-id="W5-B-S"`  | 去 `-S` 冒充 Strict                     |

## 可运行 / 可测入口

1. **空态按钮**：`WorkspaceEmptyState` → `data-testid="open-note-paper-preview"` → 静默假数据壳
2. **单测 inject**：`<NotePaperPanel transport={createMemoryNoteTransport()} />` + `refreshToken`
3. **测名**：
   - `NotePaperPanel.test.tsx`（静默 + 半 transport）
   - `WorkspaceEmptyState.w5bs.test.tsx`（可点入口）
   - `note-paper.boundary.test.ts`（禁行级 store）
   - `w5bSkeleton.test.ts`（包 ID / 轨常量）

## 半 transport 形状（≠ 产品写路径完成）

- API：`apps/crish-desktop/src/api/noteApi.ts`
  - `createMemoryNoteTransport()`：单测与 Skeleton 半 transport
  - `createTauriNoteTransport()` / 默认策略属 W5-B / W5-D 方向；**本包不以真 IPC 关交付**
- 面板：`<NotePaperPanel transport={…} refreshToken={n} />`
- 禁止：静默 onStreamEnd 写笔记；假数据关 EL-01

## 相关

- 规格：`docs/block-workspace-architecture/plans/specs/dual-engine-surface.md` §5 / §8
- 索引：`plans/09` W5-B-S 行；`plans/08` §0.2
- 呈现内核：`packages/block-paper`（chrome + silentFixture + leaves）
- 契约：`packages/block-paper-contract`
