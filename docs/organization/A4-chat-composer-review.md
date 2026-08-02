# A4 主对话界面原型评审：chat-composer-component 与现有实现对比

> 生成日期：2026-08-02
> 评审对象：`reference/chat-composer-component/`（独立 HTML/CSS/JS 原型，非 React）
> 对比基准：`apps/crish-desktop/src/components/`（chat-composer / chat-card / chat-message-row / chat-tool-call / chat-message-list）
> 性质：只读评审，未改动任何代码
> 结论速览：原型在**叙事信息架构（Purpose 投影）**与**对话流视觉禁令**上显著领先现有实现，值得按"纯函数先行 → 组件重构 → 新能力"三段整合；输入区本体（textarea / slash / 附件 / 权限菜单）现有实现更成熟，无需回迁；双预览系统、markdown 块编辑器等属探索性残留，整合前需产品决策。

---

## 1. 评审范围与方法

| 对象 | 内容 |
|------|------|
| 原型 | index.html（42 KB）、css/ 9 个主题文件 + flow/ 8 个 + file-preview/ 12 个、js/ 核心模块 8 个 + components/ 12 个 + file-preview/ 与 markdown-editor/ 子系统、CONVERSATION_FLOW_SPEC.md（35 KB） |
| 现有 | ChatComposer / ComposePlusMenu / ComposerField / ComposerAttachmentBar / ChatComposer.module.css、ChatCard / ChatStatusRibbons / PlanGoalRibbons / ApprovalDock、chat-message-row 系列（AsyncMarkdownBlock 等）、chat-tool-call 系列、ChatMessageList / MessageVirtualizer、styles/tokens.css |
| 方法 | 全文精读原型 8 个 JS 模块与全部令牌 CSS；精读现有 10 个关键组件；按 5 个维度逐项对比并给出评估 |

---

## 2. 原型设计摘要

### 2.1 页面布局与 DOM 结构

单页 demo，垂直三段式（`chat-app-layout`，max-width 720px 居中）：

```
.chat-app-layout
├── .chat-stream-container            # 消息流（可滚动，JS 渲染）
│   └── #streamMount
└── .composer-wrapper                # 底部输入区整体
    ├── #permissionBarHost           # 审批条（SPEC §7.7，输入框上方独立）
    ├── .plan-progress-bar           # 目标/计划进度中枢（向上展开）
    │   ├── .plan-goal-panel         #   目标编辑（contenteditable）
    │   ├── .plan-step-list          #   步骤抽屉（completed/active/pending）
    │   └── .plan-collapsed          #   单行锚条：模式徽章 + 步骤老虎机 + 计数 + 时长 + 编辑/暂停/停止 + 展开箭头
    └── .composer-container          # 输入卡
        ├── .file-zone               #   附件卡（file-card 按类型图标/图片缩略）+ skill-tag
        ├── .input-zone              #   contenteditable 富输入（rich-inline-tag：@ 文件引用 / Skill 标签）
        ├── .action-bar              #   ＋按钮 / 权限 pill / 模型 pill / 圆形发送钮
        └── .drag-drop-overlay       #   全卡拖拽遮罩
弹层（position:fixed）：slash（/ 与 、）、at（@ 文件）、tree（@@ 目录树）、plus（＋菜单）、skillSubmenu（级联）、modelPopover（分组模型 + 思考强度滑杆）、permissionPopover（5 模式 + tooltip）
另有 #filePreviewRoot（预览挂载点）与隐藏 file input。
```

class 命名规范：语义化 BEM 简式（`file-card`、`plan-expanded-step`、`rich-inline-tag`），全局作用域（无 CSS Modules）；同 index.html 内自带 30+ 种文件类型 SVG 图标（`icon-assets.js` 约 152 KB）。

### 2.2 JS 模块职责

