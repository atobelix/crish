# 04 — 媒体与结构能力分册（做到最好）

> **路径**：`docs/markdown-editor/feature-catalog/04-media-structure.md`  
> **能力面**：W6 媒体 + 结构导航 + 双链/标签 + 科研块族  
> **读者**：实现 agent、宿主集成、安全评审、产品验收  
> **权威顺序**：本分册金标准 > `../v3-complete/09-media-structure.md` 草稿 > 现网代码  
> **关联**：`README.md` §3.5 · `00-master-index.md` W6 · `../extensions/*` · `../10-data-format.md` · `../12-integration-contract.md` · CROSSCUTTING D14/D15  
> **修订**：2026-08-02 · W0 规格冻结首版  
> **行数目标**：600–1400 · **本册 ID 前缀**：`F-M-XXXX`

---

## 0. 导读

### 0.1 一句话

把「能插一张图」升级为 **完整媒体块族 + 文档结构导航 + 双链/标签/反链边界 + 嵌入/提示 + 科研数据集与实验日志 + 可选图表**；上传、反链索引、外链预览、对象存储 **一律走宿主端口**，编辑器内核永不绑死某一家云或某一套文件系统。

### 0.2 本册回答什么

1. 用户在媒体与结构面上 **每一项** 的金标准形态（做到最好）。  
2. 可勾选的验收清单（人工 10 分钟或自动往返）。  
3. 宿主必须/可选注入的 **ports**。  
4. 安全红线（协议、路径逃逸、XSS、配额、第三方 iframe）。  
5. **模块主人**（禁止堆进 `editor.js` 上帝文件）。

### 0.3 「做到最好」统一判据（本册强制）

| # | 判据 | 媒体/结构特化 |
|---|------|----------------|
| 1 | 主路径完整 | 插入 → 渲染 → 编辑/替换 → 序列化 → 再打开一致 |
| 2 | 边界完整 | 空块、超大文件、坏链、粘贴垃圾、IME、撤销 |
| 3 | 键盘可达 | slash / 快捷键 / Tab / Esc；不只鼠标 |
| 4 | 无错误模型 | 失焦渲染态；聚焦不出现双壳；布局不跳 |
| 5 | 有验收清单 | 本节每 F-ID 都有 `- [ ]` |
| 6 | 有模块主人 | 见 §19 模块所有权表 |
| 7 | 有失败态 | 加载失败、端口未配、不支持来源、降级可读 |

只做 UI 壳 = **半成品**，不算 W6 交付。

### 0.4 状态与优先级

| 状态 | 含义 |
|------|------|
| **缺失** | 无 schema / parse / render / slash |
| **半成品** | 有壳或局部往返，体验残缺 |
| **金标准** | 本册验收全绿 |

| 优先级 | 定义 | 默认目标 |
|--------|------|----------|
| **P0** | W6 演示失败则砍不掉 | v3.0–v3.1 |
| **P1** | 一等能力 | v3.1 |
| **P2** | 增强/科研 | v3.2 |
| **P3** | 锦上添花 | later |

### 0.5 总览矩阵（鸟瞰）

| ID | 能力 | P | 目标 | 模块主人（摘要） |
|----|------|---|------|------------------|
| F-M-0100 | 图片块基线 | P0 | v3.0 | `blocks/image/*` |
| F-M-0110 | 拖放插入图片 | P0 | v3.0 | `media/drop-paste.ts` |
| F-M-0120 | 粘贴剪贴板图片 | P0 | v3.0 | 同上 |
| F-M-0130 | 文件选择 / 替换 | P0 | v3.0 | `media/picker.ts` |
| F-M-0140 | 宿主上传端口 | P0 | v3.0 | `ports/media.ts` |
| F-M-0150 | 客户端压缩 | P2 | v3.2 | `media/compress.ts` |
| F-M-0160 | 题注 / alt / 对齐 | P1 | v3.0 | `blocks/image/*` |
| F-M-0170 | 灯箱预览 | P1 | v3.1 | `ui/lightbox.ts` |
| F-M-0180 | 标注（annotate） | P2 | v3.2 | `blocks/image/annotate/*` |
| F-M-0200 | 视频块（本地 mp4） | P1 | v3.1 | `blocks/video/*` |
| F-M-0210 | YouTube 嵌入 | P1 | v3.1 | `media/providers/youtube.ts` |
| F-M-0220 | Bilibili 嵌入 | P1 | v3.1 | `media/providers/bilibili.ts` |
| F-M-0230 | Loom 嵌入 | P2 | v3.2 | `media/providers/loom.ts` |
| F-M-0300 | 音频块 | P1 | v3.1 | `blocks/audio/*` |
| F-M-0400 | 附件卡片块 | P1 | v3.1 | `blocks/attachment/*` |
| F-M-0410 | 文件芯片 `[[file:]]` | P1 | v3.0 | `inline/file-chip.ts` |
| F-M-0500 | 文内 TOC 块 | P1 | v3.1 | `blocks/toc/*` |
| F-M-0510 | 侧栏 TOC 数据源 | P1 | v3.1 | `structure/toc-index.ts` |
| F-M-0520 | 标题锚点稳定算法 | P1 | v3.1 | `structure/anchor.ts` |
| F-M-0600 | 面包屑导航 | P2 | v3.2 | `ui/breadcrumbs.ts` + 宿主 |
| F-M-0700 | Wiki 双链 `[[doc:]]` | P1 | v3.1 | `inline/wiki-link.ts` |
| F-M-0710 | Wiki 补全 | P1 | v3.1 | `ui/wiki-complete.ts` |
| F-M-0800 | 标签 `#tag` | P1 | v3.1 | `inline/tag.ts` |
| F-M-0900 | 出链 API | P1 | v3.1 | `api/outlinks.ts` |
| F-M-0910 | 反链边界（宿主） | P1 | v3.1 | 宿主 `backlinkIndex` |
| F-M-1000 | 链接卡片 Embed | P2 | v3.2 | `blocks/embed/*` |
| F-M-1010 | 媒体提供方白名单 | P1 | v3.1 | `media/providers/*` |
| F-M-1100 | Callout / Alert | P0 | v3.0 | `blocks/callout/*` |
| F-M-1200 | 数据集块 | P2 | v3.2 | `blocks/dataset/*` |
| F-M-1300 | 实验日志块 | P2 | v3.2 | `blocks/experiment-log/*` |
| F-M-1400 | 图表块（可选） | P3 | later | `blocks/chart/*` |
| F-M-9000 | 媒体安全基线 | P0 | v3.0 | `media/security.ts` |
| F-M-9010 | pure-gfm 降级 | P1 | v3.1 | `serialize/pure-gfm.ts` |
| F-M-9020 | a11y / 动效 | P0 | v3.1 | CSS + 块 DOM |

---

