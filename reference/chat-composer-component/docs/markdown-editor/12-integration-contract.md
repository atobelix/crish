# 12 — 主软件集成契约

> 宿主（Conex Desktop / Workbench / 其它 WebView）按本文适配即可，无需改编辑器内核。

---

## 1. 最小集成

```html
<link rel="stylesheet" href="path/to/markdown-editor/index.css" />
<!-- 顺序固定 -->
<script src=".../util.js"></script>
<script src=".../schema.js"></script>
<script src=".../model.js"></script>
<script src=".../parse.js"></script>
<script src=".../serialize.js"></script>
<script src=".../registry.js"></script>
<script src=".../blocks/*.js"></script> <!-- 若拆分 -->
<script src=".../ui/*.js"></script>
<script src=".../editor.js"></script>
<script src=".../index.js"></script>
```

```js
const api = MarkdownEditor.mount(containerEl, {
  markdown: initialMd,
  onChange(md, doc) {
    // 写盘 / 同步状态
    save(md);
  },
  onOpenPath(path) { openFile(path); },
  onOpenDoc(title) { openWiki(title); },
});

// 关闭前
api.flush();
api.destroy();
```

---

## 2. 查看态（文件预览）

```js
MarkdownEditor.mount(el, {
  markdown,
  viewOnly: true, // 无编辑 chrome；UI 不出现「只读」字样
});
```

---

## 3. 可选：Doc JSON

```js
const doc = api.getDoc();
// 持久化 doc
api.setDoc(doc);
```

优先 MD 时只需 `getMarkdown` / `setMarkdown`。

---

## 4. 样式隔离

- 全部类名 `mdx-` 前缀  
- Token 可在宿主覆盖：

```css
.my-host .mdx-editor {
  --mdx-body: 15px;
  --mdx-lh-body: 1.65;
}
```

- **不要**给宿主父级设 `opacity` 叠正文（Windows 发虚）

---

## 5. 多实例

支持同一页多个 `mount`；实例状态不挂在 `window` 单例上（除模块命名空间）。

---

## 6. 打包建议（desktop）

- 将 `js/markdown-editor` + `css/markdown-editor` 收为 Vite/Rollup library  
- 导出：`mount`, `parse`, `serialize`, `migrate`  
- 动态能力（语法高亮、mermaid）按需 `import()`，不进首包  

---

## 7. 适配检查表

| 项 | 完成 |
|----|------|
| 引入 CSS/JS 顺序正确 | ☐ |
| onChange 防抖后写盘 | ☐ |
| destroy 释放监听 | ☐ |
| viewOnly 预览路径 | ☐ |
| 中文 IME 不丢字 | ☐ |
| 深色主题 token（可选） | ☐ |
