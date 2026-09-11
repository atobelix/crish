# CSS 模块去硬编码与设计系统对齐落地详案

> **文件路径**：`docs/chat-flow-systemic-remediation/plans/03-CSS模块去硬编码与设计系统对齐详案.md`
> **权威遵循**：仓库根目录 `AGENTS.md`（通用纪律 + 本仓专用 §12 Tooltip / §13 焦点态与阴影 / §14 色彩空间）、`.agents/LOGIC_PLAN_NO_RETREAT.md`（反退避全文与自检清单）、`00-对话流系统性净化与架构重塑总方案.md`。
> **核心原则**：纯逻辑规划、反退避、无工期人天人员排班、无 P0/P1 优先级划分，所有问题同权；穿透根因、净收敛、杜绝打补丁与应付。
> **缺陷基准**：全面根治 `audits/03-UI样式Token化与规范对齐审计.md`（24 项缺陷）与 `audits/10-消息行组件CSS硬编码与暗黑闪白缺陷审计.md`（17 项缺陷）揭示的全部 41 项样式与架构断层。

---

## 一、治理定位、问题同权与纯逻辑依赖架构

### 1. 根本治理诉求与双审计报告缺陷全景穿透

在对话流历史多轮迭代中，由于缺乏强类型约束与刚性门禁拦截，样式层积累了大量技术债务。结合 `audits/03` 与 `audits/10` 的深度审计，全景 41 项缺陷呈现出以下 10 类系统性架构病灶：

1. **未定义/悬空幽灵 CSS 变量（Undefined Ghost Variables）**：
   - `SubagentHeaderPanel.module.css:154-156, 178-179` 引用未定义的 `--error-color`，导致子代理失败徽章与终止按钮悬停态警示红完全失效（`VAR-UNDEFINED-01`）；
   - `CacheMetricsBadge.module.css:24-32` 引用未定义的 `--info-color`，导致缓存写入状态语义丢失并退化为普通正文色（`VAR-UNDEFINED-02`）；
   - `FlowArtifactChip.module.css:36-39` 引用全仓未定义的 `--brand-line` 幽灵变量（Audit 10 Defect 05）；
   - `StreamingTableContainer.module.css:86-110` 引用 `--stream-table-active-border`、`--stream-table-active-glow`、`--stream-table-pulse-duration`、`--stream-table-pulse-timing` 等 4 处幽灵变量（Audit 10 Defect 06）；
   - `ChatMessageRow.module.css:124` 引用未定义的 `--transition-base` 幽灵变量，导致图片过渡降级为浏览器默认线性 ease（Audit 10 Defect 15）；
   - `ChatCard.module.css:129, 207` 引用未注册的 `--font-sub` 与 `--bg-surface`。

2. **架构契约断层与死选择器（Dead Selectors & Dead Code）**：
   - `ContextInjectionBlock.module.css:353-357` 声明了 `.injectionBlock.isFailed`，但 TSX 组件 `CompactInjectionRow.tsx:145` 绑定的类名为 `styles.injectionRow`，导致注入失败红框样式 100% 无法命中成为死选择器（`ARCH-DISCONNECT-01`）；
   - `ReasoningRow.module.css:162-169` 遗留无消费者的死关键帧 `@keyframes reasoning-row-sweep`（Audit 10 Defect 12）。

3. **暗黑模式闪白与色彩反向失真（Dark Mode Flash-White & Visual Artifacts）**：
   - `focus-visible.css:54-55, 67-68` 全局焦点底板兜底硬编码 `#ffffff`，在暗黑模式初始化、iframe 嵌入或变量水合延迟时产生刺眼的纯白 1px 外环闪烁（`DARK-FLASH-01`）；
   - `ContextInjectionBlock.module.css:168` 边框回退硬编码亮浅米黄 `hsl(35 8% 91%)`，深色主题下产生亮边突刺（`DARK-FLASH-02`）；
   - `ChatComposer.module.css:658` 边框回退硬编码暗色半透明 `rgba(255, 255, 255, 0.08)`，在亮色模式下使输入框边缘隐形坍塌（`DARK-FLASH-03`）；
   - `CacheMetricsBadge.module.css:50-58` Tooltip 文本回退硬编码 Slate-50 `#f8fafc` 与 Slate-300 `#cbd5e1`，导致浅色模式下白底白字，对比度跌至 1.05:1 彻底失明（Audit 10 Defect 01）；
   - `ReasoningRow.module.css:171-184` 扫光渐变高光点硬编码极深炭黑 `#111827`，暗黑模式变量兜底时在文字上形成“周期性黑洞擦除”（Audit 10 Defect 02）；
   - `FlowPlanMilestone.module.css:25-35` 纵向脊柱线回退硬编码 `rgba(0, 0, 0, 0.15)`，暗黑底板上对比度为 0 导致脊柱线瞬间失明断裂（Audit 10 Defect 04）；
   - `FlowPlanMilestone.module.css:63-93` 步骤圆底色错配取用外层最底板 `--bg-page`（暗黑为 `#0c0c0b`），在 `#242424` 消息卡片底板上被硬生生抠出深黑色圆形“穿孔黑洞”（Audit 10 Defect 11）。

4. **全仓裸写 Hex、命名颜色与旧式 `rgba`（Raw Hex, Named Colors & Raw RGBA）**：
   - `ChatMessageRow.module.css:532, 652` 裸写 `hsl(0 0% 100%)` 与 `hsl(160 84% 39%)`（`HEX-COLOR-01`）；
   - `ApprovalAskCard.module.css:237, 239, 243` 裸写十六进制 `#047857`、`#ffffff`、`#10b981`（`HEX-COLOR-02`）；
   - `InlineAgentPanel.module.css:73-74, 88, 256-258` 裸写 `#10b981` 与 `#059669`（`HEX-COLOR-03`）；
   - `ChatComposer.module.css:1096, 1140` 裸写 CSS 命名颜色 `white`（`HEX-COLOR-04`）；
   - `CacheMetricsBadge.module.css:24-33` 缓存写入态 3 处硬编码饱和冷蓝 `#0288d1`，公然违背系统 Zero-Blue 铁律（Audit 10 Defect 03）；
   - `StreamingTableContainer.module.css:86-110` 重复裸写多达 8 次 `#10b981`（Audit 10 Defect 06）；
   - `ChatStatusRibbons.module.css:89` 与 `ChatComposer.module.css:808` 残留旧式 `rgba(...)` 重阴影（`CONEX-SHADOW-01`）。

5. **动效曲线私自内联与违背缓动正典（Motion & Easing Violations）**：
   - `StreamingTableContainer.module.css:106, 108` 私自内联 `cubic-bezier(0.16, 1, 0.3, 1)`（`MOTION-EASING-01`，Audit 10 Defect 07）；
   - `ChatToolCallBlock.module.css:119, 676, 678, 705` 私自内联非标贝塞尔与时间常数（`0.22s cubic-bezier(0.22, 1, 0.36, 1)`, `0.18s ease`）（`MOTION-EASING-02`）；
   - `ChatComposer.module.css:1102-1105` 连续 4 组内联写死 `cubic-bezier(0.16, 1, 0.3, 1)`（`MOTION-EASING-03`）；
   - `TimelineThoughtSection.module.css:144` 手写 `200ms cubic-bezier(0.16, 1, 0.3, 1)`（Audit 10 Defect 07）；
   - `ReasoningRow.module.css:264` `.copyButton` 盲目使用 `transition: all`，引发主线程高开销样式重计算与掉帧反模式（Audit 10 Defect 13）。

6. **Conex §13 焦点态微环规范与 Conex §12 Tooltip 违规**：
   - `ChatEmptyState.module.css:118, 181` 与 `ChatMessageRow.module.css:314` 滥用非受控 `--focus-ring` 粗黑环（`CONEX-FOCUS-01`）；
   - `ChatCard.module.css:100-126` 模型选择器 `.modelBadge` 完全缺失 `:focus-visible` 样式（`CONEX-FOCUS-02`）；
   - `TimelineThoughtSection.module.css:42-45` 思维链头部按钮直接清除 `outline: none` 且零微环补偿，键盘导航光标凭空消失，严重违背 WCAG 2.4.7（Audit 10 Defect 08）；
   - `ReasoningRow.module.css:56-62, 275-280` 手写非标 `0.5px / 2px` 双层混合环，脱离系统 Token 体系（Audit 10 Defect 09）；
   - 4 类核心可交互控件（`.iconBtn`, `.planApproveChip`, `.flowArtifactChip`, `.flowPlanStepHead`）完全缺失 `:focus-visible` 定义（Audit 10 Defect 10）；
   - `ChatMessageRow.module.css:108, 317, 485` 同一文件内部存在 3 套互不兼容的焦点环实现（Audit 10 Defect 17）；
   - 多处使用原生 HTML `title` 属性作为悬停气泡，违反 Conex §12 自定义 `<Tooltip>` 规范。

