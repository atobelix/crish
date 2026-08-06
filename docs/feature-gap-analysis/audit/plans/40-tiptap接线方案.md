# 40 tiptap 聊天编辑器接线方案

> 产出：收尾 Agent C1（纯文档任务，只读核验代码，未改动任何源码，不 commit）。
> 属性：UTF-8 无 BOM，全中文。
> 依据：MASTER_PLAN.md（7 冲突消解矩阵 / SSOT 架构 / RL-01~06 视觉与治理红线）、SCHEME_FRONTEND/IPC/DATA、SRS_REQUIREMENTS.md、TIPTAP_MIGRATION_REQUIREMENTS.md、WYSIWYG_LIVE_PREVIEW_SPEC.md、reviews/（challenge_perf、challenge_security、review_arch、review_guidelines）、A6 前端域审计、34 前端收束详细执行。
> 日期：2026-08-06（本地）。

## 0. 使用说明

- 本文件是把并行域半成品 tiptap 组件族接入生产 ChatComposer 的接线执行方案，供执行 agent 直接依据。每卡四要素：**文件域 / 内容 / 测试 / 验收**（附依赖与批次）。
- 范围红线：只做「接入生产聊天输入」，不改 Rust、不改 IPC 出站面、不动宿主发送管线（`useChatComposerProps.onSend → handleSendChat → streamAssistantResponseApi`，chatApi.ts）。`daemonClient.ts → core_run_task` 直连方案（SCHEME_IPC §2.1）在宿主不存在，本方案**不新建** IPC 桥。
- 前端测试可信标准沿用 34 方案 §0 六条：真实渲染、断言具体值、不 mock 被测逻辑、waitFor 收口、失败即红、门禁口径（vitest 基线失败集 4 项不新增、不扩大）。

## 1. 现状差距与并行域完成度评估

### 1.1 功能面对照（宿主生产面 vs tiptap 并行域 vs 缺口）

宿主 ChatComposer/ComposerField 生产可用功能面（接线后必须全保留）：

| # | 宿主功能面 | 现状载体 | tiptap 并行域覆盖 |
|---|---|---|---|
| 1 | 占位符双态（正常 / processingPlaceholder） | ComposerField.tsx:193-194 | 仅单态 Placeholder 扩展，缺 processing 态 |
| 2 | 自动增高 textarea（`useAutoGrowTextarea`，≤4/10 行，dense 3 行） | ComposerField.tsx:113-116 | 固定 min 80px / max 320px，无行数语义 |
| 3 | IME 保护（isComposing 状态 + compositionstart/end） | ComposerField.tsx:262-265 | 有：view.composing 门 + DOM 监听（TiptapEditorField.tsx:76/192-218） |
| 4 | Enter 提交 / Shift+Enter 换行 / ctrlEnter 偏好（localStorage crish_send_shortcut） | ComposerField.tsx:279-291 | 有（TiptapEditorField.tsx:92-119） |
| 5 | 斜杠菜单：系统命令（/goal /learn /grill-me /schedule /teamwork /browser /simulate）+ skill 命令，文本前缀注入（resolveSlashCommand，含 open-schedule 动作） | ChatComposer.tsx + ComposerSlashMenu.tsx + useChatComposerProps.ts:282-365 | 只有 8 个块格式命令（SlashExtension.ts:14-127），无系统/skill 命令、无 open-schedule |
| 6 | 附件条（chips + 图片缩略）、文件选择、文本 <512KB 读为 text、粘贴图片 | ComposerAttachmentBar + useChatComposerProps.ts:215-280 | 有同款接线（容器内复用宿主组件） |
| 7 | 权限模式菜单（api/permissionModes：ask/deep/full/plan） | PermissionModeMenu.tsx | **枚举冲突**：composerTypes.ts:10 为 auto/manual/plan，容器已 `as unknown as` 桥接并登记两源冲突（TiptapComposerContainer.tsx:146-155） |
| 8 | 队列模式 queueMode + followUp 语义（不中断当前流） | useChatComposerProps.ts:442-466 | 无（容器只透传 queuedMessages 壳） |
| 9 | Stop L2/L3（Shift+点击/长按 550ms + 二次确认） | ComposerField.tsx:120-175 | 仅简单 onStop 按钮 |
| 10 | 草稿持久化：composerDrafts 350ms 防抖 + flush（beforeunload/visibilitychange） | useChatComposerProps.ts:86-137 | 有独立草稿链路（useTiptapComposerState.ts:134-159 直写 sessionStore）——**双写源冲突** |
| 11 | 会话切换附件/队列恢复（sessionRuntimeRegistry） | useChatComposerProps.ts:172-195 | 无 |
| 12 | 无障碍 combobox 链（aria-expanded/activedescendant/listbox）、composerSeed 事件、AppErrorBoundary、dense 复用（侧栏/内联） | ChatComposer.tsx 全链 | 无 |