## 1. 架构边界（冻结）

```
┌──────────────────────────────────────────────────────────────┐
│ Host（Notebook / Desktop / markdown-editor.html）              │
│  media.upload* · resolveUrl · beforePick                       │
│  onOpenPath · onOpenDoc · onTagClick · onNavigateAnchor        │
│  wiki.suggest · backlinkIndex · embed.fetchMeta（可选）         │
│  breadcrumbs 数据源（文档树 / 路径）                              │
└───────────────────────────────┬────────────────────────────────┘
                                │ MountOptions.ports / callbacks
┌───────────────────────────────▼────────────────────────────────┐
│ MarkdownEditor 内核                                            │
│  blocks: image | video | audio | attachment | toc | callout    │
│          | embed_link | dataset | experiment_log | chart?      │
│  atoms:  file_chip | wiki_link | tag | md-link                 │
│  structure: anchor · tocIndex · getOutlinks()                  │
│  不实现：云上传协议细节、全局反链索引、DAM 媒体库、转码、波形编辑     │
└────────────────────────────────────────────────────────────────┘
```

| 职责 | 编辑器 | 宿主 |
|------|--------|------|
| 块解析 / 渲染 / 序列化 | ✅ | ❌ |
| 选文件、读 File 对象 | ✅（触发） | 可拦截 `beforePick` |
| 上传到对象存储 / 工作区 | ❌ | ✅ `upload*` |
| 将 `attachment:id` 解析为可加载 URL | ❌ | ✅ `resolveUrl` |
| 反链全局索引与面板 | ❌ | ✅ |
| 文档树面包屑路径 | 可选 chrome 槽位 | ✅ 数据 |
| YouTube/B 站 iframe 策略 | 白名单 + sandbox | CSP / 允许列表 |

**禁止**：二进制 base64 大图写入 Markdown 正文作为默认路径；内核内扫全库建反链；任意域名 iframe。

---

## 2. 图片（Image）

### F-M-0100 · 图片块基线

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **目标版本** | v3.0 |
| **现状** | schema 架子；parse/serialize/render 缺失 |
| **模块主人** | `js/markdown-editor/blocks/image/`（`schema.ts` · `parse.ts` · `render.ts` · `serialize.ts`） |
| **依赖** | F-CORE 渲染模型；F-M-0140 上传端口；F-M-9000 安全 |

#### 做到最好

- 失焦：精致 `figure`，圆角、阴影克制、加载骨架、错误态图标+文案，**无**「只读」字样。  
- 聚焦/选中：块选中态（把手+极淡轮廓），**不是**整页源码模式；属性可在块菜单或 caption 行内编辑。  
- Markdown 主形态：`![alt](src "title")` 完整往返；可选宽度扩展可降级。  
- 空 src：占位「添加图片」，一键选择或粘 URL。  
- 与段落/列表混排不破坏 indent；拖块把手可重排。

#### 验收标准

- [ ] `![示意图](https://example.com/a.png "t")` 往返后 alt/src/title 语义等价  
- [ ] 空 image 块可插入，占位可点  
- [ ] 加载失败显示 error，不白屏，src 保留可改  
- [ ] 撤销插入图片恢复上一文档状态  
- [ ] pure-gfm 模式不写出非法扩展语法导致外站炸裂  
- [ ] 模块不落在 `editor.js` 内联 200+ 行

#### 宿主端口

| 端口 | 必须 | 说明 |
|------|------|------|
| `media.resolveUrl` | 建议 | 相对路径 / `attachment:` → 可 img 的 URL |
| `media.uploadImage` | 主路径上传必须 | 见 F-M-0140 |
| 无端口时 | — | 仍允许 **URL 粘贴** 与空块

#### 安全

- 协议白名单：`https:` `http:` `blob:` 相对路径 `attachment:`；可选受限 `data:image/*`。  
- **禁止** `javascript:`、`data:text/html`、svg 内嵌脚本执行路径。  
- `alt`/`title`/`caption` 一律文本转义，禁止 `on*` 属性。

---

### F-M-0110 · 拖放插入图片

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **模块主人** | `js/markdown-editor/media/drop-paste.ts` |
| **依赖** | F-M-0100 · F-M-0140 · F-M-9000 |

#### 做到最好

- 从系统文件管理器拖入一张或多张图片，落点指示清晰（块间隙高亮）。  
- 多文件：按顺序插入多个 image 块，共享一次历史事务（可整批撤销）。  
- 非图片文件：转交 F-M-0400 附件或 toast「将作为附件」。  
- 拖放时不抢浏览器打开文件导航（`preventDefault` 仅在编辑器命中区）。

#### 验收标准

- [ ] 拖入 png/jpg/webp/gif → 出现 loading → ready  
- [ ] 拖入超过 `maxUploadBytes` → 拒绝并 toast，不插坏块  
- [ ] 无 `uploadImage` → 明确提示，不静默失败  
- [ ] 拖入中 Esc / 删除 loading 块 → abort 上传  
- [ ] 拖到编辑器外不误拦整页 drop

#### 宿主端口

同 F-M-0140；`UploadContext.source = 'drop'`。

#### 安全

- 仅读 `File.type` + 扩展名双重校验；伪装扩展名以 magic 失败则 error。  
- 不自动执行任何可执行文件 drop。

---

### F-M-0120 · 粘贴剪贴板图片

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **模块主人** | `media/drop-paste.ts` |
| **依赖** | F-M-0100 · F-M-0140 |

#### 做到最好

- 截图工具 / 浏览器复制图片后 `Ctrl+V`，在光标块后插入 image。  
- 剪贴板同时有文字与图：策略冻结为 **优先图**（媒体面）或 **可配置** `paste.preferImage`；默认优先图当 `items` 含 `image/*`。  
- 粘贴中显示 blob 本地预览，上传完成后替换为正式 URL（历史合并为一条「粘贴图片」）。

#### 验收标准

- [ ] Windows 截图粘贴成功主路径  
- [ ] 纯文字粘贴不受影响（回归）  
- [ ] 上传失败：error 态 + 可重试；blob 可保留预览  
- [ ] IME composition 期间不误触发（中文输入回归）

#### 宿主端口

`uploadImage`，`source: 'paste'`。

#### 安全

- 粘贴 `text/html` 中的远程 img 不自动抓取上传；仅本地 `image/*` File/Blob。  
- 远程 URL 粘贴进文本仍走链接/段落，不强制变 image 块。

---

### F-M-0130 · 文件选择与替换

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **模块主人** | `media/picker.ts` + 块菜单 |
| **依赖** | F-M-0140 |

#### 做到最好

- slash「图片」/ 占位点击 / 块菜单「替换」→ 宿主 `beforePick` 通过后打开系统文件选择或自定义 picker。  
- 同时支持「粘贴 URL」次要入口（无上传也能用）。  
- 替换：同一 `blockId` patch `src`，不插新块，撤销可回旧图。