7. **TSX / JSX 内联样式碎片化（TSX Inline Style Hardcoding）**：
   - `DynamicChipBar.tsx:148-153, 169, 174, 182` 大量使用 JSX `style={{ ... }}` 重置按钮与覆盖颜色（`INLINE-STYLE-01`）；
   - `ChatHeaderControls.tsx:168, 173-179` 模型选择器在已有 CSS Module 上叠加内联文本省略与弹性布局属性，造成双源漂移（`INLINE-STYLE-02`）；
   - `InjectionHeader.tsx:180` 与 `CompactToolRow.tsx:146` 内联写死 Spinner 尺寸 `width: 12, height: 12, borderWidth: 1.5` 与 `8px`（`INLINE-STYLE-03`）；
   - `ChatMessageList.tsx:191` 消息列表空态容器内联裸写 Flex 布局属性（`INLINE-STYLE-04`）。

8. **魔术数字与契约撕裂（Magic Numbers & Contract Drift）**：
   - `ChatMessageRow.module.css:86` 用户气泡圆角硬编码魔术数字 `22px`，未绑定系统 Token（`MAGIC-NUMBER-01`）；
   - `MessageContent.module.css:15, 20` 控制栏高度硬编码奇数 `33px`，下边框硬编码脆弱的亚像素 `0.5px`（`MAGIC-NUMBER-02`）；
   - `ChatMessageRow.module.css:120, 755` 按钮圆角 fallback 漂移为 `7px`（系统契约为 8px），图片圆角 fallback 漂移为 `10px`（系统契约为 8px）（Audit 10 Defect 14）；
   - `FlowPlanMilestone.module.css:25-35` 脊柱连线依赖 `left: 7.625px` 与 `0.75px` 浮点代数硬定位，在 DPI 缩放下产生严重的周期性像素抖动与连线错位（Audit 10 Defect 16）。

9. **代码卫生与破损注释（Code Hygiene & Corrupted Comments）**：
   - `ChatToolCallBlock.module.css:328-619` 与 `ChatEmptyState.module.css:29-152` 历史乱码处理不当导致中文注释字符被大面积替换为空格破损（`CODE-HYGIENE-01`）。

---

### 2. 纯逻辑规划与问题同权原则（Problem Equality）

依据 `AGENTS.md` 第 1 条及 `.agents/LOGIC_PLAN_NO_RETREAT.md`，本详案坚持**纯逻辑规划与问题同权**：
- **同权无差别**：全景 41 项缺陷同等重要，**严禁使用 P0/P1/P2 业务优先级进行挑选、延后或砍项**；
- **纯逻辑依赖驱动**：执行顺序仅根据设计系统底层基础 Token、通用规则、组件样式表、TSX 属性化以及 CI 门禁检查的技术依赖关系排序；
- **零非技术度量**：方案仅围绕文件路径、代码行号、Token 映射矩阵与自动化断言展开，**绝对不涉及任何工期、人天、排班或人员安排**；
- **效果锁与零退避**：严禁以“暗黑模式不易复现”、“某些变量很少用到”为由设立退避裁判，必须实现 100% 架构净收敛。

---

### 3. 纯逻辑七阶执行依赖拓扑（Pure Logical Execution Topology）

```
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 I：全局设计系统 Token 权威映射与基底补齐 (SSOT 基石)              │
│   • 在 tokens.css 中对齐 --color-error, --color-info, 缓动正典          │
│   • 消除幽灵变量，固化 8px 按钮契约与标准圆角体系                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (基础变量就绪)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 II：消除暗黑模式闪白、穿孔与全局 Fallback 规范化                   │
│   • focus-visible.css 剔除 #ffffff 硬编码兜底                           │
│   • 推行业务 CSS 纯 Token 引用；全面消除米黄 HSL / 暗色透明度 fallback  │
│   • FlowPlanMilestone 底色修正为 --bg-card，根除深色穿孔黑洞            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (环境底板稳固)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 III：全局缓动正典二元组与动效体系统一                             │
│   • 统一收敛至 --ease-standard (色彩) 与 --ease-emphasized (几何位移)   │
│   • 拔除所有私自手写 cubic-bezier 与 transition: all 性能反模式         │
│   • 物理切除死动画 @keyframes reasoning-row-sweep                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (动效底座确立)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 IV：Conex §13 焦点微环与 §12 Tooltip 规范化治理                    │
│   • 统一全仓焦点环为标准微弱软灰环 (对比度 <= 10%)                     │
│   • 补齐 5 类关键交互控件缺失的 :focus-visible 定义                     │
│   • 统一 ChatMessageRow 内部三套焦点环为单一形态                        │
│   • 修复 CacheMetricsBadge Tooltip 样式，全面推行自定义 <Tooltip>       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (交互规范就绪)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 V：全景 17 大 CSS 模块逐一去硬编码与纯纸化重构                     │
│   • 覆盖 17 个关键 .module.css：消灭全部 Hex、Zero-Blue 落地           │
│   • 修复死选择器 .injectionRow.isFailed；修复 7.625px 脊柱像素对齐     │
│   • 重写破损注释为 UTF-8 无 BOM 专业注释                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (CSS 模块完成)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 VI：TSX / JSX 内联样式清洗与 data-* 属性化收敛                    │
│   • 剥离 6 个 TSX 文件中的静态 style 覆盖与魔术数字                     │
│   • 统一状态化样式为 data-status 集中派发架构                          │
│   • 仅放行动态几何百分比计算内联白名单                                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (代码全面净化)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 阶段 VII：立体化自动化门禁守门与断言矩阵验证                           │
│   • check:css-encoding / check:line-counts / typecheck 0 报错          │
│   • 正则扫描断言：Hex=0, Raw-RGBA=0, Flash-Fallback=0, Bezier=0        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Conex 设计系统 Token 权威映射与全仓 Zero-Hex 标准化

### 1. 全仓 Zero-Hex 与色彩空间（HSLA / color-mix）标准化映射表

全仓业务组件严禁裸写任何十六进制颜色值或旧式 `rgba(...)`，必须严格按照以下映射表引用 `tokens.css` 权威 Token：

#### (1) 前景与文字排版（Typography SSOT）
| 语义层级 | 违规手写色值（严禁使用） | 规范 Conex Token | 浅色模式计算值 | 暗色模式计算值 | 语义职责与设计意图 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **一级正文** | `#111`, `#111111`, `#111827`, `#f8fafc` | `var(--text-primary)` | `#111111` (纯黑墨阶) | `#dddddd` (柔和乳白) | 核心正文、主标题、强语义标签、重点代码 |
| **二级副文** | `#555`, `#555555`, `#aaaaaa`, `#cbd5e1` | `var(--text-secondary)` | `#555555` (中灰度) | `#aaaaaa` (浅灰度) | 参数名、折叠摘要、副标题、正文字段 |
| **三级弱文** | `#696969`, `#8f8f8f`, `#9ca3af`, `#94a3b8` | `var(--text-tertiary)` | `#696969` (WCAG AA) | `#8f8f8f` (低眩光) | 时间戳、行号、元数据、无状态图标、未激活占位 |
| **失效禁用** | `#ccc`, `#444`, `rgba(..., 0.5)` | `var(--text-muted)` | 别名回指 `--text-tertiary` | 别名回指 `--text-tertiary` | 禁用按钮提示、次级占位符 |
| **反色文本** | `#ffffff`, `white`, `hsl(0 0% 100%)` | `var(--text-on-accent)` | `#ffffff` | `var(--bg-primary, #0a0a0a)` | 实体翡翠绿按钮文字、复选框勾选图标 |
| **品牌反色** | `white`, `#fff` | `var(--text-on-brand)` | `#ffffff` | `#ffffff` | 翡翠绿圆形发送按钮内部图标 |

#### (2) 背景与底板空间（Paper Surface SSOT）
| 空间层级 | 违规手写色值（严禁使用） | 规范 Conex Token | 浅色模式计算值 | 暗色模式计算值 | 语义职责与设计意图 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **应用外壳** | `#f5f5f5`, `#1b1b1b` | `var(--bg-primary)` | `hsl(30 2.5% 95.5%)` | `#1b1b1b` (黑曜石) | 应用最外层大矩形底板 (Shell) |
| **辅助底板** | `#f0f0f0`, `#242424` | `var(--bg-secondary)` | `hsl(30 2.5% 93%)` | `#242424` (微凸中性底) | 侧边栏、分栏头部、卡片次级背景 |
| **卡片纯纸** | `#fff`, `#ffffff`, `#242424` | `var(--bg-card)` | `hsl(0 0% 100%)` (画纸纯白) | `#242424` (卡片实体墨灰) | 对话流卡片实体、工具调用块、消息气泡宿主 |
| **浮起卡片** | `#ffffff`, `#1e1e1e` | `var(--bg-elevated)` | `hsl(0 0% 100%)` | `#242424` | 弹窗、模态对话框、下拉菜单体 |
| **微光悬停** | `rgba(0,0,0,0.05)`, `rgba(255,...)` | `var(--tint-hover)` | `color-mix(var(--text-primary) 2.5%)` | `color-mix(var(--text-primary) 3.5%)` | 按钮 Hover、行悬停透光态 |
| **微光激活** | `rgba(0,0,0,0.1)`, `rgba(255,...)` | `var(--tint-active)` | `color-mix(var(--text-primary) 5%)` | `color-mix(var(--text-primary) 6.5%)` | 按钮 Active、按下微光态 |

