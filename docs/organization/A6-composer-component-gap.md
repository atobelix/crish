# A6 主对话界面原型组件盘点 + token 体系对比 + 待做清单

> 生成日期：2026-08-04
> 分析对象：`reference/chat-composer-component/`（独立 HTML/CSS/JS 原型）
> 对比基准：主项目 `apps/crish-desktop/src/styles/tokens.css`、`z-index.css`、`tokens/zindex.ts` 与 `src/components/`（chat-card / chat-composer / chat-message-row / chat-tool-call / agent-card 等）
> 性质：只读分析，未改动任何代码
> 前置文档：A4-chat-composer-review.md（2026-08-02 评审）——本文聚焦"组件盘点 + 半成品标注 + token 差距 + 待做清单"，A4 聚焦整合策略，二者互补

---

## 一、原型组件盘点

### 1.1 布局骨架（index.html:57-66, 229-560）

| 区块 | DOM 结构 | 功能 | 状态 |
|---|---|---|---|
| `.chat-app-layout` | 纵向 flex，max-width 720px 居中 | 全屏主对话容器 | ✅ 完整（composer.css:40） |
| `.chat-stream-container` → `.chat-stream-inner`（#streamMount） | 可滚动消息流，JS 渲染挂载点 | 对话流渲染宿主 | ✅ 完整（JS 由 FlowMount 渲染） |
| `.composer-wrapper` | 底部锚定：`#permissionBarHost` + `#planProgressBar` + `.composer-container` | 输入区整体容器 | ✅ 完整 |

### 1.2 计划进度条 plan-progress-bar（index.html:71-152，css/flow/plan.css + css/popovers.css:660-839）

| 子元素 | DOM 结构 | 功能 | 状态 |
|---|---|---|---|
| `.plan-goal-panel`（order 1） | `#goalEditField`（contenteditable，data-placeholder） | 目标编辑（grid-rows 0fr→1fr 上展开） | ⚠️ 半成品：样式+JS 展开逻辑齐，但**无关闭/保存按钮**（JS 引用 `planGoalPanelClose`/`goalSaveBtn` 在 HTML 中不存在，popovers.js:483-484、595-607 为悬空引用）；只能再点徽章收回 |
| `.plan-step-list`（order 2） | `#planStepListInner` → 5 个 `.plan-expanded-step`（completed/active/pending） | 步骤抽屉（上展开） | ⚠️ 半成品：样式/JS 齐（点击条目滚动到 stream 中对应步骤，composer-core.js:207），但展开动画由两套 class 控制（见 §1.6） |
| `.plan-collapsed`（order 10） | `#planModeBadge` + `.plan-divider-v` + `#planActiveTaskBox`（`#planRollerTrack` 5 条 `.plan-step` + `#planStepCounter`）+ `.plan-right-controls`（`#planDuration` + `#planEditQuickBtn`/`#planPauseToggleBtn`/`#planStopQuickBtn` + 展开 chevron） | 单行锚条：模式徽章 / 步骤老虎机滚动 / 计数器 2/5 / 计时 / 编辑·暂停·停止 / 展开 | ✅ 完整（交互见 popovers.js:472-652：老虎机 translateY 滚动、counter 同步、计时、暂停、停止 confirm、徽章切换 goal/plan 文案） |

### 1.3 审批条 permissionBarHost（index.html:68，js/components/PermissionBar.js）

| 元素 | 功能 | 状态 |
|---|---|---|
| `.flow-permission-bar`（两行：summary+风险徽章+15s 倒计时+「还有 N 条」／ command + 拒绝/批准/始终允许） | 审批队列横向条，resolve 后 480ms 重挂载下一条 | ✅ 完整（含 is-resolved 态、队列消费、onResolved 回调）；风险三档 low/medium/high 配色齐 |

### 1.4 输入区 composer-container（index.html:155-225）