| 模块 | 规模 | 职责 | 成熟度评价 |
|------|------|------|-----------|
| composer-core.js | 6 KB | 发送钮状态、粘贴文件、文件卡创建/删除、liveFileStore（Map） | 可运行的交互骨架；无真实发送逻辑 |
| popovers.js | 26 KB | 弹层定位/互斥、选区保存与富标签插入、文件图标水合、模型分组过滤、思考强度滑杆、权限模式配色同步、拖拽遮罩、计划进度条整套交互（老虎机滚动、时长计时、展开抽屉、demo 自动步进） | 弹层系统为手写实现，无键盘导航/focus trap；计划条为 demo 自演（3.5s 自动切步） |
| skill-manager.js | 1.5 KB | skill 搜索过滤 + 点击插入 skill-tag | 简单可读 |
| tool-presentation.js | 17 KB | 工具人话化纯函数：标签（toolHumanLabel）、动词族（查看/修改/搜索/运行/写入/浏览/访问/协作）、spam 过滤、路径/命令抽取、可展开判定、inspect 组判定、single/group 渲染项、diff 统计、时长、中文状态 | 高；注释明确对齐 desktop 的 toolCardPresenter/timelineNormalizer，可平移复用 |
| flow-projector.js | 27 KB | MessageToolCall[] → FlowNode 树：Purpose 投影算法（purposeId ?? hash(normalize)）、30s 窗口启发式合并、时态化（已查看/正在运行）、pending_approval 抽离、subagent traces 规范化、整会话投影 | 高；纯函数，与框架无关，是原型最有移植价值的部分 |
| stream-renderer.js | 2 KB | FlowMount 薄封装（bootstrap） | 无独立价值 |
| markdown-lite.js | 4.7 KB | 极简 MD→HTML（标题/表格/列表/代码/引用/hr/加粗斜体链接） | 低；仅 demo 用，远不及生产渲染 |
| preview-modal.js | 30 KB | 旧式预览弹窗：图片缩放/旋转/裁剪/画笔、CSV 表格、伪 PDF 阅读器 | 已被新 file-preview/ 子系统替代（index.html 中二者并存） |
| file-preview/（子目录） | ~25 KB | PreviewShell + PreviewRouter + sniff 嗅探 + adapters/viewers（image/pdf/table/docx/text/markdown）+ focus trap + toolbar capabilities | 架构清晰的新子系统，仍在演化 |
| markdown-editor/（子目录） | ~50 KB + 8K 行文档 | 块级 Markdown 编辑器（parse/model/serialize/editor） | 探索性；与 SPEC §1.3「不做双模式硬切换」存在张力，需产品决策 |

### 2.3 原型痕迹（未完成/待定）

- index.html:27 注释：`Legacy tool-calls kept temporarily for non-migrated bits; flow/* is authoritative for stream`——旧 tool-calls.css 与 flow/ 双轨并存
- 预览双系统：`preview-modal.js`（旧）与 `file-preview/`（新）并存，`legacy-bridge.js` 桥接
- SPEC Phase 3 DoD 未勾选「对话流视觉与 Composer 对齐评审通过」；Phase 4（TaskRoot/PlanStep/Skill/MCP 前缀 chip）与 Phase 5（迁 desktop）全部未完成
- demo-data.js 的 thinking 内容混入无关的「杭州演出」搜索记录（mock 失真残留，评审时不可据此判断内容质量）
- reference 内部已有 `src/components/ChatComposer/` TSX 输入区骨架（ChatComposer.tsx / FileCard.tsx / InlineTag.tsx / types.ts），说明输入区已开始 React 化，但仅停留在静态骨架（无弹层、无发送链路）

---

## 3. 设计语言提炼

### 3.1 设计令牌体系（design-tokens.css + conversation-tokens.css）

| 维度 | 取值 |
|------|------|
| 字体 | 基准 14px；三档：14（body）/ 13（meta）/ 12（micro），禁止第 4 档 |
| 文字色 | **纯黑 + 透明度分层**：L0 正文 0.92–1.00、L1 叙事 0.55–0.68、L2 过程 0.36–0.48；刻意用 `#0a0a0a + opacity` 而非多灰 hex（`--text-primary/secondary/tertiary` 全部 `#000000`） |
| 背景 | 纯白页面/弹层/输入卡；悬浮 `rgba(0,0,0,0.035)`；展开输出块 `rgba(0,0,0,0.02)` |
| 边框 | `#E2E2E2` 极浅灰，hairline 1px |
| 强调色 | 绿族（mint #D1FAE5 / #10B981 / text #059669）+ 红 #EF4444 + 橙 #D97706；**无蓝、无紫** |
| 权限语义色 | 只读 #71717A / 计划 #B45309 / 目标 #0D9488 / 询问 #BE123C / 完全 #059669（各配浅底） |
| 圆角 | container 16 / popover 12 / card 8 / tag 6 / button 6 / badge 50% |
| 阴影 | 静态低存在感：composer `0 4px 20px rgba(0,0,0,0.04)`；popover `0 8px 24px -4px rgba(0,0,0,0.08)`；**hover 一律禁阴影** |
| 动效 | 时长 0.12/0.15/0.35s；spring `cubic-bezier(0.16,1,0.3,1)`；折叠用 `grid-template-rows 0fr→1fr` 180–280ms；运行点 pulse 1.4s；流式入场 translateY(3px)+fade，错开 ≤75ms |
| 对话流专属 | 图标列 16px 宽、图标 14px、rail 对齐 7px；消息间距 20px、节点内统一 8px、Action 间 4px；thinking 限高 168px、subagent 280px、输出 140px |

