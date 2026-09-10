# SCOUT · §7 渲染纪律与 XSS 面收敛（只读摸查）

> 依据：`docs/audit/SYSTEMATIC-FIX-PLAN.md` §7 + §0.3；交叉 `AGENTS.md` §21、`BATCH-08-14-review.md` / `BATCH-15-21-review.md` / `BATCH-22-27-review.md`、`SUMMARY.md`。  
> 范围：只读摸查，**禁止落地修复**。本文件记录涉及路径、现状差距、建议改法与风险。  
> 摸查时刻：2026-09-08（America/New_York）。

---

## §7 原文要点（对照）

1. `MarkdownDocumentView` 保持「上游消毒 + 单一渲染出口」；外链导航统一走 `sanitizeUrlCandidate`（大小写/协议一致），删除组件内另一套 `startsWith` 启发式轨。  
2. Tiptap 粘贴：DOMPurify 配置显式禁止未知协议；补回归单测，防止配置回退。  
3. GFM emoji 短码：默认关闭或与 AGENTS §21 对齐为同一开关；禁止「UI 禁 Emoji + 渲染器自动插入 Emoji」双轨。  
4. 技能预览等设置页继续只走 `MarkdownDocumentView`，禁止回潮 `dangerouslySetInnerHTML`。

---

## 7.1 MarkdownDocumentView URL 消毒 / 外链导航单轨

### 涉及文件

| 角色 | 路径 |
|------|------|
| 文档呈现 SSOT | `apps/crish-desktop/src/components/ui/MarkdownDocumentView.tsx` |
| 组件契约测试 | `apps/crish-desktop/src/components/ui/MarkdownDocumentView.test.tsx` |
| URL 消毒原语 | `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts` |
| 消毒单测 / 对抗测 | `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.test.ts`、`markdownSanitizer.adversarial.test.ts` |
| 上游写 href/src | `apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts`（`renderLinkFromDest` / `renderImgFromDest` → `isSafeHref` / `isSafeImgSrc` + `sanitizeUrlCandidate`） |
| 同步门面 | `apps/crish-desktop/src/api/markdownRender.ts`（`parseMarkdownToHtml`） |
| 异步/Rust 入口 | `apps/crish-desktop/src/api/markdownRenderAsync.ts`（`useAsyncMarkdownHtml`） |
| 其它消费方（同出口） | `apps/crish-desktop/src/components/files/FilePreview.tsx`、`settings-skills/SkillDetailPreview.tsx` |
| 对话流平行 sink（相关面，非 MDView） | `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`（`el.innerHTML = html`，同源 HTML 管线） |

### 现状

- **上游消毒已较完整**：`markdownPlugins` 写 `<a class="md-a" href=…>` 前走 `isSafeHref`；不安全链降级为 `<span class="md-a-unsafe">`；`sanitizeUrlCandidate` + `urlSafetyVariants` 覆盖控制符 / 百分号解码走私；单测与 adversarial 覆盖面较好。  
- **渲染出口**：`MarkdownDocumentView` 对上游 HTML 使用 `dangerouslySetInnerHTML`，组件内**无二次 sanitize**（与 `BATCH-15-21-review`「依赖上游」一致）。  
- **外链点击双轨（差距核心）**：`handleClick` 仍用大小写敏感启发式：

```text
href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')
```

  命中才 `preventDefault` + `openExternalUrl`（内部直接 `window.open`，**不再**调 `sanitizeUrlCandidate` / `isSafeHref`）。  
- `isSafeHref` 对 http(s)/mailto 使用 **大小写不敏感** 正则（`/^https?:\/\//i`、`/^mailto:/i`），与点击轨不一致 → 例如 `HTTPS://…` 可能被上游放行写入 href，但点击轨不拦截，落入 WebView 默认导航。  
- 测试：`MarkdownDocumentView.test.tsx` 仅覆盖小写 `https://example.com/doc`；**无**大小写 / 未知 scheme / 未复用 sanitizer 的回归。

### 差距相对 §7.1

