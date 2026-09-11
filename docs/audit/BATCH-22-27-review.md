# BATCH-22 ~ BATCH-27 代码审计报告

- **仓库**: `C:\Software\conex`（本地 checkout，未 clone）
- **分支**: `refactor/architecture`
- **审查范围**:
  - `916f0d2d` BATCH-22 feat(chat-row)
  - `ac603e64` BATCH-23 feat(chat-card)
  - `28a272e2` BATCH-24 feat(chat-composer)
  - `adfaeff3` BATCH-25 docs(provider)
  - `8fdcb5d9` BATCH-26 feat(desktop)
  - `3f2f0a83` BATCH-27 feat(desktop)
- **审计时间**: 2026-09-07（ET）
- **原则**: 仅记录有 diff / 源码证据的发现；重点覆盖虚拟列表吸底测高、流式竞态、富文本 XSS、附件路径校验、斜杠注入、设置/扩展契约、Tauri drag-region、死代码。

---

## 1. 总览评分

| 维度 | 分数 ( /10 ) | 简述 |
|------|-------------:|------|
| 架构收敛 / 契约清理 | 7.5 | B23/B26 去掉扁平兼容、预览桥单轨化、同源限制，方向正确 |
| 交互正确性（列表/吸底/流式） | 6.0 | 测高改 offsetHeight + 吸底钳位有改进；仍有测高抖动与进度条订阅缺口 |
| 安全（XSS / 路径 / IPC / SSRF） | 4.5 | Tiptap DOMPurify、技能预览去 innerHTML 是加分；拖拽路径读盘与非视觉模型 dataUrl 下发是高危 |
| 可维护性 / 死代码 | 6.5 | 删除 ChatScrollAnchor 等合理；PlanGoalRibbons 仍半死；双重拖放监听复杂 |
| **综合** | **5.8** | 视觉与装配推进明显，但附件路径读盘链路与 prompt 泄漏需优先止血 |

**结论**: 可合入主干前建议至少处理「P0 路径读盘 + 非视觉模型源数据泄漏」与「P1 双重拖放/进度条订阅」；其余多为中低优先。

---

## 2. 按批次发现

### BATCH-22 `916f0d2d` feat(chat-row) — 评分 7.5/10

**变更摘要**: 28 files, +546/-496。消息行 / 工具卡片 / Agent 面板以 CSS 与轻交互为主（Pin 常显、`data-md-variant="chat"`、工具区测高回调裁剪）。

#### 发现

| ID | 严重度 | 标题 | 证据 |
|----|--------|------|------|
| B22-1 | Low | 工具区移除 `clearHeightsSignal` / `onHeightChange`，依赖 VSM `invalidateActual` | `MessageToolCallsSection.tsx` diff：删除 props，折叠时只调 `virtualScrollManager?.invalidateActual(msgId)`。若上游仍传旧信号，会被静默忽略（本批已同步删调用方）。风险低，但流式展开时需依赖 RO 二次测高。 |
| B22-2 | Info | 视觉重构为主，未见新增 XSS sink | `MarkdownBlockItem` 仅加 `data-md-variant`；动作栏 Pin 常显。无新的 `dangerouslySetInnerHTML`。 |

**优点**: Pin 可用性改善；工具卡片 CSS 收敛；思考/工具折叠与 VSM invalidate 联动更干净。

---

### BATCH-23 `ac603e64` feat(chat-card) — 评分 5.5/10

**变更摘要**: 38 files, +1170/-496。ChatCard 全卡拖放、删除 ChatScrollAnchor/useChatScroll、MessageVirtualizer 测高改 offsetHeight、附件路径读盘、`RunNoticeBar`/`RetrySlotNotice`、计划条迁到 Composer。

#### 发现