#### 验收标准

- [ ] slash `image` 可插入  
- [ ] 替换不改变 blockId  
- [ ] `beforePick` 返回 false 时不打开文件框  
- [ ] accept 限定 `image/*`（实现可列扩展名）

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `media.beforePick('image')` | 权限/配额门控 |
| `media.uploadImage` | 选中文件后 |
| 可选 `media.pickImage()` | 宿主自定义选择器，返回 File 或 url |

---

### F-M-0140 · 宿主上传端口（媒体统一）

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **模块主人** | `js/markdown-editor/ports/media.ts` + `index` 导出类型 |
| **依赖** | 无（底层契约） |

#### 做到最好

- 单一清晰契约，覆盖 image/video/audio/file。  
- 编辑器 **只** 调端口，不关心 S3/本地盘/ipfs。  
- Demo 提供 mock（`URL.createObjectURL` + 延迟），可一键模拟失败。  
- 支持 `AbortSignal`；块删除 / 新上传替换时 abort 旧请求。  
- 进度：可选 `onProgress`；无则 indeterminate skeleton。

#### 端口契约（规范，非实现代码）

| 方法 | 入参要点 | 返回要点 |
|------|----------|----------|
| `uploadImage` | `File`, `UploadContext` | `url`, 可选 `alt/width/height` |
| `uploadVideo` | 同上 | `url`, 可选 `poster` |
| `uploadAudio` | 同上 | `url`, 可选 `name` |
| `uploadFile` | 同上 | `url/href`, `name`, `mime`, `size` |
| `resolveUrl` | `ref`, `kind` | 可加载 URL（可异步） |
| `beforePick` | `kind` | `boolean` |

`UploadContext`：`kind` · `source: paste|drop|pick|replace` · `blockId?` · `signal?`。

`MountOptions.features`：

| 开关 | 默认 | 作用 |
|------|------|------|
| `media` | true | false 时隐藏 slash 媒体与 drop 上传 |
| `maxUploadBytes` | 建议 20MB | 超限拒绝 |
| `allowDataImage` | false | 是否允许 data:image |

#### 验收标准

- [ ] 类型导出可供宿主 TS 引用  
- [ ] 未注入 upload 时粘贴图 → 可理解 toast，无抛未捕获异常  
- [ ] mock 失败路径可演示  
- [ ] abort 后不写回过期 URL  
- [ ] 单测可用 fake ports，无需网络

#### 安全

- 编辑器侧预检 size/mime；宿主仍须二次校验。  
- 返回的 `url` 再走协议白名单，防端口被攻破写 `javascript:`。

---

### F-M-0150 · 客户端图片压缩

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | `media/compress.ts` |
| **依赖** | F-M-0140 |

#### 做到最好

- 上传前可选压缩：最大边长、质量、输出 jpeg/webp。  
- 用户可在设置/块菜单关闭压缩（保留原图，例如截图要像素级）。  
- 压缩进度与前后体积提示克制显示一次。  
- 压缩失败则回退原文件上传，不中断主路径。

#### 验收标准

- [ ] 5MB png 压后明显变小且可预览  
- [ ] 关闭压缩则原样上传  
- [ ] GIF 动画：**默认不压** 或压成静帧需明示  
- [ ] 压缩不在主线程长卡死（Worker 或分片，实现自选）

#### 宿主端口

- 可选 `media.compress?: (file) => Promise<File>` 完全接管。  
- 无则用编辑器内置默认策略（可关）。

#### 安全

- Canvas 读像素注意跨域污染；仅本地 File。  
- 不把压缩中间结果长期挂 `window`。

---

### F-M-0160 · 题注 / alt / 对齐

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `blocks/image/` |
| **依赖** | F-M-0100 |

#### 做到最好

- `alt`：无障碍与 SEO；空 alt 显式允许（装饰图）但属性存在。  
- `caption`：figcaption 可编辑；与 alt 可分离（caption 给人看，alt 给读屏）。  
- `align`：left / center / right；序列化策略写入扩展或丢弃（pure-gfm）。  
- 宽度：可选拖拽缩放；持久化策略明确（扩展语法或仅会话态）。

#### 验收标准

- [ ] 改 caption 失焦后 MD 含可还原信息或文档声明不序列化  
- [ ] 改 alt 往返  
- [ ] 对齐切换视觉正确，不跳页  
- [ ] 读屏：figure/img 名称合理

#### 安全

- caption 纯文本；禁止 HTML 题注。

---

### F-M-0170 · 灯箱（Lightbox）

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `ui/lightbox.ts` + CSS |
| **依赖** | F-M-0100 |

#### 做到最好

- 阅读态单击图片（或「放大」）进入灯箱：遮罩、居中大图、Esc/点击遮罩关闭。  
- 同文档多图可左右切换（键盘 ←/→）。  
- 焦点陷阱；关闭后焦点回原图。  
- `prefers-reduced-motion` 下无夸张缩放动画。  
- 编辑态双击不与「替换」冲突：约定单击选中、明确「预览」入口或修饰键。

#### 验收标准

- [ ] Esc 关闭  
- [ ] 焦点不落到遮罩后不可达控件  
- [ ] 坏链图不进空白灯箱  
- [ ] 移动窄宽可用（若宿主桌面 WebView 仍测缩放）

#### 宿主端口

- 可选 `media.openLightbox?.(items, index)` 完全自定义；无则内置。

#### 安全

- 灯箱 img 同源策略同白名单；不加载任意 HTML。

---

### F-M-0180 · 图片标注（Annotate）

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | `blocks/image/annotate/` |
| **依赖** | F-M-0100 · F-M-0140 |

#### 做到最好

- 轻量矩形/箭头/文字标注，导出为 **新图片**（上传）或 sidecar 坐标 JSON（二选一，产品冻结一种主路径）。  
- **推荐主路径**：烘焙成新图上传，MD 仍是一张 `![]()`，外站可读。  
- 标注会话可撤销；不污染全局 undo 到不可用。  
- 非目标：完整 Photoshop、多人实时涂鸦。

#### 验收标准

- [ ] 完成标注后 src 更新或可预览叠加  
- [ ] 取消标注不改原图  
- [ ] pure-gfm 读者至少看到最终像素结果（若烘焙）

#### 宿主端口

- `uploadImage` 提交烘焙结果。  
- 可选 `media.openAnnotator(file|url) => Promise<MediaUploadResult>`。

#### 安全

- 标注文本转义；导出 canvas 不带跨域脏数据时提示。

---

## 3. 视频（Video）

### F-M-0200 · 本地 / 直链 MP4 视频块

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `blocks/video/` |
| **依赖** | F-M-0140 · F-M-9000 |

#### 做到最好