| 子元素 | 功能 | 状态 |
|---|---|---|
| `.file-zone` → `.file-card`（document/table/pdf/image 各类型）| 附件卡 + 类型图标水合 + 图片缩略图 + 点击预览 + 移除 | ✅ 完整（composer-core.js handleFiles/removeFileCard + 入场动画 + liveFileStore Map） |
| `.input-zone` → `.composer-editable`（contenteditable） | 富输入：`.rich-inline-tag`（@ 文件引用 / skill-type 标签，可点击预览、可删） | ✅ 完整（popovers.js insertRichInlineTag / hydrateAllFileIcons）；预置内容含 docx/csv/pdf/pptx/json/py 6 个引用标签 + 1 个 skill 标签 |
| `.action-bar`（左：`#btnPlus` + `#btnPermission`；右：`#btnModel` + `#btnSend`） | 附件/Skill 入口、权限 pill（5 色档）、模型 pill（厂商分组+思考强度联动）、圆形发送钮（active 态） | ✅ 完整（权限 5 模式配色切换 popovers.js:401-430；模型/滑杆联动 333-398；发送钮状态 35-43） |
| `.drag-drop-overlay` | 拖拽文件遮罩（dragenter/leave/drop + 计数器） | ✅ 完整（popovers.js:432-470） |

### 1.5 消息流渲染（stream-renderer.js → FlowMount → FlowComponents）

| 组件（js/components/） | 节点类型 | 功能 | 状态 |
|---|---|---|---|
| FlowMount.js | — | 装配器：投影→组件树、会话渲染、审批条挂载、滚动链 | ✅ 完整 |
| ThinkingBlock.js | thinking | 思考折叠块（preview/elapsed/live） | ✅ 完整 |
| TextBlock.js | text | primary 正文（markdown-lite）+ interstitial 老虎机入场 | ✅ 完整 |
| PurposeBlock.js | purpose | 意图块（主次文案 + action 列表） | ✅ 完整 |
| ActionRow.js | action | 工具行（verb/object/status/command/path） | ✅ 完整 |
| TaskRoot.js（=PlanRoot） | plan/task | 里程碑步骤列表（completed/active 入流，pending 仅留在底部抽屉；children 可折叠） | ✅ 完整 |
| SubagentRoot.js | subagent | 子任务折叠（traces 列） | ✅ 完整 |
| ArtifactChip.js + NotebookPanel.js | artifact/document | 文档芯片 + notebook 展开面板 | ✅ 完整 |
| ComposingHint.js | composing | 整理中提示（pulse + 更新/消失 API） | ✅ 完整 |
| SessionStart.js | — | 会话起点（logomark + 模式状态），插在流顶部 | ✅ 完整 |
| FlowTimelineRail.js | — | 左侧 rail 三态（静默/运行/子任务）更新 | ✅ 完整 |
| FlowScrubber.js | — | 流内 scrubber（拖动定位） | ✅ 完整（demo 中用） |
| dom-utils.js | — | el/esc/pulseDotHtml/scrollChain 工具 | ✅ 完整 |

### 1.6 JS 模块总表与半成品标注

| 模块 | 职责 | 交互状态 |
|---|---|---|
| composer-core.js | 发送钮状态、粘贴、文件卡、plan bar（旧版：is-expanded/暂停/计时/滚动定位） | ⚠️ **与 popovers.js 计划条逻辑重复绑定**：同一批按钮（planExpandTrigger/pauseBtn 等）在两处各自 addEventListener；`is-expanded`（plan.css:158）与 `expanded-steps`/`expanded-goal`（popovers.css:718/731/782）两套 class 并存，互不清理 |
| popovers.js | 弹层定位/互斥、选区保存、富标签、图标水合、模型过滤、滑杆、权限配色、拖拽、计划条（新版） | ⚠️ 计划条双实现；`planGoalPanelClose`/`goalSaveBtn` 悬空；**slash/at/tree 弹层无任何键盘触发与条目点击逻辑**（见下） |
| skill-manager.js | skill 搜索过滤 + 点击插入 skill-tag | ✅ 可用，但子菜单无入口（plus 菜单「使用 Skill」不展开级联） |
| tool-presentation.js | 工具人话化纯函数（标签/动词族/路径命令抽取/diff 统计） | ✅ 高成熟度 |
| flow-projector.js | MessageToolCall[] → FlowNode 树（purpose 投影/30s 合并/时态化/pending 抽离） | ✅ 高成熟度，纯函数 |
| stream-renderer.js | FlowMount 薄封装 | ✅ |
| demo-data.js | 5 轮对话 + plan 5 步 + pendingApprovals 1 条 | ✅ 演示数据（写死） |
| markdown-lite.js | 极简 MD 渲染 | ⚠️ 仅 demo 用，远不及生产 |
| preview-modal.js | **已废弃空壳**（file-preview 迁移占位） | ⚠️ 死代码（保留防 404） |
| file-preview/（13 文件） | PreviewRouter + sniff + PreviewShell（focus trap）+ toolbar + 7 adapters/viewers | ✅ 完整新子系统；`preview-modal.css`/`tool-calls.css` 仍被 index.html 加载但已无消费方（死 CSS） |
| markdown-editor/（30+ 文件） | 块级 MD 编辑器（parse/model/editor/selection/table…） | ⚠️ 独立测试页演示；**index.html 只加载其 CSS 未加载 JS**——主页面内为死 CSS；属探索性，需产品决策 |