| ID | 严重度 | 标题 | 证据 |
|----|--------|------|------|
| B23-1 | **Critical** | Tauri / 本地拖放路径经 `handlePathsSelected` 直读任意本地文件，**无工作区边界校验** | `useChatAttachments.ts`：`handlePathsSelected` 对每个 `paths` 调 `readLocalImageAsDataUrl` / `readLocalTextBestEffort`。`localFileReader.ts` 用 `convertFileSrc(path)` 或 `workbench_run_shell` 读任意绝对路径；仅 `trim`，无 `resolveWorkspacePath` / allowlist。ChatCard 的 `tauri://drag-drop` 把 `event.payload.paths` 原样传入。攻击面：用户拖入/恶意程序投递敏感路径 → 内容进入附件 → 后续可进模型 prompt。 |
| B23-2 | **High** | 路径读盘兜底走 **shell 拼命令**（PowerShell `ReadAllBytes` / `Get-Content -LiteralPath`） | `localFileReader.ts`：`path.replace(/'/g, "''")` 后嵌入单引号命令。虽 LiteralPath + 单引号加倍转义降低注入面，但仍是「路径 → shell」模式；特殊 Unicode / 超长路径 / 非预期 IPC 输入缺少拒绝策略。B23 新调用链放大了既有 BATCH-21 读盘器的暴露面。 |
| B23-3 | **High** | ChatCard **三路拖放叠加**，易重复入队附件 | 同文件：① `useIpcListener('tauri://drag-drop')` → `handlePathsSelected`；② `window` `drop` → `handleFilesSelected`；③ 卡片 `onDrop` → `handleFilesSelected`。ComposerDropHost / Tiptap `handleDrop`（B24）也可能再接一层。`e.stopPropagation` 不能挡住 Tauri IPC 与 DOM 并行事件。 |
| B23-4 | Medium | 虚拟列表测高改 `offsetHeight \|\| contentRect.height`，吸底仍在 RO 回调里强制 `scrollTop = maxScroll` | `MessageVirtualizer.tsx`：流式内容增高时 RO 频繁 `setActual` + 吸底赋值。`offsetHeight` 含 border/padding，与估计行高切换时可能出现 1~N px 抖动；注释自称排除 margin，但子树 margin collapse 仍可能使相邻行总高与 sum(offsetHeight) 不一致。 |
| B23-5 | Medium | `ChatComposerWrapper` 用 `getSessionById` **非订阅**读进度，计划条可能不随流式进度刷新 | `ChatComposerWrapper.tsx`：`const currentSession = activeSessionId ? getSessionById(activeSessionId) : null`，`useMemo(..., [currentSession])`。若父组件不因 session store 更新而重渲染，`ComposerPlanProgressBar` 会卡住。 |
| B23-6 | Medium | memo 切除扁平回退后，`fallbackToolStackProps` 的审批 action 为空实现 | `MessageVirtualizer.tsx`：缺 `interaction.toolStackProps` 时 `onApprovalAllow/Deny: () => {}`。正常路径由 ChatMessageList 注入；异常装配会导致审批按钮静默失效。 |
| B23-7 | Low | SVG 被当作图片附件扩展名 | `handlePathsSelected`：`/\.(png|jpe?g|gif|webp|bmp|svg)$/i`。SVG 读成 dataUrl 后若误当 HTML 插入有 XSS 史；当前缩略图走 `<img>` 风险较低，但仍建议剔除或强制栅格化。 |
| B23-8 | Low | 死代码残留：`PlanGoalRibbons` 仍存在，Wrapper 以 `omitPlanRibbons` 抑制 | `ChatStatusRibbons.tsx` 仍渲染 `PlanGoalRibbons`；`ChatComposerWrapper` 传 `omitPlanRibbons` 并改用 `ComposerPlanProgressBar`。测试仍 mock `PlanGoalRibbons`。 |
| B23-9 | Info | 删除 Chat 层 scroll FAB，吸底改由 MessageVirtualizer FloorSlot 承担 | `ChatStatusRibbons` 去掉 `showScrollToBottom` 必填；ChatCard 不再传。与「回到底部」职责下沉一致，属正向清理。 |
| B23-10 | Info | `openPathInFilesPanel` 增加可执行后缀拦截与行号剥离 | `useChatSessionActions.ts`：禁 `.exe/.bat/.ps1/...`；`resolveWorkspacePath` 优先。路径点击从已删的 ChatScrollAnchor 迁到 `handleMarkdownClick`（`.md-path-link`）。 |

**优点**: RunNotice / Retry 抽组件；路径打开安全红线；虚拟列表 props 领域化；md-path-link 点击回归消息列表。

---

### BATCH-24 `28a272e2` feat(chat-composer) — 评分 5.0/10

**变更摘要**: 15 files, +704/-219。附件栏批注卡片、Tiptap 文件 dragOver、多模态视觉门控、斜杠发送带 images/attachments。

#### 发现

