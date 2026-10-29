# Markdown 安全防护、沙箱隔离与清洗防御体系深入评估报告

> **审查范围**：
> - `crates/conex-markdown/src/sanitizer.rs`, `ammonia_config.rs`, `renderer.rs` (Rust 内核清洗与 URL 判定)
> - `apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts`, `markdownPlugins.ts` (前端清洗与回退解析)
> - `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx` (文档视图挂载、路径与链接分发)
> - `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx` (增量渲染与 DOM 挂载)
> - `apps/crish-desktop/src/api/blockedExecutableExtensions.ts`, `host_openers/execute.rs` (可执行文件拦截门禁)
> - `apps/agent-workbench/src-tauri/tauri.conf.json`, `capabilities/default.json` (WebView2 权限与 CSP)
>
> **基准准绳**：完全立足于现有代码实现、测试用例与运行时配置事实，严禁掩饰缺点，着重揭露架构缺陷与防护短板。

---

## Executive Summary：核心裁决与缺陷速览

综合代码审查结论，我们软件在 Markdown 安全与清洗防御体系上的综合评定为 **C 级（过度防御与真实漏洞并存）**。

其核心问题在于：**架构上用“极端的误杀”掩盖了清洗管道设计能力的不足，却在最关键的桌面原生跳出、WebView2 导航控制和终端 Sink 挂载上留下了高危盲区。**

1. **富文本严重误杀（Over-Defense Tag Slaughtering）**：
   - 尽管 Rust 后端在 `ammonia_config.rs` 中精心配置了包含 41 个标签的白名单，但实际渲染管道（`renderer.rs`）**根本未启用全量 ammonia 清洗**；
   - 仅顶级 `<img>` 单独经过 ammonia，其余所有 raw HTML 标签（如 `<details>`, `<summary>`, `<kbd>`, `<mark>`, `<sub>`, `<sup>`, `<u>`, `<abbr>` 等）在进入管道瞬间即被一刀切强制转义为普通字符字面量；
   - 导致现代知识库与代码注释中极其常用的折叠日志、按键说明、文本高亮、上下标排版**100% 损坏失效**。
2. **终端 Sink 二次清洗被撤防（DOMPurify Removed）**：
   - 开发者误以为 Rust 已经做了安全清洗，在 `rustCore.ts` 与 `ammonia_config.rs` 中声明“组件层 DOMPurify 为冗余”并将其从 Markdown 渲染路径彻底移除；
   - 前端直接通过 `dangerouslySetInnerHTML` 和原生 `DOMParser` 将 HTML 挂载入主界面 DOM 树，**完全放弃了浏览器运行时的纵深防御（Defense-in-Depth）**。
3. **合法本地链接瘫痪与可执行文件防护盲区**：
   - Markdown 中标准的本地文件超链接 `[file link](file:///C:/...)` 因 scheme 拦截被直接判定为危险链接，粗暴转为不可点击的 `<span class="md-a-unsafe">`，合法本地知识引用完全不可用；
   - 在路径点击分发处（`MarkdownDocumentView.tsx`），派发 `crish-open-file` 事件前**漏掉了可执行后缀校验**；
   - 后缀黑名单 SSOT 存在致命盲区：拦截了 `.exe`, `.bat`, `.cmd`，但**漏防了 Windows 快捷方式 `.lnk`、注册表导入脚本 `.reg` 以及 Internet 快捷方式 `.url`**，仍存在被绕过拉起危险进程的可能。
4. **外链跳出并非 100% 隔离，相对路径会击垮 SPA**：
   - `openExternalUrl` 依赖于未经原生包装的 `window.open(url, '_blank')`，在 Tauri WebView2 中并不能保证 100% 脱离宿主并交由系统默认浏览器打开；
   - 容器点击拦截事件对相对路径超链接（如 `[readme](readme.html)`）**未执行 `e.preventDefault()`**，用户点击后会直接触发 WebView2 的页面级硬导航，直接造成 SPA 单页崩溃并引发白屏。

---

## 一、XSS 防护与清洗管道深度解剖

### 1.1 架构脱节：虚设的 ammonia 白名单与顶级单点清洗

在 `crates/conex-markdown/src/ammonia_config.rs:15-110` 中，代码定义了一个看似非常完善的全局 `Builder`：