### 1.7 弹层 popover 总表（index.html:229-559）

| 弹层 | 触发 | 行为状态 |
|---|---|---|
| #slashPopover（/ 与 、呼出命令+Skill 4 条） | 无（无 keydown 监听） | 🔴 **静态 DOM，无 JS**：不会弹出、条目不可点（insertRichInlineTag 已实现但从未被调用） |
| #atPopover（@ 引用文件 3 条） | 无 | 🔴 静态 DOM，无 JS |
| #treePopover（@@ 目录树 + 搜索 + 范围切换） | 无 | 🔴 静态 DOM，无 JS；`treeSearchInput`/`btnScopeCurrent`/`btnScopeGlobal` 无监听 |
| #plusPopover（添加本地文件 / 使用 Skill） | `#btnPlus` ✅ | ⚠️ 弹出可用，但 `menuAddFile` 未绑定（不触发 hiddenFileInput）；「使用 Skill」不展开 #skillSubmenu 级联 |
| #skillSubmenu（Skill 搜索+3 条） | 无 | ⚠️ 子菜单样式/搜索 JS 有（skill-manager.js），无打开入口 |
| #modelPopover（10 厂商分组 + 搜索 + 思考强度滑杆） | `#btnModel` ✅ | ✅ 完整（过滤/选中/滑杆联动按钮文案） |
| #permissionPopover（5 模式 + tooltip + 短描述） | `#btnPermission` ✅ | ✅ 完整（选中同步按钮色/文案） |

---

## 二、token 体系对比

### 2.1 原型 token 分类（brand.css 基元 → design-tokens.css 语义 → conversation-tokens.css 对话层）

| 文件 | 分类 | 内容 |
|---|---|---|
| brand.css（基元层唯一真源） | 色温 | `--tint`/`--tint-amt`（正黄旋钮，当前 0%） |
| | 纸面 | `--paper-raised/paper/paper-sunken/paper-deep`、`--wash-hover/active` |
| | 墨阶 | `--ink` 5 档（primary→ghost，暖灰 L10~78%） |
| | 线 | `--line-soft/line/line-strong` |
| | 品牌绿 | `--brand/#10B981`、`--brand-deep`、`--brand-soft/line/glow`（铁律：只标「agent 活着」） |
| | 语义色 | `--sem-done`（刻意无彩）、`--sem-warn`（琥珀）、`--sem-error`（赤土）、`--sem-neutral`；各带 -soft/-line 派生 |
| | 字体 | `--font-sans/mono`、`--tracking-tight/base/wide` |
| | 材质 | `--bevel-top`（顶部内高光）、`--lift-sm/md/lg`、`--ring-brand` |
| | 几何 | `--r-xs~xl/full`（4/6/8/12/16/999px） |
| | 运动 | `--ease-out/soft`、`--t-micro/fast/base/slow`（90/140/200/320ms） |
| design-tokens.css | 排版 | `--font-base/title/body/item/sub/micro`（14/15/14/14/13/12） |
| | 文本 | `--text-primary/secondary/tertiary/placeholder/disabled` |
| | 面 | `--bg-page/composer/popover/surface/hover/active` |
| | 权限 5 态 | `--perm-readonly/plan/ask/goal/full` + `-bg`（风险梯度：无彩→琥珀→品牌绿→赤褐） |
| | 圆角 | `--radius-container/preview/popover/search/card/thumb/tag/icon/option/button/badge` |
| | 投影 | `--shadow-composer/popover/pdf-page/thumb/thumb-hover/tooltip` |
| | 动效 | `--dur-fast/normal/smooth`、`--ease-default/spring` |
| conversation-tokens.css | 流字号 | `--flow-font-body/meta/micro`（14/13/12） |
| | rail 几何 | `--flow-icon-col/icon-size/icon-gap/row-h/rail-x`（16/14/6/24/7px） |
| | rail 三态 | `--flow-rail/rail-live/rail-live-fade/subagent-rail` |
| | 间距 | `--flow-gap-msg/node/action`（22/8/4px） |
| | 运动 | `--flow-spring/spring-soft`、`--flow-accordion-ms/roller-ms/slot-ms/hover-ms/entrance-ms/pulse-ms`（180/240/260/90/160/1200ms） |
| | 别名/兼容 | 旧名映射（`--flow-color-l0/1/2`、`--op-*` 等） |