| 项 | 状态 |
|----|------|
| 上游消毒 + 单一 HTML 出口 | 基本满足（出口仍是 innerHTML，靠上游） |
| 外链导航统一 `sanitizeUrlCandidate`（大小写/协议一致） | **未满足**（独立 `startsWith` 轨） |
| 删除组件内启发式轨 | **未删除** |

### 建议改法（仅建议，本 scout 不落地）

1. 点击外链时：先 `sanitizeUrlCandidate(href)`，再用 **同一** `isSafeHref`（或抽出 `isExternalNavigableHref`）判定；通过则 `openExternalUrl(sanitized)`，否则 `preventDefault` 并忽略。  
2. 删除 `startsWith('http://'|'https://'|'mailto:')` 启发式，避免与 sanitizer 大小写/协议语义分叉。  
3. 补回归：`HTTPS://`、`MAILTO:`、已消毒安全链、以及「unsafe 不应 window.open / 不应默认导航」；可与 `markdownSanitizer` 用例共用 fixture。  
4. （可选加固）对 `dangerouslySetInnerHTML` 增加轻量出口断言或 debug 下二次过白名单，但须避免双轨消毒逻辑分叉——优先加固上游 + 点击单轨。

### 风险

- **安全**：大小写 scheme / 未 `preventDefault` 时默认导航 → WebView 内打开或意外协议处理。  
- **改动**：统一到 `isSafeHref` 后，相对路径 / `#锚点` / 本地 `md-path-link` 按钮路径须保持现有分支优先级，避免误把路径链当外链 `window.open`。  
- **回归面**：FilePreview / 技能预览 / 文档模式共用 `MarkdownDocumentView`，一点击逻辑全站生效。

---

## 7.2 Tiptap 粘贴 DOMPurify（显式禁未知协议 + 回归测）

### 涉及文件

| 角色 | 路径 |
|------|------|
| 粘贴清洗实现 | `apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts`（`handlePaste` → `DOMPurify.sanitize`） |
| 编辑器挂载/注释 | `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx` |
| 现有单测 | `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.test.tsx`（约 L261：剥离 `script` / `style`） |
| 依赖 | `apps/crish-desktop/package.json` → `dompurify` `^3.4.12` |

### 现状

当前配置（摘录语义）：

- `FORBID_TAGS`：script/style/iframe/object/embed/form/link/meta/img/video/audio/source/input/button/textarea（较全）。  
- `FORBID_ATTR`：仅 `style` / `onerror` / `onload` / `onclick`。  
- **未**设置 `ALLOW_UNKNOWN_PROTOCOLS: false`，**未**设置显式 `ALLOWED_URI_REGEXP`，**未**对 `href`/`src` 的 `javascript:` 做专用断言。  
- 单测只验证 script 剥离与样式相关行为；**无**未知协议 / `javascript:` href 回归（与 `BATCH-22-27-review` B24-5 一致）。

### 差距相对 §7.2

| 项 | 状态 |
|----|------|
| DOMPurify 已接入粘贴 | 已满足 |
| 配置显式禁止未知协议 | **未满足**（依赖 DOMPurify 默认 URI 行为） |
| 防配置回退的回归单测 | **不足** |

### 建议改法

1. 在 `DOMPurify.sanitize` 选项中显式：`ALLOW_UNKNOWN_PROTOCOLS: false`；必要时收紧 `ALLOWED_URI_REGEXP`（仅 `https?` / `mailto` / 相对路径，按产品是否允许 ftp/tel 决策一次写死）。  
2. 评估是否将 `href`/`src` 相关危险模式纳入契约测试，而不是只靠 `FORBID_ATTR` 事件名黑名单。  
3. 回归单测建议夹具：  
   - `<a href="javascript:alert(1)">` → 无 javascript 可导航残留；  
   - `<a href="HTTPS://example.com">` 行为符合策略；  
   - 未知协议 `foo:bar`；  
   - 配置项被误删时测试失败（把关键选项抽成命名常量 `TIPTAP_PASTE_DOMPURIFY_CONFIG` 便于断言快照）。  

### 风险

- **过严**：误杀合法相对链接 / 内部自定义 scheme（若产品有）。  
- **过松**：继续依赖默认值，DOMPurify 大版本升级或选项被「简化」时静默回退。  
- **产品**：粘贴清洗过猛可能导致用户从浏览器复制的富文本格式丢失（已 forbid img 等，需与产品预期一致）。

