# Extension: `conex.embed` — 链接/卡片嵌入（P2）

> 索引：[06-extensions.md](../06-extensions.md)  
> 块目录：[02-block-catalog.md](../02-block-catalog.md) §7.5 `embed_link`  
> **优先级**：P2（默认 **关闭** `features.embed`）  
> **meta.id**：`conex.embed`  
> **blockType**：`embed_link`

---

## 1. 目标 / 非目标

### 目标

- 将 URL 以 **卡片式预览** 呈现（标题/描述/favicon），优于裸链接段落。  
- Markdown 可往返；无元数据时优雅降级为链接段落。  
- 安全：仅 http(s)；无任意 iframe 默认（iframe 嵌入另开关）。

### 非目标

- v1 Notebook 交付（本扩展 P2）。  
- 任意 oEmbed 供应商无白名单。  
- 嵌入本地源码文件（用 file_chip）。  
- 嵌入整篇 wiki 正文（避免与 Notebook 单文档模型冲突；最多链接卡片）。

---

## 2. 语法

### 2.1 规范扩展形式（序列化优先）

```md
@[embed](https://example.com/article)
```

可选 title：

```md
@[embed "可选标题"](https://example.com/article)
```

### 2.2 兼容：独占行裸 URL（可选升级）

```md
https://example.com/article
```

当且仅当：

- `features.embed === true`  
- 整段唯一内容为裸 URL（可 trim）  
- 协议 http(s)  

→ 解析为 `embed_link`；否则保持 paragraph + autolink。

### 2.3 不采用（v1/P2 初版）

| 形态 | 说明 |
|------|------|
| HTML `<iframe>` | 默认拒绝；P2 末可选白名单 |
| `![[embed]]` wiki 嵌入 | 避免与 wiki_link 混淆 |
| 多 URL 同段 | 不升级为 embed |

### 2.4 文法

```
embed ::= "@[embed" ( ws+ dquote title dquote )? "](" url ")"
url   ::= 非空白非 ")" 字符
title ::= 不含 dquote 的短标题 ≤ 200
```

---

## 3. 数据形状

```ts
interface EmbedLinkProps {
  url: string;
  title?: string;         // 用户或 OG 标题
  description?: string;   // OG/预览，可缓存
  favicon?: string;       // https only
  provider?: string;      // 可选：'generic' | 'youtube' | …
  /** 运行时 */
  status?: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage?: string;
}

interface EmbedLinkBlock {
  id: string;
  type: 'embed_link';
  props: EmbedLinkProps;
  // 无 children；void-ish 卡片
}
```

**序列化只保证**：`url` + 可选用户 `title`。  
`description` / `favicon` / `status`：**默认不写进 MD**（避免脏 diff）；可选 HTML comment 缓存属 P3，不做。

---

## 4. parse / serialize

### 4.1 块级 parse

```ts
function parseEmbed(ctx: ParseContext) {
  const t = ctx.tokens[ctx.index];
  if (t.kind !== 'paragraph') return null;
  const text = t.text.trim();
  const m = text.match(/^@\[embed(?:\s+"([^"]*)")?\]\(([^)\s]+)\)$/i);
  if (m) {
    const url = sanitizeUrl(m[2]);
    if (!url) return null;
    return {
      block: {
        id: newId(),
        type: 'embed_link',
        props: { url, title: m[1] || undefined, status: 'idle' },
      },
      consumed: 1,
    };
  }
  if (ctx.features.embed && isLoneHttpUrl(text)) {
    const url = sanitizeUrl(text);
    if (!url) return null;
    return {
      block: { id: newId(), type: 'embed_link', props: { url, status: 'idle' } },
      consumed: 1,
    };
  }
  return null;
}
```

### 4.2 serialize

```ts
function serializeEmbed(block: EmbedLinkBlock, ctx: SerializeContext): string {
  const url = block.props.url;
  const title = block.props.title?.trim();
  if (ctx.mode === 'pure-gfm') {
    return title ? `[${title}](${url})` : `<${url}>`;
  }
  return title ? `@[embed "${title}"](${url})` : `@[embed](${url})`;
}
```

### 4.3 ExtensionSpec

```ts
const conexEmbed: BlockExtension = {
  meta: {
    id: 'conex.embed',
    syntaxVersion: 1,
    priority: 'P2',
    enabledByDefault: false,
    degrade: 'md-link',
  },
  blockType: 'embed_link',
  parse: parseEmbed,
  serialize: serializeEmbed,
  isVoid: true,
  slash: {
    id: 'insert.embed_link',
    title: '链接卡片',
    keywords: ['嵌入', '卡片', 'embed', 'bookmark', '链接预览'],
    group: '媒体',
    insert: () => ({
      type: 'embed_link',
      props: { url: '', status: 'idle' },
    }),
  },
  theme: { blockClass: 'mdx-embed' },
};
```