### 2.2 主项目 token 分类（styles/tokens.css，约 400 变量 + 双主题 + 三密度档）

| 分类 | 内容 |
|---|---|
| 背景 | `--bg-primary/secondary/tertiary/card/elevated/workspace/subtle/hover/active`（light 暖灰 + `html[data-theme="dark"]` 全量覆盖） |
| 文本 | `--text-primary/secondary/tertiary/muted`、`--text-danger/success/on-danger`、`--ui-text-*`（5 色） |
| 线 | `--border-color/subtle`、`--hairline/hairline-strong` |
| 语义色 | `--color-success/warning/error/info` + `-bg/-border`（各三件套）、`--danger-color/--warning-color` legacy 别名 |
| 强调色 | `--accent-color/hover/soft` + `--accent-orange/green/red/blue/violet` + `-light`、`--accent-chart-in/out`、`--color-active` |
| 语法高亮 | `--syntax-*`（9 色，light/dark 双套） |
| 终端 | `--terminal-*`（6）+ `--xterm-*`（16 色调色板）+ `--mac-dot-*` |
| 圆角 | `--radius-xs~2xl/full`（4/5/6/8/10/12/9999） |
| 阴影 | `--shadow-sm/md/lg/drag/2xl`（统一 `--shadow-color` 源） |
| 动效 | `--transition-spring-layout/micro/fast/smooth/enter/exit/spring/popover-enter/popover-exit/modal-enter/accordion/press/skeleton/spin` + `--duration-instant/micro/fast/normal/slow/enter/exit` + `--easing-enter/exit/emphasized` |
| 字体 | `--font-size-xxs~2xl`（11 档，`--font-size-adjust` 全局偏移）+ `--font-weight-*`（5）+ `--letter-spacing-*`（6） |
| 密度 | `--space-0_5~16`（17 档 2~64px）+ `--control-height(-sm/xs/lg)` + `--control-pad-*` + `--icon-size(-sm/lg)` + `--line-height-*`（8） |
| 面板壳层 | `--card-header-min-height/pad/gap`、`--panel-pad/gap/sec-gap`、`--tab-*`、`--row-height` |
| 布局 | `--header-height`、`--sidebar-width`、`--chat-col-max(-wide)`、`--settings-content-max`、`--breakpoint-sm/md/lg`、`--chat-footer-fade` |
| 密度档 | `[data-ui-size="small"|"large"]` 整体覆盖字号/控件/间距/圆角（UI Size Gear） |
| 性能档 | `html[data-perf-tier="high"|"balanced"|"eco"]`（eco 全动效 0ms） |
| 其他 | `--bg-glass/backdrop-blur`、`--focus-ring(-strong)`、`--opacity-disabled`、`--window-close-*`、`--bg-overlay`、`--titlebar-*` |

### 2.3 主项目有、原型缺的 token（差距清单）