| ID | 严重度 | 标题 | 证据 |
|----|--------|------|------|
| B24-1 | **Critical** | 非视觉模型仍把 **dataUrl / 本地绝对路径** 写入模型文本 | `multimodal.ts`：`isVisionSupported === false` 时构造 ``路径: ${a.path}`` + ``源数据: ${a.dataUrl}``（≤2048）或摘要；普通文件分支 ``- ${a.name}${pathInfo}``。本地路径与截图 dataUrl 进入上游 API，构成隐私泄漏与 prompt 膨胀。 |
| B24-2 | **High** | 用户消息持久化 `source: a.dataUrl \|\| a.path` | `useSlashSend.ts`：`MessageImageRef.source` 可存完整 dataUrl 或绝对路径；`attachments` 同步写入 `path`/`dataUrl`。会话落盘体积与敏感路径残留风险上升。 |
| B24-3 | Medium | 批注 chip `handleSave` **原地 mutate** React state 对象 | `ComposerAttachmentBar.tsx`：`attachment.annotation.comment = newComment; attachment.text = ...`。破坏不可变约定，可能造成 UI 与 registry 不同步、难追踪的流式/草稿竞态。 |
| B24-4 | Medium | Tiptap `handleDrop` 与 ChatCard/DropHost 叠加，文件可能双开 | `TiptapEditorExtensions.ts`：`handleDrop` `preventDefault` + `onDropFiles(files)`；ChatCard 窗口/卡片 drop 仍监听。需统一「唯一消费方」。 |
| B24-5 | Low | DOMPurify 粘贴清洗存在，但 `FORBID_ATTR` 未覆盖 `href`/`src` 的 `javascript:` | 同文件 `handlePaste`：`FORBID_TAGS` 较全（含 script/iframe/img）；`FORBID_ATTR` 仅 `style/onerror/onload/onclick`。默认 DOMPurify 通常会处理 URI，建议显式 `ALLOW_UNKNOWN_PROTOCOLS: false` 或加回归单测，避免配置回退。 |
| B24-6 | Low | Grill-me 去掉 `[系统上下文注入…]` 前缀 | `slashSendPreflight.ts`：`modelText = rendered`（不再加系统前缀）。属产品语义变更；需确认模型侧仍能识别模式，否则像「斜杠上下文弱化」而非注入攻击。 |
| B24-7 | Info | 斜杠导航 `/browser` 仍走 `setPreviewUrl(normalizeBrowseUrl)` | `runPreflightChecks`：导航类 slash 本地消化后 `handled`，未见把原始 slash 字符串直接 `eval`/IPC；注入风险主要在后续 preview 代理（见 B26）。 |

**优点**: 视觉模型门控 toast；批注与 `takePendingFileAnnotations` 去重；附件删除联动 `removePendingFileAnnotation`；AttachmentBar 条件渲染。

---

### BATCH-25 `adfaeff3` docs(provider) — 评分 8.0/10

**变更摘要**: 3 个详案 md，+5762。纯文档沉淀（AgentA/D/E）。

#### 发现

| ID | 严重度 | 标题 | 证据 |
|----|--------|------|------|
| B25-1 | Low | 文档含示例形态密钥字符串（非真实生产密钥） | AgentD 详案示例：`"apiKey": "sk-real-secret-key"` / `sk-dashscope-secret`；AgentA 测试夹具 `env-secret-8888`。建议统一改为明显假值（`sk-test-***`）以免扫描器误报。 |
| B25-2 | Info | 无可执行代码变更 | `git show --stat` 仅 docs。 |

**优点**: 明确指出 LocalStorage 明文 apiKey 双轨问题与凭证引用目标态，对后续改造有指导价值。

---

### BATCH-26 `8fdcb5d9` feat(desktop) — 评分 7.0/10

**变更摘要**: 22 files, +730/-309。预览桥脚本外置、vite 代理去 CORS、设置技能预览改 MarkdownDocumentView、note 边界 11→10、session context-state 防堆叠、mobile auth 契约对齐。

#### 发现

| ID | 严重度 | 标题 | 证据 |
|----|--------|------|------|
| B26-1 | Medium | 预览桥 `postMessage(..., '*')`，宿主 `subscribeToInspector` **不校验 `event.origin`** | `previewBridgeScript.ts` 与 `previewHostBridge.ts`：只校验 `source === 'crish-preview-inspector'`。任意页若能同窗口投递同 shape 消息即可伪造 HOVER/SELECT。同源代理 + 去 CORS 已降低 SSRF/跨源驱动，但 origin 校验仍缺。 |
| B26-2 | Medium | `__crish_preview_proxy` 仍是开放 URL 拉取器（同源即可） | `vite.config.ts`：`isSameOriginRequest` 缺 Origin 头放行（浏览器同源常见）；仍可被本机同源页面驱动拉取任意 http(s)。T18 去掉 `Access-Control-Allow-Origin: *` 与 strip `set-cookie` 是改进，但 SSRF 面改为「同源限定」而非消除。 |
| B26-3 | Low | `NoteLeafHost` 去掉 `wsId` 传入 `useNoteDocumentManager` | diff：仅 `initialDocId` + `flushPendingFlush`。若 manager 曾按 ws 隔离文档，可能串工作区（需对照 hook 默认实现；本批未证明已坏，标观察）。 |
| B26-4 | Info | 内置视图 `browser` 从边界名单移除（11→10） | `package-boundary.test.ts`。与 slash `/browser` 仍可开 preview 并存——契约上「browser 不再是独立内置叶」。 |
| B26-5 | Info | Skill 预览去掉 `dangerouslySetInnerHTML` | `SkillDetailPreview.tsx` → `MarkdownDocumentView`。显著降低设置中心 XSS。 |

