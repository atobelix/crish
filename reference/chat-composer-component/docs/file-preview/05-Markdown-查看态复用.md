# 05 — Markdown 查看态复用

---

## 1. 目标

文件预览打开 `.md` 时：

- **同一套**块模型 / 解析 / 行渲染（`js/markdown-editor`）  
- 用户看到的是 **精致阅读页**  
- **不能编辑**，但界面 **不出现** 任何「只读 / 预览 / 不可编辑」标签或开关  
- 工具栏只有对查看有意义的动作（关闭、下载…）

---

## 2. 与 Notebook 的分工

| | NotebookPanel | File Preview MarkdownViewer |
|--|---------------|-----------------------------|
| 目的 | 生成文档 **撰写/修改** | 附件/材料 **阅读** |
| 编辑 | 是 | 否 |
| Slash / DnD | 是 | 否 |
| 入口 | artifact chip | file-card / openPreview |
| 组件 | 同一 Mdx 内核 | 同一 Mdx 内核 |

**不要**在 Preview 里做「点击变为编辑」除非未来产品单独立项。

---

## 3. API 扩展（markdown-editor）

现有：

```js
MarkdownEditor.mount(host, { markdown, onChange, autosaveMs, ... })
```

新增选项（名称二选一，实现时统一为 **`viewOnly`**）：

```js
MarkdownEditor.mount(host, {
  markdown: string,
  viewOnly: true,          // 关键：查看态
  // viewOnly 时忽略 onChange / autosave
})
```

### viewOnly 行为清单

| 行为 | viewOnly=true |
|------|----------------|
| contenteditable / 输入 | 关闭 |
| 光标闪烁 | 无 |
| `/` `、` slash | 不触发 |
| DnD 把手 | 不渲染 |
| 块 hover 工具 | 不渲染 |
| 选中文本 | **允许**（方便复制） |
| 点击 wiki/file 链接 | 可回调 onOpenDoc / onOpenPath |
| 序列化 getMarkdown | 仍可用（导出） |

### 实现要点（建议）

1. `createEditor` 读 `options.viewOnly`  
2. 根节点加 class：`mdx-editor is-view-only`（**仅 class，无可见文案**）  
3. CSS：  
   - `pointer-events` 保留链接与滚动  
   - 隐藏 `.mdx-handle` / slash 相关  
   - `user-select: text`  
4. 键盘：拦截会改文档的快捷键（输入、Delete、Ctrl+B 等）；保留 Ctrl+C / 翻页  
5. 不要挂 `contentEditable=true`

---

## 4. MarkdownViewer 组件

```js
// js/file-preview/viewers/MarkdownViewer.js
function mount(host, model, opts) {
  const body = el('div', 'fp-md-stage');
  host.appendChild(body);
  const api = window.MarkdownEditor.mount(body, {
    markdown: model.payload.markdown,
    viewOnly: true,
    onOpenPath: opts.onOpenPath,
    onOpenDoc: opts.onOpenDoc,
  });
  return {
    destroy() { api.destroy(); body.remove(); },
    getMarkdown: () => api.getMarkdown(),
  };
}
```

样式：`css/file-preview/viewers/markdown.css`  
- stage 内边距、最大宽度  
- 可复用 `css/markdown-editor/index.css` 的阅读态规则  
- **不**引入编辑态高亮边框  

---

## 5. Adapter

```js
// adapters/markdown.js
async function load(ctx) {
  const text = await readTextFromSource(ctx.source);
  return {
    kind: 'markdown',
    name: ...,
    status: 'ready',
    capabilities: ['close', 'download', 'copy'],
    payload: { markdown: text },
  };
}
```

---

## 6. 明确不做

- 界面 badge：「只读模式」  
- Toggle：「编辑此文档」  
- 预览/源码双栏  
- 为预览重写一套 markdown-lite 渲染（仅允许 **临时降级** 当 editor 未加载）

---

## 7. 验收

- [ ] 打开 sample.md 块级样式正确  
- [ ] 键盘输入不改变内容  
- [ ] 无「只读」文案节点  
- [ ] 复制一段文字成功  
- [ ] destroy 无泄漏  
- [ ] 与 Notebook 同时存在时样式不串（class 前缀 `mdx-` / `fp-`）  