| 类别 | 主项目 | 原型现状 | 缺口评估 |
|---|---|---|---|
| **语义色** | `--color-success/warning/error/info` + 各 `-bg/-border` 三件套 | 仅 `--sem-done/warn/error/neutral`（done 刻意无彩、error=赤土、warn=琥珀；**无 success、无 info/blue**） | ⚠️ 高：success 是有意设计决策（品牌绿独占），需在整合时明确"完成态到底要不要绿"；info/blue 全缺，状态类组件（提醒条/链接/信息徽章）无落点 |
| 状态色 | `--text-danger/success`、`--ui-text-*`、`--color-active` | 无等价（原型用墨阶 + 3 语义） | ⚠️ 中：若整合"模型在线/缓存命中"等状态需补 |
| 强调色板 | `--accent-blue/violet`、`--accent-chart-in/out`、语法高亮 9 色 | 无 | 中：diff 高亮、图表、代码着色需移植（原型 `--diff-add/del` 仅两色） |
| **密度/性能档** | `[data-ui-size]` 三档 + `--space-*` 17 档 + `--control-height` + `--font-size-adjust` | 全硬编码 px，无任何档位机制 | ⚠️ 高：整合后桌面端密度齿轮与紧凑模式无法继承 |
| `[data-perf-tier]` high/balanced/eco | 动效/毛玻璃整体关停 | 无 | 中：低端机降级能力缺失 |
| **z-index 体系** | `--z-*` 32 变量（z-index.css 唯一真源 + tokens/zindex.ts 双源 check:zindex 校验） | **无 token**：62 处硬编码散落各 css（popovers 9999/10000/10010、preview-modal 9999、shell 9999、composer 100/90/20…） | ⚠️ 高：原型层叠几乎全靠 9999+ 数值竞争，整合前必须建立 `--z-*` 层 |
| **动效时长命名** | `--transition-*` 12 项 + `--duration-*` 7 项 + `--easing-*` 3 项（含 enter/exit 分离） | `--t-*` 4 档 + `--dur-*` 3 档 + flow-* 6 项（90~1200ms），部分规则内散写 180/220/240ms 字面量 | 中：原型的"入场/离场分离"与"popover/modal 专用"档位缺失 |
| 暗色主题 | `html[data-theme="dark"]` 全量变量覆盖（theme-dark.css） | 纯亮色，无 data-theme | ⚠️ 高：桌面端是深色优先产品，原型全部配色需双套化 |
| 面板基准 | `[data-panel]` 基准样式 + `--bg-overlay`/`--bg-glass`/`--backdrop-blur` | 无 | 中 |
| 布局列宽 | `--chat-col-max(760px)/wide(840px)`、`--settings-content-max` | `.chat-app-layout` 硬编码 720px（composer.css:40 附近） | 低 |
| 行高阶梯 | `--line-height-*` 8 档 | 无（散写 1.5 等） | 中 |
| 焦点环 | `--focus-ring(-strong)` | 仅 `--ring-brand`（brand-glow 3px） | 低 |

### 2.4 主项目 z-index 双源 vs 原型

| 项 | 主项目 | 原型 |
|---|---|---|
| 变量数 | 32 个 `--z-*`（基础 7 / 侧栏 3 / 弹层 5 / 浮层 4 / 模态通知 8 / 设置内 4 / 顶层 3） | 0 |
| 真源 | styles/z-index.css（CSS）+ tokens/zindex.ts（TS，`check:zindex` 脚本校验两源一致） | — |
| 实际使用 | CSS 全部消费 `var(--z-*)`；TS 组件 import 常量 | 62 处字面量：popovers.css 9999/10000/10010、preview-modal.css 9999、file-preview/shell.css 9999、composer.css 100/90/20、scrubber.css 50/100 等 |
| 结论 | 原型无等价物，且数值体系（9999 级）与主项目分层语义（200→400→9000→10000→100000）不同，**不可直接平移**，需按主项目语义重排 | |

---

## 三、主项目有而原型没有的组件（值得补的参照物）