**优点**: 预览桥单轨 + 真实 XPath；同源门禁；context-state 原地覆盖防堆叠测试扎实；`formatPercentValue` 语义更名；mobile auth 禁止伪造 relay。

---

### BATCH-27 `3f2f0a83` feat(desktop) — 评分 6.0/10

**变更摘要**: 仅 `index.html`，骨架屏多层加 `data-tauri-drag-region`。

#### 发现

| ID | 严重度 | 标题 | 证据 |
|----|--------|------|------|
| B27-1 | Medium | 在 **SVG / 子节点** 上叠加 drag-region，可能吞指针事件 | `index.html`：`#skel-app`、icon-card、**svg**、caption 均标 `data-tauri-drag-region`。Tauri 下 drag-region 常使元素不可点击；启动失败/超时若骨架残留，用户无法与内部控件交互。建议只保留最外层 loader 容器。 |
| B27-2 | Low | 无对应卸载/替换后清理逻辑变更 | React `createRoot` 替换 `#root` 后骨架 DOM 消失则副作用结束；风险主要在「长时间卡在骨架」场景。 |

**优点**: 无边框窗口启动阶段可拖动，动机合理。

---

## 3. 优点（跨批次）

1. **安全正向**: 技能预览去 raw HTML；Tiptap HTML 粘贴走 DOMPurify；聊天打开路径拦截可执行后缀；预览代理去通配 CORS、剥离 set-cookie。
2. **架构收敛**: MessageVirtualizer 去掉扁平 props 双轨；预览 inspector 单轨脚本；context-state 注入防堆叠；内置视图边界测试收紧。
3. **体验**: Pin 常显、计划进度条贴近输入区、视觉模型不支持时显式 toast、RunNotice/Retry 无障碍播报。
4. **测试**: B23 虚拟列表/流式槽测试更新；B26 sessionInjectionMount / previewBridgeScript 单测补强。

---

## 4. 优先修复

### P0（合入前必须）

1. **附件路径读盘加边界**（B23-1 / B23-2）
   - `handlePathsSelected`：仅允许工作区根内路径，或显式「用户确认后读外部文件」。
   - 禁止对未校验路径调用 `workbench_run_shell`；优先受控 FS API。
   - 拒绝 `..`、UNC 可疑形态、超长路径。

2. **禁止非视觉模型下发 dataUrl/绝对路径**（B24-1 / B24-2）
   - 非视觉：只发文件名 + 「已附件，模型不可视」提示，不写 path/dataUrl。
   - 用户消息持久化对 dataUrl 做截断/外置引用，避免会话库膨胀与路径残留。

### P1（尽快）

3. **统一拖放唯一消费者**（B23-3 / B24-4）
   - ChatCard IPC / window / card / DropHost / Tiptap 五选一主路径，其余 `preventDefault` 后 return。
   - 加「同文件指纹去重」防双入队。

4. **计划进度条订阅 store**（B23-5）
   - `ChatComposerWrapper` 改为 `useSyncExternalStore` / selector 订阅 session，避免静默过期。

5. **骨架 drag-region 收敛**（B27-1）
   - 仅外层 `#skel-app` 保留；去掉 svg/caption 上的属性。

6. **preview postMessage 校验 origin**（B26-1）
   - 宿主只接受预览 iframe origin（代理源）；桥侧也可限制。

### P2（清理 / 加固）

7. 删除或正式归档 `PlanGoalRibbons` 死路径（B23-8）。
8. 批注保存改为不可变更新（B24-3）。
9. DOMPurify 配置加协议单测（B24-5）。
10. 文档示例密钥改为明显假值（B25-1）。
11. SVG 附件策略明确（栅格化或禁止）（B23-7）。

---

## 5. 证据索引（关键文件）

| 主题 | 路径 |
|------|------|
| 拖放 / IPC | `apps/crish-desktop/src/components/chat-card/ChatCard.tsx` |
| 路径附件 | `apps/crish-desktop/src/components/chat-card/useChatAttachments.ts` |
| 本地读盘 | `apps/crish-desktop/src/api/localFileReader.ts` |
| 虚拟列表测高吸底 | `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` |
| 多模态泄漏 | `apps/crish-desktop/src/hooks/chat-stream/multimodal.ts` |
| 斜杠发送落盘 | `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts` |
| Tiptap XSS/拖放 | `apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts` |
| 预览桥 | `apps/crish-desktop/dev-server/previewBridgeScript.ts` / `vite.config.ts` / `previewHostBridge.ts` |
| 技能预览 | `apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx` |
| drag-region | `apps/crish-desktop/index.html` |

---

*本报告由代码审计执行器基于指定 commit 的 `git show` 与当前工作树源码交叉验证生成。*