### 3.2 视觉哲学与禁令（SPEC §8.7）

1. **禁侧边 border / 竖轨时间线**（以透明度层级代替左侧竖线）
2. **禁 hover 阴影、禁 hover 背景大洗色**（hover 只变 opacity/字色）
3. 禁绿勾墙；4. 禁对话流内重审批卡（审批上提到 PermissionBar）；5. 禁预览/源码硬切换；6. 字号不超三档；7. 禁方块 spinner；8. 禁英文 `Parallel`（用「并行」）
- 文字渲染面向 Windows：`-webkit-font-smoothing: auto` + 纯色墨（不用父级透明度雾化），避免发虚
- 调性一句话：**过程淡、结论实、产物可点、确认独立**

### 3.3 与现有 tokens.css 的异同

| 项 | 原型 | 现有 tokens.css |
|----|------|-----------------|
| 色板 | 纯白 + 纯黑字 + 绿强调 | 暖灰 HSL（hsl(35,12%,94%) 系）+ 暖炭 accent + 蓝/紫保留（--accent-blue 仍在） |
| 字体档 | 严格 3 档（14/13/12） | 全谱 10–22px 12 档（chat 13.5px）+ ui-size small/large 缩放档 |
| 圆角 | 8–16 集中 | xs 4 → 2xl 12 六档 |
| 主题 | **仅浅色** | light/dark 双主题 + perf-tier（high/balanced/eco）+ ui-size gear |
| 阴影 | 静态、极轻 | 双层/三层低存在感阴影族 |
| 动效 | spring 系 | 同 spring 系（--transition-accordion 同为 cubic-bezier(0.16,1,0.3,1) 220ms），理念一致 |
| hover | 禁背景洗色 | 仍有 `toolRowHead:hover { background: color-mix(…2%) }` 等少量洗色残留 |

结论：**动效与"低存在感阴影"理念已趋同；色板、字阶、主题化是主要差异**。原型令牌无法直接引入，需要映射层。

---

## 4. 对话流规范要点（CONVERSATION_FLOW_SPEC.md）

### 4.1 五层叙事树（SPEC §4.1，核心设计）

```
SessionTurn → AssistantMessage
├─ ThinkingNode     L0 元过程：一行「思考 · 预览 · 时长」，展开限高 + 上下 fade
├─ TaskRoot / PlanStep  L0.5 计划根（当前步骤 + Purpose 流）
├─ PurposeNode      L1 调用目的：人话折叠行 + secondary 老虎机
│   └─ ActionRow    L2 折叠动作（动词 + 对象 + diff），展开见真实命令/输出
├─ SubagentRoot     L0.5 特殊根：两行（状态行 + 痕迹老虎机），展开限高面板内复用同套组件
├─ TextNode         L0 正文（primary 实 / interstitial 淡）
├─ ArtifactNode     生成文档 chip → Notebook 悬浮面板
└─ ComposingHint    流式尾提示
Composer 区（不进消息树）：PermissionBar → PlanProgressBar → InputShell
```

### 4.2 Purpose 模型与渲染契约

