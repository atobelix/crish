# A7 — 主对话界面原型 UI 设计评审

> 评审对象：`reference/chat-composer-component`（独立 HTML/CSS/JS 原型）
> 评审方式：只读静态评审（HTML 616 行 + 全部核心 CSS/JS 逐行通读 + 硬编码统计）
> 日期：2026-08-04
> 结论先行：**准第一梯队**。视觉与动效单点水准已达第一梯队；系统性（暗色主题、无障碍、token 执行、状态完整）未达标。

---

## 0. 评审范围与体量

| 对象 | 体量 | 说明 |
|---|---|---|
| index.html | 616 行 | 布局 + 全部面板 + 30 个 CSS + 20+ JS 挂载 |
| 主域 CSS（8 个） | 约 3.9k 行 | design-tokens / conversation-tokens / brand / composer / file-cards / popovers / preview-modal / tool-calls |
| flow 域 CSS（12 个） | 约 2.5k 行 | flow-base / motion / live / thinking / action / purpose / plan / permission-bar 等 |
| markdown-editor / file-preview 域 CSS | 约 4.1k 行 | 独立 token 体系（mdx-* / fp-*） |
| 核心 JS | 约 3.5k 行 | composer-core / popovers / flow-projector / tool-presentation / stream-renderer + flow 组件 |

架构亮点：token 分三层（brand.css 基元 → design-tokens/conversation-tokens 语义 → 组件消费），品牌色有"铁律"注释约束，这是国内绝大多数竞品不具备的设计工程素养。

---

## 1. 逐维度评审

### 1.1 视觉层次与排版 — 9/10

| 子项 | 证据 | 评价 |
|---|---|---|
| 字号阶 | `--font-title:15px / --font-base:14px / --font-sub:13px / --font-micro:12px`（design-tokens.css:10-15） | 3 档正文 + 1 档标题，收敛正确 |
| 墨阶 | 5 级：`--ink hsl(46,9%,10%) → ink-muted 28% → ink-soft 42% → ink-faint 62% → ink-ghost 78%`（brand.css:56-60） | 完整且同色相（暖调 46°），层级靠色阶本身表达而非 opacity——正确方向 |
| 行高 | 正文 1.65-1.7、meta 1.5、工具行 24px 定高（flow-base.css:90、tool-calls.css:169） | 阅读行高健康；定高行保证 rail/图标列对齐 |
| 对比度 | ink 10% ≈ #1a1a1a 对白底 ≈ 16:1；ink-faint ≈ #a1a → 2.9:1（placeholder 可接受）；ghost 1.8:1（禁用态） | 主文本达标 WCAG AA；faint 仅用于 placeholder/chevron，可接受 |
| 信息密度 | 流区 720px 居中（composer.css:45）、消息间距 `--flow-gap-msg:22px`（conversation-tokens.css:41）、composer 内 padding 16/20 | 留白节奏成熟，无拥挤感 |
| **失分点** | tool-calls.css 全文件 `color:#000 + opacity 0.38~0.85` 表达层级 | 与 conversation-tokens.css:16 注释"绝不在文字父级上加 opacity（Windows 上会糊）"**直接矛盾**——新旧两代方案并存，旧方案未删除 |

### 1.2 色彩设计 — 8/10

| 子项 | 证据 | 评价 |
|---|---|---|
| 品牌色克制度 | `--brand #10B981` 仅用于：运行 rail（live.css:15-40）、思考/合成脉冲点、caret（composer.css:210）、发送键（composer.css:362-368）、logomark；"已完成"刻意无彩（design-tokens.css:47-54） | **全场最佳决策**。"成功≠绿"的品牌隔离，让 emerald 在界面里成为唯一的"活着"信号，这是 Claude/Cursor 级的克制 |
| 语义色 | warn 琥珀 hsl(32,84%,44%)、error 赤土 hsl(6,56%,51%)、done 无彩、diff 森林绿 hsl(150,40%,32%)（brand.css:90-96、design-tokens.css:57-58） | 四类齐全，且刻意与品牌绿拉开色相 |
| 权限梯度 | 只读/计划=无彩 → 询问=琥珀 → 目标=品牌绿 → 完全访问=赤褐（design-tokens.css:71-92） | 按"放权程度"做风险梯度，语义完整且有设计注释 |
| **失分点 1** | diff 色两套：design-tokens 定义 `--diff-add 森林绿`，但 flow/action.css:229-234 与 tool-calls.css:433-438 各自硬编码 `#2f8f5b / #c45c5c` 与 `var(--accent-green-text)`（= ink！） | diff 加行在 tool-calls 版里根本不是绿色 |
| **失分点 2** | 无暗色主题：全 CSS **0 处** `prefers-color-scheme`（第 7 节详述） | 第一梯队全部产品标配 |