### 1.2 并行域组件完成度评估（实查 12 个 tiptap 专属文件）

| 文件（行数） | 判定 | 评估 |
|---|---|---|
| TiptapEditorField.tsx（232） | **可复用核心 + 需补全** | 编辑器装配（StarterKit H1-3 / Placeholder / TaskList / TaskItem(nested) / SlashExtension）、IME 门、drop/paste、150ms 防抖序列化、content 水合（rAF + 100k 截断防爆）均已实现。缺：MentionExtension 未注册、CodeBlock Enter 保护、paste HTML 清洗（DOMPurify）、粘贴超限转 .txt 附件、processing 占位、dense、aria 链 |
| SlashExtension.ts（303） | **可复用 + 需补全** | `@tiptap/suggestion` 接线完整（char '/'、items 过滤、ReactRenderer 生命周期）；MentionExtension 已定义但未注册进编辑器；命令集需并入宿主系统命令 |
| TiptapSlashMenu.tsx（165） | **可复用** | Radix Popover.Portal + coordsAtPos 定位 + 键盘漫游已实现，`onOpenAutoFocus/onCloseAutoFocus` preventDefault 焦点盾到位。需改：z-index 硬编码 200 → `var(--z-popover)`；动画克制 |
| useTiptapComposerState.ts（294） | **需重写状态面** | blob URL 生命周期（CRM-05）与延迟 base64 值得保留；但草稿双写、附件契约（id/objectUrl/size，宿主 chat-stream/types.ts 无）、权限枚举冲突、queuedMessages 空壳——在适配层方案下整体降级/废弃，能力并入宿主链路 |
| composerTypes.ts（94） | **可复用 + 需统一** | 与 hooks/chat-stream/types.ts 契约合并（ChatAttachment 取超集、QueuedMessage 以宿主为准、PermissionMode 改 re-export） |
| serialization/markdownSerializer.ts（199） | **可复用** | AST→GFM 覆盖 heading/para/codeBlock/blockquote/taskList/bullet/ordered/hr/mention/四类 mark；无图片节点分支 |
| serialization/markdownDeserializer.ts（385） | **可复用 + 边界补强** | 行式解析 + parseInline 正则；嵌套缩进保真需 roundtrip 测试兜底 |
| serialization/markdownSerializer.test.ts（173） | **可复用** | 已有单向往断言；需扩双向 roundtrip |
| 3 个 module.css（合计 411） | **需重写视觉面** | 硬编码 rgba 兜底、sendBtn accent 填充、:active transform 缩放、5% 焦点 mix 偏低——与宿主 token 体系（ChatComposer.module.css）不符，详见 §4 |
| TiptapComposerContainer.tsx（188） | **需重写/降级** | 自建状态源未接宿主 props 全链、权限桥接 hack、Stop 语义缺失；本方案用「适配层」替代它整体接管（§2.1），该文件标记废弃 |