```rust
// ammonia_config.rs:19-62
b.add_tags([
    "a", "abbr", "b", "blockquote", "br", "code", "del", "div", "em",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd", "li",
    "mark", "ol", "p", "pre", "q", "s", "small", "span", "strong", "sub",
    "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
    "wbr", "button",
]);
b.add_tag_attributes("abbr", ["title"]);
b.add_tag_attributes("q", ["cite"]);
b.add_tag_attributes("ol", ["start", "reversed"]);
```

然而，审视真正的渲染驱动代码 `crates/conex-markdown/src/renderer.rs`，会发现惊人的事实脱节：

```rust
// renderer.rs:204-209
// 不对全量输出做 ammonia 兜底:
// 渲染器已 escape 所有 raw HTML(仅顶级 `<img>` 在 handle_html 内单独 sanitize),
// 全量 ammonia 会 parse+reserialize,把 `&#39;`/`&quot;` 等实体按 HTML5 规则
// un-escape (双引号属性中的 `'`、文本中的 `"` 不需要转义),破坏 byte-for-byte 兼容。
post_process_void_elements(std::mem::take(&mut self.output))
```

```rust
// renderer.rs:299-315
fn handle_html(&mut self, html: &str) {
    let trimmed = html.trim_start();
    let in_list_or_heading =
        !self.list_stack.is_empty() || self.current_heading_level.is_some();
    if !in_list_or_heading && (trimmed.starts_with("<img") || trimmed.starts_with("<IMG")) {
        let sanitized = ammonia_config::sanitize(html);
        self.output.push_str(&sanitized);
    } else {
        escape_html_into(html, &mut self.output);
    }
}

fn handle_inline_html(&mut self, html: &str) {
    escape_html_into(html, &mut self.output);
}
```

#### 【代码事实揭露】
1. **白名单成为死代码**：`ammonia_config.rs` 中辛苦配置并维护的 41 个 HTML 标签白名单与属性集，**在整个 Rust 渲染链路中全部沦为摆设**；
2. **唯一生效范围**：ammonia 仅在 `trimmed.starts_with("<img")` 这一极其狭窄的单分支中被调用，用于清除 `<img>` 标签上的 `onerror` 等事件属性；
3. **退避根因**：开发者为了追求所谓的“byte-for-byte 兼容”（防止 ammonia 重构 HTML 序列化时将实体 `&quot;`、`&#39;` 解开导致单测断言失败），选择了**全面抹杀所有非 img 标签的极劣妥协策略**。

---

### 1.2 过度防御（Over-Defense）：正常富文本排版被无差别屠杀

在前端回退解析器 `apps/crish-desktop/src/api/markdown-render/markdownPlugins.ts:194-203` 中，同样贯彻了粗暴的行级转义逻辑：

```typescript
let html = text
  .split('\n')
  .map((line) => {
    const t = line.trim();
    if (protectedTokens.isWholeLine(t)) {
      return line;
    }
    return escapeHtml(line);
  })
  .join('\n');
```

由于无论是 Rust 主力引擎还是 TS Worker 回退引擎，都将除了代码块围栏、表格、图片和链接之外的 HTML 视为有害输入进行字符串 `escape`，这给 Markdown 的正常阅读排版带来了灾难性的误杀：

| 用户合法书写的 Markdown 内容 | 预期渲染效果 | 实际渲染结果（代码缺陷） | 业务与体验影响 |
| :--- | :--- | :--- | :--- |
| `<details><summary>查看构建日志</summary>日志详情...</details>` | 可折叠展开的手风琴控件 | `&lt;details&gt;&lt;summary&gt;查看构建日志...` | **致命**。长日志、大段 Traceback 无法折叠，严重撑爆界面排版 |
| `<kbd>Ctrl</kbd> + <kbd>C</kbd>` | 键盘按键胶囊风格外观 | `&lt;kbd&gt;Ctrl&lt;/kbd&gt; + &lt;kbd&gt;C&lt;/kbd&gt;` | **高**。快捷键说明丑陋不堪，完全丧失技术文档专业度 |
| `<mark>高风险操作，请谨慎执行</mark>` | 背景荧光高亮提示 | `&lt;mark&gt;高风险操作...&lt;/mark&gt;` | **高**。警示文案无法突出，直接削弱信息传达效果 |
| `H<sub>2</sub>O` / `O(N<sup>2</sup>)` | 化学式下标 / 复杂度上标 | `H&lt;sub&gt;2&lt;/sub&gt;O` / `O(N&lt;sup&gt;2&lt;/sup&gt;)` | **中**。算法与科研公式排版彻底崩解 |
| `<u>重点下划线</u>` | 带有下划线的文本 | `&lt;u&gt;重点下划线&lt;/u&gt;` | **中**。强调标注失效 |
| `<div align="center">居中文本</div>` | 文本水平居中排版 | `&lt;div align="center"&gt;居中文本&lt;/div&gt;` | **中**。徽章居中、标题居中等常规 Markdown 布局失效 |