- `primary`（稳定人话目标）+ `secondary[]`（同目的下的小修正，老虎机滚动）
- 投影算法：`purposeKey = purposeId ?? hash(normalizePurpose(purposePrimary || explanation || humanize))`；无显式字段时用「同动词族 + 30s 时间窗 + 归一化文案一致」启发式合并
- 摘要文案三原则：折叠行是人话（「运行单元测试」而非 `npm run test:unit`）；命令只在展开；explanation 是模板 spam 则丢弃回退 humanize
- pending_approval **不进流**：抽到 PermissionBar 队列
- 生成文档 → Artifact chip + Notebook（hover 打开、点击 pin、拖拽、就地编辑 autosave，禁源码/预览硬切换）；代码路径 → 右侧文件面板
- 并行用「并行 N」文案，不用左边框

### 4.3 消息生命周期与状态机要点

- 工具状态：running / success / error / pending_approval；时态动词：running→「正在+基动词」，其余→过去式（已查看/已运行/已修改…）
- 展开体按需挂载；输出 DOM 预算对齐现有 `TOOL_OUTPUT_PIXEL_CAP`；流式热路径不进 immer
- 迁移顺序（SPEC §12.2）：flowProjector 纯函数+单测 → PurposeBlock+ActionRow 替换 flatten → Thinking 预览 fade → PermissionBar 上提 → SubagentRoot 换壳 → Artifact+Notebook → Plan/Task 根联动 → 删死代码

### 4.4 分期完成度（SPEC §13）

- Phase 0 文档与骨架：完成
- Phase 1 叙事树最小闭环：完成（Purpose 投影、折叠展开、Thinking、双 tone 正文、三档字号、8px 间距）
- Phase 2 独立壳层：完成（PermissionBar、Subagent 两行、pulse/老虎机、失败浅色）
- Phase 3 产物与精致度：**基本完成，仅「视觉与 Composer 对齐评审」未勾选**
- Phase 4 计划/任务根、Phase 5 迁 desktop：未开始

---

## 5. 与现有实现对比表