> 说明：任务书口径「14 个」含宿主复用件（ComposerAttachmentBar/ComposePlusMenu/PermissionModeMenu/ChatQueuePanel，均不改，直接复用），与实查 tiptap 专属 12 文件合计 16 个引用面；改造面 = tiptap 专属 12 个 + 新增适配层 1 个。

## 2. 接线架构

### 2.1 集成方式：渐进替换（适配层方案），不设并存开关

- **决策**：ChatComposer 保持唯一宿主入口；新增适配层 `chat-composer/TiptapComposerField.tsx`（props 契约 = ComposerFieldProps 兼容超集），ChatComposer.tsx:193 的 `<ComposerField>` 替换为 `<TiptapComposerField>`；`ComposerField` 本体与导出**不删除**（侧栏 AgentCard / 内联 InlineAgentPanel 继续复用，见 ChatComposer.tsx:4 注释）。
- 否决「TiptapComposerContainer 整体替换 ChatComposer」（MASTER_PLAN §2.3 原案）：容器完成度不足以接管宿主功能面（§1.1 缺失 5/8/9/11/12），且自建状态源与宿主双写冲突。适配层方案改动面小、可逆（git revert 即回退）、宿主 props 全链零改动。
- 否决 feature flag 并存开关：双编辑器双状态源属过度工程（RL-05），需要回退用版本控制。
- 与并行域的文件锁纪律对齐：tiptap 12 个文件在接线期间**冻结**（只读），改造动作全部由本方案任务卡按依赖顺序串行执行，防并行冲突。

### 2.2 状态 SSOT（对齐 MASTER_PLAN §3）

| 层级 | 归属 | 接线后状态 |
|---|---|---|
| Tier 0 类型契约 | composerTypes.ts | 与 chat-stream/types.ts 合并（T2），ChatAttachment 超集：`{ id?, name, mime?, size?, text?, dataUrl?, objectUrl? }` |
| Tier 1 应用状态 | useChatComposerProps（chatInput / attachments / queuedMessages / composerDrafts）+ useChatStream（QueuedMessage 契约，hooks/chat-stream/types.ts:11-16） | **唯一真相源**。tiptap 编辑器是「视图」，不持有业务状态 |
| Tier 1 草稿持久化 | layoutStore.composerDrafts（350ms 防抖，useChatComposerProps.ts:98-113） | 唯一写路径；废弃 useTiptapComposerState 直写路径 |
| Tier 2 临时缓冲 | TiptapEditorField 内部（editor 实例 + 150ms 防抖序列化） | 仅编辑器瞬态；markdown 经适配层回流 chatInput |

- **QueuedMessage 与编辑器状态的关系**：编辑器只产 markdown 字符串，经适配层 `onMarkdownChange` → 宿主 `setChatInput` → 350ms 草稿持久化（现有链路零改动）；发送经 `handleSendMarkdown` → 适配层 `onSend` → 宿主 onSend（queueMode 分支 / followUp / L2L3 / seed 全部保留）。**编辑器不感知队列**，队列消息回填编辑（editQueuedMessage 等，useChatComposerProps.ts:420-429）走 chatInput 受控值水合。

### 2.3 数据流接线

- **附件**：paste/drop → TiptapEditorField.onPasteImage/onDropFiles → 适配层 → 宿主 handlePasteImage/handleFilesSelected（blobToImageAttachment，imageProcessing.ts，含 dataUrl 缩略，兼容宿主 ChatAttachment）→ ComposerAttachmentBar（宿主，不改）。
- **权限**：单一枚举源 `api/permissionModes`；composerTypes.PermissionMode 删除或 `export type PermissionMode = import('../../api/permissionModes').PermissionMode`；消除容器桥接 hack。
- **斜杠菜单**：第一期保留宿主 ComposerSlashMenu 文本注入路径（改动最小，系统/skill 命令 + open-schedule 零回归），适配层把宿主 `filteredCommands` 桥给编辑器键盘（onKeyDownExtra 语义）；第二期（T6）将宿主命令并入 SlashExtension items 源。
- **增高**：编辑区 max-height 由 CSS 变量 `--composer-max-lines` × `--composer-line-height` 计算（对齐 ChatComposer.module.css:1-25 语义），dense 模式走 `containerDense` 变量；编辑器内部自然增高 + max-height 溢出滚动。
- **IME**：保留 TiptapEditorField 双保险（view.composing 门 + DOM composition 监听），composition 状态同步回宿主 `isComposing`（ComposerField 语义兼容）。

