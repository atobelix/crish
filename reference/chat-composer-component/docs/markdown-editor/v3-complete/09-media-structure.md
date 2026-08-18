# 09 · 媒体结构 — 图片 / 视频 / 音频 / 附件 · TOC · 锚点 · Wiki · Tag · Backlinks · 上传端口

> **路径**：`docs/markdown-editor/v3-complete/09-media-structure.md`  
> **读者**：块实现 agent、宿主集成、安全评审  
> **关联**：`02-block-catalog` · `06-extensions` · `conex-file-chip` · `conex-wiki-link` · `10-data-format` · `08-integration` · `06-showcase-demo` · CROSSCUTTING D14/D15  
> **修订**：2026-08-02 v3 首版

---

## 0. 一句话

把「能插一张图」升级为 **完整媒体块族 + 文档结构导航 + 双链/标签体系 + 宿主上传端口**；反链（backlinks）计算与面板 **明确归属宿主**，编辑器只做出链与事件。

---

## 1. 目标 / 非目标

### 1.1 目标

| ID | 目标 |
|----|------|
| M1 | 定义 `image` / `video` / `audio` / `attachment`（及既有 `file_chip`）块的数据、MD、DOM、交互 |
| M2 | 统一 **上传端口**（宿主注入）；编辑器不绑死对象存储 |
| M3 | TOC 块 + 侧栏 TOC 数据源；标题 **锚点** 稳定算法 |
| M4 | Wiki（`[[doc:]]` / 兼容扩展）、Tag（`#tag`）、出链枚举 API |
| M5 | Backlinks：**宿主责任**边界、编辑器需暴露的钩子 |
| M6 | 安全：URL 协议白名单、路径逃逸、XSS、大文件门控 |

### 1.2 非目标

| 非目标 | 说明 |
|--------|------|
| 完整 DAM / 媒体库 UI | 宿主侧栏或系统文件选择器 |
| 视频转码、波形编辑 | 播放与占位即可 |
| Obsidian 级图谱可视化 | 后置；本册只定数据钩子 |
| 反链面板的视觉稿进编辑器内核 | 宿主实现 |
| 二进制写入 Markdown 正文 | 只用 URL / workspace path / attachment id |
| 在 Notebook 内打开源码文件编辑 | D14：file → Files 面板 |

---

## 2. 总览架构