---

## 7.3 GFM emoji 短码 vs AGENTS §21

### 涉及文件

| 角色 | 路径 |
|------|------|
| 产品铁律 | `AGENTS.md` §21.2「全系统界面杜绝任何 Emoji 字符」；变更记录亦指向 §21 |
| 方案不变量 | `SYSTEMATIC-FIX-PLAN.md` §0.3、§7.3；附录 A「GFM emoji vs 禁 Emoji」 |
| 审计源 | `docs/audit/BATCH-08-14-review.md`（BATCH-09 中等项）、`SUMMARY.md` |
| Rust 默认开启翻译 | `crates/conex-markdown/src/renderer.rs`：`handle_text` → `translate_gfm_emoji`；`lookup_gfm_emoji` / `translate_gfm_emoji`；单测含 `:rocket:`→🚀 等 |
| crate 导出 | `crates/conex-markdown/src/lib.rs` |
| JS 镜像字典 + 无条件翻译 | `apps/crish-desktop/src/api/markdown-render/markdownInlineFormat.ts`（`GFM_EMOJI_MAP`、`translateGfmEmoji`；`formatMarkdownTextSegment` 内 **无开关** 调用） |
| JS 管线引用 | `apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts` |
| 对话注入点 | `MarkdownBlockItem` / `MarkdownDocumentView` 均消费同一渲染管线输出 → UI 可见 Emoji |

### 现状

- AGENTS §21：**绝对杜绝** UI 中的 Emoji；图标走 Lucide / 资产。  
- 渲染器：**默认且无门闩**地把 GFM 短码译成 Unicode Emoji（Rust 主路径 + JS fallback/镜像）。  
- 前后端字典宣称「100% 镜像同步」，但策略层与产品纪律冲突（纪律关、实现开）。  
- 未见统一的「emoji 短码开关」与 AGENTS / 设置 SSOT 接线；门禁脚本是否扫描渲染输出未在本 scout 中证实已挂入 `check:desktop`。

### 差距相对 §7.3

| 项 | 状态 |
|----|------|
| 与 §21 对齐为同一开关 / 默认关 | **未满足**（默认开、无开关） |
| 禁止「UI 禁 Emoji + 渲染器自动插入」双轨 | **仍冲突** |

### 建议改法

1. **默认关闭** `translate_gfm_emoji` / `translateGfmEmoji`（推荐，直接对齐 §21）。  
2. 若产品坚持短码：单一设置项（例如 `appSettings.markdown.gfmEmojiShortcodes`，默认 `false`），Rust IPC 与 JS fallback **共读同一默认**；禁止仅一端关闭。  
3. 更新 BATCH/AGENTS 措辞与门禁：对「渲染 HTML 含 emoji 短码产物」或「`:name:` → emoji 映射表在默认配置下被调用」做守卫；§8 亦要求 `conex-markdown` 与前端快照同决策。  
4. 调整/反转现有 Rust 单测期望：默认路径断言短码保留为文本，开启开关后再断言翻译。

### 风险

- **内容兼容**：历史会话 / 技能文档中的 `:white_check_mark:` 将不再自动变图标（符合禁 Emoji 纪律，但视觉变化需产品知情）。  
- **双端漂移**：只改 JS 或只改 Rust → 异步 worker 与 sync fallback 表现不一致（§8 已点名）。  
- **字典维护成本**：若保留开关，需继续维护 JS↔Rust 镜像，否则 parity 测试会红。

---

## 7.4 技能预览只走 MarkdownDocumentView（禁回潮 innerHTML）

### 涉及文件

| 角色 | 路径 |
|------|------|
| 预览 UI | `apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx` |
| Tab 装配 | `apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.tsx` |
| 状态聚合 | `apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.ts` |
| 残留 HTML 计算 | `apps/crish-desktop/src/components/settings-skills/useSkillEditor.ts`（`previewHtml = parseMarkdownToHtml(md)`） |
| 设置态测试 mock | `apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.test.tsx`（仍 mock `parseMarkdownToHtml`） |
| 渲染 SSOT | `MarkdownDocumentView` + `api/markdownRender.ts` |

