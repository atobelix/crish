# 11 — 无上帝文件宪章（强制）

> 实现与规划 agent **必须遵守**。违反则 PR/改动作废。

## 禁止

1. **禁止**继续向 `editor.js` 无底堆功能（已是上帝文件，只允许 **删减/接线**，新逻辑进新模块）。
2. **禁止**单文件同时承担：parse、serialize、model、render、table、slash、dnd、AI、media。
3. **禁止**在 demo HTML 内联超长业务逻辑。
4. **禁止**一个 agent 改超过 **其所有权清单** 外的文件（冲突文件由 orchestrator 合并）。

## 目标模块边界（packages 心智 / 现 reference 路径）

```
js/markdown-editor/
  index.js              # 仅公共 API 导出
  schema.js             # Doc/Block/table 数据
  model.js              # history
  parse.js / serialize.js
  registry.js
  editor-controller.js  # 薄：事件路由、activeId、调度（从 editor.js 抽）
  render/
    read-view.js        # 未聚焦渲染
    code-read.js
  edit/
    line-source.js      # 已有 ui/line-source.js 可迁入
    enter-exit.js       # 进入/退出编辑
    backspace-demote.js
    promote-prefix.js   # * # > 行首提升
    code-source.js      # fence 源码表面
  ui/
    slash-menu.js
    dnd.js
    table-chrome.js
    table-selection.js  # 框选（新）
    code-highlight.js
  # 禁止再挂 selection-toolbar 为默认（扩展可选）
```

## Agent 一轮上限

- **最多 12 个** 并行 agent / 轮。
- 先 **规划 agent（只读+写 docs）**，再 **实现 agent（按所有权写码）**。