| 主项目组件 | 形态 | 原型缺失点 | 值得补吗 |
|---|---|---|---|
| agent-card/ApprovalAskCard.tsx（`approval-card`）+ chat-card/ApprovalDock.tsx（悬浮 dock） | 审批**卡片**（stream 内单卡，含 tool/msg 定位、rollback 文案）+ 顶部悬浮 dock 滚动定位 | 原型只有横向审批条（permissionBarHost），无 stream 内审批卡形态、无「待审批」悬浮指示 | ✅ 补：审批条是原型新方案，但"长审批流程的进度可见性"需要卡+dock 双形态验证 |
| chat-tool-call/ChatToolCallBlock + ToolCallDiffPreview + ToolCallOutput + CompactToolRow | 工具调用卡片：header（名称/状态/时长）+ diff 预览 + output 折叠（代码查看） | 原型 flow 用 purpose/action 行表达工具，**无 diff 卡、无 output 代码视图**（demo 数据自带 Cargo.toml/lib.rs 大段 output 但只截断展示） | ✅ 补：diff 预览是 agent 产品的核心可信度面 |
| chat-message-row/MessageActionsBar（复制/置顶/撤回到此处）+ AssistantMessageActionsBar（重新生成 + 追问建议 chips） | 消息尾部操作条 + 建议 chip | 原型消息流纯展示，无任何消息级操作 | ✅ 补：验证"操作条 vs 流内嵌"两种位置方案 |
| chat-card/ChatStatusRibbons + PlanGoalRibbons + RunNoticeBar + SetupHintBanner | 会话状态 ribbon（运行/完成/计划待批）+ 空态提示条 | 原型仅 SessionStart 一行状态（流内） | ✅ 补（轻量）：计划/目标 ribbon 与计划进度条的关系值得在原型验证 |
| chat-composer/ChatQueuePanel | 发送队列面板（多条待发消息预览） | 无 | ✅ 补（可选）：agent 长输入时代的多消息队列 UX |
| chat-composer/ComposerSlashMenu | 命令菜单（键盘驱动、过滤、分组） | 原型 slashPopover 是静态 DOM（无触发无点击） | ✅ 补：这正是原型 1.7 的 P0 接线项，接线后与主项目形态对照 |
| chat-message-row/ThinkingTimer + CacheMetricsBadge | 思考计时徽章 / 缓存命中徽章 | 原型 thinking 块有 elapsed，无实时计时徽章 | ⭕ 可选 |
| chat-card/ChatHeader + ChatHeaderMore + ProjectPickerMenu | 会话头（标题/模型/项目切换/更多菜单） | 原型刻意无 header（设计决策） | ⭕ 不建议补（与原型"无 header"理念冲突，记录即可） |
| chat-card/ChatEmptyState | 空会话引导 | 无（session-start 可视为弱空态） | ⭕ 可选 |
| chat-message-list/MessageVirtualizer | 虚拟化长列表 | 原型全量渲染（demo 规模 OK） | ⭕ 不补（实现层问题，原型不验证） |

---

## 四、待做清单（按优先级）

### P0 — 原型内部闭环（先修半成品，工作量小，直接可做）

