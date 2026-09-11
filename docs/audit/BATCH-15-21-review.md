# BATCH-15～21 代码审计报告

> 仓库：`C:\Software\conex`（分支 `refactor/architecture`，本地 checkout，未 clone）
> 审查范围：`0b27e454` … `176d135e`（BATCH-15～21）
> 审计时间：2026-09-07（America/New_York）
> 方法：每 commit `git show --stat` + 相关 diff / 当前文件交叉核验；无证据不写。

---

## 总览评分

| 维度 | 评分 | 摘要 |
|------|------|------|
| 终端/端口探测安全 | **8** | 生产短路探测；端口整形扎实；preview postMessage 缺 origin 校验 |
| Markdown/XSS | **7.5** | escapeHtml 先行；URL sanitizer；dangerouslySetInnerHTML 依赖上游；外链拦截偏乐观 |
| 设计 Token 一致性 | **6.5** | 双轨标题 token 与 dark 裸 Hex；合规脚本未挂入 CI |
| 门禁脚本抗跳过 | **6** | input-guard 已接入 check:desktop；markdown 合规脚本未接线；扫描面偏窄 |
| 便签落盘/数据丢失 | **7.5** | 差量 op+队列+debounce/maxWait+UUID 加固；应急草稿只写不读回 |
| 本地文件/路径穿越 | **5.5** | readTextFile 加固好；write/toAssetUrl 空路径未对称；localFileReader shell 兜底任意读 |
| API 错误处理 | **7** | 流式死态清理、context-state 会话隔离改善；多处 swallow-ok |
| **综合** | **7.0** | 优先处理 shell 任意读与写路径空值 |

---

## 按批次发现

### BATCH-15 `0b27e454` feat(workspace)

**严重**

- 本批未发现可独立复现的严重漏洞。

**中等**

1. **`subscribeToInspector` 只校验 `event.data.source`，不校验 `event.origin`**
   - 证据：`previewHostBridge.ts` 的 `handleMessage` 直接 `parseClientToHostMessage(event.data)`，无 origin 约束。
   - 影响：伪造 `{ source: "crish-preview-inspector", type: ... }` 即可驱动拾取态/HOVER/SELECT。本批删除 previewClientBridge/previewDomInspector 改注入单轨后，消息鉴权仍过弱。

**轻微**

2. 生产端口探测短路（正向）：`activePortDetector.ts` 在 `!import.meta.env.DEV` 时 `return []`。
3. `sanitizePortList` 限制整数端口在 (0,65536)。
4. TerminalCard 分屏副格独立 status/error。

### BATCH-16 `f7b8e305` feat(ui)

**严重**

- UI 层无独立严重漏洞；XSS 依赖 BATCH-21 流水线。

**中等**

1. **`dangerouslySetInnerHTML` 直渲异步 HTML**（`MarkdownDocumentView.tsx`）。缓解：上游先 `escapeHtml` 再 `applyInline`；组件无二次 sanitize。
2. **外链仅 `startsWith(http/https/mailto)`**：大小写敏感；未匹配 scheme 走默认导航；未复用 `sanitizeUrlCandidate`。

**轻微**

3. >256KB 熔断 VirtualPlainCodeViewer。
4. ScrollArea thumb 用 translate3d + metrics 浅比较。

### BATCH-17 `04064d21` style(design-tokens)

**严重**: 无

**中等**

1. **标题 Token 双轨且数值不一致**：`tokens.css` 同时有 `--md-h1-size: 1.85em` 与 `--md-heading-h1-size: 1.5em`（light/dark）。`markdown-typography.css` 消费 `--md-h1-size`，旧轨易造成改一侧不生效。

**轻微**

2. Dark `--bg-primary` 等仍为裸 Hex（如 `#1f1f1f`）；合规脚本只扫 typography 文件。
3. `--md-font-family` 硬编码系统字体栈，与 `--font-sans` SSOT 并行。

### BATCH-18 `55ed9c55` chore(scripts)

**严重**: 无

**中等**

1. 新增 markdown 样式合规脚本，但 `package.json` 的 `check:desktop` 未引用它（仅引用 `check:input-guard`）。
2. 该脚本只检查 `markdown-typography.css` 单文件。
3. input-guard 对纯 CSS 变量阴影片段与 binary-tree 以外目录的覆盖仍不完整。

**轻微**

4. `scripts/form_parts.cjs` 为文档模板修补工具，非持续检查。
5. input-guard 扩大至 packages 并细化阴影解析——正向。

### BATCH-19 `38f19aca` docs(provider)

**严重/中等**: 纯文档 +3171 行，无运行时风险。

**轻微**: 未做文档内密钥扫描。