### 1.3 形态语言 — 7/10

| 子项 | 证据 | 评价 |
|---|---|---|
| 圆角体系 | `r-xs 4 / sm 6 / md 8 / lg 12 / xl 16 / full`（brand.css:134-139），容器/浮层/卡片/按钮全部映射（design-tokens.css:100-111） | 体系完整、阶差合理 |
| 阴影 | `lift-sm/md/lg` 三层（4%/3%/6% 墨色扩散）+ `bevel-top` 顶部内高光（brand.css:118-126） | "纸的受光边"材质观感，是整套质感的关键，执行到位 |
| 分隔线 | line-soft 93% / line 88% / line-strong 80% 三级（brand.css:65-67） | 强弱阶完整 |
| 间距 | 4/8 网格基调：flow-gap-node 8、gap-action 4、composer gap 12、padding 16/20 | 基本落在 4px 网格上 |
| **失分点** | 组件 CSS 中硬编码 `border-radius` **165 处**（如 18px/24px/999px/6px 散落 composer.css:119、preview-modal.css:224、plan.css:153 等）；preview-modal.css 整文件脱离 token 体系（圆角 10/12/24/999、色值全硬编码） | 体系只在"表面"统一，执行层失控 |

### 1.4 组件细节 — 8/10

| 组件 | 证据 | 评价 |
|---|---|---|
| 按钮 | pill 按钮 hover wash + chevron 滑入（composer.css:289-342）；发送键 3 态：禁用灰 → 激活品牌绿 + 品牌光晕 → hover 抬升 1px（:370-377） | 打磨度好；**但 chevron 用 `width` 动画**（:328-334）是布局属性，非 transform——动效实现瑕疵 |
| 文件卡片 | 28px 定高、悬浮删除徽标（hover 显现 + hover 变红，file-cards.css:121-159）、图片缩略图 27px 圆角、入场 scale 0.82→1.04→1（:14-27） | 完成度高，与 Claude 附件条同级 |
| 审批条 | 风险徽标（低=绿/中=琥珀/高=红，permission-bar.css:75-101）+ 倒计时 tabular-nums 定宽防抖（:104-119）+ 已解决态 0.55 淡化（:226-228） | 完成度高；**风险色硬编码 `#d97706/#ef4444/#10b981`，与 token 体系（--sem-warn/--sem-error/--brand）脱节** |
| 计划条 | 滚轮 translateY 索引动画（popovers.js:505）、计数器 2/5、goal/steps 双抽屉 grid-template-rows 展开（popovers.css:723-787）、暂停/终止按钮 | 设计精细；**但 JS 里 STEP_HEIGHT=18 硬编码**（popovers.js:486），CSS 里 `animation: panelSlideUp` 与 grid transition 双驱动叠加（:735-736），有竞态风险 |
| 输入区 | caret 品牌绿（composer.css:210）、权限 pill 五档梯度着色、占位符、@/@@ 富标签内嵌 | 细节到位；**聚焦无可见反馈**：`:focus-within` 明示"保持未激活与激活状态平滑微弱近乎无变化"（composer.css:181-185），违反 WCAG 2.4.7 焦点可见 |

### 1.5 交互与动效 — 7/10