- 块类型 `video`；阅读态原生 `<video controls playsinline preload="metadata">`。  
- **禁止**有声 autoplay。  
- Markdown 主形态：`@[video](url)` 或带 title；pure-gfm 降级为链接。  
- 上传走 `uploadVideo` 或 `uploadFile`+mime。  
- poster 可选；caption 可选。  
- 大文件：清晰 size 门控与 loading。

#### 验收标准

- [ ] `@[video](https://cdn.example.com/a.mp4)` 往返  
- [ ] 可播放（演示资源或 mock）  
- [ ] 无 autoplay  
- [ ] 失败态可读  
- [ ] slash `video` 可插

#### 宿主端口

`uploadVideo` / `uploadFile` / `resolveUrl`。

#### 安全

- 协议白名单同图；**禁止**把任意 URL 当 iframe。  
- 仅媒体 URL，不渲染远程 HTML 播放器页（除非 F-M-0210+ 白名单提供方）。

---

### F-M-0210 · YouTube 嵌入

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `media/providers/youtube.ts` |
| **依赖** | F-M-1010 · F-M-9000 |

#### 做到最好

- 识别常见 URL：`youtube.com/watch?v=` · `youtu.be/` · `youtube.com/embed/` · 短视频 `/shorts/`。  
- 渲染为 **沙箱 iframe** 或提供方卡片 +「在 YouTube 打开」；默认 privacy-enhanced `youtube-no-cookie` 若产品同意。  
- 序列化保留 **原始 watch URL**（可迁移、可阅读），不强制只存 embed URL。  
- 加载失败：缩略图占位 + 外链按钮，不白屏。

#### 验收标准

- [ ] 粘贴标准 watch 链接 → 识别为 youtube 视频块或 embed 子类型  
- [ ] iframe 带合理 sandbox / allow 属性  
- [ ] 往返不丢视频 id  
- [ ] 离线/屏蔽域名时降级链接

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `features.embedProviders.youtube` | 默认 true/false 由产品定；可关 |
| 可选 `media.rewriteProviderUrl` | 企业代理 |

#### 安全

- 仅允许 youtube 系 host 列表。  
- iframe：`sandbox` 最小权限；限制 `allow` 到必要（encrypted-media 等按需）。  
- 不执行 URL 内任意 query 脚本化。

---

### F-M-0220 · Bilibili 嵌入

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `media/providers/bilibili.ts` |
| **依赖** | F-M-1010 |

#### 做到最好

- 识别 `bilibili.com/video/BVxxxx`、`b23.tv` 短链（短链需宿主或 resolve，编辑器可保留原链 + 解析 BV）。  
- 使用官方播放器 embed 模式（//player.bilibili.com/…）白名单。  
- 中国大陆用户场景一等公民：错误文案中文化。  
- 序列化保留 BV 原链。

#### 验收标准

- [ ] BV 号链接可嵌入或降级  
- [ ] 非 bilibili host 不误判  
- [ ] 往返稳定  
- [ ] 可 feature flag 关闭

#### 宿主端口

`features.embedProviders.bilibili`；可选短链解析服务。

#### 安全

- host 白名单；iframe sandbox；不混用用户 HTML。

---

### F-M-0230 · Loom 嵌入

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | `media/providers/loom.ts` |
| **依赖** | F-M-1010 |

#### 做到最好

- 识别 `loom.com/share/...`；转官方 embed。  
- 与 YouTube 同级交互：失败降级为外链卡片。  
- 团队演示录屏场景友好。

#### 验收标准

- [ ] share 链接识别  
- [ ] flag 可关  
- [ ] 往返

#### 安全

同 F-M-0210 模式；仅 loom 域。

---

## 4. 音频（Audio）

### F-M-0300 · 音频块

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `blocks/audio/` |
| **依赖** | F-M-0140 |

#### 做到最好

- `@[audio](url)` 主形态；展示图标 + 标题 + 原生 controls。  
- 支持 mp3/wav/ogg/m4a（能播取决于 WebView）。  
- 上传 `uploadAudio`；拖入音频文件自动建块。  
- **不**做波形编辑器；可选简易时长显示（metadata）。  
- 不 autoplay。

#### 验收标准

- [ ] 往返 `@[audio](…)`  
- [ ] 可播放演示资源  
- [ ] 无上传端口时 URL 仍可用  
- [ ] 与 image drop 分流正确

#### 宿主端口

`uploadAudio` / `resolveUrl`。

#### 安全

协议白名单；不解析任意 HTML 音频页为 iframe。

---

## 5. 附件与文件芯片

### F-M-0400 · 附件卡片块 `attachment`

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `blocks/attachment/` |
| **依赖** | F-M-0140 · 宿主 `onOpenPath` |

#### 做到最好

- 块级卡片：图标（按 mime）+ 文件名 + 大小 + 类型副文案。  
- 语法：`@[file](path|url)` 可选 title / size 扩展。  
- 点击：`onOpenPath(href, { kind: 'attachment' })` 或下载；**不**在 Notebook 内打开源码（D14 精神一致）。  
- 拖入 pdf/zip/docx 等非媒体 → 本块，非 image。  
- pure-gfm：`[name](href)`。

#### 验收标准

- [ ] 往返 name/href  
- [ ] 点击回调 kind 正确  
- [ ] 大文件门控  
- [ ] 图标映射至少 pdf/zip/generic  
- [ ] 与 file_chip **互不串型**

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `uploadFile` | 本地附件入库 |
| `onOpenPath` | 打开/下载 |
| `resolveUrl` | 下载地址 |

#### 安全

- 路径 `..` 打开时由宿主防逃逸。  
- 可执行后缀（`.exe` 等）可警告或拒绝预览。  
- 不渲染 PDF 二进制进 MD。

---

### F-M-0410 · 文件芯片 `[[file:path]]`

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `inline/file-chip.ts` · 扩展文档 `extensions/conex-file-chip.md` |
| **依赖** | D14 · `onOpenPath` |

#### 做到最好