**结论**：当前软件的“XSS 零漏洞”是以**彻底阉割 Markdown 规范对 Raw HTML 兼容能力为代价换取的虚假安全**。

---

### 1.3 客户端清洗二次撤防：DOMPurify 被错误剥离

现代桌面应用程序在渲染非受信任的 Markdown 内容时，无一例外遵循 **纵深防御（Defense-in-Depth）** 原则：
- **后端/解析阶段**：抽象语法树（AST）层级的标签与属性清洗；
- **前端/挂载阶段（Sink 点）**：在直接插入 DOM 之前，使用基于浏览器实际 DOMParser 上下文的 `DOMPurify` 进行兜底清洗，防御各种因字符编码畸变、DOM Clobbering 或 mXSS（Mutation XSS）引起的穿透。

然而，在我们的代码中发现了严重的自信冒进：

1. `apps/crish-desktop/src/api/rustCore.ts:202`：
   > `// 全部走 tokio::task::spawn_blocking，HTML 输出 byte-for-byte 兼容现有 CSS 选择器，`
   > `// ammonia 已在渲染末端 sanitize（组件层 DOMPurify 为冗余）。`
2. `crates/conex-markdown/src/ammonia_config.rs:7`：
   > `//! 一次到位 sanitize,移除组件层 DOMPurify (Stream C 工作)。`
3. `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:439`：
   ```tsx
   <div
     ref={containerRef}
     className={`md-rendered conex-markdown ${className || ''}`.trim()}
     onClick={handleClick}
     dangerouslySetInnerHTML={{ __html: html }}
   />
   ```
4. `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx:134`：
   ```tsx
   reconcileUnits(container, splitHtmlIntoUnits(html));
   ```
   其中 `splitHtmlIntoUnits` 内部直接调用 `new DOMParser().parseFromString(html, 'text/html')`，并未经过任何 DOMPurify 净化。

#### 【严重隐患断言】
- 前端开发者完全相信了“Rust ammonia 已经全局清洗过”的假定；
- 但如 1.1 节所证实，Rust 的 ammonia 仅处理了行首为 `<img` 的情况，根本没有对全量输出做 ammonia；
- 换言之，**整个渲染输出在到达 DOM 之前，完全没有任何成熟的 HTML Sanitizer 做全量语义树清洗**！一旦底层 `pulldown-cmark` 解析器出现任何状态机漏洞、或者代码围栏高亮、表格对齐处理中拼接了未转义的字符，该攻击向量将长驱直入，通过 `dangerouslySetInnerHTML` 在主窗口无阻碍执行。

---

### 1.4 特殊协议与内联矢量穿透风险

#### 1. SVG 远程载入与追踪探测
- **内联 `<svg>`**：被行级转义阻断，无法内联注入脚本；
- **光栅化与 SVG data URI**：`sanitizer.rs:31-34` 的 `DATA_IMAGE_RASTER_RE` 仅放行了 png/jpg/gif/webp/avif/bmp，`data:image/svg+xml` 被成功阻断；
- **外链 SVG（缺陷）**：
  在 `is_safe_img_src` 中，只要是以 `https?://` 开头即无条件判定为 safe：
  `![avatar](https://evil.attacker/probe.svg)` 将直接被输出为 `<img class="md-img" src="https://evil.attacker/probe.svg" />`。
  虽然 `<img>` 上下文中浏览器会禁用 SVG 内联 script，但在 WebView2 环境下，远程 SVG 可以通过 `@import`、外部字体和 CSS filter 发送带凭证的带外网络请求，被黑客用于探测内网拓扑、获取客户端公网 IP 及进行无感知的阅读打点追踪（Pixel Tracking）。

#### 2. `data:` 协议的配置断层
- 在 `ammonia_config.rs:101` 中：
  `b.add_url_schemes(["http", "https", "mailto", "data"]);`
  注释解释为：“ammonia 的 allowed_schemes 是 scheme 级别；data: 整体放行后由渲染器侧 is_safe_img_src 守门”。