---

## 5. 交互

| 操作 | 行为 |
|------|------|
| slash 插入 | 空 embed；聚焦 URL 输入 |
| 粘贴独占 URL | 若 flag 开 → 转 embed 并 `status=loading` |
| 阅读态 | 展示卡片；Click 主区域 → 打开 url（外链新标签 + rel） |
| 编辑态 | 选中块；工具条改 url/title；无文本 caret |
| 元数据拉取 | 宿主 `fetchLinkPreview(url)` 可选；失败 `status=error`，仍显示 url |
| Backspace | 删除整块 |
| DnD | 整块移动 |

**预览请求状态机**：

```
idle → (url 有效) → loading → ready
                           ↘ error → (可重试) loading
url 变更 → idle → loading …
features.embed 关 → 永不 loading；若已是块仍显示降级 UI
```

---

## 6. 阅读 DOM

```html
<div class="mdx-block mdx-block--embed-link" data-block-type="embed_link">
  <div class="mdx-block__body">
    <a class="mdx-embed" href="https://example.com" target="_blank"
       rel="noopener noreferrer" data-embed-status="ready">
      <span class="mdx-embed__favicon" aria-hidden="true"></span>
      <span class="mdx-embed__text">
        <span class="mdx-embed__title">示例标题</span>
        <span class="mdx-embed__desc">描述一行…</span>
        <span class="mdx-embed__url">example.com</span>
      </span>
    </a>
  </div>
</div>
```

| class / attr | 用途 |
|--------------|------|
| `mdx-embed` | 卡片根（左簇图标+文字） |
| `mdx-embed__title` | 标题 |
| `mdx-embed__desc` | 描述 |
| `mdx-embed__url` | 主机名弱化显示 |
| `data-embed-status` | idle/loading/ready/error |

loading：骨架 `mdx-embed--loading`；error：显示 url +「预览不可用」。

---

## 7. 边界情况

| 情况 | 处理 |
|------|------|
| 空 url | placeholder「粘贴链接」；不 serialize 或 serialize 时跳过块 |
| 非 http(s) | sanitize 失败 → paragraph 纯文本 |
| 超长 url | cap 2048 |
| OG 含 HTML | 全 strip |
| 内网 URL | 宿主策略；编辑器不强制 SSRF 防护但 **推荐** 宿主代理 |
| flag 关闭读旧文档 | 仍 render 降级卡片或链接，serialize 保持 `@[embed]` 以免丢 |
| 与 image `![]()` | 图片不走 embed |
| YouTube | P2 可特化为 provider；默认同 generic 卡 |

---

## 8. a11y

- 卡片为真链接 `a`（或 `role="link"`）。  
- loading：`aria-busy="true"`。  
- error：`aria-label` 含错误说明。  
- 标题层级：不用 `h*` 抢文档大纲，用 `span`。

---

## 9. 安全

| 项 | 规则 |
|----|------|
| URL | 仅 `http:` `https:` |
| 点击 | `rel="noopener noreferrer"` `target="_blank"` |
| favicon/img | 仅 https；`referrerpolicy` 可 `no-referrer` |
| 无默认 iframe | 防点击劫持与脚本 |
| 预览 fetch | 宿主侧；禁止把 HTML 当 `innerHTML` |
| `@[embed](javascript:…)` | 拒绝 |

---

## 10. 测试点

1. `@[embed](https://a.com)` 往返。  
2. 带 title 往返。  
3. pure-gfm → `[title](url)` 或 `<url>`。  
4. 危险协议不生成块。  
5. 独占裸 URL 升级（flag 开/关）。  
6. slash 插入空块编辑。  
7. loading/error class。  
8. 序列化不含 description。  
9. flag 关时 parse 不升级裸 URL。  
10. 键盘聚焦卡片可激活。

---

## 11. 分期

| 项 | 期 |
|----|-----|
| 语法 + 块 + 降级链接 UI | P2 |
| OG 预览宿主 API | P2 |
| slash / 粘贴升级 | P2 |
| provider 特化（视频） | P2 末 / P3 |
| iframe 白名单 | 默认永不；需单独 RFC |

---

## 12. 与 math / mermaid 关系

本扩展 **不** 覆盖：

- `$$` 数学块 → 06 §8.1 / catalog `math_block`  
- \`\`\`mermaid → 06 §8.2 / `code_block` language  

三者均 P2，feature flag 独立。

---

## 13. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | P2 嵌入卡片语法与安全边界 |