- 行内 pill；独占行可升块。  
- `[[file:src/a.ts|显示名]]` 往返。  
- 点击 → Files 面板，**禁止**当 Notebook 文档打开源码。  
- 路径规范化：`\`→`/`，去 `./`；控制字符拒绝。  
- 阅读态与对话流 ActionRow chip 视觉同源气质。

#### 验收标准

- [ ] 行内与块级往返  
- [ ] 点击 meta.kind = `file-chip`  
- [ ] 非法 path 不生成 atom  
- [ ] pure-gfm 降级为代码或链接  
- [ ] 与 `[[doc:]]` 不混淆

#### 宿主端口

`onOpenPath(path, { kind: 'file-chip', sourceBlockId? })`。

#### 安全

- 打开时宿主 resolve 工作区根；拒绝绝对盘符越权（桌面端）。  
- 编辑器不 `fetch` 文件内容。

---

## 6. TOC 与锚点

### F-M-0500 · 文内 TOC 块

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `blocks/toc/` |
| **依赖** | F-M-0520 |

#### 做到最好

- slash「目录」插入 `@[toc]` 或 `<!-- conex:toc -->`（实现冻结一种序列化）。  
- 阅读态自动列出 H 范围（默认 H2–H3，可配 min/max）。  
- 点击平滑滚动到锚点；当前节 `aria-current`（可选交叉观察）。  
- **不**把 items 序列进 MD（防脏 diff）；改标题 debounce 刷新。  
- 空文档：友好「暂无标题」。

#### 验收标准

- [ ] 插入后随 H1–H6 增删改更新  
- [ ] 点击跳转正确  
- [ ] 序列化无巨型列表残留  
- [ ] 键盘可操作链接

#### 宿主端口

可选 `onNavigateAnchor(anchor)`；默认编辑器内 scroll。

#### 安全

- TOC 文本来自标题纯文本，防 XSS。

---

### F-M-0510 · 侧栏 TOC 数据源

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `structure/toc-index.ts` |
| **依赖** | F-M-0520 |

#### 做到最好

- API：`getToc(): TocItem[]` 与/或 `onTocChange` 订阅。  
- 展示页/Notebook 侧栏只消费数据，不反解析 MD。  
- 与文内 TOC **同一算法**，避免两边不一致。

#### 验收标准

- [ ] 标题变更后 200ms 内数据更新  
- [ ] 重复标题 anchor 唯一  
- [ ] destroy 后无泄漏订阅

#### 宿主端口

侧栏 UI 属宿主；编辑器只供数据。

---

### F-M-0520 · 标题锚点稳定算法

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `structure/anchor.ts` |
| **依赖** | heading 块 |

#### 做到最好

- 中文友好 slug：保留 `\u4e00-\u9fff`、字母数字；空白变 `-`。  
- 空标题 → `section`；冲突 → `-1` `-2`。  
- DOM `id` 挂 heading 根；`[text](#anchor)` 站内可跳。  
- 默认 **不** 把 anchor 写进 MD（减噪）；P2 可 `anchorLock`。  
- 重命名标题锚点变化：文档说明即可。

#### 验收标准

- [ ] 「你好 World」→ 稳定可测 slug  
- [ ] 两节同名不冲突  
- [ ] `# 标题` 不与 tag 冲突（tag 见 F-M-0800）  
- [ ] hash 导航可测

#### 安全

- id 不含引号/空格注入；属性编码正确。

---

## 7. 面包屑（Breadcrumbs）

### F-M-0600 · 面包屑导航

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | 宿主壳 + 可选 `ui/breadcrumbs.ts` 插槽 |
| **依赖** | 宿主文档树 / 路径服务 |

#### 做到最好

- 编辑器 **不**臆造文件系统树；提供 **插槽或回调** 渲染面包屑。  
- 形态：`工作区 / 文件夹 / 当前文档`；末级当前页不可点或弱化。  
- 中间节点点击 → 宿主打开文件夹或父文档。  
- 与 Notebook 标题栏协调，不双标题打架。  
- 窄宽省略中间段（`…`），保留首尾。

#### 验收标准

- [ ] 无宿主数据时不显示错误空壳（隐藏或单级标题）  
- [ ] 点击回调路径正确  
- [ ] 长路径省略仍可悬停看全名  
- [ ] a11y：`nav` + 列表语义

#### 宿主端口

```
breadcrumbs?: {
  getPath(): BreadcrumbItem[];      // { id, label, href? }[]
  onNavigate(item): void;
  subscribe?(cb): () => void;       // 可选
}
```

#### 安全

- label 转义；href 仅宿主可信路由，不 `eval`。

---

## 8. Wiki 双链

### F-M-0700 · Wiki 链接 `[[doc:]]` / `[[ref:]]`

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `inline/wiki-link.ts` · `extensions/conex-wiki-link.md` |
| **依赖** | D15 · `onOpenDoc` / `onOpenPath` |

#### 做到最好

- 规范：`[[doc:标题]]`、`[[doc:标题|显示名]]`；kind 大小写不敏感，序列化小写。  
- 阅读态 wiki chip；点击打开文档。  
- 编辑态 atom 整粒删除；不可拆字。  
- v1 **要求** kind 前缀；裸 `[[标题]]` 默认关，flag `wikiBareLink` 才开。  
- 与 file_chip、md-link 三分清晰。

#### 验收标准

- [ ] 往返 target/label  
- [ ] 空 target 不匹配  
- [ ] 点击 kind=`wiki-link`  
- [ ] pure-gfm 降级可读  
- [ ] 长度上限（如 256）拒绝异常串

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `onOpenDoc(title)` | 文档 store |
| `onOpenPath(target, { kind:'wiki-link' })` | 统一入口亦可 |

#### 安全

- target 转义；禁止 `javascript:` 当 target 打开。  
- 不自动抓取外部 wiki HTML。

---

### F-M-0710 · Wiki 输入补全

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `ui/wiki-complete.ts` |
| **依赖** | F-M-0700 |

#### 做到最好

- 输入 `[[` 或 `[[doc:` 弹出补全列表（宿主供给候选）。  
- 键盘上下/Enter/Esc；鼠标点选。  
- 无候选：仍可自由输入标题。  
- 防抖；IME 结束后再过滤。

#### 验收标准

- [ ] 有 `wiki.suggest` 时列表出现  
- [ ] 无端口时不报错，可手写  
- [ ] 选择后插入合法 atom  
- [ ] Esc 关闭不插垃圾

#### 宿主端口

`wiki.suggest(query): Promise<{ title: string; subtitle?: string }[]>`  
可选 `wiki.recent()`。

#### 安全

- 候选 label 转义防 HTML 注入补全列表。

---

## 9. 标签（Tags）

### F-M-0800 · `#tag` 标签

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `inline/tag.ts` |
| **依赖** | 行内 marks 模型 |

#### 做到最好

- `#tag`、`#中文标签`、`#v3`；词边界正确。  
- **绝不**把 ATX 标题 `# 标题` 解析为 tag。  
- 渲染 `span.mdx-tag`；点击 `onTagClick(name)`。  
- serialize `#name`；name 不含 `#`。  
- 非目标 v1：标签后台、嵌套 `#a/b`、每标签色板。

#### 验收标准

- [ ] 与 heading 无冲突  
- [ ] 中文 tag 往返  
- [ ] 仅 `#` 不成 tag  
- [ ] IME 输入中文 tag 不撕裂  
- [ ] 点击回调

#### 宿主端口

`onTagClick?.(name)`；可选全局标签索引（宿主）。

#### 安全

- name 过滤控制字符；展示转义。

---

## 10. 出链与反链

### F-M-0900 · 出链枚举 API

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `api/outlinks.ts` |
| **依赖** | wiki / file / link / tag / attachment 解析完备 |

#### 做到最好

- `getOutlinks(): Outlink[]`  
- 每项：`kind` · `target` · `label?` · `sourceBlockId`  
- kind 含：`wiki-link` | `file-chip` | `md-link` | `attachment` | `tag` | 可选 `embed`  
- 供宿主保存时写索引；O(n) 可接受于常规文档。

#### 验收标准

- [ ] 样本文档出链数量与手工一致  
- [ ] 删除块后出链消失  
- [ ] 不抛异常于空文档

#### 宿主端口

宿主定时或 onChange 调用；编辑器不写盘索引。

#### 安全

- 返回数据为纯 JSON 可序列化字段，无 DOM 节点。

---

### F-M-0910 · 反链（Backlinks）宿主边界

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | **宿主** `backlinkIndex`；编辑器仅文档注释 + 出链 |
| **依赖** | F-M-0900 |

#### 做到最好

- **冻结**：内核 **无** 反链面板 DOM、无全库扫描。  
- 宿主：`updateDocument` / `removeDocument` / `getBacklinks(target)`。  
- 面板展示摘录、来源标题；点击 `onOpenDoc` + 可选 focus block。  
- 展示页：callout 说明责任，console 可打 getOutlinks 调试。

#### 验收标准

- [ ] 内核包内无反链面板硬依赖  
- [ ] 宿主 mock 可单测增量更新  
- [ ] 删文档无僵尸边  
- [ ] 编辑器 onChange 能驱动宿主更新

#### 宿主端口

完整索引服务属宿主；见架构 §1 表。

#### 安全

- 摘录纯文本截断；无 HTML 摘录注入。  
- 跨文档 path 仍走工作区沙箱。

---

## 11. 嵌入（Embeds）

### F-M-1000 · 链接卡片 Embed

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | `blocks/embed/` · `extensions/conex-embed.md` |
| **依赖** | F-M-9000 · 可选 meta 端口 |

#### 做到最好

- `@[embed](https://…)`；卡片：标题/描述/favicon。  
- 无 meta 时优雅降级为标题链接。  
- **默认不**任意 iframe；iframe 仅 F-M-0210+ 提供方。  
- OG meta **默认不写进 MD**（防脏 diff）。  
- feature `embed` 默认关可开。

#### 验收标准

- [ ] 往返 url + 可选 title  
- [ ] 无网络时不崩  
- [ ] http(s) only  
- [ ] 与 paragraph 裸 URL 策略文档化

#### 宿主端口

`embed.fetchMeta?(url) => { title, description, favicon? }`  
无端口：仅显示 URL/用户 title。

#### 安全

- 仅 http(s)。  
- favicon 必须 https 或 data 受控。  
- 不渲染返回 HTML 字段为 DOM（只用文本）。

---

### F-M-1010 · 媒体提供方白名单框架

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `media/providers/registry.ts` |
| **依赖** | F-M-9000 |

#### 做到最好

- 统一注册：detect(url) → providerId → render / serialize。  
- 内置：youtube · bilibili · loom（分期）；未知 → 普通 video/link。  
- 宿主可 `registerProvider`（可选高级）或纯 flag 开关内置。  
- 一处 CSP/sandbox 策略文档。

#### 验收标准

- [ ] 未知域名不进 iframe  
- [ ] 关闭某 provider 后降级链接  
- [ ] 单测：一组 URL fixtures

#### 安全

- 新 provider 必须过安全评审清单（host 列表、sandbox、隐私）。

---

## 12. Callout / Alert

### F-M-1100 · 提示块 Callout

| 字段 | 值 |
|------|-----|
| **优先级** | P0（基础 MD 体验） |
| **模块主人** | `blocks/callout/` · `extensions/conex-callout.md` |
| **依赖** | quote 块区分 |

#### 做到最好

- GitHub Alerts：`NOTE` `TIP` `IMPORTANT` `WARNING` `CAUTION`；扩展 `success` 等可映射。  
- 序列化默认 `> [!KIND]`；解析兼容 `:::` 容器但默认不写回 `:::`。  
- 自定义 title；正文可多段/列表。  
- 与普通 `quote` 严格分离。  
- 失焦精致色条/图标；聚焦可编辑；**无**双壳。  
- slash 可插各 kind。  
- 非目标：折叠 callout（toggle P2）、任意 HTML。

#### 验收标准

- [ ] 五种 GH kind 往返  
- [ ] 自定义 title 往返  
- [ ] 普通 `>` 不变 callout  
- [ ] 未知 kind 保留或降级策略稳定  
- [ ] 色与对比度 a11y 可接受

#### 宿主端口

无必须端口；主题 token 可覆盖。

#### 安全

- kind/title 转义；不允许 callout 内 raw HTML 脚本。  
- 图标 SVG 内置，不加载远程 icon URL。

---

## 13. 数据集（Datasets）

### F-M-1200 · 数据集块

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | `blocks/dataset/` |
| **依赖** | F-M-0400 精神 · 宿主数据预览可选 |

#### 做到最好

- 科研/表格数据附件一等块：名称、格式（csv/tsv/json/parquet 引用）、行数/列数摘要、更新时间。  
- MD 形态建议：`@[dataset](path-or-id "显示名")` 或扩展 fence 元数据（实现冻结一种）。  
- 阅读态卡片 +「预览/在分析面板打开」；**默认不**把整表 inline 进 MD。  
- 小 CSV（阈值上限，如 64KB）可可选展开为只读 table 预览；超限仅卡片。  
- 与普通 attachment 区别：语义是「可分析数据」而非任意二进制。

#### 验收标准

- [ ] 往返 id/path/name  
- [ ] 超大文件不 inline 炸文档  
- [ ] 点击回调 kind=`dataset`  
- [ ] pure-gfm 降级为链接  
- [ ] slash「数据集」可插

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `uploadFile` / `uploadDataset?` | 入库 |
| `dataset.preview?(ref)` | 返回 schema 摘要 { columns, rowCount } |
| `onOpenPath(..., { kind:'dataset' })` | 打开分析 UI |

#### 安全

- 不执行 CSV 中公式（无 Excel 公式引擎）。  
- 预览 HTML 全转义。  
- 路径逃逸同附件。  
- parquet 等二进制只作引用，不在浏览器乱解析除非宿主提供。

---

## 14. 实验日志（Experiment Log）

### F-M-1300 · 实验日志块

| 字段 | 值 |
|------|-----|
| **优先级** | P2 |
| **模块主人** | `blocks/experiment-log/` |
| **依赖** | callout 视觉语言 · 可选 AI 端口无关 |

#### 做到最好

- 面向科研/调参：一次实验一条结构化块。  
- 字段建议：`title` · `status`（running|success|failed|aborted）· `startedAt` · `endedAt` · `params`（key-value）· `metrics`（key-value）· `notes`（短 Markdown 或纯文本）· `runId`。  
- 序列化：Conex 扩展容器（如 `@[experiment]` + JSON 或 YAML fence），pure-gfm 降级为表格或列表摘要。  
- 阅读态：状态色点 + 参数/指标定义列表 + 笔记。  
- 编辑态：表单式编辑或源码态（单表面原则：失焦卡片，聚焦可编辑字段/源，**禁止**双壳两套 DOM 长期并存）。  
- 非目标：完整 MLflow；多 run 对比图表（可链到 F-M-1400）。

#### 验收标准

- [ ] 创建 run 卡片并往返核心字段  
- [ ] status 变更视觉正确  
- [ ] params/metrics 空态友好  
- [ ] 撤销可用  
- [ ] 展示页至少 1 个样例

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `experiment.list?(query)` | 补全历史 run |
| `experiment.open?(runId)` | 宿主实验平台 |
| 可选写入 | 宿主在外部系统创建 run 后 patch 块 |

#### 安全

- JSON/YAML 解析用安全子集（无自定义类型反序列化）。  
- notes 按 MD 子集渲染，禁脚本。  
- runId 当不透明字符串。

---

## 15. 图表（Charts，可选）

### F-M-1400 · 图表块（Chart.js / Vega 可选）

| 字段 | 值 |
|------|-----|
| **优先级** | P3 |
| **模块主人** | `blocks/chart/` + 动态 `import()` |
| **依赖** | 包体积策略 · F-M-9000 |

#### 做到最好

- 块内声明式配置；失焦渲染图，聚焦编辑 **源配置**（JSON/YAML），单卡片单表面。  
- 支持引擎 **可插拔**：默认不进主包；`features.chartEngine = 'chartjs' | 'vega' | 'none'`。  
- 数据：inline 小表或 `dataset` 引用（F-M-1200）。  
- pure-gfm：降级为代码块或数据表，外站仍可读数据。  
- 非目标：Excel 全功能透视；服务端渲染必须。

#### 验收标准

- [ ] flag 关闭时不加载 chart 库  
- [ ] 恶意超大配置拒绝渲染并提示  
- [ ] 往返配置不丢  
- [ ] reduced-motion 下动画可关  
- [ ] 动态 import 失败有降级

#### 宿主端口

| 端口 | 说明 |
|------|------|
| `chart.loadEngine?` | 宿主提供已打包的 Chart.js/Vega |
| `dataset.preview` | 取数 |
| 主题 | CSS 变量映射到图表色板 |

#### 安全

- **禁止** Vega 表达式任意 JS 若引擎允许；使用安全模式或仅 Chart.js 受限配置 DSL。  
- 不把用户字符串当 `eval`。  
- 远程数据 URL 白名单或仅宿主 fetch。  
- 库文件 SRI/本地打包，不默认 CDN 运行时（桌面可本地）。

---

## 16. 横切：安全 · 降级 · a11y

### F-M-9000 · 媒体安全基线

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **模块主人** | `media/security.ts` |

#### 做到最好

统一函数：`assertSafeMediaUrl(url, kind)` · `assertSafeOpenPath(path)`。

| 规则 | 要求 |
|------|------|
| 协议 | 允许 https/http/blob/相对/attachment；禁 javascript/vbscript/data:html |
| data:image | 可选；长度上限 |
| 路径 | 打开时宿主防 `..` 出工作区 |
| XSS | 一切用户字符串 textContent/转义 |
| iframe | 仅白名单 provider |
| 配额 | maxUploadBytes + 类型 |
| 隐私 | 外链 img 默认无额外 cookie 策略依赖浏览器；文档说明 |

#### 验收标准

- [ ] 安全 fixture 列表全拒/全过  
- [ ] 渗透式手工：粘贴 `javascript:` 进 src 被拒  
- [ ] iframe 未授权域名不出现

---

### F-M-9010 · pure-gfm 降级

| 字段 | 值 |
|------|-----|
| **优先级** | P1 |
| **模块主人** | `serialize` pure-gfm 模式 |

#### 做到最好

| 块 | pure-gfm 策略 |
|----|----------------|
| image | 标准 `![]()` |
| video/audio | `[视频/音频: name](url)` |
| attachment | `[name](url)` |
| file_chip | 链接或 `` `path` `` |
| wiki | 文本或普通链接 |
| toc | 省略或 HTML 注释 |
| embed | 链接 |
| dataset/experiment/chart | 表格/代码/链接摘要 |

降级 **不丢用户主数据链接**；允许丢视觉 props。

#### 验收标准

- [ ] pure-gfm 导出无未闭合扩展语法  
- [ ] 再经 conex 模式打开可接受损失范围文档化

---

### F-M-9020 · a11y 与动效

| 字段 | 值 |
|------|-----|
| **优先级** | P0 |
| **模块主人** | 各块 DOM + `css/markdown-editor/media.css` |

#### 做到最好

| 块 | a11y |
|----|------|
| image | alt 属性；灯箱焦点陷阱 |
| video/audio | 原生 controls 键盘 |
| attachment | button 可聚焦，名含文件名 |
| toc | nav+list |
| tag/wiki | 键盘激活 |
| callout | 区域 role/补 title |
| chart | 数据表后备或 aria 描述 |

动效：上传 skeleton 可关；`prefers-reduced-motion` 尊重。

#### 验收标准

- [ ] Tab 可到达主交互  
- [ ] 灯箱 Esc  
- [ ] 对比度抽检

---

## 17. Slash / 特性门控 / 解析优先级

### 17.1 Slash 命令（媒体结构）

| command id | 关键词（中/英） | feature 门控 |
|------------|-----------------|--------------|
| `insert.image` | 图片 image | `media` |
| `insert.video` | 视频 video | `media` |
| `insert.audio` | 音频 audio | `media` |
| `insert.attachment` | 附件 文件 | `media` |
| `insert.file_chip` | 文件芯片 file | `fileChip` |
| `insert.toc` | 目录 toc | `toc` |
| `insert.callout` | 提示 callout note warning… | 始终（基础） |
| `insert.embed` | 嵌入 embed | `embed` |
| `insert.dataset` | 数据集 dataset | `dataset` |
| `insert.experiment_log` | 实验 日志 experiment | `experimentLog` |
| `insert.chart` | 图表 chart | `chart` |

### 17.2 块级解析优先级（与扩展总册协调）

1. fence code（含 chart/vega 源、mermaid）  
2. 表格  
3. heading  
4. hr  
5. 扩展行：`@[video]` `@[audio]` `@[file]` `@[toc]` `@[embed]` `@[dataset]` `@[experiment]`  
6. 独占行 file/wiki  
7. list / quote / **callout**  
8. 单行 GFM image → image 块  
9. paragraph  

行内：code span → file_chip → wiki_link → md-link → tag → marks。

---

## 18. 分阶段交付（W6 切片）

| 切片 | 交付 F-ID | 出口标准 |
|------|-----------|----------|
| **W6-a** | 0100–0140 · 0160 · 0410 · 1100 · 9000 | 图+上传+chip+callout 演示全绿 |
| **W6-b** | 0170 · 0200 · 0300 · 0400 · 0500–0520 · 0700–0800 · 0900 | 灯箱、音视频附件、TOC、双链标签、出链 |
| **W6-c** | 0210–0230 · 1010 · 0910 文档 | 三方视频白名单；反链宿主说明 |
| **W6-d** | 0150 · 0180 · 0600 · 1000 · 1200 · 1300 | 压缩标注面包屑 embed 科研块 |
| **later** | 1400 · 0230 polish | 图表引擎可选 |

**规则**：W6-a 未金标准，不开科研花活当主路径宣称完成。

---

## 19. 模块所有权（禁止上帝文件）

| 路径（目标包内） | 主人 F-ID | 禁止写入 |
|------------------|-----------|----------|
| `blocks/image/**` | 0100–0180 | editor.js 内联渲染 |
| `blocks/video/**` | 0200 | 提供方解析 |
| `blocks/audio/**` | 0300 | — |
| `blocks/attachment/**` | 0400 | — |
| `blocks/toc/**` | 0500 | 锚点算法 |
| `blocks/callout/**` | 1100 | — |
| `blocks/embed/**` | 1000 | — |
| `blocks/dataset/**` | 1200 | — |
| `blocks/experiment-log/**` | 1300 | — |
| `blocks/chart/**` | 1400 | 默认不进主包 |
| `inline/file-chip.ts` | 0410 | — |
| `inline/wiki-link.ts` | 0700 | — |
| `inline/tag.ts` | 0800 | — |
| `media/drop-paste.ts` | 0110–0120 | — |
| `media/picker.ts` | 0130 | — |
| `media/compress.ts` | 0150 | — |
| `media/security.ts` | 9000 | — |
| `media/providers/**` | 0210–0230 · 1010 | 块文件内写死域名 |
| `structure/anchor.ts` | 0520 | — |
| `structure/toc-index.ts` | 0510 | — |
| `api/outlinks.ts` | 0900 | — |
| `ports/media.ts` | 0140 | 业务 UI |
| `ui/lightbox.ts` | 0170 | — |
| `ui/wiki-complete.ts` | 0710 | — |
| `ui/breadcrumbs.ts` | 0600 | 文档树数据 |
| `editor.ts` / `editor.js` | **仅编排** | 单文件业务 >400 行 |

Review agent：发现媒体逻辑堆进 `editor.js` → **直接打回**。

---

## 20. 测试矩阵（摘要 ID）

| 测试 ID | 覆盖 |
|---------|------|
| RT-M01 | image GFM 往返 |
| RT-M02 | video/audio `@[]` 往返 |
| RT-M03 | attachment vs file_chip 不串型 |
| RT-M04 | wiki label 往返 |
| RT-M05 | tag vs heading |
| RT-M06 | 重复标题 anchor |
| RT-M07 | callout 五种 kind |
| RT-M08 | pure-gfm 降级无致命残留 |
| RT-M09 | dataset/experiment 往返（有则测） |
| UX-M01 | 无 upload 粘贴图提示 |
| UX-M02 | upload reject error 态 |
| UX-M03 | TOC 随标题更新 |
| UX-M04 | 灯箱 Esc/焦点 |
| UX-M05 | YouTube/B 站 flag 关闭降级 |
| API-M01 | getOutlinks 完整 |
| API-M02 | getToc 一致 |
| SEC-M01 | javascript: 拒绝 |
| SEC-M02 | 非白名单 iframe 拒绝 |
| SEC-M03 | 路径 `../` 打开门控（宿主测） |

---

## 21. 宿主集成检查表（媒体结构）

| # | 项 | 完成 |
|---|----|------|
| 1 | 注入 `media.uploadImage`（及需要的 video/audio/file） | ☐ |
| 2 | 注入 `resolveUrl`（若用相对路径/attachment id） | ☐ |
| 3 | `onOpenPath` 区分 file-chip / attachment / dataset | ☐ |
| 4 | `onOpenDoc` / wiki-link | ☐ |
| 5 | 可选 `onTagClick` · `wiki.suggest` | ☐ |
| 6 | 保存时 `getOutlinks` → 反链索引 | ☐ |
| 7 | CSP 允许需要的 iframe 提供方 | ☐ |
| 8 | `maxUploadBytes` 与产品一致 | ☐ |
| 9 | Demo mock 上传失败开关 | ☐ |
| 10 | 面包屑数据源（若启用） | ☐ |

---

## 22. Showcase 必须样例

1. image ≥1 + mock 上传说明  
2. video 直链/占位 + 可选 YouTube 或 Bilibili 一条  
3. audio · attachment · `[[file:]]` 各一（分工可见）  
4. 文内 TOC + ≥3 标题（含中文重名测 anchor）  
5. `[[doc:]]` + `#tag` · 反链宿主责任 callout  
6. callout NOTE + WARNING  
7. P2 区：dataset / experiment-log；chart 仅 flag 开时出现  

---

## 23. W6 DoD

- [ ] 全部 **P0** F-ID 金标准 ≥4 分（00-master-index）  
- [ ] **P1** 主路径可演示或挂账  
- [ ] MediaPorts 写入集成契约并类型导出  
- [ ] 安全 fixture 签核；无上帝文件  
- [ ] pure-gfm 降级落实；README §3.5 可回填状态  

---

## 24. 旧文档映射与权威

| 本册 | 旧锚点 |
|------|--------|
| 0100–0180 | v3-complete/09 §4 · matrix M01–M05 |
| 0200–0300 | 09 §5–6 |
| 0400–0410 | 09 §7 · conex-file-chip |
| 0500–0520 | 09 §9–10 |
| 0700–0800 | 09 §11–12 · conex-wiki-link |
| 0900–0910 | 09 §13 |
| 1000–1010 | conex-embed + 本册提供方 |
| 1100 | conex-callout |
| 1200–1400 | 本册新增（P2/P3） |
| 0140 · 9000 | 09 §8 · 10-data-format |

**冲突以本分册 F-ID 为准。**

---

## 25. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-08-02 | W0 冻结：媒体全族、结构导航、双链标签反链、embed 提供方、callout、dataset、experiment-log、可选 chart；每 F-ID 含做到最好/验收/端口/安全/模块主人 |

---

*本册结束。F-ID 全表见 §0.5。调度回填 `00-master-index.md` §4 · README §3.5。W6 实现须 W1 行源码模型过门后启动。*
