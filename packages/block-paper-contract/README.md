# `@crish/block-paper-contract`

块纸面 **W0 接口冻结** TypeScript 类型草稿包：`query_blocks` / `FlavourRegistration` / `ProjectionDiff` / `MountSpec` / `Intent` / **EditorSurface**。

**仅契约，不接线业务**（不改 apps、不实现工具/注册表/投影）。

## 双 surface / 禁止共享（A-SURF）

对齐 `docs/block-workspace-architecture/plans/specs/dual-engine-surface.md`：

| Surface          | 权威模型                      | 本包角色                          |
| ---------------- | ----------------------------- | --------------------------------- |
| **`chat`**       | `lines[]` 行缓冲（会话/流式） | 仅枚举标注；**无**行级 store 类型 |
| **`note-paper`** | RS `BlockTree` + `DocSession` | 块契约类型（BlockId / Diff…）     |

```ts
import {
  EDITOR_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
  type EditorSurface,
  type SendToNoteIntent,
  isSendToNoteIntent,
} from '@crish/block-paper-contract';

// A-SURF-01：仅两个 surface
EDITOR_SURFACES; // ['chat', 'note-paper']
```

### 禁止共享（硬锁摘要）

跨 surface **禁止**共享：Doc store / `DocSession` 实例、`lines[]` 或行级 `EditorStore`、yrs / YText 句柄、PM 整树 doc、混存两坐标系的选区 store。

完成态 chat → 笔记 **仅**经显式 `SendToNoteIntent`（`type: 'send_to_note'`），载荷为 **markdown 字符串快照**，禁止持有 `lines[]` 引用过桥。

### 依赖方向

```
editor-kit ──► block-paper-contract（类型 only）
block-paper ──► block-paper-contract + editor-kit
editor-kit ─╳→ markdown-editor / DocSession / yrs
block-paper ─╳→ markdown-editor EditorStore / lines[] 权威
```

## 脚本

```bash
npm run typecheck -w @crish/block-paper-contract
npx vitest run packages/block-paper-contract
```