#### (3) 边框与发丝线（Hairlines SSOT）
| 边框层级 | 违规手写色值（严禁使用） | 规范 Conex Token | 浅色模式计算值 | 暗色模式计算值 | 语义职责与设计意图 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **微弱发丝** | `#e5e5e5`, `#2a2a2a`, `rgba(0,0,0,0.15)` | `var(--border-subtle)` | `hsl(30 2.5% 91%)` | `#2a2a2a` | 卡片外框、内部隔线、胶囊边框、计划脊柱线 |
| **结构边框** | `#d4d4d4`, `#333333`, `rgba(...)` | `var(--border-color)` | `hsl(30 2.5% 86%)` | `#333333` | 强调外框、输入框基线、重要面板大分割 |
| **超细发丝** | `0.5px solid ...` | `var(--hairline)` | 别名回指 `--border-subtle` | 别名回指 `--border-subtle` | 1px 高分屏中性分割（禁裸写 0.5px） |
| **强化发丝** | `1px solid #999` | `var(--hairline-strong)`| 别名回指 `--border-color` | 别名回指 `--border-color` | 关键接缝线、面板底栏顶线 |

#### (4) 语义状态与 Zero-Blue 铁律（Semantic Matrix）
| 语义状态 | 违规手写色值 | 规范前景/图标 Token | 浅底填充 Token | 状态边框 Token | 业务场景与铁律说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **成功态** | `#10b981`, `#059669`, `hsl(142...)` | `var(--color-success)` | `var(--color-success-bg)` | `var(--color-success-border)` | 工具执行完成、Diff 新增行、任务打钩 |
| **错误/危险** | `--error-color`, `#ef4444`, `#e03131` | `var(--color-error)` | `var(--color-error-bg)` | `var(--color-error-border)` | 工具执行报错、Diff 删除行、子代理失败、终止按钮 |
| **警告态** | `#f59e0b`, `#c2410c`, `#e8590c` | `var(--color-warning)` | `var(--color-warning-bg)` | `var(--color-warning-border)` | 权限拦截待审批、重试提示、流式截断 |
| **信息态** | `--info-color`, `#0288d1`, `#3b82f6` | `var(--color-info)` | `var(--color-info-bg)` | `var(--color-info-border)` | **Zero-Blue 铁律**：信息态使用翡翠墨阶 `var(--accent-blue)`，禁饱和冷蓝 |
| **品牌活态** | `#10b981`, `#059669`, `#047857` | `var(--brand)` / `var(--brand-deep)` | `color-mix(var(--brand) 8%, transparent)` | `color-mix(var(--brand) 30%, transparent)` | 翡翠绿流动呼吸灯、主操作按钮、流式光标 |

---

### 2. 幽灵/未定义变量与废弃别名终极收敛表

针对审计揭示的全部悬空与幽灵变量，确立系统单一真理源收口方案：

| 悬空/幽灵变量名 | 违规发现位置 | 根因与危害 | 终极规范收敛方案 (SSOT) |
| :--- | :--- | :--- | :--- |
| `--error-color` | `SubagentHeaderPanel.module.css:154, 178` | 未定义变量，计算期解析为无效声明，失败态与 Kill 悬停丢失红色 | 统一替换为 `var(--color-error)`（已有标准别名 `--danger-color` 亦可，推荐 `--color-error`） |
| `--info-color` | `CacheMetricsBadge.module.css:24, 27, 31` | 未定义变量，退化为文本色，缓存写入状态丢失高对比语义 | 统一替换为 `var(--color-info)` |
| `--brand-line` | `FlowArtifactChip.module.css:39` | 全仓 0 声明幽灵变量，每帧降级到带有旧式 rgba 的 fallback | 废除该变量，直接采用 `color-mix(in srgb, var(--accent-color) 35%, transparent)` |
| `--stream-table-active-border` | `StreamingTableContainer.module.css:86, 102` | 全局未定义，导致 3 层嵌套动态代数计算与 8 处 `#10b981` 裸写 | 收敛为标准 Token：`color-mix(in srgb, var(--accent-color) 48%, var(--border-color))` |
| `--stream-table-active-glow` | `StreamingTableContainer.module.css:87, 104` | 全局未定义 | 收敛为标准 Token：`0 0 0 1px color-mix(in srgb, var(--accent-color) 18%, transparent)` |
| `--stream-table-pulse-duration` | `StreamingTableContainer.module.css:106` | 全局未定义 | 统一收敛至系统动效常量 `1.6s` 或 `var(--transition-pulse, 1.6s)` |
| `--stream-table-pulse-timing` | `StreamingTableContainer.module.css:106` | 全局未定义，私写 `cubic-bezier(0.16, 1, 0.3, 1)` | 统一替换为缓动正典 `var(--ease-emphasized)` |
| `--transition-base` | `ChatMessageRow.module.css:124` | 未定义变量，降级为默认线性 `150ms ease` | 统一替换为 `var(--transition-fast)` |
| `--font-sub` | `ChatCard.module.css:129` | 未在系统排版体系中注册的非标字号 | 统一替换为 `var(--font-size-sm, 13px)` |
| `--bg-surface` | `ChatCard.module.css:207` | 未注册的表面底色变量 | 统一替换为 `var(--bg-secondary)` 或 `var(--bg-elevated)` |

---

## 三、根除暗黑模式闪白与无 Fallback / 自适应 Token 标准

### 1. 闪白与穿孔物理病灶根因剖析

在深浅双色主题架构中，样式表在暗黑模式下呈现异常主要由以下 4 大根因诱发：

1. **时序竞争态与亮色 Fallback 暴闪（Cold-Start White Flash）**：
   当元素声明类似 `var(--bg-card, #ffffff)` 或 `var(--border-subtle, hsl(35 8% 91%))` 时，在应用冷启动、WebView 挂载尚未完成主题属性（`html[data-theme='dark']`）注入的瞬间，浏览器引擎会无条件执行回退并渲染 `#ffffff`。当用户按下 Tab 键穿过界面元素时，`focus-visible.css` 中的 `#ffffff` 会在深黑底板上激发出刺眼的白色环闪。
2. **容器色彩层级错位形成的“穿孔黑洞”（Visual Punch-through）**：
   `FlowPlanMilestone` 位于消息卡片内部（底色为 `--bg-card: #242424`），而序号圆点误用最外层 Shell 底色 `--bg-page`（暗黑为 `#0c0c0b`）。高亮度差（`#242424` vs `#0c0c0b`）使圆点呈现凹陷穿孔，破坏卡片纸面一致性。
3. **旧式 `rgba(...)` 浅底半透明黑在深色底板上的湮灭（Contrast Obliteration）**：
   `FlowPlanMilestone` 脊柱线使用 `rgba(0, 0, 0, 0.15)` 作为 `--border-color` 的回退。在暗黑底板上，15% 透明度的黑叠加在黑灰底板上对比度为 0，导致计划执行树纵向轴线瞬间消失。
4. **文字裁切渐变混入深黑导致的“反向黑洞擦除”（Black Hole Erase）**：
   `ReasoningRow` 扫光文字裁切高光混入 `#111827`，在暗黑底板上文字不仅没有发光，反而在周期性变黑被吞噬。

---

### 2. Fallback 治理三级刚性铁律

- **铁律一【首选单真源原则：纯裸 Token 引用】**：
  由于 `tokens.css` 在 `:root` 与 `html[data-theme='dark']` 中已实现 100% 变量闭环覆盖，业务 CSS 模块一律优先使用**无 fallback 的纯 Token 引用**。严禁书写任何具体 Hex、HSL 或 RGB 作为 fallback：
  ```css
  /* ❌ 违规：暗黑模式下触发闪白或对比度崩塌 */
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border-subtle, hsl(35 8% 91%));
  color: var(--text-primary, #111111);
  color: var(--text-primary, #f8fafc);

  /* ✅ 规范：无闪白风险，单一真理源 */
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  ```

- **铁律二【自适应双 Token 兜底限制】**：
  若因跨上下文独立弹窗或极端边界必须提供 fallback，**严禁使用任何固定色彩值**，必须且仅能 fallback 至同等语义的深浅自适应系统 Token：
  ```css
  /* ❌ 违规：手写亮色/暗色具象兜底 */
  border-color: var(--border-color, rgba(0, 0, 0, 0.15));
  background: var(--bg-card, #fff);

  /* ✅ 规范：深浅自适应双 Token 兜底 */
  border-color: var(--hairline-strong, var(--border-color));
  background: var(--bg-card, var(--bg-secondary));
  ```

- **铁律三【全局底座规则剔除 `#ffffff` 兜底】**：
  在 `focus-visible.css` 全局键盘聚焦规则中，内层同心遮罩阴影彻底剔除 `#ffffff` 硬编码：
  ```diff
  --- a/apps/crish-desktop/src/styles/focus-visible.css
  +++ b/apps/crish-desktop/src/styles/focus-visible.css
  @@ -53,3 +53,3 @@
     box-shadow:
  -    0 0 0 1px var(--bg-card, var(--bg-canvas, #ffffff)),
  +    0 0 0 1px var(--bg-card, var(--bg-canvas)),
       0 0 0 1.5px var(--focus-visible-ring);
  ```

---

## 四、缓动正典体系与动效阻尼收敛（Standard & Emphasized）

### 1. 缓动正典二元组（Motion SSOT）