| 维度 | 原型 | 现有实现 | 差距 | 建议 |
|------|------|----------|------|------|
| 输入区载体 | contenteditable 富文本（@ 文件引用标签、@@ 目录树、Skill 标签内嵌） | textarea + slash 菜单（IME 组合处理、autogrow ≤4 行、L2/L3 停止） | 原型交互更"富"；现有更稳（IME/选区/无障碍） | 富标签交互保留为探索项；textarea 方案不动 |
| 命令菜单 | / 与顿号 、，4 条内置项 + skill 提示 | / 实时过滤 + loadSkillSlash + listbox 键盘导航 + aria-activedescendant | 现有大幅领先（键盘、无障碍、真实 skill 数据源） | 不回迁；可在现有菜单上补充顿号 、触发 |
| ＋/技能菜单 | plusPopover 两项 + skillSubmenu 级联搜索 | ComposePlusMenu 六项（文件/技能/插件/MCP/扩展中心/定时）+ Menu 基座 | 现有功能面与交互规范均领先 | 不回迁 |
| 附件展示 | file-card：30+ 文件类型彩色图标、图片缩略、入场动画、hover 移除徽标、点击预览 | attachChip：paperclip 图标 + 图片缩略 + 移除钮 | 原型视觉精致度与信息量（类型可辨）领先；点击预览缺失 | **提取图标资产**（icon-assets.js 为 React 图标组件）接入现有附件条，补点击预览 |
| 权限菜单 | 5 模式 + 短描述 + 信息 tooltip + 语义色 | PermissionModeMenu（已有） | 原型多"短描述+tooltip"与语义配色 | 低优先：把语义色与 tooltip 补进现有菜单 |
| 模型选择 | 分组模型 + frameless 搜索 + 思考强度滑杆（关/低/中/高/极高） | ModelBadgePickerMenu 等（真实连接 store） | 原型的思考强度滑杆为 demo 装饰；现有数据真实 | 滑杆需产品确认与模型能力映射后再说 |
| 流式 markdown | markdown-lite 全量重渲染（demo 级） | AsyncMarkdownBlock：流式纯文本+caret，完成态 Rust 异步渲染（SoT），worker 兜底 | **原型远弱于现有**（渲染质量/性能/IPC 预算） | 绝不回迁渲染层；只借鉴「流式纯文本 + 完成态渲染」同款策略（现有已做到） |
| 工具调用展示 | **Purpose 树**：人话目的折叠 + Action 行 + secondary 老虎机 + 展开命令/输出 + 「· N 步」组摘要 | 扁平工具行（显式 flatten，注释「避免 N 步汇总头」）+ turnId 并行组「Parallel（N）」+ 行内审批卡 | **最大差距**：现有无 Purpose 叙事层，审批在流内，并行用英文 | **P0 整合**：移植 flow-projector 纯函数，重构 CompactToolRow 为 ActionRow，并行改「并行 N」 |
| 思考展示 | 一行预览 + 限高 fade + 时长 | MessageThinkingBlock（预览、展开、ThinkingTimer 自管秒数） | 功能已覆盖；原型多"限高上下 fade"视觉细节 | 低成本：给现有思考块补 fade 与限高 |
| 审批 | PermissionBar 独立于 Composer 上方，流内无审批卡 | ApprovalAskCard 行内卡片 + ApprovalDock 底部 sticky 条 + 批量批准栏 | 定位已部分上提（ApprovalDock）；但流内行内卡仍存在 | P1：把 pending_approval 从流内行完全移到 ApprovalDock/PermissionBar 位 |
| 子 agent | SubagentRoot：两行 + 痕迹老虎机 + 缩进限高面板（复用同套节点） | InlineAgentPanel（自带输入区与完整子流外壳，懒加载） | 现有更"重"；原型「两行根 + 老虎机」更扫读 | P1：以两行根+痕迹重构 InlineAgentPanel 外壳 |
| 计划/目标进度条 | 单条中枢：模式徽章、步骤老虎机、计数、时长、编辑目标、暂停/停止、向上展开步骤抽屉 | PlanGoalRibbons：计划条（含批准动作）+ 目标条（进度百分比）+ 停止 | 原型交互更完整（老虎机/时长/抽屉）；现有已接真实状态（goalTasksDone/Total） | P2：把老虎机与步骤抽屉并入 PlanGoalRibbons |
| 弹层系统 | 手写 popovers.css（定位避让、spring 入场） | ui/Menu 基座（碰撞避让、键盘导航、position.ts 单测、focus restore） | 现有成熟度显著领先 | 不回迁弹层本体 |
| 文件预览 | 双系统：旧 preview-modal（图片编辑/CSV/伪 PDF）+ 新 file-preview（shell+router+sniff+viewers） | FilePreview / FileViewerCard / ImageGallery（真实文件流、缩略图、markdown 渲染） | 原型的 sniff+adapter 路由思想值得借鉴；现有数据链路真实 | P2：对照 sniff/viewer 架构审计现有 FilePreview 扩展点 |
| 生成文档产物 | Artifact chip → Notebook（hover/pin/拖拽/就地编辑 autosave） | 无对应能力（文档仅以 md 正文/链接呈现） | 全新能力 | P2 新能力立项 |
| 消息列表 | 全量渲染 `mountEl.innerHTML=''` | MessageVirtualizer 窗口化 + 固定 pin 区 + 搜索高亮 + older 步进 | 现有大幅领先 | 不回迁；投影结果必须接入现有虚拟列表 |
| 设计令牌 | 独立双 token 文件（纯黑/白 + 三档字号 + 禁令） | tokens.css（暖灰双主题 + ui-size + perf-tier + 12 档字号） | 理念趋同、体系分叉 | 建立 `--flow-*` 映射层并入 tokens.css，不引入原型 CSS 文件 |
| 状态管理 | 无（demo 静态数据） | layoutStore / streamingStore / useChatStream 全链路 | 现有为唯一真相源 | 投影层在现有 store 之上做纯函数 |

---

## 6. 分项评估（亮点 / 风险 / 成熟度）

### 6.1 值得整合到现有 React 实现的设计（按价值）

