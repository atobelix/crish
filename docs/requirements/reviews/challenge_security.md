# Tiptap Migration Security & Edge Case Challenge Report

## 1. 边界情况与功能漏洞 (Edge Cases)
- **IME 50ms 竞争条件不可靠**：需求中设计使用 50ms 的硬编码定时器 (`isComposingJustEndedRef`) 配合 `compositionend` 来拦截回车键发送，这在系统负载高或 WebView2 线程调度延迟时非常脆弱。延迟超过 50ms 就会导致误发消息。**建议**：应依赖事件队列顺序或更稳定的键盘事件 `isComposing` 属性进行拦截，而非单纯的时间窗口。
- **深层嵌套与超大负载粘贴**：文档中没有提到对用户粘贴内容的体积与嵌套深度进行限制。粘贴数兆字节的文本或极深的列表可能导致 `tiptap-markdown` 序列化引擎或 350ms 存储防抖机制引发 UI 线程阻塞 (DoS)。**建议**：加入粘贴内容的 Payload 大小与嵌套深度截断策略。
- **Tauri 窗口关闭的草稿丢失风险**：在桌面端应用中，依赖浏览器的 `beforeunload` 来触发防抖草稿保存（flush）不够安全。如果宿主直接强杀或快速关闭窗口，草稿可能来不及落盘。**建议**：必须监听 Tauri 原生的 `tauri://close-requested` 生命周期事件以确保草稿同步落盘。

## 2. IPC 通信伪造 (IPC Communication Forgery)
- **附件路径伪造与本地文件包含 (LFI)**：前端向 Rust 后端发送的 `streamOptions` 包含 `attachments`（转换为 `image_url: { url: string }`）。如果攻击者或恶意脚本通过篡改 IPC Payload，将 URL 修改为 `file:///C:/Windows/System32/...` 或敏感命名管道，后端若是没有进行协议与路径隔离检查，就会将本地敏感文件读取并随 prompt 发送给大模型。**建议**：Rust 端（`streamViaEngine`）必须严格校验附件 URL scheme，仅允许前端提交安全的 `data:` URI 或受信任的 `app://` 协议，并禁止任何绝对文件系统路径。
- **权限提权与会话冒用 (Permission Spoofing)**：IPC Payload 中的 `permissionMode` 如果直接由前端传递并被后端信任，一旦前端被 XSS 攻破，攻击者即可篡改该字段（如直接将工具调用权限升至 Auto-Approve 模式），导致未经授权的高危工具执行。**建议**：后端的 `session-loop` 必须是 `permissionMode` 的单一事实来源 (Source of Truth)，IPC 通信只能携带指令，Rust 端应从数据库重新读取会话真正的安全配置，不信任前端传来的权限级别。

## 3. XSS 与代码注入风险 (XSS Risks)
- **富文本剪贴板污染**：Tiptap 默认的粘贴解析器会处理剪贴板中的 HTML。如果缺乏像 `DOMPurify` 的前置清洗，用户在粘贴内容时，带有 `javascript:` 伪协议的链接或带有 `onerror` 属性的媒体标签可能被绕过并注入到 DOM 中。在 WebView2 的环境中，严重的 XSS 甚至可能导致 Node.js 层的 RCE (如果上下文隔离没做好)。**建议**：明确要求在 `onPaste` 生命周期或 Tiptap Schema 配置中集成严格的 HTML 清洗层。
- **Markdown 反序列化的 HTML 逃逸**：当系统从 `useLayoutStore` (草稿) 中读取内容并通过 `setContent()` 恢复编辑器状态时，若原内容中夹杂恶意的原生 HTML 标签，`tiptap-markdown` 反序列化过程可能将这些 HTML 标签直接还原为 DOM 节点。**建议**：明确在 `tiptap-markdown` 初始化时禁用原生 HTML 支持，或确保在双向同步时将所有不可信的 HTML 标签转义为普通文本节点。
