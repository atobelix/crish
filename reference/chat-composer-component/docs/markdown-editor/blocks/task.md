# Block: `task_list` / `task_item`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> 列表共性见 [list.md](./list.md)  
> **优先级**：P0

---

## 1. 目标 / 非目标

- **目标**：GFM 任务列表；勾选切换；与 bullet 列表键盘模型对齐。
- **非目标**：任务截止日期、指派人（可用 mention P2 挂正文）；跨文档同步。

---

## 2. 标识

| type id | 说明 |
|---------|------|
| `task_list` | 容器（渲染仍可用 `ul`） |
| `task_item` | 带 `checked` 的项 |

| slash | 结果 |
|-------|------|
| `insert.task_list` | `task_list` + 一空未勾选 `task_item` |

---

## 3. Markdown（GFM）

```md
- [ ] 未完成
- [x] 已完成
- [X] 也可
```

- 必须在 list 标记后：`- [ ] ` / `* [x] `。
- **序列化**：未完成 `- [ ] `；完成 `- [x] `（小写 x）；统一 `-` 标记。
- 嵌套：

```md
- [ ] 父
  - [x] 子
```

有序任务 `1. [ ]`：解析可接受；序列化 **降为** `- [ ]`（GFM 常见）或保留 ordered——**v1 统一 bullet 任务**。

---

## 4. props schema

```ts
interface TaskListProps {}

interface TaskItemProps {
  checked: boolean;
}

interface TaskListBlock {
  id: string;
  type: 'task_list';
  props: TaskListProps;
  children: TaskItemBlock[];
}

interface TaskItemBlock {
  id: string;
  type: 'task_item';
  props: TaskItemProps;
  children: Block[]; // [paragraph, nested list?]
}
```

与 `list_item` 分离 type，便于序列化与过滤；不可与普通 `list_item` 混写在同一容器（parse 时分拆为相邻 list）。

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--task-list" data-block-type="task_list">
  <div class="mdx-block__body">
    <ul class="mdx-list mdx-list--task">
      <li class="mdx-task-item" data-block-type="task_item" data-checked="false">
        <label class="mdx-task-item__check">
          <input type="checkbox" class="mdx-task-item__input" />
          <span class="mdx-task-item__box" aria-hidden="true"></span>
        </label>
        <div class="mdx-task-item__body">
          <p class="mdx-paragraph">未完成</p>
        </div>
      </li>
      <li class="mdx-task-item mdx-task-item--checked" data-checked="true">…</li>
    </ul>
  </div>
</div>
```

| class | 用途 |
|-------|------|
| `mdx-list--task` | 任务列表 |
| `mdx-task-item` | 项 |
| `mdx-task-item--checked` | 完成态样式（删除线可选，克制） |
| `mdx-task-item__input` | 原生 checkbox（可视觉隐藏） |
| `mdx-task-item__body` | 文本区 |

勾选 **左簇** 与文字同一行，符合左簇信息架构。

---

## 6. 编辑交互

| 操作 | 行为 |
|------|------|
| Click checkbox | toggle `props.checked`；**不**抢文本焦点（可保持） |
| Click 文本 | 编辑主 paragraph |
| Enter 非空 | 新 `task_item` `checked:false` |
| Enter 空 | 退出 task_list → 后接 `paragraph`（同 list） |
| Tab / Shift+Tab | indent/outdent；嵌套仍为 task_list |
| Backspace 空项 | 删项 / 退出 |
| Mod+Enter 在项上 | 可选：toggle checked（P1） |

**阅读态勾选**：允许在 reading 直接点 checkbox（无需进 editing）——提升 Notebook 可用性。

---

## 7. Placeholder

- 空项：`待办事项`

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| `checked` true/false | `[x]` / `[ ]` |
| 空项 | `- [ ] \n` |
| 与 bullet 交错 | 拆成多个 list 块 |
| 完成态样式 | 不进 MD |
| 非法 `[?]` | 当未完成或当普通 list_item |

---

## 9. canMergeWith

同 list：容器不自动 merge；项合并仅空项删除路径。

---

## 10. a11y

- `input type=checkbox` 与文本 `label` 关联（`id`/`for` 或包裹）。
- 状态变化可被读屏感知；完成项 `aria-checked`。
- 不要只靠颜色表示完成。

---

## 11. 测试点

1. `- [x] a` 往返 checked。  
2. 阅读态点击切换 checked 且 serialize 变。  
3. Enter 空退出。  
4. slash 后 placeholder「待办事项」。  
5. 嵌套任务一层往返。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| 勾选 + 编辑 + 序列化 | P0 |
| 阅读态直接勾选 | P0 |
| 嵌套 | P0 |
| Mod+Enter toggle | P1 |
| 有序任务保留 | P2 |