1. **Purpose 叙事投影（flow-projector.js）**——亮点：把 10 次工具调用折成 1–3 行人话目的，是"扫读"体验的核心；纯函数、无 DOM 依赖，移植成本低且可单测。风险：启发式合并（30s 窗 + 动词族）在真实流中的误合并；需要 purposeId 协议演进兜底。成熟度：高（spec Phase 1 完成）。
2. **工具人话化与 spam 过滤（tool-presentation.js）**——与现有 toolPresentation.ts 同源，差异在 `toolLabelFromArgs` 的 shell 命令 humanize（tsc/vitest/git 识别）、`isHumanExplanation` 判定、inspect 分组语义。亮点：直接并入现有 api 层。风险：与现有 `humanizeShellCommand` 重复实现，需合并而非新增。
3. **对话流视觉禁令**（禁侧边线/禁 hover 洗色/三档字号/失败浅色/「并行 N」文案）——亮点：零代码架构成本，纯 CSS 与文案收敛。风险：需过暗色与 ui-size 档。成熟度：高。
4. **Thinking 预览行 + 限高 fade**——低成本补强现有 MessageThinkingBlock。
5. **附件 file-card 类型图标资产**——icon-assets.js 已含 30+ 官方风格 SVG，提取为 React 图标组件即可点亮现有附件条。
6. **Subagent 两行根 + 痕迹老虎机**——扫读性明显优于现有 InlineAgentPanel 外壳。
7. **PermissionBar 上提**——与现有 ApprovalDock 定位一致，属布局与组件边界调整。
8. **Artifact chip + Notebook**——全新能力，阅读态 + 就地编辑 autosave 的设计完整（spec §7.6 已冻结决策）。

### 6.2 与现有实现重叠（已有能力，勿重复建设）

- 命令菜单（现有键盘导航/aria/IME 全链路更成熟）
- ＋菜单与技能入口（现有六项 + Menu 基座）
- 附件添加与粘贴（现有 onPasteImage + file input 链路；原型粘贴任意文件可补）
- 权限模式选择（双方案都有）
- 模型选择（现有真实 store 数据）
- 思考折叠展示（现有 MessageThinkingBlock + 计时）
- 工具行折叠/展开/diff/输出/重试（现有 CompactToolRow 体系）
- 批量审批（现有 BatchApprovalBar）
- 图片预览与文件查看（现有 ImageGallery / FilePreview）
- 消息虚拟列表、搜索高亮、pin、older 步进（现有 MessageVirtualizer）
- 流式 markdown 渲染（现有 Rust 异步渲染，远强于原型）
- 弹层基础件（现有 ui/Menu 带碰撞避让与键盘）

### 6.3 原型中仍不成熟/需产品决策的部分