```
┌─────────────────────────────────────────────────────────┐
│  Host（Notebook / Desktop / markdown-editor.html）       │
│  · media.upload* · resolveUrl · onOpenPath · onOpenDoc  │
│  · backlinkIndex.query(target) → 反链面板 UI             │
└───────────────────────────┬─────────────────────────────┘
                            │ options.media / callbacks
┌───────────────────────────▼─────────────────────────────┐
│  MarkdownEditor                                          │
│  · blocks: image | video | audio | attachment | file_chip│
│  · marks/atoms: wiki_link | tag | md-link                │
│  · structure: heading.anchor | toc block | getOutlinks() │
│  · 不实现：全局反链索引、云上传协议细节                     │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 媒体块目录

### 3.1 类型一览

| type | 中文 | MD 主形态 | slash | 优先级 | 说明 |
|------|------|-----------|-------|--------|------|
| `image` | 图片 | `![alt](src "title")` | `insert.image` / `core.image` | P0（v3 展示必有） | 既有 catalog §7.2 升级 |
| `video` | 视频 | 扩展 `@[video](src)` 或安全 HTML | `insert.video` | P1 | 新增 |
| `audio` | 音频 | 扩展 `@[audio](src)` | `insert.audio` | P1 | 新增 |
| `attachment` | 附件块 | 扩展 `@[file](path|url)` | `insert.attachment` | P1 | 下载/打开；可与 file_chip 分工 |
| `file_chip` | 文件芯片 | `[[file:path]]` | `insert.file_chip` | P1 | 行内/独占行；工作区路径 |

**分工**：

| 形态 | 语义 | 典型 UI |
|------|------|---------|
| `image` | 可视觉浏览的图 | figure + img |
| `video` / `audio` | 时基媒体 | 播放器控件 |
| `attachment` | 任意文件附件（pdf/zip…） | 卡片：图标+文件名+大小+操作 |
| `file_chip` | 工作区路径引用（源码/文档路径） | pill chip；点开 Files |

`attachment` 偏「嵌在文档里的附件资源」；`file_chip` 偏「指向仓库路径的引用」。允许产品后期合并，但 v3 **API 两套并存**，避免破坏 D14。

---

## 4. 图片块 `image`

### 4.1 数据形状

```ts
interface ImageBlock {
  id: BlockId;
  type: 'image';
  indent: number;
  props: {
    src: string;           // http(s) | 相对路径 | blob: | attachment:id
    alt?: string;
    title?: string;
    width?: number;        // px；可选，序列化见下
    align?: 'left' | 'center' | 'right';
    caption?: string;      // 若与 alt 分离
    /** 运行时，不序列化 */
    status?: 'loading' | 'ready' | 'error';
    naturalWidth?: number;
    naturalHeight?: number;
  };
}
```

### 4.2 Markdown

**标准 GFM**：

```md
![示意图](https://cdn.example.com/a.png "title")
```

**带宽度（Conex 扩展，可选）**：

```md
![示意图](https://cdn.example.com/a.png =640x)
```

或 HTML（仅解析白名单，序列化优先 GFM）：

```html
<img src="..." alt="..." width="640" />
```

**pure-gfm**：只写 `![alt](src)`；丢弃 width/align 或写入 title 旁注（不推荐）；优先丢弃视觉 props。

### 4.3 DOM

```html
<figure class="mdx-block mdx-image" data-block-id="…" data-block-type="image" data-align="center">
  <div class="mdx-image__frame">
    <img class="mdx-image__img" src="…" alt="…" draggable="false" />
    <div class="mdx-image__placeholder" hidden>添加图片</div>
    <div class="mdx-image__error" hidden>无法加载图片</div>
  </div>
  <figcaption class="mdx-image__caption" data-editable="true">可选说明</figcaption>
</figure>
```

### 4.4 交互

| 动作 | 行为 |
|------|------|
| 单击块 | 选中块（非文本 caret）；显示块菜单/替换入口 |
| 双击 / 块菜单「替换」 | 调宿主文件选择或 URL 输入 |
| 编辑 caption/alt | 选中后属性条或 figcaption contenteditable |
| 粘贴剪贴板图片 | 若 `media.uploadImage` 存在 → 上传 → 插入/替换 src |
| 拖入图片文件 | 同上 |
| 无 src | 占位「添加图片」；点击触发选择 |
| 加载失败 | error 态；保留 src 以便改 |

**键盘**：块选中时 `Backspace`/`Delete` 删块；`Enter` 在后插入 paragraph。

### 4.5 安全

| 规则 | 要求 |
|------|------|
| 协议 | 允许 `https:` `http:` `blob:` 相对路径 `attachment:`；**禁止** `javascript:` `data:text/html` |
| `data:image/*` | 可选允许；限制 base64 长度（如 ≤ 1.5MB 解码前） |
| 跟踪参数 | 可不剥；外链 img 不带 cookies（默认浏览器行为） |
| XSS | alt/title 文本转义；禁止 raw HTML on* |

---

## 5. 视频块 `video`

### 5.1 数据形状

```ts
interface VideoBlock {
  id: BlockId;
  type: 'video';
  indent: number;
  props: {
    src: string;
    poster?: string;
    caption?: string;
    /** 秒；可选 */
    startAt?: number;
    status?: 'loading' | 'ready' | 'error';
  };
}
```

### 5.2 Markdown 序列化（冻结建议）

**Conex 主形态**（与 embed 风格一致，易 parse）：

```md
@[video](https://cdn.example.com/demo.mp4)
@[video](https://cdn.example.com/demo.mp4 "可选标题")
```

可选属性行（P2）：

```md
@[video](path/to/a.mp4){poster=path/to/p.jpg}
```

**pure-gfm 降级**：

```md
[视频: demo.mp4](https://cdn.example.com/demo.mp4)
```

或保留为段落链接，避免非法 HTML。

### 5.3 DOM

```html
<figure class="mdx-block mdx-video" data-block-type="video">
  <div class="mdx-video__frame">
    <video class="mdx-video__el" controls playsinline preload="metadata" src="…" poster="…"></video>
    <!-- 无 src：占位 -->
    <div class="mdx-video__placeholder">添加视频</div>
  </div>
  <figcaption class="mdx-video__caption"></figcaption>
</figure>
```

### 5.4 交互 / 安全

- 阅读态可播放；**编辑器不**自动 autoplay 有声。  
- 上传走 `media.uploadVideo` 或泛化 `uploadFile` + mime 判断。  
- 协议白名单同图片；**禁止**任意 iframe 套壳（防嵌恶意页）。  
- 展示页可用静态 svg 图标作假 src，验收占位 UI。

---

## 6. 音频块 `audio`

### 6.1 数据形状

```ts
interface AudioBlock {
  id: BlockId;
  type: 'audio';
  indent: number;
  props: {
    src: string;
    title?: string;
    caption?: string;
    status?: 'loading' | 'ready' | 'error';
  };
}
```

### 6.2 Markdown

```md
@[audio](https://cdn.example.com/note.mp3)
@[audio](./assets/sample.mp3 "会议录音")
```

pure-gfm：`[音频: note.mp3](url)`。

### 6.3 DOM

```html
<figure class="mdx-block mdx-audio" data-block-type="audio">
  <div class="mdx-audio__row">
    <span class="mdx-audio__icon" aria-hidden="true"></span>
    <div class="mdx-audio__meta">
      <div class="mdx-audio__title">会议录音</div>
      <audio class="mdx-audio__el" controls preload="metadata" src="…"></audio>
    </div>
  </div>
</figure>
```

---

## 7. 附件块 `attachment`

### 7.1 数据形状

```ts
interface AttachmentBlock {
  id: BlockId;
  type: 'attachment';
  indent: number;
  props: {
    /** 展示名 */
    name: string;
    /** 打开/下载地址：url 或 workspace path 或 attachment id */
    href: string;
    mime?: string;
    size?: number;       // bytes；可序列化进扩展属性
    /** file | url */
    kind?: 'file' | 'url';
  };
}
```

### 7.2 Markdown

```md
@[file](reports/q3.pdf)
@[file](reports/q3.pdf "Q3 报告")
```

带 size（可选扩展）：

```md
@[file](reports/q3.pdf){size=204800}
```

pure-gfm：`[Q3 报告](reports/q3.pdf)`。

### 7.3 DOM / 交互

```html
<div class="mdx-block mdx-attachment" data-block-type="attachment" role="group">
  <button type="button" class="mdx-attachment__card">
    <span class="mdx-attachment__icon" data-mime="application/pdf"></span>
    <span class="mdx-attachment__text">
      <span class="mdx-attachment__name">q3.pdf</span>
      <span class="mdx-attachment__sub">200 KB · PDF</span>
    </span>
  </button>
</div>
```

- 点击 → `onOpenPath(href, { kind: 'attachment' })` 或宿主下载。  
- 图标可复用 `assets/icons/*.svg`（pdf/zip/word…）。

### 7.4 与 `file_chip` 对比

| | attachment | file_chip |
|--|------------|-----------|
| 语法 | `@[file](…)` | `[[file:path]]` |
| 形态 | 块级卡片 | 行内 pill（可独占行） |
| 元数据 | size/mime | path/label |
| 主场景 | 报告附件、二进制 | 源码跳转、工作区引用 |

---

## 8. 上传端口

### 8.1 宿主注入（MountOptions）

与 `10-data-format` 对齐并扩展：

```ts
interface MediaPorts {
  /** 图片：粘贴、拖放、文件选择 */
  uploadImage?: (file: File, ctx: UploadContext) => Promise<MediaUploadResult>;
  /** 视频 */
  uploadVideo?: (file: File, ctx: UploadContext) => Promise<MediaUploadResult>;
  /** 音频 */
  uploadAudio?: (file: File, ctx: UploadContext) => Promise<MediaUploadResult>;
  /** 通用附件 */
  uploadFile?: (file: File, ctx: UploadContext) => Promise<MediaUploadResult>;
  /**
   * 将存储键解析为可加载 URL（attachment:id / 相对路径）
   * 阅读态渲染前调用
   */
  resolveUrl?: (ref: string, kind: MediaKind) => string | Promise<string>;
  /** 可选：选文件前拦截（权限、配额） */
  beforePick?: (kind: MediaKind) => boolean | Promise<boolean>;
}

type MediaKind = 'image' | 'video' | 'audio' | 'file';

interface UploadContext {
  kind: MediaKind;
  source: 'paste' | 'drop' | 'pick' | 'replace';
  blockId?: BlockId;
  /** 用于取消 */
  signal?: AbortSignal;
}

interface MediaUploadResult {
  /** 写入 props.src / href 的值 */
  url: string;
  alt?: string;
  name?: string;
  mime?: string;
  size?: number;
  poster?: string;
  width?: number;
  height?: number;
}
```

```ts
// MountOptions 片段
media?: MediaPorts;
features?: {
  media?: boolean;        // false 时 slash 隐藏 image/video/audio/file
  maxUploadBytes?: number; // 默认建议 20 * 1024 * 1024
};
```

### 8.2 编辑器侧流程

```
用户粘贴图片
  → 若 !uploadImage → toast「宿主未配置上传」；可插入空 image 占位
  → 若 file.size > max → toast 拒绝
  → 插入 image 块 status=loading（可选 blob 预览）
  → await uploadImage(file, { kind:'image', source:'paste', signal })
  → 成功：patch src=url, status=ready；历史一条「插入图片」
  → 失败：status=error；保留 blob 预览或清空；toast error.message
  → 支持 signal 取消（Esc / 块删除时 abort）
```

**替换**：选中已有媒体 → 上传成功 patch 同一 blockId，不插新块。

### 8.3 Demo / 无后端 Mock

```js
function demoUploadMock(kind) {
  return function (file, ctx) {
    return new Promise(function (resolve, reject) {
      if (window.__ME_UPLOAD_FAIL) {
        reject(new Error('模拟上传失败'));
        return;
      }
      var url = URL.createObjectURL(file);
      setTimeout(function () {
        resolve({
          url: url,
          name: file.name,
          mime: file.type,
          size: file.size,
          alt: file.name,
        });
      }, 400);
    });
  };
}
```

展示页 `··· → 模拟上传失败` 置 `__ME_UPLOAD_FAIL`。

### 8.4 未配置端口时的 UI

| 入口 | 行为 |
|------|------|
| slash「图片」 | 仍可插入空块；或打开「输入 URL」对话框（仅 URL 不需 upload） |
| 粘贴二进制图 | toast 禁用说明 |
| 拖放文件 | 同上 |
| 仅 URL | 始终允许（白名单协议） |

---

## 9. TOC（目录）

### 9.1 两种形态

| 形态 | 谁渲染 | 数据源 |
|------|--------|--------|
| **侧栏 TOC** | 宿主或编辑器 chrome（展示页 `me-toc`） | 扫描 heading 1–3 |
| **文内 TOC 块** | 块 `toc` | 同上，阅读态列表 |

### 9.2 文内块

```ts
interface TocBlock {
  id: BlockId;
  type: 'toc';
  indent: number;
  props: {
    minLevel?: number; // 默认 2
    maxLevel?: number; // 默认 3
    /** 运行时生成，不序列化 */
    items?: TocItem[];
  };
}

interface TocItem {
  blockId: BlockId;
  level: number;
  text: string;
  anchor: string;
}
```

**Markdown 标记**（任选其一，实现冻结一种）：

```md
<!-- conex:toc -->
```

或：

```md
@[toc]
```

slash：`insert.toc` / 关键词「目录」「toc」。

**阅读态**：可点击列表；**编辑态**：可选中整块，一般不直接改列表项（改标题即刷新）。

### 9.3 刷新策略

- 标题 `update` / `move` / `remove` 后 debounce 100–200ms 重建 TOC items。  
- 不把 items 写入 serialize（避免脏 MD）。

---

## 10. 锚点（Anchor）

### 10.1 算法（稳定、中文友好）

```ts
function slugifyHeading(text: string, used: Map<string, number>): string {
  let base = text
    .trim()
    .toLowerCase()
    // 保留中文、字母数字
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff\-]+/g, '')
    .replace(/\-+/g, '-')
    .replace(/^\-|\-$/g, '');
  if (!base) base = 'section';
  const n = used.get(base) || 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}
```

- 每个 `heading` 块：`props.anchor` **运行时**计算；可选序列化 HTML 注释 `<!-- anchor:xxx -->`（默认 **不** 写入 MD，减少噪音）。  
- DOM：`id={anchor}` 挂在 heading 根节点；保证 `document.getElementById` / `location.hash` 可用。

### 10.2 站内链接

- MD：`[文本](#anchor)`  
- 点击：编辑器内 `preventDefault` + `scrollToAnchor`；宿主可监听 `onNavigateAnchor(anchor)`。

### 10.3 冲突

- 同文重复标题 → `-1` `-2` 后缀。  
- 重命名标题 → 锚点变化；**旧 hash 不保证稳定**（文档说明即可；P2 可提供显式 `props.anchorLock`）。

---

## 11. Wiki 双链

### 11.1 语法（与扩展对齐）

| 语法 | atom | 回调 |
|------|------|------|
| `[[doc:标题]]` | `wiki_link` kind=doc | `onOpenDoc` / `onOpenPath(..., {kind:'wiki-link'})` |
| `[[doc:标题\|显示名]]` | 同上 + label | 同上 |
| `[[ref:id]]` | kind=ref | 宿主稳定 id |
| `[[file:path]]` | `file_chip` | `onOpenPath` kind file-chip |

v1 **要求** kind 前缀（`doc:` / `file:`），避免与自由 `[[标题]]` 冲突。  
若产品要兼容 Obsidian 无前缀，须单独 flag `features.wikiBareLink`，默认 **关**。

### 11.2 数据

```ts
// 行内
{ type: 'wiki_link'; kind: 'doc' | 'ref'; target: string; label?: string }

// TextMark 兼容（10-data-format）
{ type: 'wiki'; title: string }
```

解析优先扩展 atom；serialize 统一 `[[doc:target]]`。

### 11.3 交互

- 阅读态：chip / 链接样式（`--flow-doc-ink`）。  
- 点击：宿主打开文档；展示页 toast。  
- 编辑态：atom 不可拆字；Backspace 整粒删除。  
- 悬停：可选 title tooltip = target。

### 11.4 出链枚举 API

```ts
interface Outlink {
  kind: 'wiki-link' | 'file-chip' | 'md-link' | 'attachment' | 'tag';
  target: string;
  label?: string;
  sourceBlockId: BlockId;
}

interface MarkdownEditorAPI {
  // ...
  getOutlinks?(): Outlink[];
}
```

宿主可定期 `getOutlinks()` 写入全局索引。

---

## 12. Tag（标签）

### 12.1 语法

- 行内：`#tag`、`#中文标签`、`#v3`  
- 词边界：前为空白/行首/标点；后为空白/标点/行尾  
- **不**把 `# 标题`（ATX heading）解析为 tag

```ts
{ type: 'tag'; name: string }  // name 不含 #
```

serialize：`#${name}`。

### 12.2 交互

| 行为 | 规格 |
|------|------|
| 渲染 | `span.mdx-tag` |
| 点击 | `callbacks.onTagClick?.(name)`；无则 no-op |
| 输入 | 空格结束 tag 识别；IME 中文用 composition 结束后再 token 化 |
| 非法 | 仅 `#` 不成形 |

### 12.3 非目标

- 标签管理后台  
- 嵌套 `#a/b`（P2）  
- 颜色系统（可全用同一 meta 色）

---

## 13. Backlinks（反链）— 宿主责任

### 13.1 边界冻结

| 职责 | 编辑器 | 宿主 |
|------|--------|------|
| 解析本页出链 | ✅ `getOutlinks` | 消费 |
| 维护「文档 A ← 文档 B」全局索引 | ❌ | ✅ |
| 反链列表面板 UI | ❌ | ✅ |
| 打开反链来源文档 | 回调 | ✅ `onOpenDoc` |
| 索引失效/重建 | 可发 `onChange` | ✅ 增量更新 |

**禁止**在 `js/markdown-editor` 内核内做跨文档文件系统扫描。

### 13.2 宿主索引建议形状

```ts
// 宿主侧，非编辑器包
interface BacklinkEdge {
  fromDocId: string;   // 来源文档
  toTarget: string;    // wiki target 或规范化标题
  kind: 'wiki-link' | 'md-link';
  excerpt?: string;    // 来源块纯文本摘要
  blockId?: string;
}

interface BacklinkIndex {
  /** 文档保存时 */
  updateDocument(docId: string, outlinks: Outlink[], excerpts?: Map<BlockId, string>): void;
  removeDocument(docId: string): void;
  /** 谁指向 target */
  getBacklinks(target: string): BacklinkEdge[];
}
```

### 13.3 Notebook 集成示意

```
onAutosave(md)
  → editor.getOutlinks()
  → backlinkIndex.updateDocument(title, outlinks)
  → 若侧栏打开反链：re-render list

用户打开文档 X
  → panel.showBacklinks(backlinkIndex.getBacklinks(X))
  → 点击某条 → onOpenDoc(fromDocId) + 可选 focus blockId
```

### 13.4 展示页

- **不**做反链面板。  
- 活文档 §结构 用 callout 说明宿主责任（见 06-showcase-demo）。  
- 可选：console 打印 `getOutlinks()` 供调试。

### 13.5 验收点 · Backlinks

- [ ] 编辑器文档 **无** 反链面板 DOM 硬依赖  
- [ ] `getOutlinks` 含 wiki/file/md-link/tag（按实现范围）  
- [ ] 宿主 mock 索引可在单元测试中验证增量更新  
- [ ] 删文档会 `removeDocument`，无僵尸边

---

## 14. Slash 与 feature 门控

| command id | section | when |
|------------|---------|------|
| `core.image` / `insert.image` | media | `features.media !== false` |
| `insert.video` | media | 同上 |
| `insert.audio` | media | 同上 |
| `insert.attachment` / `core.file` | media | 同上 |
| `insert.file_chip` | media/advanced | `features.fileChip !== false` |
| `insert.toc` | advanced | `features.toc !== false` |
| wiki 插入 | 可走 `[[` 自动完成 P2 | — |

---

## 15. 解析优先级（行级 / 行内）

**块级扫描**（与 06-extensions 协调，插入点示意）：

1. fence code（含 mermaid）  
2. 表格  
3. heading  
4. hr  
5. 媒体扩展行：`@[video]` `@[audio]` `@[file]` `@[toc]`  
6. 独占行 file/wiki（B8）  
7. list / quote / callout  
8. 单行 image GFM `![…](…)` → image 块  
9. paragraph  

**行内**：code span 锁定 → file_chip → wiki_link → link → tag → marks。

---

## 16. a11y

| 块 | 要求 |
|----|------|
| image | img 必有 alt（可空字符串但要属性）；figure 可选 aria-label |
| video/audio | controls 原生键盘；占位 button 有名称 |
| attachment | card 为 button 或链接；名称含文件名 |
| toc | nav + list；当前项 `aria-current` |
| tag/wiki | 键盘 focus；Enter 激活 |

动效：`prefers-reduced-motion` 下上传 skeleton 不闪烁。

---

## 17. 测试点

| ID | 用例 |
|----|------|
| RT-M01 | `![a](u)` 往返 |
| RT-M02 | `@[video](u)` / `@[audio](u)` 往返 |
| RT-M03 | `@[file](p)` / `[[file:p]]` 往返且互不串型 |
| RT-M04 | `[[doc:t\|L]]` label 往返 |
| RT-M05 | `#tag` 与 heading `# 标题` 不冲突 |
| RT-M06 | 重复标题锚点唯一 |
| RT-M07 | pure-gfm 降级无扩展残留致命错误 |
| UX-M01 | 无 upload 粘贴图 → 明确提示 |
| UX-M02 | upload reject → error 态 |
| UX-M03 | TOC 随标题变更更新 |
| API-M01 | getOutlinks 含本页全部 wiki |

---

## 18. 分期

| 阶段 | 交付 |
|------|------|
| **v3-a** | image 完整 + uploadImage + file_chip/wiki/tag 已有对齐 + 锚点 + 侧栏 TOC 数据 |
| **v3-b** | video/audio/attachment + 文内 toc 块 + getOutlinks |
| **v3-c** | 宿主 backlinkIndex 参考实现（可在 desktop，不在 reference 内核） |
| **P2** | `[[裸标题]]`、标签嵌套、图片宽度拖拽持久化 |

---

## 19. 与展示页（06）对齐

展示页 SAMPLE 必须包含：

1. 至少 1 张 image（可用 `assets/icons/image.svg`）  
2. video/audio 占位语法各 1  
3. `[[file:…]]` 与 `[[doc:…]]`  
4. `#tag` 一行  
5. 反链宿主责任 callout  
6. mount 注入 mock upload  

---

## 20. 完成定义（DoD）

- [ ] 四类媒体 + file_chip 数据/MD/DOM 可实现  
- [ ] MediaPorts 类型进 10/12 契约（实现时回写）  
- [ ] TOC + 锚点算法可测  
- [ ] Wiki/Tag 与既有扩展文档无冲突  
- [ ] Backlinks 边界写清：宿主责任 + getOutlinks  
- [ ] 安全白名单与上传失败态有验收  

---

## 21. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-08-02 | 媒体块族、上传端口、结构导航、双链/标签、反链宿主边界 |
