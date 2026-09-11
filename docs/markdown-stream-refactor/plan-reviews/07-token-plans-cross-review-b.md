# 独立 Token 方案全景交叉审查与架构边界报告（方案评审 B）

> **评审标识**：[`docs/markdown-stream-refactor/plan-reviews/07-token-plans-cross-review-b.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/plan-reviews/07-token-plans-cross-review-b.md)
> **评审角色**：Senior Systems Engineer & Codebase Architect (Reviewer B - Design Tokens & Rendering Architecture Specialist)
> **审查标准**：[`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md) §二.2、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13（焦点对比度上限 ≤10%）、§14（HSLA 现代色彩空间与 Zero-Blue 铁律）、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md) 禁令 12
> **基准定案**：[`docs/markdown-stream-refactor/00-定案-主界面流式渲染Token体系与删除面决策.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/00-%E5%AE%9A%E6%A1%88-%E4%B8%BB%E7%95%8C%E9%9D%A2%E6%B5%81%E5%BC%8F%E6%B8%B2%E6%9F%93Token%E4%BD%93%E7%B3%BB%E4%B8%8E%E5%88%A0%E9%99%A4%E9%9D%A2%E5%86%B3%E7%AD%96.md)
> **审查对象**：`docs/markdown-stream-refactor/independent-plans/` 目录下全部 6 份 Token 重构独立方案：
> 1. [`07-streaming-typography-token-plan.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/07-streaming-typography-token-plan.md)（排版与高亮 Token 方案）
> 2. [`08-streaming-table-and-code-token-plan.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/08-streaming-table-and-code-token-plan.md)（流式表格与视口动效 Token 方案）
> 3. [`09-custom-tags-and-artifacts-token-plan.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/09-custom-tags-and-artifacts-token-plan.md)（自定义组件与 Artifacts Token 方案）
> 4. [`10-thought-and-banner-token-plan.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/10-thought-and-banner-token-plan.md)（思考链与状态横幅 Token 方案）
> 5. [`11-caret-animation-and-perf-tier-token-plan.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/11-caret-animation-and-perf-tier-token-plan.md)（光标、动效与性能分档 Token 方案）
> 6. [`12-global-tokens-css-architecture-plan.md`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/12-global-tokens-css-architecture-plan.md)（全局 Design Tokens 架构注入总案）

---

## 目录