## 3. 依赖治理（幽灵依赖修复，T1 先行）

- **现状（已核验）**：`apps/crish-desktop/package.json` 无任何 `@tiptap/*` 声明；`node_modules/@tiptap/react@3.29.2` 等 27 个包存在于根 hoisted 目录（来自 reference/chat-composer-tiptap 时代的安装残留）；根 `package-lock.json` 与 `apps/crish-desktop/package-lock.json` **均无 @tiptap 记录**。当前 typecheck 能过只因残留，`npm ci` 后必然断链——属 A8 幽灵依赖类风险。
- **修复动作（T1）**：在 `apps/crish-desktop/package.json` dependencies 声明：`@tiptap/react`、`@tiptap/core`、`@tiptap/pm`、`@tiptap/starter-kit`、`@tiptap/extension-placeholder`、`@tiptap/extension-task-list`、`@tiptap/extension-task-item`、`@tiptap/suggestion`，版本 `^3.29.2`（与原型 reference/chat-composer-tiptap/package.json 对齐，node_modules 实装 3.29.2）。`@radix-ui/react-popover` 已声明（^1.1.23），无需动。
- **不引入**（反过度工程裁决，登记为与原 SRS §3.1 的偏差）：`tiptap-markdown`（并行域已自研 serializer/deserializer 且有测试，双序列化器属冗余，性能 review 亦反对每击键序列化）；`tiptap-extension-global-drag-handle`（聊天输入框块拖拽价值低、与防爆红线冲突，砍；若产品坚持列入第三批评审，不默认实施）。
- **lockfile 刷新**：在仓库根执行 `npm install --workspace @crish/crish-desktop`（或等价 `npm i`），确认根 lock 出现 8 条 @tiptap 记录；随后 `npm ci` 全量重装验证一次通过。验收以 `rg -c "@tiptap" package-lock.json` ≥ 8 且 `npm ci && npm run check:desktop` 全绿为准。

## 4. 视觉执行（高级品味红线）

### 4.1 token 映射表（tiptap CSS → 宿主 token，重写 3 个 module.css 时执行）

| tiptap 现用（错误/兜底） | 宿主 token（ChatComposer.module.css / tokens.css 实测） |
|---|---|
| `--bg-surface`（#ffffff 兜底） | `--bg-primary`（编辑区透明，复用容器 `--composer-bg`） |
| `--bg-code` / `--text-code` | `--bg-secondary` / `--bg-subtle` + `--text-secondary`；行内 code 用 `color-mix(in srgb, var(--text-primary) 8%, transparent)` 底 |
| `--text-muted` | `--text-tertiary`（占位符/描述一律 tertiary，对齐 ChatComposer.module.css:81-84） |
| 硬编码 rgba(0,0,0,...) 全链 | `--border-color`、`--hairline`（细分隔）、`--hairline-strong`（附件 chip 边框，对齐 attachChip 用法） |
| `--bg-hover` rgba 兜底 | `--bg-hover`（hover 才着色，基线：RuntimePanel.module.css 只 hover 变色、空态无边框） |
| `--radius-*` 硬编码 8/6/4 | `--radius-lg`（输入壳）/ `--radius-md` / `--radius-sm`（项） |
| `z-index: 200` 硬编码 | `var(--z-popover)`（SRS §5.2 / check:zindex 语义） |
| `--font-*` 兜底 | `var(--font-sans)` / `var(--font-mono)` / `var(--font-size-*)` / `var(--line-height-dense)` |
| accent 填充发送钮（--accent-color 底 + 白字） | 宿主按钮语汇：透明底 + `--text-tertiary` → hover `--text-primary`（sendBtn 模式，ChatComposer.module.css:192-216） |

