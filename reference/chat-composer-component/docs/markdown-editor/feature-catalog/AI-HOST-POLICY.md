# AI 与样例数据政策（运行时 vs 子 agent）

## 硬规则

| 层 | 允许 | 禁止 |
|----|------|------|
| **运行时代码**（`js/markdown-editor/**`） | 薄端口转发 `options.ai.complete`；无端口则关闭入口 | 内置 mock complete、假摘要/假改写、`ai:true` 自动造文 |
| **演示/验收样本文档** | 由**专门子 agent** 写成**真实可用的 Markdown 文件**（标题、代码、表、私有扩展语法齐全） | 把「Mock AI 输出」写进库逻辑 |
| **主软件（Conex）** | 实现真正的 AI 网关并注入 `complete` | 依赖编辑器内置假模型 |

## 宿主接入（唯一 AI 路径）

```js
MarkdownEditor.mount(el, {
  markdown: md,
  ai: {
    complete: function (req) {
      // req: { action, selection, documentMd, signal }
      return hostAi.run(req); // Promise<string> | AsyncIterable<string>
    },
  },
});
```

- 未注入 `complete` → slash / 命令面板 **不出现 AI 项**，`runAi` 返回 `no-ai-port`。
- 编辑器**不**根据 `ai: true` 启用任何假实现。

## 样本文档怎么来

需要展示页、harness、截图用内容时：

1. 派 **sample-data agent**（或人工）写 `samples/*.md` / 内嵌于 html 的**真实文档字符串**。
2. 内容应是合法 GFM + Conex 私有扩展（callout、wiki、file chip、表等），可 parse/serialize 往返。
3. **不要**在 `ai/ports.js` 里生成「【Mock 摘要】」一类字符串。

## 创建 Markdown 的接口（保持简单）

```js
// 解析 / 序列化
MarkdownEditor.parse(md)      // → Doc
MarkdownEditor.serialize(doc) // → md

// 挂载
const api = MarkdownEditor.mount(el, {
  markdown,           // 或 doc
  onChange(md, doc),
  viewOnly,
  // 私有能力端口（非 AI）
  onOpenPath, onOpenDoc, uploadImage, resolveUrl,
  // 可选 AI（宿主）
  ai: { complete },
});
api.getMarkdown(); api.setMarkdown(md);
api.getDoc(); api.setDoc(doc);
```

私有格式注意点：callout / `[[doc:]]` / `[[file:]]` / 表合并（JSON Doc 保真，GFM 导出可能降级）——见扩展分册 07。

## 与分册 05 的关系

历史规格里的「Mock 端口」作废；以本文件与 `ai/ports.js` 实现为准。