- 这种“底层配置全面放行，指望上层每处手工调用单独把关”的做法属于典型的反模式。一旦新增了某种图表、LaTeX 宏包或思维导图插件直接调用了 `ammonia_config::sanitize`，`data:text/html,<script>alert(1)</script>` 将直接被 ammonia 判定合法而放行。

#### 3. `blob:` 协议的 CSP 与渲染器割裂
- 在 `sanitizer.rs` 中，`blob:` 因不属于 http/mailto/raster-data 而被 `is_safe_href` 和 `is_safe_img_src` 归类为危险 scheme；
- 然而在宿主 `apps/agent-workbench/src-tauri/tauri.conf.json:29` 的 CSP 中：
  `img-src 'self' data: blob: asset: ...; worker-src 'self' blob:; media-src 'self' data: blob: ...;`
  Tauri 宿主对 `blob:` 协议给予了高度信任。
- 这种前后端认知的脱节，导致前端由 Worker 或 Canvas 生成的合法安全 `blob:` 预览图像在 Markdown 中无法渲染；而一旦有其他 XSS 向量构造出 `blob:` 上下文，CSP 也无法形成有效拦截。

---

## 二、链接与本地文件系统安全隔离分析

### 2.1 `file:///...` 协议的处理机制与误杀

在 `crates/conex-markdown/src/sanitizer.rs` 中：
```rust
pub fn is_safe_href(url: &str) -> bool {
    // 检查是否有空白...
    // 仅放行 #锚点、https?://、mailto:
    for t in variants.iter() {
        if cfg.http_scheme_re.is_match(t) || cfg.mailto_scheme_re.is_match(t) {
            return true;
        }
    }
    // 任意变体带其它 scheme 一律拒绝 (file: 命中 ANY_SCHEME_RE)
    for t in variants.iter() {
        if cfg.any_scheme_re.is_match(t) {
            return false;
        }
    }
    true // 仅无 scheme 相对路径放行
}

pub fn is_local_path_ref(s: &str) -> bool {
    // 仅匹配 C:\, /, ~/, ./, ../, apps/, packages/, src/ 或特定源码扩展名
    if cfg.win_drive_re.is_match(t) { return true; }
    if t.starts_with('/') || t.starts_with("~/") || t.starts_with("./") || t.starts_with("../") { return true; }
    // ...
    false
}
```

#### 【执行流与缺陷事实】
当用户在 Markdown 中书写标准规范的本地超链接时，例如：
`[方案设计文档](file:///C:/Workspace/docs/design.pdf)`
1. `is_local_path_ref("file:///C:/Workspace/docs/design.pdf")`：
   由于其以 `file:` 开头，不匹配盘符前缀，也不匹配 `/` 或 `./`，返回 `false`；
2. `is_safe_href("file:///C:/Workspace/docs/design.pdf")`：
   由于其不是 `http` 或 `mailto`，命中了 `any_scheme_re`（`^[a-z][a-z0-9+.-]*:`），返回 `false`；
3. `renderer.rs:553` 的链接构建逻辑：
   ```rust
   if !is_safe_href(&url) {
       self.output.push_str("<span class=\"md-a-unsafe\">");
       self.link_kind = Some(LinkKind::Unsafe);
       return;
   }
   ```
   **该链接被强制渲染为 `<span class="md-a-unsafe">方案设计文档</span>`！**
4. **缺陷后果**：软件对合法规范的 `file:///` 协议采取了“一棒子打死”的态度，用户在 Markdown 中整理本地知识库、引用本机文档的正常诉求被彻底阻断。

---

### 2.2 本地可执行文件（.exe, .bat, .cmd）打开与拦截链路漏洞

#### 1. 点击事件委托处的门禁缺失（Missing Gatekeeper in Click Delegation）
在 `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:197-233` 中：

```tsx
// 3.2 拦截本地路径超链接微胶囊 (.md-path-link)
const pathBtn = target.closest('.md-path-link');
if (pathBtn instanceof HTMLElement) {
  e.preventDefault();
  e.stopPropagation();

  const rawPath =
    pathBtn.getAttribute('data-path') || pathBtn.textContent || '';
  const { cleanPath, line, col } = parsePathAndLocation(rawPath);
  if (cleanPath && !isExternalNavigableHref(cleanPath)) {
    onOpenPathRef.current?.(cleanPath);
    if (typeof window !== 'undefined') {
      // ... 构建 leafId 与 sessionId
      window.dispatchEvent(
        new CustomEvent('crish-open-file', {
          detail: { path: cleanPath, line, col, ... },
        })
      );
    }
  }
  return;
}
```

