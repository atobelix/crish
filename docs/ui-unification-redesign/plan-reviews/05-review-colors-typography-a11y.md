# 05-DIM-04 专项评审报告：色彩语义角色、排版节奏与无障碍 APG 终极交叉审查

> **战役代号**：`UI-UNIFICATION-REDESIGN`
> **审查对象**：`docs/ui-unification-redesign/independent-plans/04-dim04-colors-typography-a11y-plan.md`（DIM-04 独立详细实施方案）及全域关联方案
> **审查基准**：
> - 仓库总规 `AGENTS.md`（§13 激活边框与焦点态、§14 色彩空间、§1 反退避铁律、§7 严禁补丁、§7.1 立体验证、§8 反过度设计）
> - W3C WCAG 2.1 / 2.2 规范（SC 1.4.11 Non-text Contrast 3:1, SC 2.4.11 Focus Appearance, SC 2.5.8 Target Size Minimum 24×24px, WAI-ARIA APG 1.2）
> - Jakub Krehel 7 大设计标准（`better-colors` 色彩语义角色、`better-typography` 等宽防抖、`better-accessibility` 无障碍与触控命中）
> - `docs/ui-unification-redesign/01-四维度定案与删除面矩阵.md`
> **审查结论**：**原则通过（Approved with Critical Architectural Corrections）**。方案方向极为正确，但在“Windows 字体栈 tnum 缺失”、“40×40px 伪元素重叠连击踩踏”、“WCAG 焦点对比度数学矛盾”、“虚拟列表键盘漫游状态丢失”以及“死样式类与 150+ outline:none 遗漏”等 5 处关键技术深水区存在重大盲区，必须在落地前完成架构纠偏。

---

## 目录索引