| 子项 | 证据 | 评价 |
|---|---|---|
| 时长/缓动 | 全局 token：90/140/200/320ms + ease-out-expo 系（brand.css:144-149） | 节奏统一、偏"snappy"——正确取向 |
| 滚轮/数字滚动 | transform 索引驱动 + 上下渐变遮罩"似有非有"（flow/motion.css:143-218） | 实现质量高，零布局抖动 |
| 手风琴展开 | `grid-template-rows 0fr→1fr`（flow/motion.css:111-141、tool-calls.css:19-36） | 现代做法，无 reflow 跳动 |
| 入场 | 节点 stagger 28ms×i 上限 120ms（FlowMount.js:148） | 克制 |
| reduced-motion | flow/motion.css:311-348 全覆盖、brand.css:191、mdx index.css | **加分项**，多数国产产品没有 |
| **失分点 1** | `transition: all` 滥用：file-cards.css:137、popovers.css:178 等 | 性能与可控性双输 |
| **失分点 2** | 悬停反馈双语言：流区"只变 opacity 不染背景"（tool-calls.css:14 声明）vs UI 区"wash 背景"（composer.css:307） | 分属两代设计语言，同屏并存 |
| **失分点 3** | 键盘交互完全缺失（见 1.7） | 交互完成度对半 |

### 1.6 设计一致性 — 5/10

| 证据（统计） | 数值 | 说明 |
|---|---|---|
| 组件 CSS 硬编码 HEX（排除 3 个 token 文件） | **415 处** | 占比约 91%（415 vs token 文件内 ~40 个色值定义） |
| 硬编码 rgba() | **323 处** | 主要来自 tool-calls.css / preview-modal.css / action.css 渐变遮罩 |
| 硬编码 border-radius / box-shadow | **165 / 50 处** | 见 1.3 |
| 死代码 | **tool-calls.css 1067 行**，类名（tc-row/tc-group/tc-approval/msg-text…）在全部 JS 中**零引用** | 渲染路径全走 flow-* 类；1067 行旧实现仍被 index.html 加载，是硬编码色值最大来源 |
| 同名双定义 | `.plan-progress-bar` 在 popovers.css（token 版）与 flow/plan.css（硬编码版）各定义一次，plan.css 后加载覆盖 | 同一组件两套实现并存 |
| 双实现 | 计划条逻辑在 composer-core.js 的 `initPlanBar` 与 popovers.js 各实现一遍 | 行为分叉风险 |
| 三套 token 并存 | 主域（brand→design-tokens）+ file-preview（fp-*）+ markdown-editor（mdx-*） | 子系统自成体系，色值互不引用 |
| 字体双栈 | index.html 引 Google Fonts（Plus Jakarta Sans + Fira Code）+ brand.css 自托管 Geist/MiSans | Google Fonts 是多余网络请求，离线时挂起；真正生效的是 Geist |

结论：**token 体系设计是 9 分的，token 执行纪律是 4 分的。** 设计与实现的落差是本项目最大的内部矛盾。

### 1.7 第一梯队对照矩阵

| 第一梯队共性特征 | 本原型 | 证据 | 判定 |
|---|---|---|---|
| 精密的层次体系（容器/浮层/状态全 token 化） | 设计层 ✅ 执行层 ❌ | 三层 token + 语义注释（design-tokens.css 全文）；但 91% 色值硬编码、死代码 1067 行、三套 token 并存 | 半达标 |
| 克制的动效（微过渡、不炫技） | ✅ | 90-320ms 档位、transform/opacity 优先、reduce 全覆盖、无 overshoot | 达标 |
| 高密度但不拥挤（信息架构成熟） | ✅ | 720px 流、22px 消息间距、5 级墨阶支撑进程流、rail 运行态才出现（live.css:19-41） | 达标 |
| 完整状态表达（loading/empty/error/成功反馈） | ⚠️ | loading ✅（composing 脉冲/骨架/呼吸点）、error ✅（赤土 + 过去式动词）、成功反馈 ✅（toast/勾）；**empty ❌ 无空会话/空态设计** | 缺一角 |
| 暗色主题 | ❌ | 全 CSS 0 处 `prefers-color-scheme`；且 preview 模态为深色玻璃（#27272A），主界面亮色，**同屏双主题** | 不达标 |
| 键盘/无障碍完备 | ❌ | index.html **0 处** aria/role/tabindex；composer-core.js + popovers.js **0 处** keydown（无 Esc、无方向键）；popover 无 aria-expanded/aria-controls、无焦点移入管理；`:focus-visible` 33 处规则中多数是 `outline:none` 负处理（flow/action.css:57-60 等）；composer 聚焦无可见反馈（composer.css:181-185）；确认终止用原生 `confirm()`（popovers.js:642） | 基本空白 |
| 自托管字体/中文排版 | ✅ | Geist + MiSans 全量自托管，tabular-nums 覆盖时长/计数/耗时（design-tokens.css:167-170） | 达标 |