#### 【高危断层审计】
- **未做后缀拦截**：当用户点击一个指向本地危险脚本的路径按钮（例如 `[快速修复](C:\Workspace\scripts\danger.bat)`）时，`MarkdownDocumentView` **完全没有调用 `isBlockedExecutablePath(cleanPath)`**，直接向整个应用广播了 `crish-open-file` 事件并回调了 `onOpenPath`！
- **下游防线的脆弱性**：
  - 虽然在 `useChatSessionActions.ts:122` 和 `hostOpenersApi.ts:115` 中单独增加了 `isBlockedExecutablePath` 判断；
  - 但在应用的其他上下文（例如 `FilePreview.tsx` 或第三方集成组件）中，如果直接消费了 `crish-open-file` 事件并尝试以系统默认程序打开，危险脚本将被直接唤醒；
  - **组件自身没有形成闭环守卫，把安全防线的责任推给下游消费方，属于严重的不安全架构设计**。

#### 2. 黑名单 SSOT 存在关键漏网之鱼（Windows 攻击面盲区）
审视 `apps/crish-desktop/src/api/blockedExecutableExtensions.ts:12-33`：
```typescript
export const BLOCKED_EXECUTABLE_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'msi', 'ps1', 'vbs', 'com', 'sh', 'bin',
  'scr', 'pif', 'hta', 'jse', 'vbe', 'wsf', 'wsh', 'msc', 'jar',
] as const;
```

对照 Windows 系统的实际执行机制，发现其**遗漏了数个高危的可执行载体**：
1. **`.lnk`（Windows 快捷方式文件）**：
   黑客极常利用特制的 `.lnk` 文件通过传参调用 `cmd.exe` 或 `powershell.exe` 执行无文件落地攻击。黑名单未收录 `.lnk`，且在 Rust 侧 `execute.rs:54` 甚至有专门的 `open_with_shortcut` 分支；
2. **`.reg`（Windows 注册表脚本）**：
   一旦通过系统默认程序打开 `.reg` 文件，Windows 会弹出注册表合并提示，普通用户极易误点导致注册表被恶意纂改；
3. **`.url`（Internet 快捷方式）**：
   可利用 `URL=file://...` 或特定协议头触发本地代码执行（如 CVE-2023-36025）；
4. **带有宏的 Office 文档（`.docm`, `.xlsm`）**：
   宏病毒是企业内网勒索病毒最主要的传播介质之一，黑名单亦完全未包含。

---

### 2.3 外链跳转与 WebView2 内部直接导航防御

#### 1. `window.open` 并非真正的系统浏览器沙箱跳出
在 `MarkdownDocumentView.tsx:78-86` 中：
```typescript
function openExternalUrl(url: string): void {
  const sanitized = sanitizeUrlCandidate(url);
  if (!sanitized) return;
  if (!isSafeHref(sanitized) || !isExternalNavigableHref(sanitized)) return;

  if (typeof window !== 'undefined') {
    window.open(sanitized, '_blank', 'noopener,noreferrer');
  }
}
```

并在 `apps/crish-desktop/src/api/gitApi.ts:139` 中验证了开发者的妥协理由：
> `// 不用 @tauri-apps/plugin-shell：包可能未装，Vite 会静态解析 import 直接报错。`
> `window.open(GIT_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');`

#### 【严重缺陷揭露】
- **未走系统级 ShellOpen**：顶尖桌面应用（VS Code / Obsidian）跳转外链时，必须且只能走 OS 原生 IPC（如 Electron 的 `shell.openExternal` 或 Rust 的 `open::that` / `ShellExecuteW`），唤起操作系统的默认浏览器（如独立运行的 Chrome / Firefox）；
- **WebView2 弹窗风险**：在没有配置 `with_new_window_req_handler` 深度接管时，WebView2 执行 `window.open` 会尝试在 WebView2 内部新建一个 Webview 弹窗或在已有宿主内打开；
- **恶意站点仿冒与会话冒充**：如果恶意外部网页在当前桌面软件的窗口树内直接打开，攻击者可以通过构造高仿的登录界面欺骗用户，甚至利用 WebView2 共享的 Cookie 容器窃取未隔离的会话令牌。