### 现状

- **正向（已落地）**：`SkillDetailPreview` 预览分支使用 `<MarkdownDocumentView content={skillContent} … />`；设置技能区 **无** 直接 `dangerouslySetInnerHTML`（与 `BATCH-22-27` B26-5 / `SUMMARY`「技能预览去 dangerouslySetInnerHTML」一致）。  
- **残留双轨**：`useSkillEditor` 仍 `useMemo` 计算 `previewHtml`（同步 `parseMarkdownToHtml`），经 `useSkillsSettingsState` → `SkillsSettingsTab` 传入 `SkillDetailPreview`；接收侧写为 `previewHtml: _previewHtml` **未使用**。  
- 即：运行时 XSS 面已收敛到 MDView，但 **死参数 + 每次选中仍同步解析 HTML** 的伪连通/双轨残留仍在，违背方案「杜绝双轨/兼容层残留」精神，也增加回潮风险（未来有人再次 `dangerouslySetInnerHTML={{ __html: previewHtml }}`）。

### 差距相对 §7.4

| 项 | 状态 |
|----|------|
| 预览只走 MarkdownDocumentView | **运行时满足** |
| 禁止回潮 dangerouslySetInnerHTML | **当前满足**（无 sink） |
| 清除旧 HTML 预览轨 / 死代码 | **未满足**（`previewHtml` 链仍在） |

### 建议改法

1. 删除 `previewHtml` 计算与全链路 prop（`useSkillEditor` / `useSkillsSettingsState` / `SkillsSettingsTab` / `SkillDetailPreview`）。  
2. 测试改为断言渲染 `MarkdownDocumentView`（或 content 组装），去掉对 `parseMarkdownToHtml` 的无意义 mock。  
3. 可选门禁：`settings-skills/**` 禁止 `dangerouslySetInnerHTML`；禁止除 MDView 外的 markdown HTML 字符串 prop。

### 风险

- 删除死 prop 属低风险重构；注意测试与类型导出更新。  
- 若有外部/ Storybook 依赖 `previewHtml` 需一并清理（本摸查未发现其它生产消费方）。

---

## 总览：差距矩阵

| §7 子项 | 主要差距 | 严重度（相对 §7 目标） |
|---------|----------|------------------------|
| 7.1 外链导航单轨 | MDView 点击 `startsWith` 与 `sanitizeUrlCandidate`/`isSafeHref` 分叉；缺大小写回归 | **中（P2 级，审计已记）** |
| 7.2 DOMPurify 协议显式化 | 无 `ALLOW_UNKNOWN_PROTOCOLS: false`；无协议回归测 | **低～中（B24-5）** |
| 7.3 GFM emoji vs §21 | 默认开启短码→Emoji，与禁 Emoji 铁律冲突 | **中（P1，BATCH-09）** |
| 7.4 技能预览 | 运行时已 MDView；`previewHtml` 死轨残留 | **低（防回潮/双轨清理）** |

---

## 明确不在本 scout 落地的事项

- 不修改任何业务/测试代码。  
- 不改 AGENTS / 门禁脚本接线（仅建议）。  
- 不处理 §8 `conex-markdown` HR/CJK 等并行议题（仅在 7.3 风险中交叉引用）。  
- 对话 `MarkdownBlockItem.innerHTML` 与 MDView 同属「上游消毒 + sink」模型，完整收敛可并入 7.1/上游 hardening，但不扩展为本文件修复范围。

---

## 证据索引（只读）

- 计划：`docs/audit/SYSTEMATIC-FIX-PLAN.md` L141–146（§7）、L23–26（§0.3）、附录 A GFM 行。  
- 铁律：`AGENTS.md` §21.2。  
- 审计：`BATCH-15-21-review.md`（外链 startsWith）、`BATCH-22-27-review.md` B24-5 / B26-5、`BATCH-08-14-review.md` BATCH-09 emoji、`SUMMARY.md` 相关条。  
- 代码：上文各「涉及文件」路径（2026-09-08 工作区只读核对）。