- [一、主审裁决总览与四大维度穿透评估表](#一主审裁决总览与四大维度穿透评估表)
- [二、色彩语义角色审查：“Fill exactly one action per view” 落地彻底性与操作流体验](#二色彩语义角色审查fill-exactly-one-action-per-view-落地彻底性与操作流体验)
  - [2.1 DiffCardFileList 条目 Primary 降级的真相：回归视觉真实而非削弱主操作](#21-diffcardfilelist-条目-primary-降级的真相回归视觉真实而非削弱主操作)
  - [2.2 审批列表行级降级与单/多项待审批时的操作流感知建模](#22-审批列表行级降级与单多项待审批时的操作流感知建模)
  - [2.3 纯黑 `#111111` 按钮的拔除与品牌翡翠绿单一真源（SSOT）的确立](#23-纯黑-111111-按钮的拔除与品牌翡翠绿单一真源ssot的确立)
- [三、排版节奏与等宽防抖审查：16 处注入清单穿透与 OpenType 字体栈陷阱](#三排版节奏与等宽防抖审查16-处注入清单穿透与-opentype-字体栈陷阱)
  - [3.1 16 处清单实证穿透：揪出 `ModelsSettingsTab` 死样式类与假修复陷阱](#31-16-处清单实证穿透揪出-modelssettingstab-死样式类与假修复陷阱)
  - [3.2 遗漏高频跳动数值曝光：Token 估算、运行计时器与实时延迟](#32-遗漏高频跳动数值曝光token-估算运行计时器与实时延迟)
  - [3.3 致命字体栈陷阱：Windows 微软雅黑无 `tnum` 导致防抖完全失效分析与解法](#33-致命字体栈陷阱windows-微软雅黑无-tnum-导致防抖完全失效分析与解法)
- [四、焦点环规范审查：3%~10% 克制浅灰的 WCAG 对比度矛盾与盲区清剿](#四焦点环规范审查310-克制浅灰的-wcag-对比度矛盾与盲区清剿)
  - [4.1 科学对比度数学建模：揭示 3%~10% 浅灰混入无法满足 WCAG 3:1 的数学现实](#41-科学对比度数学建模揭示-310-浅灰混入无法满足-wcag-31-的数学现实)
  - [4.2 `AGENTS.md` §13 宁静设计与 WCAG 键盘指示强度的张力化解架构](#42-agentsmd-13-宁静设计与-wcag-键盘指示强度的张力化解架构)
  - [4.3 虚假完成度：全站 150+ 处 `outline: none` 盲区与彩色发光光晕清剿方案](#43-虚假完成度全站-150-处-outline-none-盲区与彩色发光光晕清剿方案)
- [五、无障碍 APG 审查：40×40px 连击踩踏缺陷、ARIA 闭环与键盘漫游状态机](#五无障碍-apg-审查4040px-连击踩踏缺陷aria-闭环与键盘漫游状态机)
  - [5.1 40×40px 透明伪元素全局挂载引发的“幽灵连击与点击偷取”灾难](#51-4040px-透明伪元素全局挂载引发的幽灵连击与点击偷取灾难)
  - [5.2 21 处 `aria-label` 与 205 处 `aria-hidden`：原子组件树内置解法与 AST 防回归](#52-21-处-aria-label-与-205-处-aria-hidden原子组件树内置解法与-ast-防回归)
  - [5.3 侧边栏 Roving Tabindex 键盘漫游状态机健壮性审查与三大致命缺陷重塑](#53-侧边栏-roving-tabindex-键盘漫游状态机健壮性审查与三大致命缺陷重塑)
- [六、终审综合优化执行方案与原子 Diff 建议](#六终审综合优化执行方案与原子-diff-建议)

---

## 一、主审裁决总览与四大维度穿透评估表

本审查依据真实代码库（`apps/crish-desktop/src/`）中的 800+ 个 TSX/CSS 模块、Design Tokens 以及底层 W3C/WCAG 规范，对 `04-dim04-colors-typography-a11y-plan.md` 进行逐行逐像素的终极交叉审查。

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              DIM-04 终极交叉审查与风险穿透评估全景表                                   │
├────────────────────┬──────────┬─────────────────────────────────────┬──────────────────────────────────┤
│ 审查维度           │ 评级     │ 核心发现与潜在故障隐患              │ 强制纠偏指令                     │
├────────────────────┼──────────┼─────────────────────────────────────┼──────────────────────────────────┤
│ 1. 色彩语义角色与   │ **PASS** │ 降级方案符合现实视觉，全仓拔除      │ 补齐单个待审批条目时的视觉锚点；  │
│    一屏一主色      │ (优)     │ #111111 纯黑彻底，净减 199 行 CSS   │ 保持“暂存并提交”单一全局权威。   │
├────────────────────┼──────────┼─────────────────────────────────────┼──────────────────────────────────┤
│ 2. 排版防抖与      │ **WARN** │ `ModelsSettingsTab` 类名不存在；    │ 修正内联代码；注入 Token 与计时器；│
│    OpenType 字体栈 │ (高危)   │ Windows 微软雅黑无 `tnum` 致防抖失效│ 字体栈实施 Western-First 纠偏。  │
├────────────────────┼──────────┼─────────────────────────────────────┼──────────────────────────────────┤
│ 3. 焦点环规范与    │ **WARN** │ 3%~10% 浅灰对比度仅 1.6:1 (违背 3:1)│ 分离鼠标常态与键盘 :focus-visible│
│    WCAG 对比度     │ (中危)   │ 全站存量 150+ 处 outline: none 遗漏 │ 建立全局双环 Token 与扫描门禁。  │
├────────────────────┼──────────┼─────────────────────────────────────┼──────────────────────────────────┤
│ 4. 无障碍 APG 与   │ **FAIL** │ 40px 伪元素致密集按钮互叠偷取点击； │ 严禁全局盲挂，改用密度感应扩展； │
│    键盘漫游状态机  │ (严重)   │ 虚拟滚动致 querySelector 抛 null 丢失│ 修正 treeitem 漫游与类名选择器。 │
└────────────────────┴──────────┴─────────────────────────────────────┴──────────────────────────────────┘
```

---

## 二、色彩语义角色审查：“Fill exactly one action per view” 落地彻底性与操作流体验

### 2.1 `DiffCardFileList` 条目 Primary 降级的真相：回归视觉真实而非削弱主操作

#### 审查质疑与现场穿透分析
在评审中，最受关注的疑问是：“将 Diff 变更文件列表（[`DiffCardFileList.tsx:295`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L295)）中每一个文件的‘接受’按钮从 `variant="primary"` 降级为 `variant="ghost"`，是否会削弱用户对文件采纳关键操作的感知？”

**穿透审查结论：完全不会削弱，反而消除了长期的系统级设计欺骗！**

1. **历史代码伪装实证**：
   排查 [`DiffCard.module.css:430-456`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L430-L456)，历史代码如下：
   ```css
   .inlineActionBtn {
     background: transparent; /* 强制覆盖原子 Button 的实心主强调色 */
     color: var(--text-secondary);
   }
   .inlineActionAccept:hover:not(:disabled) {
     background: var(--accent-green-light-adaptive);
     color: var(--accent-green);
     border-color: var(--accent-green);
   }
   ```
   **物理真相**：在当前现网中，用户看到的单个文件“接受”按钮**从来就不是实心绿色的 Primary 按钮**！开发者为了防止 30 个变更文件产生 30 个耀眼绿块引发视觉灾难，在外部 CSS 中粗暴注入了 `background: transparent;`。
2. **架构反模式危害**：
   - 业务层一方面给 `<Button>` 传入 `variant="primary"`，另一方面用私有 CSS 将其击穿为透明，完全破坏了原子组件与消费端的契约信任；
   - 一旦该样式被重构微调，界面就会瞬间爆发多主色轰炸。
3. **主操作权重的唯一真源**：
   在代码变更面板中，用户的终极推进动作是**“暂存并提交全部”（[`DiffCardGitActions.tsx:110`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardGitActions.tsx#L110)）**。行级单文件“接受/暂存”本质上是局部细化调整，属于辅助/次要动作。将其显式声明为 `variant="ghost"`（悬停时泛起微翠绿底色），不仅符合用户既有心智，而且通过删除私有暴力覆盖，达成了代码架构的净收敛。

---

### 2.2 审批列表行级降级与单/多项待审批时的操作流感知建模

#### 审查质疑与多状态流建模
在待处理任务面板（[`ActiveTasksSection.tsx:84`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ActiveTasksSection.tsx#L84)）中，原计划将循环行中的“允许”按钮从 `variant="primary"` 降级为 `variant="secondary"`，并由顶部批量审批条承担唯一的 Primary Solid。

审查团队对以下边缘操作流进行了深度建模：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               待处理审批操作流认知与视觉权重状态机                                     │
├─────────────────────┬───────────────────────────────────────┬──────────────────────────────────────────┤
│ 场景                │ 现状问题                              │ 终审判定与最佳实践                       │
├─────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────┤
│ **场景 A：**        │ 若行内降级为 Secondary，而顶部又无批量│ **体验断层**：整个卡片无任何 Primary     │
│ 仅 1 项待审批工具   │ 栏，界面将陷入“零 Primary”状态        │ 实心推进色，用户无法秒级识别主决策！     │
├─────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────┤
│ **场景 B：**        │ 原实现中多行同时展示 Primary Solid 绿 │ **视觉喧嚣**：多个推进色互相撕扯，       │
│ $\ge 2$ 项待审批工具 │ 块，严重分散决策注意力                │ 用户无法形成清晰的主次认知。             │
└─────────────────────┴───────────────────────────────────────┴──────────────────────────────────────────┘
```

#### 架构裁决与纠偏方案
必须实施**动态单主操作契约（Dynamic Single-Primary Contract）**：
1. **多项并发待审批（$N \ge 2$）**：
   - 顶部渲染统一批量操作栏：`[全部允许 (variant="primary")]` + `[全部拒绝 (variant="ghost")]`；
   - 列表各行内的单项操作：允许按钮降级为 `variant="secondary"`（纯白卡片微边框），拒绝按钮保持 `variant="ghost"`。
2. **单项独占待审批（$N = 1$）**：
   - 不渲染冗余的顶部批量操作栏；
   - **允许当前唯一行内的“允许”按钮保留 `variant="primary"`**，作为该视图内唯一的实心推进色！
3. **断言锁定**：
   无论是 $N=1$ 还是 $N \ge 2$，在任何渲染时刻，`ActiveTasksSection` 视图内**实心 Primary 按钮的实例计数必须严格恒等于 1**（$\sum \text{Primary} \equiv 1$）。

---

### 2.3 纯黑 `#111111` 按钮的拔除与品牌翡翠绿单一真源（SSOT）的确立

#### 审查发现与现场证据
在 [`ModernApprovalCard.tsx:40-54`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernApprovalCard.tsx#L40-L54) 中，裸写的原生 `<button className={styles.approvalBtnPrimary}>` 消费了 [`ModernToolCall.module.css:507-513`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L507-L513) 的私有定义：
```css
.approvalBtnPrimary {
  border: none;
  font-weight: 600;
  background: var(--text-primary, #111111); /* 纯黑实体填充！ */
  color: var(--bg-card, #ffffff);
}
```
**严重弊端**：
1. **品牌语言分裂**：在全应用其他 99% 的卡片中，Primary Solid 均为翠绿 `--brand`（`hsl(160 84% 39%)`），唯独此处私自发明了纯黑主按钮，造成严重的“一系统两套语言”；
2. **无障碍机制归零**：原生 `<button>` 配合私有类，不仅失去了原子 `<Button>` 拥有的同心圆角、物理按压微缩（`scale(0.96)`）、`:focus-visible` 柔和焦点环，而且私有类中赫然书写了 `outline: none;`，直接摧毁了键盘聚焦。

**审查裁决**：
必须坚决执行 DIM-04 规划，物理删除该 43 行私有代码，全面换装为 `<Button variant="primary" size="sm">`，品牌权威不容篡改。

---

## 三、排版节奏与等宽防抖审查：16 处注入清单穿透与 OpenType 字体栈陷阱

### 3.1 16 处清单实证穿透：揪出 `ModelsSettingsTab` 死样式类与假修复陷阱

DIM-04 方案列出了 16 处 `font-variant-numeric: tabular-nums` 的防抖注入清单。审查团队通过静态 AST 交叉检索，发现了**一处严重的死样式类陷阱**：

#### 现场证据：清单第 8 处 `ModelsSettingsTab.module.css:460`
- **方案描述**：在 `ModelsSettingsTab.module.css:460` 的 `.mrdLatencyBadge` 注入 `font-variant-numeric: tabular-nums`；
- **代码真相排查**：
  Grep 全仓检索 `.mrdLatencyBadge`，发现该类名在整个 `src/` 下**除了在 CSS 中声明外，从未在任何 TSX 文件中被引用！**
  真实渲染网络延迟徽标的地方位于 [`ModelList.tsx:154-178`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelList.tsx#L154-L178)：
  ```tsx
  <span
    style={{
      fontSize: '11px',
      fontWeight: 500,
      padding: '1px 5px',
      borderRadius: '4px',
      userSelect: 'none',
      lineHeight: '16px',
      background: meta.lastTest.ok ? ... : ...,
      color: ...
    }}
  >
    {meta.lastTest.ok ? `${meta.lastTest.latencyMs}ms` : ...}
  </span>
  ```
- **审查穿透结论**：
  `ModelList.tsx` 使用了**内联样式（Inline Styles）**直接渲染延迟徽标！如果实现 Agent 仅遵照方案修改 `ModelsSettingsTab.module.css:460`，**该修复将 100% 不会生效，属于典型的“虚假绿灯/无效修复”！**

#### 纠偏指令：
必须拔除 `ModelList.tsx` 的内联样式，将其收敛至 CSS Module 类名，或直接在内联样式中加入 `fontVariantNumeric: 'tabular-nums'`，彻底消除测速刷新时数字的左右抽动。

---

### 3.2 遗漏高频跳动数值曝光：Token 估算、运行计时器与实时延迟

除了清单中的 16 处外，审查团队在工程中揪出了以下 **3 处未被覆盖的高频动态跳动数值点**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              审查追加：3 处遗漏的高频跳动数值曝光清单                                 │
├────┬─────────────────────────────┬───────────────────────────┬─────────────────────────────────────────┤
│ 序号│ 目标文件与行号              │ 容器/类名                 │ 动态变动场景描述                        │
├────┼─────────────────────────────┼───────────────────────────┼─────────────────────────────────────────┤
│ A1 │ `ContextInjectionBlock.module.css:130`│ `.tokenBadge`     │ 上下文注入卡片估算 Token 实时变动       │
│    │ `InjectionHeader.tsx:69`    │                           │ （如 `~320 Tokens`，当前仅设 font-mono）│
├────┼─────────────────────────────┼───────────────────────────┼─────────────────────────────────────────┤
│ A2 │ `OverviewCard.module.css:283`│ `.itemMain em`            │ 运行中子代理与后台任务实时耗时计时器    │
│    │ `ActiveTasksSection.tsx:118`│                           │ （如 `00:15` 每秒跳动，严重拉扯容器）  │
├────┼─────────────────────────────┼───────────────────────────┼─────────────────────────────────────────┤
│ A3 │ `UsageSummaryHero.module.css:34`│ `.currencySymbol`      │ 用量面板货币符号与大数字基线对齐        │
│    │ `UsageSummaryHero.tsx:34`   │                           │ （需确保与后随 tabular-nums 数字无错位）│
└────┴─────────────────────────────┴───────────────────────────┴─────────────────────────────────────────┘
```

**纠偏行动**：将防抖清单从 16 处刚性扩充至 **19 处**，全面覆盖流式 Token 估算与每秒自增的耗时计时器。

---

### 3.3 致命字体栈陷阱：Windows 微软雅黑无 `tnum` 导致防抖完全失效分析与解法

这是本次审查发现的**最具破坏力的底层字体渲染陷阱**！

#### 缺陷根因深层解剖
在 [`tokens.css:445-449`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L445-L449) 与 [`fontStoreStacks.ts:48-56`](file:///c:/Software/conex/apps/crish-desktop/src/api/fontStoreStacks.ts#L48-L56) 中，Windows 平台的 UI 字体栈被定义为：
```ts
const CJK_UI = "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', ...";
// Windows 平台默认字体栈：
return `'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, 'Segoe UI', ...`;
```

**底层排版学断裂机制**：
1. **字形匹配优先级**：
   在 CSS 字体匹配算法中，浏览器按照字体列表依次检查字形（Glyph Coverage）。因为 `'Microsoft YaHei UI'` 包含了完整的 ASCII 数字字符（U+0030 到 U+0039），所以 Windows 平台上的所有数字都会直接被 `Microsoft YaHei UI` 命中渲染，**根本不会回退到后方的 `'Segoe UI'`！**
2. **OpenType 特性表缺失**：
   - 微软在制作 `Microsoft YaHei`（`msyh.ttc`）时，西文部分脱胎于 Segoe UI，但**完全没有编译 OpenType `tnum`（Tabular Numbers）GSUB 替换表！**
   - 微软雅黑中的数字在默认状态下为比例字体（Proportional Numbers），且字库内部**根本不存在等宽数字字形变体**；
3. **静默失效**：
   当开发者在声明了 `font-family: var(--font-sans)` 的元素上设置 `font-variant-numeric: tabular-nums` 或 `font-feature-settings: "tnum" 1` 时，Chromium 引擎检查当前命中的微软雅黑，发现缺少 `tnum` 特性表，**引擎会直接静默放弃，既不报错也不合成等宽，而是直接输出默认的比例数字！**
   **结果**：在 Windows 平台上，所谓的 `font-variant-numeric: tabular-nums` **全面失效！数字依然在剧烈抖动！**

#### 跨平台对照对比：
- **macOS**：字体栈首位为 `'PingFang SC'`，随后为 `-apple-system`。Apple 的 San Francisco 与 PingFang SC 共享 macOS 核心排版引擎，完美内建 `tnum` 特性表，因此 macOS 下工作正常；
- **Linux**：`Noto Sans` / `DejaVu Sans` 均具备完整的 OpenType GSUB 布局表，工作正常；
- **Windows**：只要微软雅黑排在西文字体前，`tnum` 必挂！

#### 架构纠偏方案：Western-First 标尺或专有数字字体栈
必须在排版基础设施层实施以下两项根本性纠偏：

1. **方案 A（全局推荐）：字体栈恢复 Western-First 黄金法则**
   修改 `fontStoreStacks.ts` 中 Windows 平台的字体栈声明：
   ```ts
   // 纠偏前：'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, 'Segoe UI'...
   // 纠偏后：让 Segoe UI 优先匹配西文字符与数字（提供完整 tnum），中文字符平滑回退至微软雅黑：
   return `'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif`;
   ```
2. **方案 B（针对 `.tabular-nums` 的加固注入）**：
   在 `.tabular-nums` 与 `[data-tabular-nums='true']` 工具类中，强制前置声明支持等宽西文数字的字体族：
   ```css
   .tabular-nums,
   [data-tabular-nums='true'] {
     font-family: 'Segoe UI', -apple-system, system-ui, var(--font-sans);
     font-variant-numeric: tabular-nums;
     font-feature-settings: 'tnum' 1;
   }
   ```
   如此一来，无论用户或全局如何配置字体，跳动数值均能绝对稳定地激活硬件级等宽字宽。

---

## 四、焦点环规范审查：3%~10% 克制浅灰的 WCAG 对比度矛盾与盲区清剿

### 4.1 科学对比度数学建模：揭示 3%~10% 浅灰混入无法满足 WCAG 3:1 的数学现实

DIM-04 方案宣称其焦点环设计“严格遵守 `AGENTS.md` §13”，并宣称达成了“WCAG 无障碍合规”。**审查团队通过严格的色度学公式验算，揭示其存在不可忽视的数学矛盾。**

#### 严格对比度色度验算：
依据 W3C WCAG 2.1 相对亮度（Relative Luminance）与对比度公式：
$$L = 0.2126 \times R_{lin} + 0.7152 \times G_{lin} + 0.0722 \times B_{lin}$$
$$\text{Contrast Ratio} = \frac{L_1 + 0.05}{L_2 + 0.05} \quad (L_1 > L_2)$$

#### 1. 浅色模式（Light Mode）验算：
- 页面基底色：`--bg-card: #ffffff`，相对亮度 $L_{bg} = 1.0$；
- 基础边框色：`--border-color: hsl(38 2.5% 86%)`（sRGB: `[222, 221, 217]`），$L = 0.72$；
- 文本主色：`--text-primary: #111111`（sRGB: `[17, 17, 17]`），$L = 0.006$；
- **6% 混入量级（`--focus-ring-color`）**：
  $$\text{RGB} = [222 \times 0.94 + 17 \times 0.06, \dots] \approx [210, 209, 205] \implies \#\text{d2d1cd}$$
  相对亮度 $L \approx 0.635$。
  **与 `#ffffff` 背景对比度**：
  $$\text{Ratio} = \frac{1.0 + 0.05}{0.635 + 0.05} = \frac{1.05}{0.685} = \mathbf{1.53 : 1}$$
- **10% 混入上限（`--focus-border-color`）**：
  $$\text{RGB} = [222 \times 0.90 + 17 \times 0.10, \dots] \approx [201, 201, 197] \implies \#\text{c9c9c5}$$
  相对亮度 $L \approx 0.58$。
  **与 `#ffffff` 背景对比度**：
  $$\text{Ratio} = \frac{1.0 + 0.05}{0.58 + 0.05} = \frac{1.05}{0.63} = \mathbf{1.67 : 1}$$

#### 2. 深色模式（Dark Mode）验算：
- 页面基底色：`--bg-card: #1e1e1e`（sRGB: `[30, 30, 30]`），$L_{bg} = 0.012$；
- 基础边框色：`--border-color: #333333`（sRGB: `[51, 51, 51]`），$L = 0.033$；
- 文本主色：`--text-primary: #ededed`（sRGB: `[237, 237, 237]`），$L = 0.84$；
- **10% 混入上限**：
  $$\text{RGB} = [51 \times 0.90 + 237 \times 0.10, \dots] \approx [70, 70, 70] \implies \#\text{464646}$$
  相对亮度 $L \approx 0.063$。
  **与 `#1e1e1e` 背景对比度**：
  $$\text{Ratio} = \frac{0.063 + 0.05}{0.012 + 0.05} = \frac{0.113}{0.062} = \mathbf{1.82 : 1}$$

#### 结论：
**WCAG 2.1 SC 1.4.11（Non-text Contrast）明确要求交互状态与焦点指示器的对比度必须达到至少 3.0 : 1！**
1.53:1 ~ 1.82:1 的对比度在严格的无障碍规范下是**完全不合格的**！如果宣称其“完全满足 WCAG 对比度指标”，属于严重的事实判断偏差。

---

### 4.2 `AGENTS.md` §13 宁静设计与 WCAG 键盘指示强度的张力化解架构

那么，为什么仓库总规 `AGENTS.md` §13 会做出如下硬性规定？
> “克制的激活边框：输入或按钮处于 active / focused / recording 时，**禁止**粗、深、实心黑边（例如直接用 var(--text-primary) 或厚重 0 0 0 1px 黑环）。灰色加深混入文本色不超过约 10%，常规元素优先约 3%–6% 混入以保持柔软。全页空态 composer 等至多约 5%。”

#### 规范背景与张力根源：
`AGENTS.md` §13 诞生于对抗“界面过度设计、刺眼黑框与高饱和彩色光晕”，旨在保护用户长时间阅读与鼠标点击时的视觉宁静。
然而，**无障碍用户使用键盘 Tab 键进行导航时（`:focus-visible`），微弱的 1.53:1 浅灰焦点环对于弱视群体与高分辨率屏幕是完全不可视的！**

#### 终审化解方案：双态分流架构（Dual-State Focus Architecture）

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              焦点指示双态分流架构 (Dual-State Focus Architecture)                       │
├──────────────────────────┬─────────────────────────────────────┬───────────────────────────────────────┤
│ 交互情境                 │ 触发伪类                            │ 视觉表现与遵从规范                    │
├──────────────────────────┼─────────────────────────────────────┼───────────────────────────────────────┤
│ **情境 1：鼠标/触控点击** │ `:focus:not(:focus-visible)`        │ **100% 遵从 AGENTS.md §13**           │
│ 输入框激活 / 按钮轻触    │                                     │ 3%~10% 极柔软中性浅灰，无外阴影，宁静  │
├──────────────────────────┼─────────────────────────────────────┼───────────────────────────────────────┤
│ **情境 2：键盘纯键导航** │ `:focus-visible`                    │ **100% 遵从 WCAG 1.4.11 & 2.4.11 (3:1)│
│ Tab / 方向键键盘漫游     │                                     │ 采用微位移双层对比环 (Contrast Ring)  │
│                          │                                     │ 柔和深灰外框 + 1px 间隙，清晰但不粗暴  │
└──────────────────────────┴─────────────────────────────────────┴───────────────────────────────────────┘
```

#### 实施代码规范：
在 `src/styles/focus-visible.css` 中，将键盘专属的 `:focus-visible` 升级为具备充足辨识度的中性对比指示：
```css
/* 鼠标点击：极致柔软，完全符合 AGENTS.md §13 */
:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}

/* 键盘 Tab 导航：满足 WCAG 3:1 可访问性底线，同时杜绝高饱和彩色与刺眼黑框 */
:focus-visible {
  outline: 2px solid var(--focus-visible-ring, color-mix(in srgb, var(--border-color) 40%, var(--text-primary) 60%));
  outline-offset: 2px;
}

/* 按钮与卡片：使用同心外微阴影规避 outline 对圆角的切角 */
button:focus-visible,
[role='button']:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 1px var(--bg-card),
    0 0 0 3px color-mix(in srgb, var(--border-color) 50%, var(--text-primary) 50%);
}
```
*收益*：鼠标交互依然纯净柔和，不增加任何视疲劳；而键盘导航时呈现清晰、高可读的同心中性指示，完美兼顾审美与包容性。

---

### 4.3 虚假完成度：全站 150+ 处 `outline: none` 盲区与彩色发光光晕清剿方案

DIM-04 方案宣称其“清剿了全站 `outline: none` 盲区”，但其详单中**仅拔除了 3 处**（`FileEditor`、`ModernToolCall`、`SubagentHeaderPanel`）。

#### 审查穿透实证：全仓实际存量扫描
审查团队对 `apps/crish-desktop/src/` 展开正则全量扫描，**赫然发现了超过 150 处 `outline: none;` 声明！**
其中大量关键交互容器存在严重的键盘隐形盲区：
- [`PreviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css)：8 处 `outline: none;`；
- [`ChatComposer.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css)：9 处 `outline: none;`；
- [`TerminalCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.module.css)：6 处 `outline: none;`；
- [`TiptapEditorField.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css)：2 处 `outline: none;`；
- [`WorkspaceEmptyState.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.module.css)：3 处 `outline: none;`。

#### 彩色发光光晕现存点：
- [`DiffCard.module.css:765`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L765)：高饱和翠绿发光光晕 `box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand) 25%, transparent)`；
- [`SidebarSessionList.module.css:545`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L545)：重命名状态的高对比绿色硬线 `outline: 1.5px solid var(--accent-primary)`。

#### 架构清剿原则：
1. **兜底守门**：不能仅靠手动挨个修改 150 个 CSS 文件，必须在 `focus-visible.css` 中确立 `:focus-visible` 的高权重兜底规则；
2. **严惩滥用**：在 CI 门禁（`scripts/check-ui-layer.mjs`）中增加静态 AST 断言：**严禁在 CSS 中裸写没有任何替代样式的 `outline: none`**；
3. **光晕收口**：刚性拔除 `DiffCard.module.css` 与 `SidebarSessionList.module.css` 中的彩色硬实线，全面回归中性微阴影。

---

## 五、无障碍 APG 审查：40×40px 连击踩踏缺陷、ARIA 闭环与键盘漫游状态机

### 5.1 40×40px 透明伪元素全局挂载引发的“幽灵连击与点击偷取”灾难

DIM-04 方案在 6.1 节中提出：
> “在 `Button.module.css` 中，针对 `.iconButton`、`.buttonSm` 与 `.buttonXs`，内置绝对定位的透明伪元素 `::after`，外延至最小 40×40px 触控区。”

**审查结论：这是极具隐蔽性与杀伤力的设计缺陷，必须立即叫停并纠偏！**

#### 致命碰撞缺陷推演（Click-Stealing Hazard）：
以工程中极其常见的紧凑工具栏或操作条（如 `DiffCardFileList` 的行内操作栏、`MarkdownEditor` 的工具栏、`ChatComposer` 的右侧按钮组）为例：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              紧凑按钮组 40×40px 伪元素互叠与“偷取点击”灾难推演                          │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│   按钮 A (24×24px)              按钮 B (24×24px)                                                       │
│   [ x: 0 ~ 24px ]               [ x: 28 ~ 52px ]  (间隙 gap: 4px)                                      │
│                                                                                                        │
│        按钮 A 的 ::after 隐形热区 (min-width: 40px) 覆盖范围：[ x: -8px  至  32px ]                    │
│        ════════════════════════════════════════════════════                                            │
│                                      按钮 B 的 ::after 隐形热区 (min-width: 40px) 覆盖范围：           │
│                                      [ x: 20px  至  60px ]                                             │
│                                      ════════════════════════════════════════════════════              │
│                                                                                                        │
│                                      ▲▲▲▲▲▲▲▲                                                          │
│                                      【危险重叠区：x = 20px ~ 24px】                                   │
│                                      此区域物理上位于【按钮 A 的可见右边界内部】！                      │
│                                      但由于按钮 B 在 DOM 结构中位于后方（z-index: 1 生效），            │
│                                      按钮 B 的透明伪元素直接【覆盖在按钮 A 之上】！                     │
│                                                                                                        │
│   ★ 灾难现象：用户明明用鼠标点击了【按钮 A 的右半侧】，触发的却是【按钮 B 的点击事件】！                │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 进一步的次生灾害：
1. **悬停抖动（Hover Flickering）**：鼠标移动到按钮 A 边缘时，提前触发了按钮 B 的 `:hover` 样式，造成界面视觉严重抽搐；
2. **列表溢出截断（Overflow Clipping）**：在有 `overflow: hidden` 的行容器（如 `DiffCardFileList`、`SidebarSessionList`）中，40px 的伪元素会导致容器出现意外的滚动条或被粗暴裁切；
3. **WCAG 标准误读**：WCAG 2.5.8（Level AA）的最低触控目标是 **24×24px**！`.buttonXs`（高度 24px）与 `.buttonSm`（高度 28px）**在物理尺寸上早已 100% 达标**！Jakub Krehel 原文明确注明：“Aim for 40×40px on desktop **where density permits**（在密度允许的场景下）”，而不是无脑在原子组件底层全局滥加！

#### 纠偏方案：
1. **立即移除** `Button.module.css` 中对 `.iconButton`、`.buttonSm`、`.buttonXs` 的全局 `::after` 注入；
2. **声明式独立扩展类**：新增专用的 `.touchExpand` 工具类或 `<IconButton touchExpand />` 属性，**仅限在孤立浮标、无紧密相邻元素的单个图标按钮（如独立关闭按钮、右下角浮动球）上开启**；
3. 密集按钮组严禁外延，依靠其自身的 24px / 28px 物理面积与内边距保证命中。

---

### 5.2 21 处 `aria-label` 与 205 处 `aria-hidden`：原子组件树内置解法与 AST 防回归

#### 审查发现：
1. **冰山一角**：DIM-04 方案列出的 21 处 `aria-label` 确实存在，但通过 grep 扫描，工程中裸写的 `<button>` 超过 300 处，未命名按钮远不止 21 处；
2. **重复劳动**：方案试图通过人工逐个查找修改 205 处 Lucide 图标的 `aria-hidden="true"`，极易疏漏且后续极易回归。

#### 架构级优雅解法（遵从 AGENTS.md §7）：
排查原子组件 [`Button.tsx:103`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx#L103)：
```tsx
const iconNode =
  icon != null ? (
    <span className={styles.buttonIcon} aria-hidden="true">
      {icon}
    </span>
  ) : null;
```
**惊人发现**：
原子 `<Button>` 与 `<IconButton>` 在渲染 `icon` 属性时，**外层已经自动包裹了带有 `aria-hidden="true"` 的 span 标签！**
根据 WAI-ARIA 规范，当父节点被标记为 `aria-hidden="true"` 时，其整个子 DOM 树（包括 SVG 图标）会被屏幕阅读器完全忽略！
**结论**：只要业务代码将裸写的 `<button>` 换装为 `<IconButton icon={<Check />} aria-label="..." />`，**内部图标的 `aria-hidden` 问题就已经在底层被 100% 自动闭环解决！根本不需要去手动改动 205 处 SVG 标签！**

---

### 5.3 侧边栏 Roving Tabindex 键盘漫游状态机健壮性审查与三大致命缺陷重塑

DIM-04 方案在 6.4 节为侧边栏会话列表规划了 Roving Tabindex 漫游方案。审查团队深入 [`SidebarSessionList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx)、[`SessionRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx) 与 [`useSidebarSessionList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/useSidebarSessionList.tsx)，发现了**三大严重导致运行期崩溃或失效的缺陷**：

#### 缺陷 1：虚拟滚动窗口化（Virtualization Windowing）导致焦点丢失到 `body`
- **代码真相**：`SidebarSessionList.tsx:68` 启用了 `useWindowedList` 虚拟滚动。当会话数量达到 100 个时，DOM 中只渲染视口内的 20~30 个节点；
- **DIM-04 方案代码**：
  ```ts
  const targetEl = sessionListRef.current?.querySelector(`[data-testid-session-id="${targetId}"]`);
  targetEl?.focus();
  ```
- **崩溃现场推演**：当用户在会话 10 按 `End` 键（试图跳到最后一个会话 100）时，会话 100 根本不在当前 DOM 中！`querySelector` 返回 `null`，`focus()` 彻底失效，物理键盘焦点直接被浏览器重置到 `document.body`！用户键盘交互瞬间瘫痪！

#### 缺陷 2：折叠分组穿透缺陷（Navigating into Invisible Collapsed Items）
- **DIM-04 方案代码**：`const allIds = sortedSessions.map((s) => s.id);`；
- **代码真相**：侧边栏拥有 `pinnedCollapsed`（置顶折叠）、`collapsedProjects`（项目分组折叠）、`generalCollapsed`（常规折叠）。`sortedSessions` 包含全量会话！
- **故障现场**：如果用户折叠了某个项目文件夹，按 `↓` 方向键依然会漫游进该文件夹中那些**在视觉上已被隐藏的会话 ID**，导致光标在界面上凭空消失！
- **令人惊讶的对照**：实际上，`useSidebarSessionList.tsx:186-212` 中**早已精心编写了 `navSessionIds` 过滤算法**（已完美剔除折叠项目），而 DIM-04 方案的设计者却直接写了一个无脑的 `sortedSessions.map`，险些造成严重的逻辑倒退！

#### 缺陷 3：CSS Modules 类名选择器失效的历史遗留 Bug
在现存的 `useSidebarSessionList.tsx:251` 中，历史代码为：
```ts
const row = sessionListRef.current?.querySelector(`[data-session-id="${safeFrom}"] .session-item`);
```
在生产环境中，CSS Modules 会将类名哈希化（如 `_sessionItem_a1b2_10`），**页面中根本不存在 `.session-item` 纯字符串类名！** 该 querySelector 长期返回 `null`，全靠外部 React 重新渲染激活状态。

#### 缺陷 4：ARIA 语义混淆（Treeview vs Listbox）
- `SessionRow.tsx:264` 中现存的角色是 **`role="treeitem"`**；
- 侧边栏包含可折叠的项目文件夹（具有层级深度与展开/收起能力），按照 WAI-ARIA APG 规范，**这必须是标准的 Treeview 模式（`role="tree"` / `role="treeitem"`）**；
- DIM-04 方案错误地提议将其降级为 `role="listbox"` / `role="option"`，这将导致折叠展开语义丢失，读屏用户无法感知层级关系。

---

## 六、终审综合优化执行方案与原子 Diff 建议

针对上述所有审查问题，特制定立即可落盘的架构级优化方案：

### 6.1 字体防抖与 OpenType 加固优化 Diff
在 `src/styles/tokens.css` 中，加固 `.tabular-nums`，确保跨平台无论默认字体如何配置，均能稳定激活等宽数字：

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -635,6 +635,7 @@
 .tabular-nums,
 [data-tabular-nums='true'] {
+  font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, var(--font-sans);
   font-variant-numeric: tabular-nums;
   -webkit-font-feature-settings: 'tnum' 1;
   font-feature-settings: 'tnum' 1;
 }
```

同时，在 `ContextInjectionBlock.module.css` 与 `OverviewCard.module.css` 补齐遗漏的防抖注入：
```diff
--- a/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
+++ b/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
@@ -136,4 +136,5 @@
   font-family: var(--font-mono);
   line-height: 1.5;
   white-space: nowrap;
+  font-variant-numeric: tabular-nums;
 }

--- a/apps/crish-desktop/src/components/overview/OverviewCard.module.css
+++ b/apps/crish-desktop/src/components/overview/OverviewCard.module.css
@@ -288,4 +288,5 @@
   flex-shrink: 0;
   white-space: nowrap;
+  font-variant-numeric: tabular-nums;
   max-width: 50%;
 }
```

---

### 6.2 触控外延纠偏：移除全局 `::after`，设立按需 `.touchExpand`
彻底废弃无脑全局注入，在 `Button.module.css` 中重塑：

```diff
--- a/apps/crish-desktop/src/components/ui/Button/Button.module.css
+++ b/apps/crish-desktop/src/components/ui/Button/Button.module.css
@@ -242,0 +243,18 @@
+/* 仅在显式声明 touchExpand 的孤立按钮上开启 40x40px 热区外延，杜绝紧凑按钮组互叠偷取点击 */
+.button[data-touch-expand='true']::after {
+  content: '';
+  position: absolute;
+  top: 50%;
+  left: 50%;
+  transform: translate(-50%, -50%);
+  min-width: 40px;
+  min-height: 40px;
+  width: 100%;
+  height: 100%;
+  pointer-events: auto;
+  border-radius: inherit;
+  z-index: 1;
+}
+
+.button:disabled::after {
+  display: none;
+  pointer-events: none;
+}
```

---

### 6.3 侧边栏虚拟列表与 Treeview 漫游状态机终极健壮性加固
在 `useSidebarSessionList.tsx` 中，修复选择器失效与虚拟滚动跳变：

```diff
--- a/apps/crish-desktop/src/components/sidebar/session-list/useSidebarSessionList.tsx
+++ b/apps/crish-desktop/src/components/sidebar/session-list/useSidebarSessionList.tsx
@@ -250,3 +250,3 @@
         const row = sessionListRef.current?.querySelector(
-          `[data-session-id="${safeFrom}"] .session-item`
+          `[data-testid-session-id="${safeFrom}"]`
         ) as HTMLElement | null;
@@ -265,3 +265,3 @@
           const row = sessionListRef.current?.querySelector(
-            `[data-session-id="${safe}"] .session-item`
+            `[data-testid-session-id="${safe}"]`
           ) as HTMLElement | null;
+          if (row) {
             row.focus({ preventScroll: false });
+          } else {
+            // 虚拟滚动兜底：若节点不在视口，通过滚动容器对齐后再聚焦
+            sessionListRef.current?.dispatchEvent(new CustomEvent('scroll-to-session', { detail: id }));
+          }
```

---

### 6.4 审查结论与交付准则

1. **色彩语义**：`DiffCardFileList` 与 `ActiveTasksSection` 的降级方案完全成立；拔除 `#111111` 纯黑按钮必须按期完成，净消减私有 CSS $\ge 160$ 行；
2. **防抖排版**：必须采纳 Western-First 字体栈纠偏，修正 `ModelList.tsx` 的内联样式，将跳动防抖点扩充至 19 处；
3. **焦点无障碍**：采纳鼠标/键盘双态分流焦点环，严禁在紧凑按钮组全局挂载 40×40px 伪元素，以防引发连击事故；
4. **状态机合规**：保留 `role="treeitem"` 与 `navSessionIds` 状态机，修复选择器哈希断裂，确保键盘导航与虚拟滚动完美连通。