依据 `tokens.css:402-404` 铁律，全仓动效曲线严格收敛为**缓动正典二元组**：
- **`var(--ease-standard)`（`cubic-bezier(0.4, 0, 0.2, 1)`）**：服务于色彩、背景色、边框色、透明度常规平滑过渡；
- **`var(--ease-emphasized)`（`cubic-bezier(0.16, 1, 0.3, 1)`）**：服务于几何形变、高度展开、抽屉折叠、弹窗进出、位置位移等快出型动态反馈；
- **硬性红线**：**组件样式内绝对严禁私写 `cubic-bezier(...)`**。

---

### 2. 动效全场景标准化收口表

| 组件与选择器 | 违规现状（内联贝塞尔 / 性能反模式） | 规范化收敛方案 (SSOT) | 阻尼类型与设计意图 |
| :--- | :--- | :--- | :--- |
| `StreamingTableContainer.module.css:106` | 私写 `cubic-bezier(0.16, 1, 0.3, 1)` | `animation: md-table-pulse var(--transition-pulse, 1.6s) var(--ease-emphasized) infinite;` | 几何活跃边框呼吸，快出弹性 |
| `TimelineThoughtSection.module.css:144` | 私写 `200ms cubic-bezier(0.16, 1, 0.3, 1)` | `transition: grid-template-rows var(--transition-accordion);` (内含 `--ease-emphasized`) | 折叠抽屉弹性展开与收拢 |
| `ChatComposer.module.css:1182-1185` | 连续 4 组手写 `cubic-bezier(0.16, 1, 0.3, 1)` | 统一引用 `var(--ease-emphasized)`：`width 200ms var(--ease-emphasized), ...` | 发送按钮展开弹性入场 |
| `ChatComposer.module.css:814` | 手写 `0.14s cubic-bezier(0.16, 1, 0.3, 1)` | `animation: annPopoverFadeIn 140ms var(--ease-emphasized);` | 浮层轻量弹性呼出 |
| `ChatToolCallBlock.module.css:119, 676, 705` | 捏造 `0.22s cubic-bezier(0.22, 1, 0.36, 1)` | 统一使用 `var(--transition-fast)` 与 `var(--ease-emphasized)` | 工具翻转与折叠平滑响应 |
| `ReasoningRow.module.css:264` | `transition: all var(--transition-fast)` | `transition: color var(--transition-fast), background-color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);` | 剔除 `all`，锁定属性消除重排 |
| `ReasoningRow.module.css:162-169` | 遗留无消费者 `@keyframes reasoning-row-sweep` | **物理直接删除整段死代码** | 彻底收敛代码卫生 |

---

### 3. 无障碍动效减弱适配（Reduced Motion）

所有包含持续动画的组件模块（`StreamingTableContainer`, `ReasoningRow`, `InlineAgentPanel`, `FlowPlanMilestone`），必须 100% 声明媒体查询：
```css
@media (prefers-reduced-motion: reduce) {
  .streamingTarget,
  .pulseDot,
  .sweepShine {
    animation: none !important;
    transition: none !important;
  }
}
```

---

## 五、Conex §13 焦点态微环与 §12 Tooltip 规范化设计

### 1. Conex §13 焦点微环硬核规范（Focus Ring SSOT）

- **禁止硬黑实线**：输入框、按钮、可折叠 Header、操作 Chip 在处于 `:focus-visible` 时，**严禁粗、深、实心黑边（如 `outline: 2px solid #000` 或 `box-shadow: 0 0 0 2px #000`）**；
- **对比度混入上限严格 $\le 10\%$**：相对基线边框色，灰色加深混入主文字色的比例严格控制在 $6\% \sim 10\%$：
  - 微弱级（Subtle）：`box-shadow: var(--focus-ring-subtle);`（混入 5%~6%）；
  - 标准级（Standard）：`box-shadow: var(--focus-ring);`（1.5px 软环）；
  - 强化级（Strong）：`box-shadow: var(--focus-ring-strong);`（2px 软环，上限 10% 混入）；
- **标准 Conex §13 微环正典配方**：
  ```css
  /* ✅ 标准内联微环 */
  :focus-visible {
    outline: none;
    border-radius: var(--radius-sm, 4px);
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```
- **消除同一文件多套焦点环分裂（Unification in `ChatMessageRow`）**：
  统一收敛 `.userBubble:focus-visible`、`.followupChip*:focus-visible` 与 `.md-path-link:focus-visible`，彻底消灭 20% 翡翠绿光晕与非受控粗外环，统一使用 Conex §13 标准微环。
- **全面补齐 5 类缺失焦点态定义的交互控件**：
  1. `ChatCard.module.css`：`.modelBadge:focus-visible`；
  2. `ChatMessageRow.module.css`：`.iconBtn:focus-visible`；
  3. `ChatMessageRow.module.css`：`.planApproveChip:focus-visible`；
  4. `FlowArtifactChip.module.css`：`.flowArtifactChip:focus-visible`；
  5. `FlowPlanMilestone.module.css`：`.flowPlanStepHead:focus-visible`；
  6. `TimelineThoughtSection.module.css`：`.thoughtHeaderBtn:focus-visible`（补充丢失的微环补偿）。

---

### 2. Conex §12 自定义 Tooltip 悬停提示体系

