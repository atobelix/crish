# 文件预览 · Markdown 样例

这是一份用于 **文件预览** 的中等长度 GFM 示例，覆盖常见块级元素。

## 功能概览

- 复用块编辑器查看态渲染
- 支持选中与复制
- 键盘不可修改文档内容

### 有序列表

1. 打开附件栏中的 `.md` 卡片
2. 确认块级样式与 Notebook 一致
3. 尝试复制一段文字

## 代码块

```js
function greet(name) {
  return '你好，' + name;
}
console.log(greet('Conex'));
```

行内代码示例：`openPreview({ type: "text", name: "note.md", text })`。

## 表格

| 格式 | 查看态 | 说明 |
| --- | --- | --- |
| Markdown | 是 | 复用 MarkdownEditor |
| PDF | 是 | pdf.js 真解析 |
| 图片 | 是 | 缩放 / 旋转 |

## 引用与提示

> 查看态不应出现「只读」「预览模式」等解释性标签。

- [x] 标题与列表
- [x] 代码与表格
- [ ] 更多格式见后续 Phase

---

文末段落：滚动、选中复制应可用；输入与删除不得改变内容。