---

## 2. 差距清单（按优先级）

**P0 — 决定"能否自称第一梯队"的三件套：**

1. **暗色主题缺失**。这是第一梯队产品的入场券（Claude Code/Cursor/Grok/Zed 全都有）。好消息：颜色已集中在 brand.css 基元层，理论上只需新增 `@media (prefers-color-scheme: dark)` 覆盖 ink/paper/line 六组基元即可，成本低、收益大。preview-modal 与 file-preview 的深色玻璃需与主主题统一或明确"预览器固定深色"的决策。
2. **无障碍基线为零**。最低投入清单：popover 触发器补 `aria-expanded/aria-controls` + 打开时焦点移入 + Esc 关闭；全部交互元素补 `:focus-visible` 正反馈（用现有 `--ring-brand`，design-tokens 已备好：brand.css:129）；composer `:focus-within` 加 1px 边框高亮；终止确认从 `confirm()` 换成产品内确认弹层。
3. **token 执行收口**。三步走：① 删除死代码 tool-calls.css（1067 行，类零引用）；② 合并 `.plan-progress-bar` 双定义（popovers.css vs flow/plan.css）；③ preview-modal.css 的 100+ 处硬编码色值/圆角/阴影迁移到 fp-* 或主 token。目标：硬编码 HEX 从 415 降到 <50。

**P1 — 工程与体验缝隙：**

4. **empty 空状态**：无会话/无文件/搜索无结果三态缺失，且与 demo 数据深度绑定（DemoData 常驻），无法展示空态。
5. **悬停反馈双语言统一**：流区 opacity-only 与 UI 区 wash 背景二选一（建议流区也引入极淡 wash 或至少把 opacity 阈值统一到 0.42/0.68 之外的新 token）。
6. **plan 双实现合并**：composer-core.js 的 initPlanBar 与 popovers.js 的 plan 逻辑合并，STEP_HEIGHT=18 提为 token（`--flow-roller-ms` 同层）。
7. **动效修边**：chevron `width` 动画改 transform/opacity（composer.css:328-334）；`transition: all` 逐条展开；panelSlideUp 动画与 grid transition 去重（popovers.css:735-736）。
8. **字体栈清理**：移除 Google Fonts 双链路，保留 Geist/MiSans 自托管。

**P2 — 打磨：**

9. diff 色统一到 `--diff-add/--diff-del` 单源（现三处定义互不一致：design-tokens / action.css / tool-calls.css）。
10. permission-bar 风险色（#d97706/#ef4444/#10b981）改引 `--sem-warn/--sem-error/--brand`。

---

## 3. 结论

**分级：准第一梯队（视觉 9 分，系统 6 分）。**

- **达到第一梯队的部分**：品牌色的独占与克制策略（"成功≠绿"）、5 级暖墨阶、三层 token 的架构设计、滚轮/插槽/手风琴的动效实现质量、prefers-reduced-motion 全覆盖、计划条/审批条/文件卡片的完成度、自托管中文字体。这些单点放在 Claude Code 桌面版旁边不丢人，且多数国产 AI 工作台（含部分第一梯队 TUI）达不到。
- **未达到的部分**：暗色主题（0%）、无障碍（≈0）、token 执行纪律（91% 硬编码 + 1067 行死代码 + 三套 token 并存）、empty 态、预览子系统与主界面风格分裂。这五条正是"第一梯队"与"好看的 demo"的分界线。

一句话：**这是"第一梯队的设计系统 + 中等偏下的工程执行"的产物；把 P0 三件套做完（暗色 + 无障碍基线 + token 收口，预计 2-3 人周），即可跨线。**