#### 2. 相对路径无 `preventDefault` 导致 SPA 硬刷新崩塌
观察 `MarkdownDocumentView.tsx:236-267`：
```typescript
const anchor = target.closest('a');
if (anchor instanceof HTMLAnchorElement) {
  const href = anchor.getAttribute('href');
  if (href == null) return;
  const sanitized = sanitizeUrlCandidate(href);
  // ...
  if (isExternalNavigableHref(sanitized)) {
    e.preventDefault();
    e.stopPropagation();
    openExternalUrl(sanitized);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(sanitized) && !isSafeHref(sanitized)) {
    e.preventDefault();
    e.stopPropagation();
  }
  // 相对路径 / #锚点：保持既有默认行为（不外开）
}
```

#### 【逻辑漏洞】
- 当 Markdown 中存在一个普通的相对链接 `[本地文档](docs/api.html)` 时：
  - 它不是 `https?` 或 `mailto`，跳过了外部打开分支；
  - 它没有协议 scheme，跳过了危险协议拦截分支；
  - **最终没有调用 `e.preventDefault()`**！
- **破坏性后果**：用户点击该链接后，WebView2 会执行浏览器原生锚点/链接导航，导致主窗口整体跳转向 `http://localhost:5174/docs/api.html`。这会导致整个 React SPA 卸载、全局状态丢失、当前多轮对话与未保存的代码全部蒸发，屏幕直接呈现 404 白屏。

---

## 三、对比顶尖产品与安全等级定级

### 3.1 横向多维对比矩阵

| 对比维度 | VS Code (Markdown Preview) | Obsidian | Notion | 本产品 (Conex / Crish) |
| :--- | :--- | :--- | :--- | :--- |
| **沙箱隔离机制** | **最高（S级）**：运行在独立的 Out-of-Process Webview 中，严格限制在 `iframe sandbox="allow-scripts"`，禁用 Node.js/Electron API | **高（A+级）**：开启 Electron `contextIsolation`，主进程与渲染进程严格隔离，插件沙箱受限 | **高（A级）**：纯受控 Block 结构化渲染，完全消除裸 HTML 注入点 | **低（C级）**：在主窗口 WebView2 宿主内裸挂载 `dangerouslySetInnerHTML`，无 iframe 隔离，无沙箱子进程 |
| **Raw HTML 支持** | 允许基础安全标签，提供 4 档安全设置（严格模式、禁用脚本、允许安全脚本等） | 原生完美支持 `details`, `kbd`, `mark`, `sub`, `sup`，由 DOMPurify 精准清洗危险属性 | 业务建模替代 HTML（Callout, Toggle, Math Block），天然防注入 | **极端误杀**：除顶级 `<img>` 外全部粗暴转义为文本字面量，富文本功能全灭 |
| **清洗防御深度** | 双层清洗 + 虚拟协议 (`vscode-resource:`) 隔离本地资产 | AST 解析 + 前端 DOMPurify 严格终端清洗（纵深防御） | 无裸 HTML，AST 转换严格映射到 React 组件属性 | **单层且半途而废**：Rust ammonia 仅清洗 `<img>`，前端 DOMPurify 被主动弃用 |
| **外链跳转机制** | 强制弹窗警告，严格经由系统默认浏览器打开 | 拦截所有 `<a>` 点击，强制走 Electron `shell.openExternal` | 拦截外链，受控路由或调用系统浏览器 | 依赖不可靠的 `window.open`，WebView2 内部存在仿冒与截留风险 |
| **相对路径处理** | 在 Webview 内部转换为虚拟资源或定位到内部文档编辑器 | 智能识别并定址到库内（Vault）对应 Markdown 笔记 | 内部转换为页面引用 Block，绝不触发现代硬跳转 | **无 preventDefault**，点击直接导致主窗口 SPA 崩塌白屏 |
| **本地文件执行防护** | 无法通过 Markdown 链接直接执行任何本地二进制程序 | 限制协议，禁止唤起本地危险脚本并给予安全警告 | 完全脱敏，无本地拉起路径 | 依靠有限扩展名黑名单，**遗漏 `.lnk`, `.reg` 等载体**，且组件层分发漏守门 |

---

### 3.2 本软件安全等级定级：C 级

我们给出 **C 级（纸面激进、架构粗糙、体验受损、隐患丛生）** 的客观定级判定：