- **markdown 块编辑器**（docs/markdown-editor 约 8K 行）：与 SPEC §1.3 非目标（不做预览/源码硬切换）张力未解，spec 修订记录 1.1 已标注"CROSSCUTTING 冻结决策"，需产品拍板后另行立项
- **输入区 contenteditable 富标签**（@ 引用 / @@ 目录树）：选区管理靠 `savedRange` 手写，无 IME/无障碍保障；现有 textarea 方案是正确基线
- **思考强度滑杆**：demo 装饰，未与模型能力映射
- **预览双系统并存**：preview-modal.js 应归档，file-preview/ 需独立评审后再谈整合
- **plan-progress-bar demo 自演**（3.5s 自动步进、confirm() 原生弹窗）：只可借鉴交互结构，不可照搬
- **flow/tool-calls.css 双轨**：spec 已声明 flow/* 为准，旧 tool-calls.css 待清理

---

## 7. 整合建议（优先级排序）

### P0 — 纯函数与设计收敛（低成本、可单测、不触碰渲染链）

1. 移植 `flow-projector`（projectPurposes / projectMessage / projectConversation）为 `apps/crish-desktop/src/api/flowProjector.ts`，对齐现有 toolPresentation 测试风格补单测（spec §12.2 第 1 步）
2. 将 `tool-presentation` 的增量（shell humanize、spam 过滤、isHumanExplanation、inspect 组语义、group label「· N 步」）合并进现有 `toolPresentation.ts`，**合并而非复制**
3. 落地视觉禁令：tokens.css 增加 `--flow-*` 映射段（三档字号、L0/L1/L2 色阶、无 hover 阴影/洗色、失败浅色），文案「Parallel」→「并行」；通过暗色与 ui-size 回归
4. Thinking 块补限高 + 上下 fade（对照 `--flow-thinking-max-h` 168px 与 motion 设计）

### P1 — 组件重构（复用现有骨架，改动面可控）

5. 新增 `chat-flow/PurposeBlock.tsx` + `ActionRow.tsx`，在 `MessageContent` 中把工具栈从扁平行升级为 Purpose 树（展开交互、secondary 老虎机、Action 展开命令/输出）；保留现有 diff/重试/路径回调不变
6. pending_approval 从流内行移除，统一由 ApprovalDock（对齐 PermissionBar 定位）承载；清理 CompactToolRow 的 ApprovalAskCard 分支与 BatchApprovalBar 的流内形态
7. 以「两行根 + 痕迹老虎机 + 缩进限高面板」重构 InlineAgentPanel 外壳（内部复用现有组件与输入区）
8. 附件条升级：引入图标资产（icon-assets → `ui/FileTypeIcon.tsx`），补点击预览（复用 FilePreview）

### P2 — 新能力与增强（需排期）

9. Artifact chip + Notebook 面板（hover/pin/拖拽/就地编辑 autosave），复用 markdown-lite 思路但渲染走现有 Rust 渲染
10. PlanGoalRibbons 增强：步骤老虎机、时长、向上展开步骤抽屉（接真实 goalTasks 数据，删 demo 自演）
11. file-preview sniff/adapter 路由思想对照审计现有 FilePreview 的扩展点（评估是否引入 adapter 注册制）
12. 模型菜单思考强度滑杆——先与模型能力映射对齐，再决定是否立项

### P3 — 探索/暂缓

13. contenteditable 富标签输入（@ 引用 / @@ 目录树）——先做选区/IME 可行性验证
14. markdown 块编辑器——产品决策冻结后再谈
15. 原型 `src/components/ChatComposer/` TSX 骨架：仅作视觉参考，不并入（与现有 ChatComposer 职责重叠）

---

## 8. 风险提示

1. **令牌体系双轨漂移**：原型 token（纯白/纯黑/绿）与 tokens.css（暖灰/双主题/缩放）差异大，禁止直接 import 原型 CSS；必须建立映射层并跑暗色、ui-size small/large、perf-tier 回归，否则会重现历史上「样式分叉」问题（spec §2.1 已列为根因）。
2. **渲染层不可回迁**：markdown-lite 与全量 `innerHTML=''` 渲染是 demo 手段；现有 Rust 异步渲染 + MessageVirtualizer 是生产真相源。Purpose 树必须接入虚拟列表（高度变化通知 Virtualizer，spec §11.3）。
3. **审批上提的联动风险**：`ApprovalAskCard` 调用链（useChatApprovalHandlers / useChatMessageState）与既有测试（ribbon/approval 相关）会被改动波及，需分批迁移而非一次性替换。
4. **Purpose 启发式误合并**：无 purposeId 时 30s 窗 + 动词族合并可能在快速换目标时错误归并；上线前需协议补 `purpose_id`（spec Phase B）与 dev 警告（spec §4.3.2）。
5. **"做一半"历史风险**：spec §2.1 的问题总账（文档与 reference 脱节、截图驱动、Mock 失真、交付无 DoD）同样适用于本次整合——建议按 spec §13 分期 + DoD 清单推进，每期可演示闭环；迁移完成后统一归档 reference 中已迁移部分，避免双真相源。
6. **原型内容不可作为质量依据**：demo-data 的 thinking 含无关噪声（杭州演出记录）、plan 条为自演数据；评审视觉时仅看设计意图。
7. **a11y 与键盘**：原型的弹层/折叠/老虎机均无键盘方案（spec §9.1 仅口头约定）；整合时必须复用现有 Menu 基座与 aria 契约（expanded/controls/activedescendant）。
8. **性能预算**：Purpose 展开体按需挂载、输出限高与 DOM 预算对齐现有 `TOOL_OUTPUT_PIXEL_CAP`；流式热路径不经 immer（spec §11.3）。

---

## 附录 A — 参考文件索引

| 内容 | 路径 |
|------|------|
| 对话流权威规格 | reference/chat-composer-component/CONVERSATION_FLOW_SPEC.md |
| 投影层 | reference/.../js/flow-projector.js |
| 工具人话化 | reference/.../js/tool-presentation.js |
| 设计令牌 | reference/.../css/design-tokens.css、conversation-tokens.css |
| 现有输入区 | apps/crish-desktop/src/components/chat-composer/ |
| 现有工具栈 | apps/crish-desktop/src/components/chat-tool-call/ |
| 现有消息行 | apps/crish-desktop/src/components/chat-message-row/、chat-message-list/ |
| 现有令牌 | apps/crish-desktop/src/styles/tokens.css |