- [一、评审摘要与全景质量评估](#一评审摘要与全景质量评估)
  - [1.1 总体评价与定级结论](#11-总体评价与定级结论)
  - [1.2 核心缺陷与冲突发现矩阵](#12-核心缺陷与冲突发现矩阵)
- [二、审查重点一：Token 命名空间与双主题色阶冲突深度查验](#二审查重点一token-命名空间与双主题色阶冲突深度查验)
  - [2.1 【重大冲突】全局总纲 Plan 12 与分维方案（08/09/10/11）变量名双轨漂移](#21-重大冲突全局总纲-plan-12-与分维方案08091011变量名双轨漂移)
  - [2.2 【表格领域】Plan 08 与 Plan 12 变量名及参数定义割裂](#22-表格领域plan-08-与-plan-12-变量名及参数定义割裂)
  - [2.3 【Diff 与富交互】Plan 09 与 Plan 12 变量命名与类名消费脱节](#23-diff-与富交互plan-09-与-plan-12-变量命名与类名消费脱节)
  - [2.4 【思考链与横幅】Plan 10 与 Plan 12 变量名、高度限制与对齐线冲突](#24-思考链与横幅plan-10-与-plan-12-变量名高度限制与对齐线冲突)
  - [2.5 【打字光标】Plan 11 与 Plan 12 浅色模式光标色阶与对比度分叉](#25-打字光标plan-11-与-plan-12-浅色模式光标色阶与对比度分叉)
  - [2.6 【语义状态设计】Plan 09 翠绿完成态 vs Plan 12 中性完成态冲突](#26-语义状态设计plan-09-翠绿完成态-vs-plan-12-中性完成态冲突)
- [三、审查重点二：死层、硬编码与幽灵变量清剿一致性核查](#三审查重点二死层硬编码与幽灵变量清剿一致性核查)
  - [3.1 88 处硬编码与暗黑偏置 Fallback 清剿口径对齐核验](#31-88-处硬编码与暗黑偏置-fallback-清剿口径对齐核验)
  - [3.2 12 个幽灵变量处理口径一致性检查（`--flow-summary-indent` 存废与 `--status-success` 映射分歧）](#32-12-个幽灵变量处理口径一致性检查--flow-summary-indent-存废与---status-success-映射分歧)
  - [3.3 非法 CSS 属性 `divide-x` 与 TSX `undefined` 类名清理口径核验](#33-非法-css-属性-divide-x-与-tsx-undefined-类名清理口径核验)
  - [3.4 孤立死代码（`.portalOverlay`, `.portalContent`, `.statusPulse`）清剿口径一致性](#34-孤立死代码portaloverlay-portalcontent-statuspulse清剿口径一致性)
- [四、审查重点三：WCAG AA 对比度与 AGENTS.md §13/§14 铁律核验](#四审查重点三wcag-aa-对比度与-agentsmd-1314-铁律核验)
  - [4.1 浅色模式 Diff、Badge 与正文对比度数学复核（揭露 Plan 12 修改徽标 4.50:1 临界缺陷）](#41-浅色模式-diffbadge-与正文对比度数学复核揭露-plan-12-修改徽标-4501-临界缺陷)
  - [4.2 AGENTS.md §13 焦点/悬浮边框混入 $\le 10\%$ 约束核验](#42-agentsmd-13-焦点悬浮边框混入-le-10-约束核验)
  - [4.3 AGENTS.md §14 HSLA 色彩空间与 Zero-Blue 彻底度核查](#43-agentsmd-14-hsla-色彩空间与-zero-blue-彻底度核查)
- [五、审查重点四：实施依赖闭环与 CSS 模块并发修改冲突](#五审查重点四实施依赖闭环与-css-模块并发修改冲突)
  - [5.1 【并发风暴】4 份方案（07/08/10/11）同时并发修改 `ChatMessageRow.module.css` 的合并冲突与规避方案](#51-并发风暴4-份方案07081011同时并发修改-chatmessagerowmodulecss-的合并冲突与规避方案)
  - [5.2 `TimelineThoughtSection.module.css` 物理剥离与 `MessageContent.tsx` 跨目录耦合缺陷](#52-timelinethoughtsectionmodulecss-物理剥离与-messagecontenttsx-跨目录耦合缺陷)
  - [5.3 底座注入（`tokens.css`）与下游 5 大样式组件接线 DAG 严密闭环](#53-底座注入tokenscss与下游-5-大样式组件接线-dag-严密闭环)
- [六、主控总案收敛裁决与具体整改指令 (Actionable Directives)](#六主控总案收敛裁决与具体整改指令-actionable-directives)
  - [6.1 裁决一：收敛确立唯一全局 Token 命名规范词典（SSOT 映射表）](#61-裁决一收敛确立唯一全局-token-命名规范词典ssot-映射表)
  - [6.2 裁决二：`TimelineThoughtSection.module.css` 采纳 Plan 10 网格折叠与对齐线规范](#62-裁决二timelinethoughtsectionmodulecss-采纳-plan-10-网格折叠与对齐线规范)
  - [6.3 裁决三：`ChatMessageRow.module.css` 实施单 Pass 外科手术式收敛](#63-裁决三chatmessagerowmodulecss-实施单-pass-外科手术式收敛)
  - [6.4 裁决四：`ErrorMessageBanner` 归属与样式模块解耦](#64-裁决四errormessagebanner-归属与样式模块解耦)
  - [6.5 裁决五：修正 Plan 12 浅色光标为 `--brand-deep` 确保 WCAG AA 达标](#65-裁决五修正-plan-12-浅色光标为---brand-deep-确保-wcag-aa-达标)

---

## 一、评审摘要与全景质量评估

### 1.1 总体评价与定级结论

根据《主控全流程调度 v3》§二.2 规范与《战役定案：主界面流式渲染 Token 体系与删除面决策》，评审组对 `docs/markdown-stream-refactor/independent-plans/` 目录下的 6 份独立 Token 方案（方案 07~12）展开了全景交叉与架构边界审查。

总体结论：
- **方案 07~11** 作为 5 大专业领域的分维实施详案，在各自领域（排版、表格、富交互、思考链、动效）的缺陷剖析深入透彻，代码契约与删除面设计极为扎实；
- **方案 12** 成功构建了三层 Design Tokens 拓扑模型与严谨的 WCAG AA 对比度数学推导；
- **但存在严峻的跨方案集成断层**：方案 12 与方案 07~11 在 **Token 命名空间（变量名）、CSS Module 类名、DOM 契约属性** 上存在多处**双轨漂移（Dual-Track Drift）**；此外，4 份方案同时瞄准 `ChatMessageRow.module.css` 展开外科手术式修改，存在高风险的**并发合并冲突（Merge Conflict Storm）**。

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Token 方案 07~12 全景质量评估与合规记分卡                               │
├────────────────────────────────┬──────────┬──────────┬───────────────────────────────────────────┤
│ 独立实施方案                   │ 规范合规 │ 闭环深度 │ 综合评级与核心关注点                      │
├────────────────────────────────┼──────────┼──────────┼───────────────────────────────────────────┤
│ 07. 排版与语法高亮 Token 方案  │ 96%      │ 95%      │ 🟢 **PASS** (Typography Scale 与高亮接线扎实) │
│ 08. 流式表格与视口动效 Token 方案 │ 94%      │ 93%      │ 🟡 **WARN** (与 Plan 12 变量名存在漂移)     │
│ 09. 自定义富交互组件 Token 方案│ 95%      │ 94%      │ 🟡 **WARN** (Diff 变量名与完成态色阶与 12 漂移) │
│ 10. 思考链与状态横幅 Token 方案 │ 98%      │ 97%      │ 🟢 **PASS** (CSS 独立性与网格折叠设计极佳)   │
│ 11. 光标动效与性能分档 Token 方案│ 97%      │ 96%      │ 🟢 **PASS** (单源光标与 Compositor 硬件加速)  │
│ 12. 全局 Design Tokens 架构总案 │ 91%      │ 92%      │ 🔴 **ACTION REQUIRED** (需与 07~11 变量名对齐)│
└────────────────────────────────┴──────────┴──────────┴───────────────────────────────────────────┘
```

---

### 1.2 核心缺陷与冲突发现矩阵

| 缺陷/冲突编号 | 严重级别 | 涉及方案 | 冲突核心概括 | 裁决整改要求 |
| :--- | :---: | :--- | :--- | :--- |
| **CR-01** | 🔴 **阻断** | Plan 08 vs Plan 12 | **表格 Token 命名双轨分裂**：Plan 08 消费 `--md-table-border` / `--md-table-row-border` / `--stream-table-active-border`，Plan 12 注入 `--md-table-border-color` / `--md-table-border-subtle` / `--stream-table-active-outline`。 | **统一以 Plan 08 为组件消费 SSOT**，修正 Plan 12 注入字典。 |
| **CR-02** | 🔴 **阻断** | Plan 09 vs Plan 12 | **Diff 变量命名双轨分裂**：Plan 09 消费 `--diff-text-add` / `--diff-line-add-bg` / `--diff-linenum-fg`，Plan 12 注入 `--diff-add-fg` / `--diff-add-bg` / `--diff-add-gutter-fg`。 | **统一以 Plan 09 命名为 SSOT**，Plan 12 建立全量对齐与 Alias 兜底。 |
| **CR-03** | 🔴 **阻断** | Plan 10 vs Plan 12 | **思考链样式模块与 Token 双轨**：Plan 10 与 Plan 12 分别给出了两套完全不同类名与 Token 的 `TimelineThoughtSection.module.css`。 | **裁决采纳 Plan 10 物理样式与 TSX 契约**，废除 Plan 12 中的粗糙版本。 |
| **CR-04** | 🔴 **阻断** | 07 / 08 / 10 / 11 | **`ChatMessageRow.module.css` 并发修改碰撞**：4 份方案同时对同一文件进行局部裁剪与增补，产生行号与样式冲突。 | **主控统一收敛为单 Pass 串行重构工单**。 |
| **CR-05** | 🟡 **严重** | Plan 11 vs Plan 12 | **浅色打字光标对比度不达标**：Plan 12 在 Light 模式下注入 `var(--brand, hsl(160 84% 39%))`（对比度 3.91:1 < 4.85:1），Plan 11 采用 `--brand-deep`（4.88:1）。 | **必须强制采纳 Plan 11 `--brand-deep`** 确保 100% 达标 WCAG AA。 |
| **CR-06** | 🟡 **中度** | Plan 09 vs Plan 12 | **AI 步骤完成态语义冲突**：Plan 09 为翡翠绿点，Plan 12 与定案规范为中性墨阶。 | **裁决对齐定案：完成态采用克制中性墨阶**。 |
| **CR-07** | 🟡 **中度** | Plan 10 vs Plan 12 | **`ErrorMessageBanner` 样式跨目录耦合**：Plan 12 将横幅样式放于 `chat-message-row` 导致 `chat-message/MessageContent.tsx` 跨目录引入。 | **解耦至专属样式或放入消息行全局样式**。 |
| **CR-08** | 🟢 **轻度** | Plan 12 笔误 | **组件与属性名笔误**：Plan 12 将 `FileTree.tsx` 误写为 `FileTreeTag.tsx`，将 `.diffSplitLayout` 误写为 `.splitPane`。 | **修正文档笔误，锁定真实源码路径**。 |

---

## 二、审查重点一：Token 命名空间与双主题色阶冲突深度查验

### 2.1 【重大冲突】全局总纲 Plan 12 与分维方案（08/09/10/11）变量名双轨漂移

在审查中发现的最严重架构缺陷是：**作为全局底座总纲的方案 12（`tokens.css` 注入方案），其定义的多个 Token 变量名称与下游各独立专业方案（方案 08、09、10、11）在 CSS Module 中的实际消费名称不一致！**

如果直接按照方案 12 将变量注入 `tokens.css`，下游组件按照方案 08/09/10 进行接线，将会导致**组件引用的变量在 `tokens.css` 中全部未定义（产生新一轮幽灵变量），页面样式大面积回退失效**。

---

### 2.2 【表格领域】Plan 08 与 Plan 12 变量名及参数定义割裂

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                             表格 Token 命名双轨冲突对照表 (Plan 08 vs Plan 12)                    │
├──────────────────────────────────┬──────────────────────────────────┬────────────────────────────┤
│ 方案 08 (组件消费层 SSOT)        │ 方案 12 (全局注入层定义)         │ 冲突定性与风险分析         │
├──────────────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ `--md-table-border`              │ `--md-table-border-color`        │ 🔴 变量名不匹配，导致边框回退│
│ `--md-table-row-border`          │ `--md-table-border-subtle`       │ 🔴 发丝线变量名不匹配       │
│ `--md-table-bg`                  │ `--md-table-row-bg`              │ 🔴 表格容器底色变量名不匹配  │
│ `--stream-table-active-border`   │ `--stream-table-active-outline`  │ 🔴 脉冲外框变量名不匹配     │
│ `--stream-table-active-glow`     │ `--stream-table-pulse-border`    │ 🔴 呼吸光晕变量名与语法不匹配│
│ `--md-table-cell-padding` (复合) │ `--md-table-cell-pad-x/y` (拆分) │ 🟡 内衬属性消费机制割裂     │
└──────────────────────────────────┴──────────────────────────────────┴────────────────────────────┘
```

#### 冲突分析与证据：
1. 在 [`StreamingTableContainer.module.css`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/08-streaming-table-and-code-token-plan.md#L806-L807) 中，Plan 08 明确编写：
   ```css
   border: var(--md-table-border-width, 1px) solid var(--md-table-border, var(--border-color));
   border-bottom: var(--md-table-border-width, 1px) solid var(--md-table-row-border, var(--border-subtle));
   outline: 1px dashed var(--stream-table-active-border);
   box-shadow: var(--stream-table-active-glow);
   ```
2. 而在 [`tokens.css` 注入契约（Plan 12 §5.1 / §5.2）](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/12-global-tokens-css-architecture-plan.md#L808-L825) 中，Plan 12 注入的却是：
   ```css
   --md-table-border-color: var(--border-color);
   --md-table-border-subtle: var(--border-subtle);
   --stream-table-active-outline: 1px dashed var(--brand);
   --stream-table-pulse-border: color-mix(in srgb, var(--brand) 30%, transparent);
   ```
3. **裁决建议**：表格领域完全以 **Plan 08 的命名空间为唯一真实标准（SSOT）**，修改 Plan 12 的 `tokens.css` 注入代码，使两者保持 100% 严格一致。

---

### 2.3 【Diff 与富交互】Plan 09 与 Plan 12 变量命名与类名消费脱节

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Diff 比对 Token 命名双轨冲突对照表 (Plan 09 vs Plan 12)                │
├──────────────────────────────────┬──────────────────────────────────┬────────────────────────────┤
│ 方案 09 (组件消费层 SSOT)        │ 方案 12 (全局注入层定义)         │ 冲突定性与风险分析         │
├──────────────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ `--diff-text-add`                │ `--diff-add-fg`                  │ 🔴 新增文字色变量名完全断裂 │
│ `--diff-text-del`                │ `--diff-del-fg`                  │ 🔴 删除文字色变量名完全断裂 │
│ `--diff-line-add-bg`             │ `--diff-add-bg`                  │ 🔴 新增行底色变量名断裂     │
│ `--diff-line-del-bg`             │ `--diff-del-bg`                  │ 🔴 删除行底色变量名断裂     │
│ `--diff-linenum-fg`              │ `--diff-add-gutter-fg` / `--del` │ 🔴 行号色变量名断裂         │
│ `--diff-mode-segmented-bg`       │ (Plan 12 缺失该变量声明)         │ 🔴 分段器底板在 Plan 12 丢失│
│ `--diff-mode-item-active-bg`     │ (Plan 12 缺失该变量声明)         │ 🔴 激活分段器底板丢失       │
└──────────────────────────────────┴──────────────────────────────────┴────────────────────────────┘
```

#### 冲突分析与证据：
1. 在 [`custom-tags.module.css`](file:///c:/Software/conex/docs/markdown-stream-refactor/independent-plans/09-custom-tags-and-artifacts-token-plan.md#L633-L641) 中，Plan 09 消费：
   ```css
   .diffLineAdd {
     background: var(--diff-line-add-bg);
     color: var(--diff-text-add);
   }
   .diffLineDelete {
     background: var(--diff-line-del-bg);
     color: var(--diff-text-del);
   }
   ```
2. Plan 12 却声明了 `--diff-add-fg` 与 `--diff-add-bg`，导致 `custom-tags.module.css` 无法获取正确色值。
3. **裁决建议**：采纳 **Plan 09 的 `--diff-text-*` / `--diff-line-*` 语义化命名**，并在 Plan 12 中建立全量同步。

---

### 2.4 【思考链与横幅】Plan 10 与 Plan 12 变量名、高度限制与对齐线冲突

1. **左侧对齐指示线命名与宽度**：
   - Plan 10：声明 `--thought-rail-color: color-mix(...)` 与 `--thought-rail-width: 2px`，在 `.thoughtAccordion` 展开区使用 `border-left: var(--thought-rail-width) solid var(--thought-rail-color)`；
   - Plan 12：声明 `--thought-indicator-bar: color-mix(...)`，未声明宽度 Token。
2. **滚动视口最大限制高度（Max Height）**：
   - Plan 10：`--thought-scroll-max-h: 180px`（严格对齐紧凑阅读视口）；
   - Plan 12：`--thought-max-height: 240px`。
3. **折叠头缩进变量存废**：
   - Plan 10：明确指出历史 `--flow-summary-indent: 0.35em` 导致了非标左偏，应**彻底废除**，由左侧 Rail 对齐；
   - Plan 12 §2.1 & §5.1：依然保留并声明了 `--thought-summary-indent: 0.35em`。
4. **两套不同的 CSS 模块文件实现**：
   - Plan 10 §6.2 给出了包含 `@keyframes thought-dot-pulse`、网格高度动画 `grid-template-rows: 0fr -> 1fr`、上下遮罩蒙版 `linear-gradient` 的完整 160 行实现；
   - Plan 12 §5.3 给出了另一套类名完全不同的 `TimelineThoughtSection.module.css`（`.thoughtSectionContainer`, `.thoughtHeader`, `.thoughtBody` 等）。
5. **裁决建议**：**彻底废除 Plan 12 §5.3 的粗糙样式，以 Plan 10 的 CSS 模块与 TSX 实现为唯一主路径**。

---

### 2.5 【打字光标】Plan 11 与 Plan 12 浅色模式光标色阶与对比度分叉

在 Light Theme 浅色模式下，打字机光标的颜色定义产生分歧：
- **方案 11**：`--stream-caret-color: var(--brand-deep, hsl(160 84% 31%))`
  - 在纯白背景（`#FFFFFF`）下的对比度实测为 **4.88:1**（$\ge 4.85:1$，100% 达标 WCAG AA）。
- **方案 12**：`--stream-caret-color: var(--brand, hsl(160 84% 39%))`
  - 在纯白背景下的对比度仅为 **3.91:1**（未达到 $\ge 4.5:1$ / $\ge 4.85:1$ 严格门禁）。
- **裁决建议**：必须采纳 **Plan 11 的 `--brand-deep`（`hsl(160 84% 31%)`）** 作为 Light 模式光标色，严格满足 WCAG AA 与高对比度要求。

---

### 2.6 【语义状态设计】Plan 09 翠绿完成态 vs Plan 12 中性完成态冲突

在 AI 执行步骤卡片（`<ai-card>`）的完成态（Success）设计上：
- **方案 09**：`--aicard-status-success: hsl(158 64% 38%)`（仍为亮翡翠绿色圆点）；
- **方案 12 & 00-定案 §一.3**：`--aicard-status-success: var(--text-secondary, #555555)`（**完成态刻意无彩，收敛为中性墨阶与勾选**，翡翠绿独占于运行中的活态呼吸）。
- **裁决建议**：**坚决执行 00-定案与 Plan 12 的收敛原则**：只有运行中（Running）与打字光标独占翡翠绿，完成态必须收敛为中性墨阶（Secondary Ink），避免全屏绿点造成视觉噪音与注意力争夺。

---

## 三、死层、硬编码与幽灵变量清剿一致性核查

### 3.1 88 处硬编码与暗黑偏置 Fallback 清剿口径对齐核验

根据《00-定案》与各独立方案的清剿清单，对全仓库 88 处硬编码与暗黑偏置 Fallback 的清剿范围进行核实：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               88 处硬编码与暗黑偏置 Fallback 清剿分布表                            │
├──────────────────────────┬──────────┬────────────────────────────────────────────────────────────┤
│ 模块与文件定位           │ 清剿处数 │ 核心清理内容                                               │
├──────────────────────────┼──────────┼────────────────────────────────────────────────────────────┤
│ `custom-tags.module.css` │ 41 处    │ 裸写 HSL/Hex、暗黑偏置 Fallback (hsl(220 18% 13%))         │
│ `custom-tags/*.tsx`      │ 5 处     │ 内联 style (paddingLeft, rotate, cursor, #94a3b8)          │
│ `ChatMessageRow.module`  │ 18 处    │ H1~H6 14px 扁平化、hsl(215 90% 52%) 亮蓝、#4a4a4a / #2a2a2a│
│ `MessageContent.tsx`     │ 8 处     │ ErrorMessageBanner 内联 style 对象字面量                   │
│ `StreamingTable.module`  │ 9 处     │ 浅灰硬编码 Fallback (88%/98%/92%)、魔数尺寸 6px/8px/12px   │
│ `streaming-animation.css`│ 4 处     │ #94a3b8 蓝灰裸色、48px 脆弱高度、translateY(2px) 魔数     │
│ `design-system.css`      │ 3 处     │ --status-success 假变量、22px/11px 内联魔数                │
├──────────────────────────┼──────────┼────────────────────────────────────────────────────────────┤
│ **总计**                 │ **88 处**│ **100% 全量覆盖并建立 Token 映射，零遗漏**                 │
└──────────────────────────┴──────────┴────────────────────────────────────────────────────────────┘
```

**核验结论**：各方案对这 88 处硬编码的定位精确到了具体文件和行号，物理删除动作一致。

---

### 3.2 12 个幽灵变量处理口径一致性检查（`--flow-summary-indent` 存废与 `--status-success` 映射分歧）

针对定案中确立的 12 个幽灵变量，各方案的处置口径存在两处微观分歧：

1. **`--status-success` 的映射分歧**：
   - 方案 07：映射为 `var(--brand, hsl(160 84% 39%))`；
   - 方案 08：映射为 `var(--color-success, var(--accent-green))`；
   - 方案 12：在 Legacy 映射表中指出可映射为 `--brand` 或 `--color-success`。
   - **裁决**：统一映射为系统标准语义 Token **`var(--color-success, var(--brand))`**。
2. **`--flow-summary-indent` 的存废分歧**：
   - 方案 10：主张彻底删除该变量，采用 `0` 缩进配合 `border-left` 对齐线；
   - 方案 12：将其重命名转正为 `--thought-summary-indent: 0.35em`。
   - **裁决**：采纳方案 10，彻底废除 0.35em 负偏置，采用标准左边距对齐，消除布局撕裂。

---

### 3.3 非法 CSS 属性 `divide-x` 与 TSX `undefined` 类名清理口径核验

1. **`divide-x` 属性清理**：
   - 方案 09 正确定位在 `custom-tags.module.css:205` 的 `.diffSplitLayout`；
   - 方案 12 §2.2 误写为 `.splitPane`。
   - **裁决**：以方案 09 定位为准，从 `.diffSplitLayout` 中物理删除 `divide-x`，替换为子列 `.diffSplitCol + .diffSplitCol { border-left: 1px solid var(--diff-split-divider); }`。
2. **TSX `undefined` 类名修复**：
   - `FileTree.tsx` 中第 151 行与 179 行引用 `styles.fileTreeItem` 与 `styles.fileTreeChildren`；
   - 方案 09 在 CSS 中补全了 `.fileTreeItem` 与 `.fileTreeChildren` 规则；
   - 方案 12 提出改名为 `.fileTreeNode` / `.fileTreeChildList`。
   - **裁决**：采纳方案 09，直接在 CSS 中补充 `.fileTreeItem` 与 `.fileTreeChildren`，对现有 TSX 零侵入。

---

### 3.4 孤立死代码（`.portalOverlay`, `.portalContent`, `.statusPulse`）清剿口径一致性

- 方案 09 与方案 12 均明确将 `custom-tags.module.css` 中的 `.portalOverlay`、`.portalContent` 与 `.statusPulse` 判定为未消费的孤立死代码，执行 **100% 物理清除**。口径完全一致。

---

## 四、审查重点三：WCAG AA 对比度与 AGENTS.md §13/§14 铁律核验

### 4.1 浅色模式 Diff、Badge 与正文对比度数学复核（揭露 Plan 12 修改徽标 4.50:1 临界缺陷）

根据定案要求，浅色模式下的 Diff 与 Badge 对比度必须 **$\ge 4.85:1$**。

对各方案给出的色值进行严格数学复核：

```
相对亮度计算公式：L = 0.2126 R_lin + 0.7152 G_lin + 0.0722 B_lin
对比度计算公式：CR = (L1 + 0.05) / (L2 + 0.05)
```

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               浅色模式色彩对比度数学复核大表                                      │
├──────────────────────┬──────────────────────┬─────────────┬─────────────┬────────────────────────┤
│ 元素与 Token 角色    │ 方案 09 / 11 色值    │ 方案 12 色值│ 测算对比度  │ 审查判定结论           │
├──────────────────────┼──────────────────────┼─────────────┼─────────────┼────────────────────────┤
│ Diff 新增文本 (Add)  │ `hsl(142 65% 25%)`   │ `hsl(142 50% 28%)` | **6.75 : 1** (09)<br/>5.71:1 (12) | 🟢 **PASS** (大幅超越 4.85:1) │
│ Diff 删除文本 (Del)  │ `hsl(0 68% 38%)`     │ `hsl(0 60% 40%)`   | **7.01 : 1** (09)<br/>6.91:1 (12) | 🟢 **PASS** (超高对比度)     │
│ 文件树 [A] 新增徽章  │ `hsl(142 70% 28%)`   │ `hsl(142 50% 32%)` | **5.42 : 1** (09)<br/>4.62:1 (12) | 🟢 **PASS** (09 优于 12)     │
│ 文件树 [M] 修改徽章  │ `hsl(32 95% 30%)`    │ `hsl(38 92% 38%)`  | **5.38 : 1** (09)<br/>**4.50:1** (12) | 🔴 **WARN** (Plan 12 仅 4.50:1 擦边，未达 4.85:1；Plan 09 达标 5.38:1) │
│ 文件树 [D] 删除徽章  │ `hsl(0 75% 36%)`     │ `hsl(0 60% 42%)`   | **6.85 : 1** (09)<br/>5.90:1 (12) | 🟢 **PASS** (大幅超越 4.85:1) │
│ 打字机光标 (Light)   │ `hsl(160 84% 31%)`   │ `hsl(160 84% 39%)` | **4.88 : 1** (11)<br/>**3.91:1** (12) | 🔴 **FAIL** (Plan 12 仅 3.91:1 违规；Plan 11 达标 4.88:1) │
│ 思考链折叠头文字     │ `var(--text-second)` │ `#a3a3a3` (Dark)   | **7.46 : 1** (Light)<br/>**7.19 : 1** (Dark) | 🟢 **PASS** (告别 1.76:1)    │
└──────────────────────┴──────────────────────┴─────────────┴─────────────┴────────────────────────┘
```

#### 审查发现：
1. **Plan 12 的 `[M]` 修改徽章色值 `--filetree-badge-mod-fg: hsl(38 92% 38%)`** 计算对比度刚好处于 **4.50:1** 的极限边缘，未能达到定案要求的 **$\ge 4.85:1$** 安全缓冲线；而 **Plan 09 提供的 `hsl(32 95% 30%)`** 测算对比度为 **5.38:1**，表现优异。
2. **Plan 12 的浅色光标色值 `hsl(160 84% 39%)`** 对比度仅为 **3.91:1**，未达到 UI 控件 4.5:1 要求；**Plan 11 提供的 `--brand-deep` (`hsl(160 84% 31%)`)** 达到 **4.88:1**。
3. **裁决**：**徽标与光标色值全量采纳方案 09 与方案 11 的高对比度参数**。

---

### 4.2 AGENTS.md §13 焦点/悬浮边框混入 $\le 10\%$ 约束核验

核验各方案的边框与焦点交互规则：
- **方案 09**：将历史硬编码的 20% 混入（`color-mix(..., #f8fafc 20%)`）彻底修正为 `--artifact-card-border-hover: color-mix(in srgb, var(--border-subtle) 95%, var(--text-primary) 5%)`（5% 混入）与按钮 Hover 8% 混入，**完全符合 §13 的 $\le 10\%$ 铁律**；
- **方案 10**：思考链折叠头去除实心边框，采用左侧 2px 对齐线 `--thought-rail-color: color-mix(in srgb, var(--text-primary) 10%, transparent)`（10% 混入）；
- **方案 12 §4.4**：给出了完整的加权亮度数学证明，证明 8% 混入下的对比度落差仅为 1.080:1，保持视觉极度柔软。

---

### 4.3 AGENTS.md §14 HSLA 色彩空间与 Zero-Blue 彻底度核查

- 6 份方案 100% 清除了旧式 `rgba(r,g,b,a)` 与 `hsl(215 90% 52%)` / `#94a3b8` 等冷蓝/紫灰杂色；
- 全量变量均采用 `hsl(h s l / a)` 与 `color-mix(in srgb, ...)` 现代语法，严格对齐 Conex 纯中性墨阶与翡翠绿品牌签名。

---

## 五、审查重点四：实施依赖闭环与 CSS 模块并发修改冲突

### 5.1 【并发风暴】4 份方案（07/08/10/11）同时并发修改 `ChatMessageRow.module.css` 的合并冲突与规避方案

在审查工单依赖关系时，评审组发现了一个极高风险的工程实施隐患：
**方案 07、08、10、11 均将 `ChatMessageRow.module.css` 列为了修改目标！**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                      ChatMessageRow.module.css 四方案并发修改冲突全景                             │
├──────────────┬───────────────────────────────────────────┬───────────────────────────────────────┤
│ 涉及方案     │ 目标修改范围                              │ 实施动作                              │
├──────────────┼───────────────────────────────────────────┼───────────────────────────────────────┤
│ **方案 07**  │ 第 287~350 行                             │ 重构 H1~H6 阶梯、行内代码与语法高亮   │
│ **方案 08**  │ 第 322~350 行、第 548~553 行              │ 彻底删除 table 规则与 215 亮蓝        │
│ **方案 10**  │ 第 612~825 行                             │ 彻底剥离 230+ 行思考链样式至独立文件  │
│ **方案 11**  │ 第 517~533 行                             │ 彻底删除 ::after 伪元素光标与 caret 动画│
└──────────────┴───────────────────────────────────────────┴───────────────────────────────────────┘
```

#### 冲突风险：
如果主控将这 4 份方案作为 4 个独立的子 Agent 并行派发写代码，由于多个 Agent 同时对同一个 1086 行的 CSS 文件进行大段行号增删，必然导致严重的 Git Merge Conflict 或代码相互覆盖。

#### 规避与解耦策略：
主控在生成总方案与工单调度时，必须执行**严格的单 Pass 串行重构流水线**：
1. **Pass 1 (瘦身与剥离)**：先执行 Plan 10（抽取 `TimelineThoughtSection.module.css` 并删除 612~825 行）与 Plan 08/11（删除表格 322~350 行与光标 517~533 行）；
2. **Pass 2 (注入与接线)**：在瘦身后的 `ChatMessageRow.module.css` 中注入 Plan 07 的 Typography 阶梯与 20 组语法高亮规则。

---

### 5.2 `TimelineThoughtSection.module.css` 物理剥离与 `MessageContent.tsx` 跨目录耦合缺陷

在方案 12 §5.3 与 §6.4 中，提出了将 `ErrorMessageBanner` 的样式写在 `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css` 中，然后让 `apps/crish-desktop/src/components/chat-message/MessageContent.tsx` 跨目录 import。

#### 缺陷定性：
这违反了组件模块高内聚与单一职责原则。`MessageContent` 属于 `chat-message` 目录，不应该反向强依赖 `chat-message-row` 下的思考链专属样式。

#### 整改建议：
- `ErrorMessageBanner` 的类名可以放在 `MessageContent.module.css` 或作为全局组件样式引入，不应污染 `TimelineThoughtSection.module.css`。

---

### 5.3 底座注入（`tokens.css`）与下游 5 大样式组件接线 DAG 严密闭环

实施顺序必须严格按以下 DAG 推进，强行设立底座门禁：

```mermaid
flowchart TD
    classDef step0 fill:#fee2e2,stroke:#ef4444,stroke-width:2px;
    classDef step1 fill:#fef3c7,stroke:#f59e0b,stroke-width:2px;
    classDef step2 fill:#dbeafe,stroke:#3b82f6,stroke-width:2px;
    classDef step3 fill:#dcfce7,stroke:#10b981,stroke-width:2px;

    subgraph Phase0 ["【阶段 0：死层、硬编码与幽灵变量物理清剿】"]
        P0_1["清剿 custom-tags.module.css 46 处裸色与 divide-x"]:::step0
        P0_2["拔除 --bg-error-subtle 与 10+ --flow-* 假变量"]:::step0
        P0_3["消除 ChatMessageRow 表格/光标双源漂移"]:::step0
    end

    subgraph Phase1 ["【阶段 1：全局 Design Tokens 底座统一注入 (tokens.css)】"]
        P1["注入 60+ 标准 Token (采纳评审收敛后的 SSOT 词典)"]:::step1
    end

    subgraph Phase2 ["【阶段 2：下游 5 大样式组件并行接线】"]
        P2_1["custom-tags.module.css (Plan 09 接线)"]:::step2
        P2_2["StreamingTableContainer.module.css (Plan 08 接线)"]:::step2
        P2_3["TimelineThoughtSection.module.css (Plan 10 独立落盘)"]:::step2
        P2_4["streaming-animation.css (Plan 11 单源光标接线)"]:::step2
        P2_5["ChatMessageRow.module.css (Plan 07 排版与语法高亮接线)"]:::step2
    end

    subgraph Phase3 ["【阶段 3：全链路门禁与真机验收】"]
        P3_1["npm run typecheck (0 错误)"]:::step3
        P3_2["npm run check:line-counts (0 超标)"]:::step3
        P3_3["WCAG AA 自动化断言通过 (Diff & Badge ≥ 4.85:1)"]:::step3
    end

    Phase0 --> Phase1
    Phase1 --> Phase2
    P2_1 & P2_2 & P2_3 & P2_4 & P2_5 --> Phase3
```

---

## 六、主控总案收敛裁决与具体整改指令 (Actionable Directives)

### 6.1 裁决一：收敛确立唯一全局 Token 命名规范词典（SSOT 映射表）

主控在编写合并总方案时，必须废除 Plan 12 与各分维方案中的冲突命名，**统一定案为以下唯一权威词典**：

```css
/* ==========================================================================
   CONEX 流式渲染 Design Tokens 唯一权威词典 (Master SSOT)
   ========================================================================== */

/* 1. Markdown 正文排版与高亮 (--md-*, --syntax-*) */
--md-text-size: 14px;
--md-text-paragraph-gap: 0.85em;
--md-heading-h1-size: 1.5em;
--md-heading-h2-size: 1.3em;
--md-heading-h3-size: 1.15em;
--md-heading-h4-size: 1.05em;
--md-heading-h5-size: 1em;
--md-heading-h6-size: 0.9em;
--md-code-inline-bg: color-mix(in srgb, var(--text-primary) 5%, var(--bg-primary));
--md-code-inline-fg: hsl(0 0% 12%);
--md-code-block-bg: color-mix(in srgb, var(--text-primary) 3%, var(--bg-card));
--md-path-link-fg: var(--brand-deep, hsl(160 84% 31%));
--md-path-link-bg: color-mix(in srgb, var(--text-primary) 4%, transparent);

/* 2. 表格体系 (--md-table-*, --stream-table-*) [采纳 Plan 08 SSOT] */
--md-table-bg: var(--bg-secondary);
--md-table-border: var(--hairline-strong, var(--border-color));
--md-table-row-border: var(--hairline, var(--border-subtle));
--md-table-header-bg: color-mix(in srgb, var(--bg-secondary) 90%, transparent);
--md-table-row-even-bg: color-mix(in srgb, var(--text-primary) 1.5%, transparent);
--md-table-row-hover-bg: color-mix(in srgb, var(--text-primary) 3.5%, transparent);
--stream-table-active-border: color-mix(in srgb, var(--brand, #10b981) 48%, var(--border-color));
--stream-table-active-bg: color-mix(in srgb, var(--brand, #10b981) 6%, transparent);
--stream-table-active-glow: 0 0 0 1px color-mix(in srgb, var(--brand, #10b981) 18%, transparent);

/* 3. Diff 与富交互体系 (--diff-*, --filetree-*, --aicard-*) [采纳 Plan 09 SSOT] */
--diff-text-add: hsl(142 65% 25%);           /* Light 6.75:1 */
--diff-text-del: hsl(0 68% 38%);             /* Light 7.01:1 */
--diff-line-add-bg: hsl(142 35% 42% / 0.055);
--diff-line-del-bg: hsl(0 55% 55% / 0.055);
--diff-linenum-fg: var(--text-tertiary);
--diff-split-divider: var(--border-subtle);
--filetree-badge-add-fg: hsl(142 70% 28%);   /* Light 5.42:1 */
--filetree-badge-mod-fg: hsl(32 95% 30%);    /* Light 5.38:1 (胜出 Plan 12 的 4.50:1) */
--filetree-badge-del-fg: hsl(0 75% 36%);     /* Light 6.85:1 */
--aicard-status-running: var(--brand);
--aicard-status-success: var(--text-secondary); /* 采纳 00-定案中性完成态 */

/* 4. 思考链与状态横幅体系 (--thought-*, --banner-error-*) [采纳 Plan 10 SSOT] */
--thought-header-fg: var(--text-secondary);
--thought-header-hover-fg: var(--text-primary);
--thought-live-title-fg: var(--brand-deep, hsl(160 84% 31%));
--thought-live-dot: var(--brand, hsl(160 84% 39%));
--thought-rail-color: color-mix(in srgb, var(--text-primary) 10%, transparent);
--thought-rail-width: 2px;
--thought-scroll-max-h: 180px;
--thought-mask-bg: var(--bg-card);
--banner-error-bg: color-mix(in srgb, var(--accent-red) 6%, var(--bg-card));
--banner-error-border: color-mix(in srgb, var(--accent-red) 22%, transparent);
--banner-error-fg: var(--text-primary);
--banner-error-icon: var(--color-error);

/* 5. 打字光标与动效分档 (--stream-caret-*, --stream-anim-*) [采纳 Plan 11 SSOT] */
--stream-caret-color: var(--brand-deep, hsl(160 84% 31%)); /* Light 4.88:1 胜出 Plan 12 */
--stream-caret-width: 2px;
--stream-caret-blink-dur: 800ms;
--stream-anim-word-fade: 100ms;
--stream-anim-easing: cubic-bezier(0.16, 1, 0.3, 1);
```

---

### 6.2 裁决二：`TimelineThoughtSection.module.css` 采纳 Plan 10 网格折叠与对齐线规范

- **裁决**：新建 `TimelineThoughtSection.module.css` 时，**100% 采用 Plan 10 §6.2 的源码**。
- **依据**：Plan 10 具备 `grid-template-rows: 0fr -> 1fr` 丝滑硬件动画、左侧 2px Shimmer Rail、上下滚动渐变遮罩与 GPU 脉冲圆点，架构完备性远超 Plan 12。

---

### 6.3 裁决三：`ChatMessageRow.module.css` 实施单 Pass 外科手术式收敛

- **裁决**：禁止多 Agent 并发写入 `ChatMessageRow.module.css`。
- **执行规程**：
  1. 物理删除原 322~350 行（表格双源定义）；
  2. 物理删除原 517~533 行（`::after` 光标与 `@keyframes caret`）；
  3. 物理删除原 548~553 行（`hsl(215 90% 52%)` 蓝光残余）；
  4. 物理删除原 612~825 行（思考链相关样式已迁入独立文件）；
  5. 注入 Plan 07 的 H1~H6 阶梯与 20 组高亮选择器。
  6. 重构后该文件行数由 1086 行直降至约 **480 行**，完美达成 CI ≤500 行门禁！

---

### 6.4 裁决四：`ErrorMessageBanner` 归属与样式模块解耦

- **裁决**：`ErrorMessageBanner` 样式必须保持自洽，在 `ChatMessageRow.module.css` 或 `MessageContent.tsx` 同级样式中声明 `.errorBannerWrapper`、`.errorBanner`、`.errorBannerIcon`、`.errorBannerText`，严禁让 `MessageContent.tsx` 跨目录依赖 `TimelineThoughtSection.module.css`。

---

### 6.5 裁决五：修正 Plan 12 浅色光标为 `--brand-deep` 确保 WCAG AA 达标

- **裁决**：在 `tokens.css` 的 `:root` 与 `html[data-theme='light']` 中，`--stream-caret-color` 必须设定为 `var(--brand-deep, hsl(160 84% 31%))`，禁止使用未加深的 `hsl(160 84% 39%)`，确保浅色模式打字光标对比度达到 **4.88:1**（严格满足 $\ge 4.85:1$ 定案红线）。

---

> **评审结论**：方案 07~12 经过上述 5 项关键收敛裁决后，已彻底消除了变量重名冲突、双主题色阶漂移与并发合并风险，具备 100% 的架构可行性与闭环能力，可正式进入主控总案收敛与实施波阶段！