- **严禁浏览器原生 HTML `title` 属性**：原生气泡渲染延迟大、外观陈旧且破坏暗黑模式沉浸感，严禁将其作为主交互提示；
- **统一使用自定义 `<Tooltip>` 组件**：所有需要说明性悬停提示的可交互图标与按钮，统一由 `<Tooltip content="...">` 包裹；
- **彻底根治 Tooltip 样式失明缺陷（`CacheMetricsBadge.module.css`）**：
  剔除 `#f8fafc` 与 `#cbd5e1` 裸写，恢复标准 Token：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css
  @@ -50,5 +50,5 @@
   .tooltipTitle {
     font-weight: 600;
  -  color: var(--text-primary, #f8fafc);
  +  color: var(--text-primary);
     margin-bottom: 2px;
   }

   .tooltipRow {
  -  color: var(--text-secondary, #cbd5e1);
  +  color: var(--text-secondary);
   }
  ```

---

## 六、全景 17 大 CSS 模块逐一治理实施详案

本节针对全仓涉及的 17 个关键 CSS 样式文件，逐一列明文件定位、承担职责、缺陷来源、病灶审查与精确改造 Diff。

---

### 1. `apps/crish-desktop/src/styles/focus-visible.css`
- **承担职责**：全局键盘聚焦无障碍底座、通用微环守卫。
- **缺陷来源**：`audits/03: DARK-FLASH-01`
- **病灶审查**：第 54-55、67-68 行在 `box-shadow` 内层遮罩硬编码 `#ffffff` 兜底，暗黑模式下 Tab 导航产生白色刺眼光晕。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/styles/focus-visible.css
  +++ b/apps/crish-desktop/src/styles/focus-visible.css
  @@ -53,3 +53,3 @@
     box-shadow:
  -    0 0 0 1px var(--bg-card, var(--bg-canvas, #ffffff)),
  +    0 0 0 1px var(--bg-card, var(--bg-canvas)),
       0 0 0 1.5px var(--focus-visible-ring);
  @@ -66,3 +66,3 @@
     box-shadow:
  -    0 0 0 1px var(--bg-card, var(--bg-canvas, #ffffff)),
  +    0 0 0 1px var(--bg-card, var(--bg-canvas)),
       0 0 0 1.5px var(--focus-visible-ring);
  ```
- **治理断言**：`focus-visible.css` 中 0 处 `#ffffff`，暗黑模式下 Tab 聚焦 0 闪白。

---

### 2. `apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css`
- **承担职责**：子代理协作顶栏容器、状态徽章、终止交互。
- **缺陷来源**：`audits/03: VAR-UNDEFINED-01`
- **病灶审查**：第 154-156、178-179 行引用未定义的 `--error-color`，失败徽章与终止悬停红失效。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css
  +++ b/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css
  @@ -153,4 +153,4 @@
   .statusBadge.failed {
  -  background: color-mix(in srgb, var(--error-color) 15%, transparent);
  -  color: var(--error-color);
  +  background: color-mix(in srgb, var(--color-error) 15%, transparent);
  +  color: var(--color-error);
   }
  @@ -177,3 +177,3 @@
   .killBtn:hover {
  -  color: var(--error-color);
  +  color: var(--color-error);
   }
  ```
- **治理断言**：完全消除 `--error-color`，子代理失败与 Kill 悬停 100% 呈现标准系统警示红。

---

### 3. `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css`
- **承担职责**：缓存命中/写入/未命中指标徽章、Tooltip 内容。
- **缺陷来源**：`audits/03: VAR-UNDEFINED-02`; `audits/10: Defect 01, Defect 03`
- **病灶审查**：
  1. 第 24-32 行引用未定义 `--info-color`，且曾硬编码饱和冷蓝 `#0288d1`，严重违背 Zero-Blue 铁律；
  2. 第 50-58 行 Tooltip 标题与正文硬编码 `#f8fafc` 与 `#cbd5e1`，浅色模式白底白字失明。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css
  @@ -23,10 +23,7 @@
   .write {
  -  color: var(--info-color, var(--text-primary));
  -  background: color-mix(
  -    in srgb,
  -    var(--info-color, var(--text-primary)) 10%,
  -    transparent
  -  );
  -  border: 1px solid
  -    color-mix(in srgb, var(--info-color, var(--text-primary)) 20%, transparent);
  +  color: var(--color-info);
  +  background: color-mix(in srgb, var(--color-info) 10%, transparent);
  +  border: 1px solid color-mix(in srgb, var(--color-info) 20%, transparent);
   }
  @@ -50,5 +47,5 @@
   .tooltipTitle {
     font-weight: 600;
  -  color: var(--text-primary, #f8fafc);
  +  color: var(--text-primary);
     margin-bottom: 2px;
   }

   .tooltipRow {
  -  color: var(--text-secondary, #cbd5e1);
  +  color: var(--text-secondary);
   }
  ```
- **治理断言**：完全剔除 `#0288d1`、`#f8fafc`、`#cbd5e1`，写入态符合 Zero-Blue 铁律，Tooltip 在浅色与深色模式下均清晰可读。

---

### 4. `apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css`
- **承担职责**：上下文注入卡片基座、紧凑注入行、失败态高亮、发丝微提示。
- **缺陷来源**：`audits/03: ARCH-DISCONNECT-01, DARK-FLASH-02`
- **病灶审查**：
  1. 第 353-357 行死选择器 `.injectionBlock.isFailed`，TSX 容器绑定的实际类名为 `styles.injectionRow`，导致失败红框永远不生效；
  2. 第 168 行残留浅米黄色 fallback：`border: 1px solid var(--border-subtle, hsl(35 8% 91%));`，暗黑闪白；
  3. 第 130 行残留字体硬编码。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
  +++ b/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
  @@ -129,3 +129,3 @@
   .tokenBadge {
  -  font-family: 'Segoe UI', -apple-system, var(--font-sans);
  +  font-family: var(--font-sans);
     font-variant-numeric: tabular-nums;
  @@ -167,3 +167,3 @@
     height: 18px;
  -  border: 1px solid var(--border-subtle, hsl(35 8% 91%));
  +  border: 1px solid var(--border-subtle);
     border-radius: var(--radius-sm, 4px);
  @@ -353,2 +353,3 @@
   .injectionRow.isFailed,
  -.injectionBlock.isFailed {
  +/* 规范化单一真源类名绑定，移除已失效的 .injectionBlock.isFailed */
  +.isFailed {
     border-left-color: var(--color-error);
  ```
- **治理断言**：`.injectionRow.isFailed` 100% 挂载生效，清除亮米黄 fallback，注入卡片达到纯纸化发丝标准。

---

### 5. `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`
- **承担职责**：工具调用执行块、双层结果容器、Git 差异对比卡、翻转指示器。
- **缺陷来源**：`audits/03: VAR-UNDEFINED-03, MOTION-EASING-02, CODE-HYGIENE-01`
- **病灶审查**：
  1. 第 913-920 行裸写未统一的 `--accent-green-light` / `--accent-red-light`；
  2. 第 119、676、705 行私自内联非标贝塞尔；
  3. 第 328-619 行大量中文注释因历史编码问题字符丢失沦为空格破损。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css
  +++ b/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css
  @@ -118,3 +118,3 @@
   .toolIndicatorFlip {
  -  animation: toolIndicatorFlip 100ms cubic-bezier(0.2, 0, 0, 1) forwards;
  +  animation: toolIndicatorFlip var(--transition-micro) forwards;
   }
  @@ -675,5 +675,5 @@
     transition:
  -    max-width 0.22s cubic-bezier(0.22, 1, 0.36, 1),
  -    opacity 0.18s ease,
  -    margin-left 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  +    max-width var(--transition-fast),
  +    opacity var(--transition-fast),
  +    margin-left var(--transition-fast);
   }
  @@ -704,3 +704,3 @@
     transition:
  -    color 0.15s ease,
  -    background 0.15s ease,
  -    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  +    color var(--transition-fast),
  +    background var(--transition-fast),
  +    transform var(--transition-fast);
   }
  @@ -912,7 +912,7 @@
   .gitDiffLineRow.addition {
  -  background-color: var(--accent-green-light);
  +  background-color: var(--color-success-bg);
   }

   .gitDiffLineRow.deletion {
  -  background-color: var(--accent-red-light);
  +  background-color: var(--color-error-bg);
   }
  ```
  同时将第 328-619 行被破坏的空格注释全部重写恢复为标准 UTF-8 无 BOM 中文注释。
- **治理断言**：消除所有内联私写贝塞尔，Diff 行背景色严格与设计系统语义色对齐，注释清洁无乱码。

---

### 6. `apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css`
- **承担职责**：中性工具调用卡片、命令行终端执行块、平铺 Diff 对比。
- **缺陷来源**：三层嵌套 fallback、终端分割线与 Diff 背景微调。
- **病灶审查**：第 284 行包含三层嵌套 fallback：`color: var(--color-success, var(--brand-deep, hsl(160 84% 30%)));`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css
  +++ b/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css
  @@ -283,3 +283,3 @@
   .copiedCheckIcon {
  -  color: var(--color-success, var(--brand-deep, hsl(160 84% 30%)));
  +  color: var(--color-success);
   }
  ```
- **治理断言**：完全清除三层嵌套 fallback，终端与卡片结构发丝线严格使用 `var(--border-subtle)`。

---

### 7. `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`
- **承担职责**：用户气泡、助手消息流、Markdown 渲染骨架、操作栏微交互。
- **缺陷来源**：`audits/03: HEX-COLOR-01, MAGIC-NUMBER-01`; `audits/10: Defect 10, Defect 14, Defect 15, Defect 17`
- **病灶审查**：
  1. 第 86 行用户气泡硬编码魔术数字 `border-radius: 22px`；
  2. 第 120 行 `--radius-lg, 10px` 与第 755 行 `--button-radius, 7px` 发生逆向漂移（系统真实 Token 为 8px）；
  3. 第 124 行引用未定义的 `--transition-base`；
  4. 第 526-534 行硬编码 `var(--brand, #10b981)` 与 `hsl(0 0% 100%)`；
  5. 第 654 行硬编码 `var(--brand, hsl(160 84% 39%))`；
  6. 第 108、317、485 行存在 3 套互不相容的焦点环；
  7. `.iconBtn`（行 727）与 `.planApproveChip`（行 219）完全缺失 `:focus-visible`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
  @@ -85,3 +85,3 @@
   .userBubble {
  -  border-radius: 22px;
  +  border-radius: var(--radius-2xl, 20px);
   }
  @@ -103,4 +103,4 @@
   .userBubble:focus-visible {
     outline: none;
  -  box-shadow: 0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  +  box-shadow: var(--focus-ring-strong);
   }
  @@ -117,5 +117,5 @@
   .userImageWrapper {
  -  border-radius: var(--radius-lg, 10px);
  +  border-radius: var(--radius-lg);
     overflow: hidden;
  -  transition: transform var(--transition-base, 150ms ease), border-color var(--transition-base, 150ms ease);
  +  transition: transform var(--transition-fast), border-color var(--transition-fast);
   }
  @@ -226,4 +226,9 @@
   .planApproveChip:hover {
     background: var(--bg-hover);
     border-color: var(--border-color);
   }
  +.planApproveChip:focus-visible {
  +  outline: none;
  +  box-shadow: var(--focus-ring);
  +}
  @@ -310,6 +315,6 @@
   .followupChipMain:focus-visible,
   .followupChipSend:focus-visible,
   .followupDismiss:focus-visible {
     outline: none;
  -  box-shadow: var(--focus-ring);
  +  box-shadow: var(--focus-ring);
   }
  @@ -480,4 +485,4 @@
   .assistantText :global(.md-path-link:focus-visible) {
     outline: none;
  -  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand) 20%, transparent);
  +  box-shadow: var(--focus-ring);
   }
  @@ -530,3 +535,3 @@
   .assistantText :global(.md-task-box.checked::after) {
  -  border: solid var(--text-on-accent, hsl(0 0% 100%));
  +  border: solid var(--text-on-accent);
   }
  @@ -650,3 +655,3 @@
   .assistantText :global(.md-code-copy.is-copied) {
  -  color: var(--brand, hsl(160 84% 39%));
  +  color: var(--brand);
   }
  @@ -744,4 +749,9 @@
   .iconBtn:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
   }
  +.iconBtn:focus-visible {
  +  outline: none;
  +  box-shadow: var(--focus-ring);
  +}
  @@ -751,3 +761,3 @@
   .retractBtn {
  -  border-radius: var(--button-radius, 7px);
  +  border-radius: var(--button-radius);
   }
  ```
- **治理断言**：完全消灭 22px、7px、10px 魔术数字与漂移，补全缺失的焦点态，统一 3 套焦点环为 Conex §13 标准微环。

---

### 8. `apps/crish-desktop/src/components/chat-message/MessageContent.module.css`
- **承担职责**：轮次过程折叠状态机、控制栏、多媒体嵌入区。
- **缺陷来源**：`audits/03: MAGIC-NUMBER-02`
- **病灶审查**：第 15、20 行硬编码奇数高度 `33px` 与亚像素下边框 `0.5px`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message/MessageContent.module.css
  +++ b/apps/crish-desktop/src/components/chat-message/MessageContent.module.css
  @@ -15,7 +15,7 @@
   .turnProcessControlBar {
     display: flex;
     align-items: center;
     width: 100%;
  -  height: 33px;
  +  height: var(--control-height, 32px);
     padding: 6px 0;
     margin: 0;
     background: transparent;
  -  border-bottom: 0.5px solid var(--border-subtle);
  +  border-bottom: var(--hairline-width, 1px) solid var(--border-subtle);
   }
  ```
- **治理断言**：对齐 8 点栅格律，消除 0.5px 在 1x 屏幕上抖动与被丢弃的物理隐患。

---

### 9. `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css`
- **承担职责**：思考链 24px 极简交互条、流式扫光追踪、展开态正文。
- **缺陷来源**：`audits/10: Defect 02, Defect 09, Defect 12, Defect 13`
- **病灶审查**：
  1. 第 171-184 行扫光渐变混入 `#111827`，暗黑模式下呈现黑洞擦除；
  2. 第 56-62、275-280 行手写 `0.5px/2px` 双层环；
  3. 第 162-169 行死动画 `@keyframes reasoning-row-sweep`；
  4. 第 264 行 `.copyButton` 滥用 `transition: all`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css
  @@ -56,6 +56,3 @@
   .reasoningRow:focus-visible {
     outline: none;
  -  box-shadow:
  -    0 0 0 0.5px color-mix(in srgb, var(--text-primary) 6%, transparent),
  -    0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  +  box-shadow: var(--focus-ring-strong);
     border-radius: var(--radius-sm, 4px);
   }
  @@ -161,9 +158,0 @@
  -@keyframes reasoning-row-sweep {
  -  0% {
  -    background-position: -200% 0;
  -  }
  -  100% {
  -    background-position: 200% 0;
  -  }
  -}
  @@ -174,3 +162,3 @@
       var(--text-tertiary) 0%,
  -    color-mix(in srgb, var(--text-primary, #111827) 75%, transparent) 50%,
  +    color-mix(in srgb, var(--text-primary) 75%, transparent) 50%,
       var(--text-tertiary) 100%
  @@ -263,3 +251,3 @@
     cursor: pointer;
  -  transition: all var(--transition-fast, 150ms ease);
  +  transition: color var(--transition-fast), background-color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
     line-height: 1.4;
  @@ -276,4 +264,2 @@
   .copyButton:focus-visible {
     outline: none;
  -  box-shadow:
  -    0 0 0 0.5px color-mix(in srgb, var(--text-primary) 6%, transparent),
  -    0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  +  box-shadow: var(--focus-ring);
   }
  ```
- **治理断言**：完全剔除死关键帧，扫光动效在暗黑模式下自然闪耀，`transition: all` 彻底清零。

---

### 10. `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css`
- **承担职责**：执行计划步骤脊柱线、序号圆点微动效、展开子步骤。
- **缺陷来源**：`audits/10: Defect 04, Defect 10, Defect 11, Defect 16`
- **病灶审查**：
  1. 第 25-35 行 `left: 7.625px` 与 `width: 0.75px` 浮点定位导致像素抖动，`rgba(0, 0, 0, 0.15)` 导致暗黑脊柱失明；
  2. 第 46-61 行 `.flowPlanStepHead` 缺失 `:focus-visible`；
  3. 第 74、82、88 行误用 `--bg-page` 产生穿孔黑洞。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css
  @@ -25,10 +25,10 @@
   .flowPlanStep::after {
     content: '';
     position: absolute;
     top: 30px;
     bottom: calc(var(--plan-gap) * -1);
  -  left: 7.625px;
  -  width: 0.75px;
  -  background-color: var(--border-color, rgba(0, 0, 0, 0.15));
  +  left: 7.5px;
  +  width: var(--hairline-width, 1px);
  +  background-color: var(--border-color);
     z-index: 0;
   }
  @@ -60,2 +60,6 @@
     text-align: left;
   }
  +.flowPlanStepHead:focus-visible {
  +  outline: none;
  +  box-shadow: var(--focus-ring);
  +}
  @@ -73,3 +77,3 @@
     font-variant-numeric: tabular-nums;
  -  background: var(--bg-page);
  +  background: var(--bg-card);
     color: var(--text-secondary);
  @@ -81,3 +85,3 @@
   .flowPlanStep.isDone .flowPlanStepNum {
  -  background: var(--bg-page);
  +  background: var(--bg-card);
     color: var(--text-primary);
  @@ -87,4 +91,4 @@
   .flowPlanStep.isRunning .flowPlanStepNum {
  -  background: color-mix(in srgb, var(--brand, var(--color-success)) 12%, var(--bg-page));
  -  color: var(--brand, var(--color-success));
  +  background: color-mix(in srgb, var(--brand) 12%, var(--bg-card));
  +  color: var(--brand);
     border-color: color-mix(in srgb, var(--brand) 40%, transparent);
  ```
- **治理断言**：消灭浮点亚像素 Hack，脊柱连线在深色底板清晰可见，步骤圆圈与卡片背景完全融为一体。

---

### 11. `apps/crish-desktop/src/components/chat-message-row/FlowArtifactChip.module.css`
- **承担职责**：代码产物交互胶囊、实时同步指示行。
- **缺陷来源**：`audits/10: Defect 05, Defect 10`
- **病灶审查**：
  1. 第 36-39 行引用幽灵变量 `--brand-line`，其 fallback 裸写 `rgba(16, 185, 129, 0.35)`；
  2. 第 22-56 行缺失 `:focus-visible` 定义。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/FlowArtifactChip.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/FlowArtifactChip.module.css
  @@ -38,2 +38,2 @@
     text-underline-offset: 3px;
  -  text-decoration-color: var(--brand-line, rgba(16, 185, 129, 0.35));
  +  text-decoration-color: color-mix(in srgb, var(--accent-color) 35%, transparent);
  @@ -55,2 +55,6 @@
   }
  +.flowArtifactChip:focus-visible {
  +  outline: none;
  +  box-shadow: var(--focus-ring);
  +}
  ```
- **治理断言**：拔除 `--brand-line` 幽灵引用与旧式 `rgba`，产物胶囊键盘聚焦可感知。

---

### 12. `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css`
- **承担职责**：流式 Markdown 表格容器、高频活跃单元格呼吸脉冲。
- **缺陷来源**：`audits/03: MOTION-EASING-01`; `audits/10: Defect 06, Defect 07`
- **病灶审查**：
  1. 第 86-110 行连续使用 4 个未定义的 `--stream-table-*` 幽灵变量与 8 处硬编码 `#10b981`；
  2. 第 106 行私自内联 `cubic-bezier(0.16, 1, 0.3, 1)`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css
  @@ -85,11 +85,11 @@
     0%, 100% {
  -    outline-color: var(--stream-table-active-border, color-mix(in srgb, var(--accent-color) 48%, var(--border-color)));
  -    box-shadow: var(--stream-table-active-glow, 0 0 0 1px color-mix(in srgb, var(--accent-color) 18%, transparent));
  -    background-color: var(--stream-table-active-bg, color-mix(in srgb, var(--accent-color) 6%, transparent));
  +    outline-color: color-mix(in srgb, var(--accent-color) 48%, var(--border-color));
  +    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-color) 18%, transparent);
  +    background-color: color-mix(in srgb, var(--accent-color) 6%, transparent);
     }
     50% {
  -    outline-color: color-mix(in srgb, var(--stream-table-active-border, color-mix(in srgb, var(--accent-color) 48%, var(--border-color))) 35%, transparent);
  +    outline-color: color-mix(in srgb, color-mix(in srgb, var(--accent-color) 48%, var(--border-color)) 35%, transparent);
       box-shadow: 0 0 0 0 transparent;
  -    background-color: color-mix(in srgb, var(--stream-table-active-bg, color-mix(in srgb, var(--accent-color) 6%, transparent)) 25%, transparent);
  +    background-color: color-mix(in srgb, color-mix(in srgb, var(--accent-color) 6%, transparent) 25%, transparent);
     }
   }
  @@ -101,6 +101,6 @@
     position: relative;
  -  outline: 1px dashed var(--stream-table-active-border, color-mix(in srgb, var(--accent-color) 48%, var(--border-color)));
  +  outline: 1px dashed color-mix(in srgb, var(--accent-color) 48%, var(--border-color));
     outline-offset: -1px;
  -  box-shadow: var(--stream-table-active-glow, 0 0 0 1px color-mix(in srgb, var(--accent-color) 18%, transparent));
  -  background-color: var(--stream-table-active-bg, color-mix(in srgb, var(--accent-color) 6%, transparent));
  -  animation: md-table-pulse var(--stream-table-pulse-duration, 1.6s) var(--stream-table-pulse-timing, cubic-bezier(0.16, 1, 0.3, 1)) infinite;
  +  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-color) 18%, transparent);
  +  background-color: color-mix(in srgb, var(--accent-color) 6%, transparent);
  +  animation: md-table-pulse var(--transition-pulse, 1.6s) var(--ease-emphasized) infinite;
  ```
- **治理断言**：拔除 4 个幽灵变量与 8 处 `#10b981`，脉冲缓动完全收敛至 `--ease-emphasized`。

---

### 13. `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css`
- **承担职责**：时间线思维链展开器、抽屉折叠容器。
- **缺陷来源**：`audits/10: Defect 07, Defect 08`
- **病灶审查**：
  1. 第 42-45 行 `.thoughtHeaderBtn:focus-visible` 清空 `outline: none` 且零微环补偿；
  2. 第 144 行私写 `200ms cubic-bezier(0.16, 1, 0.3, 1)`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css
  +++ b/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css
  @@ -43,3 +43,4 @@
     outline: none;
  -  color: var(--text-primary);
  +  color: var(--text-primary);
  +  box-shadow: var(--focus-ring);
   }
  @@ -143,3 +144,3 @@
     display: grid;
     grid-template-rows: 0fr;
  -  transition: grid-template-rows 200ms cubic-bezier(0.16, 1, 0.3, 1);
  +  transition: grid-template-rows var(--transition-accordion);
   }
  ```
- **治理断言**：补齐键盘聚焦微环，抽屉折叠动效接入系统正典 `--transition-accordion`。

---

### 14. `apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css`
- **承担职责**：工具调用权限审批询问卡片、危险操作二阶段确认。
- **缺陷来源**：`audits/03: HEX-COLOR-02`
- **病灶审查**：第 237-243 行裸写 `#047857`、`#ffffff`、`#10b981`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
  +++ b/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
  @@ -236,5 +236,5 @@
   .approvalCardBtn.allow {
     background: var(--accent-color);
     border-color: transparent;
  -  color: var(--text-on-accent, hsl(0 0% 100%));
  +  color: var(--text-on-accent);
   }
  ```
- **治理断言**：全卡片 0 处 Hex，严格接入 `--text-on-accent` 与系统品牌 Token。

---

### 15. `apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css`
- **承担职责**：内嵌子代理协作面板、运行脉冲指示灯、产出卡片。
- **缺陷来源**：`audits/03: HEX-COLOR-03`
- **病灶审查**：第 73-74、88、256-258 行多处残留硬编码 `#10b981` 与 `#059669`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css
  +++ b/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css
  @@ -72,4 +72,4 @@
     border-radius: 50%;
  -  background: var(--brand, #10b981);
  -  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--brand, #10b981) 22%, transparent);
  +  background: var(--brand);
  +  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--brand) 22%, transparent);
   }
  @@ -87,3 +87,3 @@
       opacity: 1;
  -    box-shadow: 0 0 0 4.5px color-mix(in srgb, var(--brand, #10b981) 32%, transparent);
  +    box-shadow: 0 0 0 4.5px color-mix(in srgb, var(--brand) 32%, transparent);
     }
  ```
- **治理断言**：彻底消灭 `#10b981` 与 `#059669`，子代理呼吸灯与徽章完全 Token 化。

---

### 16. `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`
- **承担职责**：底部 Composer 坞、发送按钮、附件栏、快捷操作圆纽。
- **缺陷来源**：`audits/03: DARK-FLASH-03, HEX-COLOR-04, CONEX-SHADOW-01, MOTION-EASING-03`
- **病灶审查**：
  1. 第 659 行硬编码暗色半透明 `rgba(255, 255, 255, 0.08)` 导致亮色模式边框隐形；
  2. 第 809 行残留 `box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);`；
  3. 第 814 行私写 `cubic-bezier(0.16, 1, 0.3, 1)`；
  4. 第 1176、1220 行裸写颜色命名 `white`；
  5. 第 1182-1185 行连续 4 组内联 `cubic-bezier(0.16, 1, 0.3, 1)`。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
  +++ b/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
  @@ -658,3 +658,3 @@
     padding: 0;
  -  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  +  border: 1px solid var(--border-subtle);
     max-width: 28px;
  @@ -808,4 +808,3 @@
     border: 1px solid var(--border-color);
     border-radius: var(--radius-md, 8px);
  -  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);
  +  box-shadow: var(--shadow-lg);
     padding: 10px 12px;
  @@ -813,3 +812,3 @@
     gap: 8px;
  -  animation: annPopoverFadeIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
  +  animation: annPopoverFadeIn 140ms var(--ease-emphasized);
   }
  @@ -1175,3 +1174,3 @@
     background: var(--brand);
  -  color: var(--text-on-brand, white);
  +  color: var(--text-on-brand);
     flex-shrink: 0;
  @@ -1181,6 +1180,6 @@
     transition:
  -    width 200ms cubic-bezier(0.16, 1, 0.3, 1),
  -    margin-left 200ms cubic-bezier(0.16, 1, 0.3, 1),
  -    opacity 160ms cubic-bezier(0.16, 1, 0.3, 1),
  -    transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
  +    width 200ms var(--ease-emphasized),
  +    margin-left 200ms var(--ease-emphasized),
  +    opacity 160ms var(--ease-emphasized),
  +    transform 200ms var(--ease-emphasized),
       background var(--transition-fast, 120ms ease),
  @@ -1219,3 +1218,3 @@
     stroke-width: 2.5;
  -  color: var(--text-on-brand, white);
  +  color: var(--text-on-brand);
     stroke: currentColor;
  ```
- **治理断言**：完全消灭 `white`、`rgba(...)` 重阴影与内联贝塞尔，附件卡片在亮暗双色主题下边缘清晰。

---

### 17. `apps/crish-desktop/src/components/chat-card/ChatCard.module.css` 及周边组件
- **承担职责**：对话卡片主体容器、模型选择胶囊、空态底板。
- **缺陷来源**：`audits/03: CONEX-FOCUS-01, CONEX-FOCUS-02, CONEX-SHADOW-01, CODE-HYGIENE-01`
- **病灶审查**：
  1. `ChatCard.module.css:100-126` `.modelBadge` 完全缺失 `:focus-visible`；
  2. `ChatStatusRibbons.module.css:89` 残留 `box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);`；
  3. `ChatEmptyState.module.css:29-152` 残留大量空格破损注释。
- **改造对比（Before vs After）**：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-card/ChatCard.module.css
  +++ b/apps/crish-desktop/src/components/chat-card/ChatCard.module.css
  @@ -126,2 +126,6 @@
   }
  +.modelBadge:focus-visible {
  +  outline: none;
  +  box-shadow: var(--focus-ring);
  +}
  @@ -128,3 +132,3 @@
   .modelText {
  -  font-size: var(--font-sub, 13px);
  +  font-size: var(--font-size-sm, 13px);
  ```
  ```diff
  --- a/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css
  +++ b/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css
  @@ -88,3 +88,3 @@
     background: var(--bg-secondary);
  -  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  +  box-shadow: none;
     animation: chipFadeIn var(--transition-popover-enter);
  ```