```
S 级 (VS Code / 严格进程沙箱与细粒度权限控制)
  ▲
A 级 (Obsidian / Notion: 富文本表达力与纵深防御高度兼顾)
  ▲
B 级 (Typora / GitHub.com: 完整 HTML 清洗，体验良好，外链与文件规范跳出)
  ▲
C 级 (本软件: 架构过度转义导致正常语法全毁，但桌面跳出与 Sink 点却严重缺乏防御) ◄── [当前评级]
  ▲
D 级 (完全无防御、直接注入 XSS、任意执行可执行文件)
```

---

### 3.3 架构权衡代价（Trade-off）剖析

1. **以“牺牲所有现代排版功能”换取代码实现的简单化**：
   - 团队为了避免处理 HTML5 完整的 AST 重建与实体序列化冲突，直接用 `escape_html_into` 把一切非 img 的 HTML 拍扁；
   - 这种做法使得开发者不用去解决复杂的标签配对和 XSS 过滤算法，但代价是把技术文档中不可或缺的 `<details>`（日志折叠）、`<kbd>`（按键指导）全部变成乱码般的字符，软件的 Markdown 排版水平直接退化到 20 年前；
2. **“假定后端已清洗”带来的防线撤空**：
   - 前端架构师误读了 Rust 后端的能力边界，在 `rustCore.ts` 中错误地废黜了 `DOMPurify`；
   - 结果导致前端直接裸用 `dangerouslySetInnerHTML`，打破了“永远不要相信任何上游输入”的零信任安全铁律；
3. **“Web 思维”移植到“桌面原生”的水土不服**：
   - 将网页端的 `window.open` 原样搬到 Tauri 桌面端，既没有对接 Tauri 原生的系统 Shell 打开命令，也没有利用 WebView2 的原生窗口生命周期拦截机制；
   - 造成了外链可能在应用内加载、内链点击直接让工作台白屏的业余表现。

---

## 四、根本性整改架构建议（非补丁方案）

针对上述深层次架构缺陷，提出以下系统性治理重构路线：

```
[原始 Markdown 输入]
       │
       ▼
[pulldown-cmark 事件流 (Rust)]
       │
       ├─► 允许合法的富文本块: details, summary, kbd, mark, sub, sup
       │
       ▼
[ammonia 统一整树清洗 (Rust)] ──► 真正全量执行白名单标签与属性净化 (废黜单点 img 兜底)
       │
       ▼
[前端接收 HTML 字符串]
       │
       ▼
[DOMPurify 终端 Sink 二次净化 (TS)] ──► 恢复前端纵深防御，封死 mXSS 与 DOM Clobbering
       │
       ▼
[挂载与交互拦截中枢]
       │
       ├─► 本地路径 (.md-path-link): 强制前置 isBlockedExecutablePath 校验
       ├─► file:/// 协议: 正确解析为本地安全只读定址，禁止判定为 unsafe
       ├─► 相对路径 (a[href]): 必须调用 e.preventDefault()，拦截内部硬刷新
       └─► 外部链接 (https/mailto): 严格调用 Tauri invoke('workbench_open_external_browser')
```

1. **重构 Rust 后端清洗管道**：
   - 彻底废黜 `handle_html` 和 `handle_inline_html` 中的暴力 `escape_html_into`；
   - 允许 `details`, `summary`, `kbd`, `mark`, `sub`, `sup`, `u`, `abbr` 进入输出树；
   - 在 `Renderer::render()` 终点统一跑一次 `ammonia_config::sanitize()`，通过配置调整实体序列化行为，而非绕开它；
2. **恢复前端 DOMPurify 终端防御**：
   - 在 `MarkdownDocumentView.tsx` 与 `ReconciledMarkdownHtml.tsx` 中，重新引入轻量级 DOMPurify 配置，作为挂载到 `dangerouslySetInnerHTML` 之前的最后一道不可逾越之墙；
3. **重写链接点击拦截与外链调度器**：
   - 在 `MarkdownDocumentView.tsx` 中，对所有 `<a>` 标签一律执行 `e.preventDefault()`，杜绝 WebView2 内部跳转导致的 SPA 白屏；
   - 在 Tauri 侧通过 Rust `open::that` 实现受控的 `open_external_in_system_browser` IPC，废弃存在安全隐患的 `window.open`；
   - 补齐 `BLOCKED_EXECUTABLE_EXTENSIONS` 中的 Windows 高危攻击载体（`.lnk`, `.reg`, `.url`, `.docm`）。
