# BATCH-03 基线记录

- **日期**：2026-09-11
- **方案 SSOT**：`docs/layout-token-system/00-总方案.md` v2
- **前置**：BATCH-01 / 02 已落地

## 落地内容

1. **NoteLeafHost 先补后删**：根节点内联 `flex: '1 1 0%'` + overflow hidden。
2. **拔除宿主穿透**：删除 `.leafChatColumn > *:not(...)` / `> * > *:not(...)` 与全部 note testid/host 越权规则。
3. **leafBody 边框恢复**：`border: 1px solid var(--border-subtle)`，激活态高亮重新生效。
4. **leaf-insulate 局部翻转**：仅替换第一段 describe 为负向契约；后半段 IA / FloatHandle / 全局表 0 原样保留。

## 验收

```
npx vitest run \
  src/components/binary-tree/BinaryTreeWorkspace.leaf-insulate.test.ts \
  src/components/note-paper/NotePaperPanel.insulate.test.ts
# 2 files, 12 tests, all passed
```

## 改动文件

- `apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.tsx`
- `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`
- `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.leaf-insulate.test.ts`

## 回归注意

- 新增 `workspace.leaf.panel` 产品必须自带 flex 自闭环。
- leafBody 1px 边框为有意恢复，真机确认与岛屿几何无双重描边。