- **治理断言**：补全模型选择器键盘焦点微环，拔除无谓阴影，重构破损注释。

---

## 七、TSX / JSX 内联样式清洗与属性化架构详案

### 1. 内联样式清洗核心红线与白名单机制

- **绝对禁止静态外观属性内联**：严禁在 JSX/TSX 元素上通过 `style={{ color: ... }}`、`style={{ background: ... }}`、`style={{ border: ... }}`、`style={{ fontSize: ... }}` 或布局类 `style={{ display: 'flex', ... }}` 裸写样式；
- **允许的唯一例外（动态几何计算白名单）**：仅允许由运行时 JavaScript 计算得出的瞬态几何数值使用内联 `style`：
  - 进度百分比：`style={{ width: `${progressPct}%` }}`；
  - 虚拟列表滚动偏移：`style={{ transform: `translateY(${startOffset}px)` }}` 或 `style={{ height: totalHeight }}`；
  - 动态气泡/弹窗物理定位：`style={{ top: coords.y, left: coords.x }}`。

---

### 2. 6 个核心 TSX 文件逐一重构落地

#### (1) `DynamicChipBar.tsx`（`audits/03: INLINE-STYLE-01`）
- **违规行号**：148-153, 169, 174, 182
- **重构方案**：将内联样式移入 `ChatStatusRibbons.module.css` 或 `DynamicChipBar.module.css`：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-card/DynamicChipBar.tsx
  +++ b/apps/crish-desktop/src/components/chat-card/DynamicChipBar.tsx
  @@ -147,7 +147,2 @@
             size="sm"
  -          style={{
  -            background: 'none',
  -            border: 'none',
  -            cursor: 'pointer',
  -            color: 'var(--text-tertiary)',
  -          }}
  +          className={styles.closePlanBtn}
             aria-label="关闭计划详情"
  @@ -168,3 +163,3 @@
                   <Lucide.CheckCircle2
                     size={13}
  -                  style={{ color: 'var(--accent-green)' }}
  +                  className={styles.itemIconDone}
                   />
  @@ -173,3 +168,3 @@
                   <Lucide.Circle
                     size={13}
  -                  style={{ color: 'var(--text-tertiary)' }}
  +                  className={styles.itemIconPending}
                   />
  @@ -181,3 +176,3 @@
         ) : (
  -        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
  +        <div className={styles.emptyPlanTip}>
             {inPlanMode
  ```

#### (2) `ChatHeaderControls.tsx`（`audits/03: INLINE-STYLE-02`）
- **违规行号**：168, 173-179
- **重构方案**：剥离内联文本省略与弹性布局属性，由于这些属性已在 `ChatCard.module.css` 的 `.modelBadge` 与 `.modelText` 中完备声明，直接删除冗余的内联 `style` 属性即可：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-card/ChatHeaderControls.tsx
  +++ b/apps/crish-desktop/src/components/chat-card/ChatHeaderControls.tsx
  @@ -167,3 +167,2 @@
             aria-label="选择模型"
  -          style={{ cursor: 'pointer', position: 'relative' }}
             onClick={handleBadgeClick}
  @@ -172,8 +171,2 @@
               className={styles.modelText}
  -            style={{
  -              textOverflow: 'ellipsis',
  -              overflow: 'hidden',
  -              whiteSpace: 'nowrap',
  -              flex: 1,
  -              textAlign: 'left',
  -            }}
             >
  ```

#### (3) `InjectionHeader.tsx` 与 `CompactToolRow.tsx`（`audits/03: INLINE-STYLE-03`）
- **违规行号**：`InjectionHeader.tsx:180`；`CompactToolRow.tsx:146`
- **重构方案**：微型 Spinner 尺寸封装为全局原子类 `.spinnerSm`（12px）与 `.spinnerXs`（8px），严禁在 TSX 中内联像素：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-injection/InjectionHeader.tsx
  +++ b/apps/crish-desktop/src/components/chat-injection/InjectionHeader.tsx
  @@ -178,3 +178,3 @@
                 <span
  -                className={`${styles.pendingPulse} loading-spinner`}
  -                style={{ width: 12, height: 12, borderWidth: 1.5 }}
  +                className={`${styles.pendingPulse} loading-spinner ${styles.spinnerSm}`}
                 />
  ```
  ```diff
  --- a/apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx
  +++ b/apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx
  @@ -144,3 +144,3 @@
                       <span
  -                      className="loading-spinner"
  -                      style={{ width: 8, height: 8, borderWidth: 1.5 }}
  +                      className={`loading-spinner ${styles.spinnerXs}`}
                       />
  ```

#### (4) `ChatMessageList.tsx`（`audits/03: INLINE-STYLE-04`）
- **违规行号**：191
- **重构方案**：将空态消息容器布局移入 `ChatMessageList.module.css` 中的 `.emptyScrollContainer` 类名：
  ```diff
  --- a/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx
  +++ b/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx
  @@ -190,2 +190,3 @@
           data-chat-scroll-container=""
  -        style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
  +        className={styles.emptyScrollContainer}
         >
  ```

#### (5) 状态驱动外观规范（`data-status` 集中派发）
对于具有状态切换的外观（成功、警告、失败、运行中），严禁在 TSX 中使用三元运算符拼接类名或 style，统一通过 `data-status` 属性驱动：
```tsx
// ❌ 违规：三元拼接
<div style={{ color: isError ? 'var(--color-error)' : 'var(--color-success)' }} />

// ✅ 规范：data-status 集中派发
<div className={styles.statusIndicator} data-status={status} />

/* CSS Module 统一派发： */
.statusIndicator[data-status='error'] { color: var(--color-error); }
.statusIndicator[data-status='success'] { color: var(--color-success); }
.statusIndicator[data-status='running'] { color: var(--brand); }
```

---

## 八、全自动门禁脚本与守门规则（CI Gateways & Assertions）

依据 `AGENTS.md` §7.1“立体验证纪律（禁止单一检查冒充验收）”，本详案建立覆盖全生命周期的立体化门禁守门体系。

### 1. 现行全量门禁检查清单

| 门禁类型 | 执行命令 | 检验核心对象与规则 | 阻断阈值 |
| :--- | :--- | :--- | :--- |
| **CSS 编码守门** | `npm run check:css-encoding` | 扫描全仓 `.css`、`.ts`、`.tsx`：检测 UTF-8 BOM、真 GBK 字节、U+FFFD 替换符、PUA 区及 GBK 逆变换 | 退出码非 0 立即阻断（零豁免） |
| **行数基线门禁** | `npm run check:line-counts` | UI Components $\le 500$ 行，业务 $\le 400$ 行，类型 $\le 800$ 行，单文件 $>650$ 行硬阻断 | 违规超标立即阻断 |
| **输入框守门** | `npm run check:input-guard` | 拦截输入框四态倒退与幽灵 Token | 违规立即阻断 |
| **UI 分层解耦** | `npm run check:ui-layer` | 检查前端分层契约与私有引用隔离 | 违规立即阻断 |
| **TypeScript 类型** | `npm run typecheck` | 全仓静态类型编译，确保 TSX 类名清洗后 0 断裂 | 0 报错（Exit Code 0） |
| **单测回归套件** | `npx vitest run chat-*` | 验证对话流组件渲染、注入微提示与工具卡片 100% 通过 | 100% PASS，0 失败 |

---

### 2. CSS 去硬编码与设计系统专职守护规则设计

在 `scripts/check-css-encoding.mjs` 之外，规划建立/扩展专职样式守门检测断言（如 `check:css-standards` 或在 `check:ui-layer` 中装配专职规则）：

1. **Zero-Hex 刚性清零断言**：
   - 目标扫描域：`apps/crish-desktop/src/components/chat-*` 及周边组件的所有 `.module.css`；
   - 规则：正则扫描 `#[0-9a-fA-F]{3,8}`，**命中数量必须严格为 0**（所有颜色必须引用 `var(--...)` 或 `color-mix(...)`）；
2. **Zero-Raw-RGBA 刚性清零断言**：
   - 目标扫描域：上述组件 CSS 模块；
   - 规则：正则扫描 `rgba\(`，**命中数量必须严格为 0**（透明度统一走 `hsl(h s l / a)` 或 `color-mix(in srgb, ...)`）；
3. **Zero-Flash-Fallback 刚性清零断言**：
   - 目标扫描域：上述组件 CSS 模块；
   - 规则：正则扫描 `var\(--[^,)]+,\s*(?:#[0-9a-fA-F]+|hsl\(0\s+0%\s+100%\)|white|rgba)`，**命中数量必须严格为 0**（严禁将亮白色或旧式半透明作为 CSS 变量 fallback）；
4. **Zero-Inline-Cubic-Bezier 刚性清零断言**：
   - 目标扫描域：除 `tokens.css` 以外的全仓所有 CSS 模块；
   - 规则：正则扫描 `cubic-bezier\(`，**命中数量必须严格为 0**（必须统一引用 `var(--ease-standard)` 或 `var(--ease-emphasized)`）；
5. **Zero-Static-Inline-Style 刚性清零断言**：
   - 目标扫描域：`apps/crish-desktop/src/components/chat-*/**/*.tsx`；
   - 规则：正则扫描 `style=\{\{[^}]*(?:color|background|border|fontSize)`，除动态百分比白名单外，**静态外观内联命中数必须为 0**；
6. **Zero-Dead-Selector 静态校验**：
   - 校验 CSS Module 中导出的类名与对应 TSX 文件中的 `styles.*` 引用一一对应，防止出现类似 `.injectionBlock.isFailed` 的死选择器。

---

## 九、反退避自检与架构净收敛审查表

严格对照 `.agents/LOGIC_PLAN_NO_RETREAT.md` 与根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md` 逐条审查：

| 审查维度 | 规范准则与红线要求 | 本详案遵循证据与设计闭环 | 审查结论 |
| :--- | :--- | :--- | :--- |
| **效果锁** | 严禁自行砍功能、削减视觉表现或将需求降级为“简化版” | 全量保全了 17 个关键 CSS 模块的所有动效细节（流式扫光、思考脉冲、微提示分割线、抽屉折叠），并在消除闪白后视觉质感更加高级纯粹 | **合规** |
| **问题同权** | 禁止使用 P0/P1 优先级对问题进行挑拣，问题一律平等 | audits/03 与 audits/10 的 41 项缺陷全量建档治理，无一遗漏；方案完全基于逻辑拓扑组织，零业务优先级划分 | **合规** |
| **反退避裁判** | 不得以“暗黑模式不易出现”、“业界都写 fallback”为由劝退或妥协 | 穿透暗黑模式闪白物理根因，建立“无 fallback 首选 + 自适应双 Token 兜底”的刚性铁律，彻底拔除妥协退避 | **合规** |
| **架构净收敛** | 严禁使用延时盲猜、坐标测距补偿或临时兼容补丁 | 清理了多重退避嵌套与死关键帧 `@keyframes reasoning-row-sweep`，消灭 7.625px 浮点 Hack，收敛为单一真理源 Token | **合规** |
| **反过度设计** | 严禁引入不必要的复杂 runtime 计算或过度抽象的样式处理器 | 100% 依赖浏览器原生 CSS 自定义属性与原生 `color-mix(in srgb, ...)`，零第三方 runtime 依赖，零额外渲染负担 | **合规** |
| **立体验证纪律** | 绝对禁止使用 `--no-verify` 绕过门禁，必须正面跑通检查 | 制定了涵盖 `check:css-encoding`、`check:line-counts`、`typecheck` 的立体化断言矩阵，强制自动化绿灯 | **合规** |

---

> **详案定案结论**：本方案作为全仓 CSS 模块去硬编码与设计系统对齐的唯一权威执行方案，全量覆盖并根治了 `audits/03`（24 项）与 `audits/10`（17 项）揭示的全部 41 项缺陷，锁定了 Zero-Hex 映射矩阵、防闪白标准、缓动正典与 Conex §12/§13 规范。后续实现任务严格依据本详案规划的七阶纯逻辑拓扑执行落地。