### BATCH-20 `2d80448e` feat(note-paper)

**严重**: 未发现可直接导致静默永久丢盘的严重逻辑洞。

**中等**

1. **应急草稿只写不读回**：`saveEmergencyDraftSync` 在 `beforeunload` 写入 localStorage；`loadEmergencyDraftSync` 仅见于定义与单元测试，面板挂载/打开文档无产品恢复路径。进程被杀后用户看不到抢救内容。
2. `flushPendingDraft` 固定两轮 pass，非形式化排空证明（低概率残留）。

**轻微**

3. `newNoteBlockId` 无 crypto 时回落 `Math.random`（格式合法、熵弱；桌面通常有 crypto）。
4. 废止幽灵 ID `init-first-block`、insert 失败回退空态——正向。

### BATCH-21 `176d135e` feat(api)

**严重**

1. **`localFileReader.ts` 通过 `workbench_run_shell` 兜底读取任意本机路径**
   - 证据：`readLocalImageAsDataUrl` / `readLocalTextBestEffort` 在 `convertFileSrc` 失败后，把路径拼进 PowerShell `ReadAllBytes` 或 Unix `base64`/`head` 命令；仅做单引号加倍；无工作区边界、无路径 allowlist。
   - 单测 `localFileReader.test.ts` 只覆盖 `getMimeFromPath`。
   - SVG 映射为 `image/svg+xml` 进入 dataUrl，后续若当 HTML 嵌入需额外注意。

**中等**

2. **`writeTextFile` / `toAssetUrl` 与 `readTextFile` 不对称**：本批为 `readTextFile` 增加 `if (!path) throw`；写与 asset URL 仍可能对 `resolveWorkspacePath` 返回的空串继续 invoke / `convertFileSrc`。
3. **`revealInOs` 使用原始 `filePath`**，未走 `resolveWorkspacePath`（同文件周边 API）。
4. context-state 会话隔离与死态 cleanup 正向；双键暂存与大量 `swallow-ok` 仍增加排障成本。

**轻微**

5. `FILE_PREVIEW_MAX_LINES` 降至 20000；`highlightCodeSafe` 长文本短路；Markdown escape-first；PTY UTF-8 截断——正向。

---

## 优点（有证据）

1. 端口探测生产短路 + 端口整形（BATCH-15）。
2. 预览桥单轨化，删除近 1.8k 行重复客户端/DOM inspector。
3. Markdown escape-first + URL sanitizer + adversarial 测试。
4. 便签：合法 UUID 首块、差量 op、inFlight 队列、debounce+maxWait、无写锥诚实 unsaved。
5. `readTextFile` 工作区失败显式抛错；预览行数上限下调。
6. input-guard 扫描 packages、阴影语义精确化。
7. context-state 改为发送时携带、会话去重。

---

## 优先修复

| 优先级 | 项 | 批次 | 建议 |
|--------|----|------|------|
| P0 | 收紧 `localFileReader` 的 shell 兜底 | 21 | 改专用读文件 IPC + 路径 allowlist；补单测 |
| P0 | `writeTextFile` / `toAssetUrl` 对齐 `readTextFile` 空路径拒绝 | 21 | 与 `resolveWorkspacePath` 失败语义一致 |
| P1 | preview message 校验 `event.origin` | 15 | 拒绝伪造 source |
| P1 | 应急草稿产品侧读回 + 打开时提示恢复 | 20 | 否则抢救无用户价值 |
| P1 | markdown 合规脚本挂入 `check:desktop` | 18 | 并明确/扩大扫描面 |
| P2 | 收敛 `--md-h1-size` vs `--md-heading-h1-size` | 17 | 单一真源 |
| P2 | `MarkdownDocumentView` 外链 scheme 规范化 | 16 | 对齐 sanitizer |
| P2 | `revealInOs` 工作区解析或文档化威胁模型 | 21 | |

---

## 审查元数据

| Commit | 短哈希 | 主题 |
|--------|--------|------|
| BATCH-15 | `0b27e454` | workspace 预览/终端/端口 |
| BATCH-16 | `f7b8e305` | MarkdownDocumentView / ScrollArea |
| BATCH-17 | `04064d21` | design tokens / typography |
| BATCH-18 | `55ed9c55` | 门禁脚本 |
| BATCH-19 | `38f19aca` | provider 文档 |
| BATCH-20 | `2d80448e` | note-paper 落盘 |
| BATCH-21 | `176d135e` | API / 本地文件 / markdown |

本报告仅基于上述 commit 的 diff 与工作区当前文件交叉验证；未运行完整测试套件，未审计 Rust/Tauri 命令实现侧二次校验。