| # | 组件名 | 目的 | 依赖 token | 建议实现位置 |
|---|---|---|---|---|
| 1 | 计划条双实现合并 | 消除 composer-core.js initPlanBar（is-expanded）与 popovers.js 计划区（expanded-steps/expanded-goal）的重复绑定与状态分裂 | `--dur-*`、`--ease-spring` | js/popovers.js + js/composer-core.js（保留一份，删 `is-expanded` 路径） |
| 2 | 目标面板闭环（关闭/保存） | `planGoalPanelClose`/`goalSaveBtn` 已在 JS 引用，HTML 缺失；补按钮 + Esc/回车行为 | `--radius-button`、`--accent-green` | index.html plan-goal-panel（order 1 内） |
| 3 | slash/at/tree 弹层接线 | `/` `、` `@` `@@` 键盘触发 + 条目点击（insertRichInlineTag/locateOrPreviewFile 已存在未调用）+ tree 搜索过滤 + scope 切换 | `--shadow-popover` | js/popovers.js；index.html 229-352 区块 |
| 4 | plus 菜单接线（menuAddFile → hiddenFileInput.click()；skillSubmenu 级联展开） | 附件上传入口与 Skill 级联当前死按钮 | — | js/popovers.js + skill-manager.js |
| 5 | 死 CSS 清理标记 | tool-calls.css / preview-modal.css / markdown-editor/* 已无消费方（A4:27 亦记录），清理或注释 | — | index.html head；css/ |
| 6 | 审批条与权限模式联动 | permission bar 出现时与 `--perm-*` 五色档的视觉一致性 | `--perm-*` | css/flow/permission-bar.css |

### P1 — token 对齐（整合主项目前的必要地基）

| # | 组件名 | 目的 | 依赖 token | 建议实现位置 |
|---|---|---|---|---|
| 7 | z-index 体系化 | 62 处硬编码 → `--z-*` 层（对齐主项目 32 变量语义：200 弹层/400 菜单/9000 模态/10000 toast/100000 顶层） | 新建 `css/z-index.css` | 各 css 的 z-index 字面量替换 |
| 8 | 语义色补全 | 增 `--color-success/info` 三件套；记录「success 无彩」决策与主项目绿色 success 的取舍 | `--sem-*` | design-tokens.css |
| 9 | 动效档位对齐 | `--transition-enter/exit` 分离、popover/modal 专用档、关停档（eco） | `--duration-*`、`--easing-*` | design-tokens.css + conversation-tokens.css |
| 10 | 密度档机制 | `--space-*` 阶梯 + `--control-height` + `--font-size-adjust`（data-ui-size small/large 覆盖层） | 新建 space/control 系列 | design-tokens.css |
| 11 | 暗色主题层 | `html[data-theme="dark"]` 全量变量覆盖（对齐 theme-dark.css） | 全 token 双套化 | design-tokens.css + brand.css |
| 12 | 性能档 | `[data-perf-tier]` 动效/毛玻璃关停 | — | design-tokens.css |

### P2 — 组件补全（主项目有、原型值得验证的形态）

| # | 组件名 | 目的 | 依赖 token | 建议实现位置 |
|---|---|---|---|---|
| 13 | 审批卡片（ApprovalAskCard 形态） | 验证 stream 内审批卡 vs 横向审批条的取舍 | `--color-warning`、`--perm-ask` | streamMount（flow 节点）+ permissionBarHost |
| 14 | 工具输出卡（diff 预览 + output 代码视图） | 验证 diff/output 的可信度展示；demo 数据已具备（Cargo.toml/lib.rs output） | `--diff-add/del`、`--font-mono`、`--radius-card` | PurposeBlock/ActionRow 展开体 |
| 15 | 消息操作条（复制/置顶/撤回到此处 + 追问建议） | 验证消息级操作的位置方案 | `--icon-size`、`--text-tertiary` | flow-msg 尾部（FlowMount.renderUserMessage/renderAssistantMessage） |
| 16 | 状态 ribbon（运行/计划待批） | 计划进度条与 ribbon 双形态对照 | `--color-warning`、`--perm-goal` | chat-stream-container 顶部 |
| 17 | 发送队列面板 | 多消息队列 UX 验证 | `--shadow-panel`、`--flow-gap-msg` | composer-wrapper（plan bar 上方） |
| 18 | 命令菜单完整版（过滤/分组/历史） | slash 接线后的形态升级 | `--shadow-popover`、`--font-sub` | slashPopover 区块 |

---

## 五、结论速览

1. **原型主体已高度完整**：计划进度条、审批条、文件区、输入区、消息流（11 个 Flow 组件）均有完整 JS 行为；真正"缺"的是**弹层接线**（slash/at/tree/plus 为静态 DOM）与**计划目标面板闭环**。
2. **最大结构性半成品**：计划条存在两套实现（composer-core.js + popovers.js、is-expanded + expanded-steps/expanded-goal），合并前所有计划条改动都有双份成本。
3. **token 差距集中在五类**：z-index（无 token，62 处字面量）、语义色（无 success/info）、密度/性能档（无机制）、暗色主题（纯亮色）、动效档位命名（缺 enter/exit 分离）。其中 z-index 与暗色主题是整合主项目的前置门槛。
4. **主项目值得回迁原型的验证点**：审批卡形态、工具输出/diff 卡、消息操作条、命令菜单——其余（header/虚拟化/空态）与原型理念冲突或属实现层问题，不建议补。