### 4.2 红线执行清单

1. **对比度 3% 红线**：焦点态 `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`（标准）/ `95%+5%`（`data-empty-kind="session-empty"` 落地面，MASTER_PLAN §5.1）；任何态不得超过 10% mix。
2. **零阴影**：输入壳、弹层一律 `box-shadow: none !important`；禁用 `--shadow-color` 系轻阴影（宿主 slashPopover 现有 8%/2% shadow-color 阴影不复制进新弹层，弹层用 hairline 边框分层）。
3. **克制动效**：仅 `transition: border-color var(--transition-fast)`；删除容器 CSS 的 `:active { transform: scale(...) }` 按压动画与 `slideUpAndFade` 位移入场（如需保留弹层入场只留 opacity 0.15s，参照 `--transition-popover-enter` token 语义）；禁 will-change 滥用。
4. **空态/焦点态/占位符**：占位符走 Placeholder 扩展 `p.is-editor-empty::before`，色 `var(--text-tertiary)`（对齐宿主 `::placeholder`）；`outline: none` + focus-within 边框渐变；session-empty 落地面 5% mix 特例必须存在。
5. **节点基线样式**：heading / taskList / blockquote / pre / code 必须有显式 token 化样式（review_arch 建议 2），否则「纯文本外观」。
6. **视觉基准引用**：RuntimeSection（workspace/RuntimePanel.module.css：section 头 rowMeta 用 text-tertiary、空态无边框无底色）、SecurityAuditSection 同族、ComposerField 现状（半透壳 + hairline 边框 + hover 着色）——新视觉必须与这三者同族，禁止出现实心按钮、彩色描边、重阴影。

## 5. 任务分解（接线任务卡，按依赖排序）

### 第一批：核心接线（T1→T5 串行）

**T1 依赖治理**
- 文件域：`apps/crish-desktop/package.json`、根 `package-lock.json`、子 `package-lock.json`
- 内容：按 §3 声明 8 个 @tiptap 依赖并刷新 lockfile；不引入 tiptap-markdown / drag-handle
- 测试：`npm ci` 全量重装；`rg -c "@tiptap" package-lock.json` ≥ 8
- 验收：`npm run check:desktop` 全绿；`npm run dev` 下 vite 预构建无 @tiptap 解析告警
- 依赖：无（先行）

**T2 类型契约统一**
- 文件域：`composerTypes.ts`、`hooks/chat-stream/types.ts`（只读对齐）、`TiptapComposerContainer.tsx`（消除桥接 hack）
- 内容：ChatAttachment 合并为超集（id/name/mime/size/text/dataUrl/objectUrl 均可选）；QueuedMessage 以宿主为准；PermissionMode 改 re-export api/permissionModes；更新容器内 `as unknown as` 桥接为直用
- 测试：typecheck + 既有 chat-stream/multimodal.test.ts 不回归
- 验收：`rg "as unknown as.*permissionModes" apps/crish-desktop/src` 零命中；typecheck 全绿
- 依赖：T1

**T3 适配层 TiptapComposerField（新文件）**
- 文件域：新建 `chat-composer/TiptapComposerField.tsx`（≤500 行）
- 内容：props = ComposerFieldProps 兼容超集；内部挂 TiptapEditorField；映射 value↔content/onMarkdownChange（受控水合，防循环写回）、handleSendMarkdown→onSend、onPaste→宿主粘贴、onKeyDownExtra→斜杠桥、isProcessing→processingPlaceholder、dense/maxLines→CSS 变量、aria 全链透传、canSend 空护栏
- 测试：装配测试（真实渲染）：受控值注入水合 / 发送回调携带最新 markdown（防抖 150ms 场景用 waitFor）/ IME composition 门 / processing 态占位切换
- 验收：测试全绿；行数门禁（check-line-counts）通过；不 mock TiptapEditorField 本体
- 依赖：T2

**T4 ChatComposer 替换**
- 文件域：`ChatComposer.tsx`（仅替换导入与 JSX 一处）、`ComposerField.tsx`（只读，保留导出）
- 内容：`<ComposerField>` → `<TiptapComposerField>`；宿主 slash 文本注入、附件条、queueMode、L2/L3、seed、AppErrorBoundary 全部不动
- 测试：`ComposerField.stop.test.tsx` 语义迁移（Stop L2/L3 交互经适配层仍达宿主）；装配级发送/粘贴/seed 用例
- 验收：既有 chat-composer 测试全绿（基线失败集不新增）；typecheck 全绿
- 依赖：T3

**T5 序列化接线验证**
- 文件域：`serialization/*`（只读补测）、适配层
- 内容：发送时同步 `serializeToMarkdown(editor.getJSON())`（已有路径，TiptapEditorField.tsx:106-107）；草稿反序列化 parseFromMarkdown 水合；补双向 roundtrip 测试（嵌套列表/嵌套 taskList/mention/code fence 含 ```）
- 测试：`markdownSerializer.test.ts` 扩展 roundtrip describe
- 验收：roundtrip 用例全绿；发送 markdown 与编辑器所见一致（快照级断言）
- 依赖：T4

### 第二批：扩展（T6→T8，可与第一批并行域边界隔离后串行）

**T6 宿主斜杠命令并入**
- 文件域：`SlashExtension.ts`、`TiptapSlashMenu.tsx`（只读若只接数据）、适配层
- 内容：items 源 = 宿主 BASE_SLASH + skillSlash（映射为文本注入命令 + 保留 8 个块命令）；open-schedule 动作桥接宿主 onOpenSchedule；查询过滤沿用宿主 startsWith 语义
- 测试：getSuggestionItems 扩展用例；斜杠注入后 chatInput 断言
- 验收：`/goal`、`/schedule`、skill 命令在编辑器内可选并生效；原 ComposerSlashMenu 文本注入路径可退役（保留代码待 T11 清理）
- 依赖：T5

**T7 IME/CodeBlock/粘贴加固**
- 文件域：`TiptapEditorField.tsx`、`useTiptapComposerState.ts`（能力并入宿主或适配层）
- 内容：CodeBlock 内 Enter 只换行不发送（SRS 3.7.1）；paste HTML 走 DOMPurify 清洗（dompurify 已在依赖）；粘贴 >50k 字符转 .txt 附件（SRS TC-07）；编辑器最大长度上限（100k 截断已有，补 UI 提示）
- 测试：keydown 序列用例（TC-05/06/07/09 语义）
- 验收：四类 TC 用例全绿；无 50ms 定时器式 IME 压制（challenge_security 红线）
- 依赖：T5

**T8 Mention 接线**
- 文件域：`TiptapEditorField.tsx`（注册 MentionExtension）、`SlashExtension.ts`（@ 触发 suggestion 第二实例）、serialization（mention 分支已有）
- 内容：注册 MentionExtension；`@` 触发候选人（文件/agent，接入宿主能力或先留白）；序列化 `@[label](id)` 双向保真
- 测试：mention roundtrip + 渲染 chip 断言
- 验收：测试全绿；未接候选人源时 @ 不崩溃（空列表兜底）
- 依赖：T7

### 第三批：打磨（T9→T11）

**T9 视觉收尾**
- 文件域：`TiptapEditorField.module.css`、`TiptapComposerContainer.module.css`、`TiptapSlashMenu.module.css`（重写）+ 适配层样式
- 内容：按 §4.1 token 映射表重写；§4.2 红线 1-6 全落地；对照 RuntimePanel/SecurityAuditSection 基准
- 测试：`rg "box-shadow:" 非 none 零命中（域内）`；`rg "z-index: 200|#[0-9a-fA-F]{3,8}"` 域内零命中（tokens.css 例外）
- 验收：CDP 9222 截图目检：焦点 6%/落地 5% 边框、零阴影、hover 才着色、无按压缩放
- 依赖：T8

**T10 无障碍与细节**
- 文件域：适配层、`TiptapEditorField.tsx`
- 内容：aria combobox/listbox 全链（对齐 ChatComposer.tsx:220-253 现状）；焦点回迁（menu 关闭 → 编辑器）；dense 模式；processing 双态占位；行数增高语义
- 测试：aria 断言用例；dense 渲染用例
- 验收：axe 无 critical（或等价人工核查）；侧栏 AgentCard 复用路径零回归
- 依赖：T9

**T11 清理与收束**
- 文件域：`useTiptapComposerState.ts`（废弃/降级为适配层内部工具）、`TiptapComposerContainer.tsx`（标记废弃或删除）、`composerTypes.ts`（收敛）
- 内容：移除双草稿写源；未用 CSS 与导出清理；`check:desktop`、`check-line-counts`、`lint:depcruise`、`check:ui-layer` 全绿；`npx vitest run src` 基线失败集不扩大
- 测试：全量门禁命令
- 验收：§1.1 宿主功能面 12 项逐一回归（对照表打勾记录在轮报告）；无 tiptap 域死代码残留
- 依赖：T10

## 6. 风险与对策

| 风险 | 现状/证据 | 对策 |
|---|---|---|
| IME/Enter 竞态 | WebView2 compositionend→Enter 连发可误发（challenge_security §1）；50ms 定时器不可靠 | 保留 view.composing + event.isComposing + DOM 监听三条件门（TiptapEditorField.tsx:74-81/192-218）；CDP 9222 真实 CJK 输入验证（SRS 7.3） |
| markdown 序列化保真 | 自研 serializer 无图片节点分支、嵌套缩进靠缩进字符串、`parseInline` 正则对 `*` 嵌套敏感 | T5 双向 roundtrip 测试兜底；发送前强制同步序列化（已有）；发现保真缺口在该测试域修，不换 tiptap-markdown |
| 性能（大文档） | onUpdate 同步 getJSON 有成本；100k 截断已有（TiptapEditorField.tsx:173-179）；challenge_perf 明确禁每击键全量序列化 | 保持 150ms 防抖序列化 + 发送时单次同步；粘贴超限转附件（T7）；不做流式输出区 tiptap 化（SRS §1.2 铁律，聊天历史渲染禁止 tiptap） |
| 与并行域边界 | docs/composer-preview（live-preview 原型：src/core/live-preview、src/menus）为独立 vite 原型域；reference/chat-composer-tiptap 为原型源 | 两者只读参考不并入；tiptap 12 文件冻结至接线完成；本方案不派生子任务（C1 无派发能力），需并行拆解时上报主 Agent 统一派发 |
| 双草稿写源 | useTiptapComposerState.ts:134-159 直写 composerDrafts，与宿主 350ms 链路并存会互相覆盖 | 适配层方案下该路径随 T11 移除；T4 起宿主链路为唯一写源 |
| 权限枚举两源 | composerTypes 'auto/manual/plan' vs api 'ask/deep/full/plan'（容器 hack 已登记） | T2 统一到 api/permissionModes；Rust 侧权限真源不信任前端（challenge_security §2，宿主已有该语义，不动） |
| 依赖断链 | 幽灵依赖：npm ci 即断 | T1 先行 + lockfile 刷新 + npm ci 验证（验收标准硬性） |
| 宿主回归面 | 侧栏/内联复用 ComposerField、队列/seed/权限链路敏感 | ComposerField 不删；T10 回归用例覆盖侧栏路径；T11 对照表逐项打勾 |

---
*End of Plan 40（tiptap 聊天编辑器接线方案，C1 产出，2026-08-06）*
