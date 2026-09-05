# 战役：差异面板与笔记面板系统性重构 —— 阶段五：详案终审反幻觉严苛审计报告 (AUDIT-FINAL-UI-TOKENS)

> **审计编号**：AUDIT-FINAL-UI-TOKENS  
> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）  
> **所属阶段**：阶段五 · 详案终审反幻觉严苛审计（Phase 5: Anti-Hallucination Final Audit）  
> **审计角色**：UI 组件与 CSS Tokens 真实性终审官（UI & CSS Tokens Anti-Hallucination Auditor）  
> **审计对象**：
> - [`docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md) (DETAIL-PLAN-01)
> - [`docs/diff-view-redesign/02-分维详案-行内工具条物理拔除与代码比对专注化.md`](file:///c:/Software/conex/docs/diff-view-redesign/02-分维详案-行内工具条物理拔除与代码比对专注化.md) (DETAIL-PLAN-02)
> - [`docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md`](file:///c:/Software/conex/docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md) (DETAIL-PLAN-04)
> - [`docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md`](file:///c:/Software/conex/docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md) (DETAIL-PLAN-05)
> **产出落盘**：`docs/diff-view-redesign/audits/01-ui-components-and-tokens-anti-hallucination-audit.md`  
> **审计准则与权威底线**：
> - 用户最高指示：“差异界面的每个文件改成列表就行了，去掉圆角。然后去掉每个文件列表里面的顶部工具行，越简单越好...而且现在的这个界面很多东西还有硬编码的呢，这个也统一使用我们的token体系。这个界面的hover我看也是有问题的，有的很灰啊...笔记的顶部功能栏我看也没有。底部那个灰色的大区域一点用处没有，两个块区域是又丑又没用...系统性做，先考虑架构。以及避免双轨或者多轨、硬编码、功能伪实现、伪连通。”
> - 仓库铁律 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（反退避纯逻辑推进）、§3（Git 提交权归主控）、§7（严禁补丁与绕过、立体验证、架构净收敛）、§8（反过度设计红线）、§9（测试资产保护铁律）、§12（UI 自定义 Tooltip，严禁原生 HTML title）、§13（输入框与焦点态、焦点对比度上限 <= 10%、形态 ④ 纯光标极简型）、§14（现代 CSS 语法、优先 HSLA / 斜杠透明度、零裸写十六进制、Zero-Blue 铁律）。

---

## 目录

- [一、审计概览与裁决矩阵](#一审计概览与裁决矩阵)
  - [1.1 总体终审裁决：条件性准入 (Need-Fix before Implementation)](#11-总体终审裁决条件性准入-need-fix-before-implementation)
  - [1.2 关键缺陷统计分布](#12-关键缺陷统计分布)
- [二、真实代码库现场查验结果 (Reality Check)](#二真实代码库现场查验结果-reality-check)
  - [2.1 DiffCard.module.css:374-436 八大待删除选择器 100% 存在性与防误删审查](#21-diffcardmodulecss374-436-八大待删除选择器-100-存在性与防误删审查)
  - [2.2 DiffCardFileList.tsx 三大正交子域（Chevron/超链接/Git操作）功能完整性审查](#22-diffcardfilelisttsx-三大正交子域chevron超链接git操作功能完整性审查)
  - [2.3 笔记面板底部两块灰色区域删除彻底性与 NoteLeafHost 真实挂载链审查](#23-笔记面板底部两块灰色区域删除彻底性与-noteleafhost-真实挂载链审查)
  - [2.4 13 处裸写 Hex 与 6 处幽灵 Token 真实分布与权威 Tokens 真伪核查](#24-13-处裸写-hex-与-6-处幽灵-token-真实分布与权威-tokens-真伪核查)
- [三、严厉反幻觉与致命破坏性缺陷定位 (Critical Findings)](#三严厉反幻觉与致命破坏性缺陷定位-critical-findings)
  - [缺陷 01【P0 致命断裂】：详案 05 物理删除 MirrorDriftStatusBar.tsx 且修改 Policy，直接击穿两套既有测试资产](#缺陷-01p0-致命断裂详案-05-物理删除-mirrordriftstatusbartsx-且修改-policy直接击穿两套既有测试资产)
  - [缺陷 02【P0 跨方案分裂】：详案 02 完整代码严重滞后，保留手风琴圆角卡片与 .fileItem，与详案 01/04 完全脱节](#缺陷-02p0-跨方案分裂详案-02-完整代码严重滞后保留手风琴圆角卡片与-fileitem与详案-0104-完全脱节)
  - [缺陷 03【P1 规范违背】：详案 04 臆造 `<button>` 嵌套 `<button>`，引发 HTML 规范冲突与事件失效](#缺陷-03p1-规范违背详案-04-臆造-button-嵌套-button引发-html-规范冲突与事件失效)
  - [缺陷 04【P1 铁律违背】：详案 04 私自声明 8 处 `!important`，公然违规并危及 style-contract 门禁基线](#缺陷-04p1-铁律违背详案-04-私自声明-8-处-important公然违规并危及-style-contract-门禁基线)
  - [缺陷 05【P1 铁律违背】：详案 05 顶栏输入框焦点态对比度超标（15%）且加 1px 外阴影环，违反 AGENTS.md §13](#缺陷-05p1-铁律违背详案-05-顶栏输入框焦点态对比度超标15且加-1px-外阴影环违反-agentsmd-13)
  - [缺陷 06【P1 承诺落空】：详案 05 在 CSS 中大量回潮裸写 Hex，且在状态指示器中引入违章 Tailwind 蓝 #3b82f6（破 Zero-Blue 铁律）](#缺陷-06p1-承诺落空详案-05-在-css-中大量回潮裸写-hex且在状态指示器中引入违章-tailwind-蓝-3b82f6破-zero-blue-铁律)
  - [缺陷 07【P2 门禁违规】：详案 01 与 05 中多处违规采用原生 HTML title 属性，违反 AGENTS.md §12](#缺陷-07p2-门禁违规详案-01-与-05-中多处违规采用原生-html-title-属性违反-agentsmd-12)
  - [缺陷 08【P2 排版倒退】：详案 04 在操作按钮区域依然采用绝对定位 .hoverActions，与详案 01 的 Flex 盒架构冲突](#缺陷-08p2-排版倒退详案-04-在操作按钮区域依然采用绝对定位-hoveractions与详案-01-的-flex-盒架构冲突)
- [四、SLoHT 单层 Hover 体系推导数学性与类名体系冲突剖析](#四sloht-单层-hover-体系推导数学性与类名体系冲突剖析)
  - [4.1 计算机图形学 Alpha 混合公式验证（4.94% 复合深脏灰之谜）](#41-计算机图形学-alpha-混合公式验证494-复合深脏灰之谜)
  - [4.2 跨方案类名推导脱节与收敛矩阵 (SSOT 仲裁)](#42-跨方案类名推导脱节与收敛矩阵-ssot-仲裁)
- [五、主控 Agent 分步整改指令清单 (Actionable Directives)](#五主控-agent-分步整改指令清单-actionable-directives)
- [六、终审结论与签字盖章](#六终审结论与签字盖章)

---

## 一、审计概览与裁决矩阵

### 1.1 总体终审裁决：条件性准入 (Need-Fix before Implementation)

本终审官在全面通读 4 份分维详案（合计超过 9000 行技术文档与全量源代码）、地毯式审查 `apps/crish-desktop/` 源码现场与全量关联测试套件后，签发终审裁决：

**【判定】：条件性准入（NEED-FIX）**  
详案的重构大方向（直角化、32px 紧凑、专注比对、单轨超链接、物理剔除底部双灰块、SLoHT 单层悬停）完全契合用户最高指示，且对 13 处裸写 Hex 与 6 处幽灵 Token 的代码定位 100% 真实确凿；  
然而，**方案在子方案协同一致性、测试资产保护、铁律门禁遵从度上出现了严重的“幻觉”、“阳奉阴违”与“破门禁”行为**。若不经修正确接盲目进入阶段六实施，将直接引发 **3 套测试套件红灯报错、HTML 语法结构崩溃、以及多处样式回潮**。必须执行本文第五章的整改指令后，方可由主控统一发令编码。

### 1.2 关键缺陷统计分布

| 严重等级 | 缺陷定义与判据 | 数量 | 涉及方案 | 核心危害 |
| :---: | :--- | :---: | :--- | :--- |
| **P0 致命断裂** | 破坏存量保护测试套件、或导致跨方案代码完全冲突不可运行 | **2 项** | 详案 05, 详案 02 | CI 流水线直接编译失败或单测报死，方案彼此覆盖 |
| **P1 严重违规** | 违反仓库铁律（`AGENTS.md` §7, §13, §14）、HTML 规范或存在严重代码质量倒退 | **4 项** | 详案 04, 详案 05 | 破门禁基线（!important）、破坏 Zero-Blue、button 嵌套崩溃 |
| **P2 规范瑕疵** | 违反非阻断性 UI 规范（如原生 title 提示）或局部排版命名脱节 | **2 项** | 详案 01, 04, 05 | 遗留旧浏览器气泡、类名漂移与排版抖动 |
| **总计** | **共计 8 大核心缺陷** | **8 项** | 全部 4 份详案 | 详见本文第三章逐条取证剖析 |

---

## 二、真实代码库现场查验结果 (Reality Check)

### 2.1 DiffCard.module.css:374-436 八大待删除选择器 100% 存在性与防误删审查

#### 1. 真实存在性核验结论：100% 真实确凿
在 [`apps/crish-desktop/src/components/diff/DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css) 物理文件中，详案 02 列出的 8 大选择器在第 374 行至第 436 行完整、连续存在，无任何行号或选择器捏造：

```css
/* 现场代码确凿证据 (DiffCard.module.css:374-436) */
374: .inlineHeader { ... }               /* 1. 工具行根容器 (10 行) */
385: .compareSelectorWrap { ... }        /* 2. 对比维度包裹层 (5 行) */
391: .selectLabel { ... }                /* 3. 维度文本标签 (6 行) */
398: .inlineCompareSelect { ... }        /* 4. 下拉框定宽 (4 行) */
403: .inlineActions { ... }              /* 5. 右侧按钮组 (5 行) */
409: .inlineIconBtn { ... }              /* 6. 图标按钮 (16 行) */
426: .inlineIconBtn:hover { ... }        /* 7. 图标按钮悬停 (4 行) */
431: .actionDivider { ... }              /* 8. 竖线分割线 (6 行) */
```

#### 2. 全仓引用范围核验：零越界风险
经 Ripgrep 全工程扫描，除 `DiffCardFileList.tsx:219-296` 外，全工程（含业务代码、扩展包、测试套件）没有任何其他地方引用这 8 个类名。

#### 3. 误伤防御核验：边界清晰，但存在跨方案认知分裂
- **`.inlineBody` (Line 367-372)**：紧挨 `.inlineHeader` 上方。详案 02 明确标记保留；但详案 01 序号 10 标记将其重命名为 `.diffPane`；
- **`.inlineSelect` (Line 72-75)**：全局顶部控制栏 [`DiffHeaderControls.tsx:126,140`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx#L126) 专用，绝对保留；
- **`.scrollParent` (Line 439+)**：紧挨 `.actionDivider` 下方，作为代码比对滚动视口，绝对保留。

---

### 2.2 DiffCardFileList.tsx 三大正交子域（Chevron/超链接/Git操作）功能完整性审查

查阅 [`apps/crish-desktop/src/components/diff/DiffCardFileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx) 原代码，与详案 01 提出的三大正交子域进行逐一功能对齐：

| 子域职责 | 原代码现场实现 (L142-215) | 详案 01 重构后实现 (L770-900) | 功能完整性判定 | 潜在风险与说明 |
| :--- | :--- | :--- | :---: | :--- |
| **子域 A：Chevron 与状态徽标** | 整行单一 `<button class="fileItem">` 粗暴触发展开 | 独立 `<button class="chevronBtn">` 承载旋转图标；新增 `<span class="statusBadge">` 区分 M/A/D/R 徽章 | **功能无损并显著增强** | 提供了精准的语义化状态指示，不再依赖文件名颜色盲猜。 |
| **子域 B：超链接与路径分级** | `<span class="fileNameLink">` 仅为虚假超链接，点击实际触发整行折叠 | 独立 `<button class="fileNameLinkBtn">` 响应点击；提供 `onOpenFileViewer` 钩子在右侧独立 Tab 打开文件预览 | **核心功能飞跃** | 彻底打通用户裁决的“点击差异超链接直接打开新标签页预览文件”链路。 |
| **子域 C：Git 操作与增减统计** | 悬停时暴力 `opacity: 0` 抹除统计数字，由绝对定位 `.hoverActions` 遮盖原位置 | `.fileStat` 刚性常驻可见（tabular-nums 排版）；`.rowActions` 与统计并排排列，hover 时平滑浮现；暂存、取消暂存、放弃修改与 Loader 完备 | **体验大幅提升，零丢失** | 彻底根除数字疯狂闪烁与遮挡问题，Git 操作能力 100% 保留。 |

**审查结论**：三大正交子域的 JSX 重构在业务功能上**没有任何现有功能丢失**，但在工程细节与门禁规范上存在下文详述的几项严重缺陷。

---

### 2.3 笔记面板底部两块灰色区域删除彻底性与 NoteLeafHost 真实挂载链审查

#### 1. 真实挂载关系溯源
在当前代码库中：
1. 扩展叶入口 [`apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.tsx) 调用 `useWorkspaceEmptyStateMirrorSlot`，通过 Props 向主面板注入：`mirrorDriftReport`, `mirrorWatchSource`, `showMirrorDriftBar`, `onMirrorThreeWay`；
2. 笔记面板主容器 [`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx:252-266`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx#L252-L266) 挂载了两大调试区域：
   - `<MirrorDriftStatusBar>`（即编译后的 `class="_mirrorDriftBar_fcd5v_1083"`）；
   - `<footer className={styles.footer}>`（即编译后的 `class="_footer_fcd5v_21"`）。

#### 2. 删除是否彻底且干净？
- **UI 树剔除**：详案 05 提出从 `NotePaperStrictPanel.tsx` 中连根切除 L252-266 节点的挂载，使 `NotePaperStrictBody` 直达底部边缘，**在 UI 视口层完全彻底、绝无 `display: none` 掩耳盗铃**；
- **严重副作用（致命断裂）**：详案 05 为了“彻底”，粗暴决定删除 `MirrorDriftStatusBar.tsx` 源码并修改 `productMirrorPolicy.ts`，直接引发了两大重要测试套件的连锁报死（见缺陷 01）。

---

### 2.4 13 处裸写 Hex 与 6 处幽灵 Token 真实分布与权威 Tokens 真伪核查

#### 1. 13 处硬编码与 6 处幽灵 Token 真实代码坐标核验
经过现场代码地毯式比对，详案 04 列出的清单 **100% 真实存在于当前源码中**：

| 序号 | 物理文件与真实行号 | 当前源码违规代码片段 | 拟替换的 SSOT Token | 真实性核验状态 |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `DiffCard.module.css:14` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 2 | `DiffCard.module.css:29` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 3 | `DiffCard.module.css:140` | `color-mix(in srgb, var(--accent-red, #ef4444) 10%, var(--bg-card))` | `background: var(--color-error-bg);` | **100% 吻合** |
| 4 | `DiffCard.module.css:141` | `1px solid color-mix(in srgb, var(--accent-red, #ef4444) 25%, transparent)` | `border-bottom: 1px solid var(--color-error-border);` | **100% 吻合** |
| 5 | `DiffCard.module.css:142` | `color: var(--accent-red, #ef4444);` | `color: var(--color-error);` | **100% 吻合** |
| 6 | `DiffCard.module.css:169` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 7 | `DiffCard.module.css:280` | `color: var(--accent-blue);` | `color: var(--md-link-color);` | **100% 吻合** |
| 8 | `DiffCard.module.css:446` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 9 | `DiffCard.module.css:462` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 10 | `DiffCard.module.css:476` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 11 | `DiffCard.module.css:730` | `background: var(--diff-bg-pane, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 12 | `DiffCard.module.css:845` | `background: var(--bg-card, #ffffff);` | `background: var(--bg-card);` | **100% 吻合** |
| 13 | `VirtualPlainCodeViewer.tsx:65`| `background: 'var(--diff-bg-pane, #ffffff)',` | `background: 'var(--bg-card)',` | **100% 吻合** |

#### 2. 全局 Design Tokens 真实性校验
终审官真实审查 [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)：
- `--bg-card`、`--bg-hover`、`--bg-active`：在 `:root` 与 `html[data-theme='dark']` 中均具备权威定义；
- `--color-error`、`--color-error-bg`、`--color-error-border`：在两个主题下均有定义；
- `--md-link-color`：Light 为 `var(--brand-deep, #059669)`，Dark 为 `var(--brand, #10b981)`，严格符合 Zero-Blue 规范；
- `--diff-add-fg`、`--diff-add-bg`、`--diff-del-fg`、`--diff-del-bg`、`--diff-linenum-fg`：在 `tokens.css:122-146` (Light) 及 `tokens.css:322-346` (Dark) 均具备通过 WCAG AAA 对比度校验的权威定义；
- `--filetree-badge-*` 系列（mod/add/del/renamed）：在两个主题中均已定义完整色阶。

**结论**：详案所提议替换的 Design Tokens **在仓库全局样式表中 100% 真实有效，绝无凭空臆造**。

---

## 三、严厉反幻觉与致命破坏性缺陷定位 (Critical Findings)

---

### 缺陷 01【P0 致命断裂】：详案 05 物理删除 MirrorDriftStatusBar.tsx 且修改 Policy，直接击穿两套既有测试资产

- **严重级别**：P0（流水线直接阻断）
- **涉及文件与行号**：
  - 详案 05:219-225（宣称彻底删除 `MirrorDriftStatusBar.tsx`）
  - 详案 05:340-353（宣称修改 `productMirrorPolicy.ts` 与 `NoteLeafHost.tsx`）
  - 破坏现场 1：[`apps/crish-desktop/src/components/note-paper/mirrorThreeWayBridge.test.tsx:15, 105, 158`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/mirrorThreeWayBridge.test.tsx#L15)
  - 破坏现场 2：[`apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.conn-ext.test.tsx:197-203`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.conn-ext.test.tsx#L197-L203)
- **确凿证据与缺陷剖析**：
  1. 详案 05 §2.2 写道：“*目标文件：apps/crish-desktop/src/components/note-paper/MirrorDriftStatusBar.tsx（共 293 行）... 彻底从仓库中物理删除该文件*”；
  2. 然而，真实测试文件 `mirrorThreeWayBridge.test.tsx` 是用于验证三路状态与 IPC 决策的核心单测，第 15 行直接静态导入：
     ```tsx
     import { MirrorDriftStatusBar } from './MirrorDriftStatusBar';
     ```
     并在第 105 行与第 158 行直接渲染 `<MirrorDriftStatusBar />` 执行测试。如果物理删除该文件，Vitest 运行直接报 `Cannot find module './MirrorDriftStatusBar'`，导致整个测试套件编译崩溃！
  3. 详案 05 §2.3 擅自指示将 `productMirrorPolicy.ts` 中的常量修改为：
     ```typescript
     export const WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE = false as const;
     ```
     并在 `NoteLeafHost.tsx` 中拔除 mirror 逻辑。然而，已入库的保护测试 `NoteLeafHost.conn-ext.test.tsx` 第 197-203 行对此做了硬性源码与行为断言：
     ```tsx
     it('conn_ext_e2_prime_policy_on_no_tauri', async () => {
       expect(WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE).toBe(true);
       expect(readExt('NoteLeafHost.tsx')).toMatch(
         /resolveWorkspaceProductEmptyMirrorProps/
       );
       expect(readExt('NoteLeafHost.tsx')).toMatch(
         /WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE/
       );
       ...
     ```
     执行详案 05 的改动将直接导致该测试失败！
- **违反铁律**：严重践踏 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §9（测试资产保护铁律：“测试是资产不是杂物... 任何会话禁止删除测试文件或随意破坏既有测试”）。
- **整改要求**：
  1. **恪守用户边界**：用户的批评是“笔记的顶部功能栏我看也没有。底部那个灰色的大区域一点用处没有，两个块区域是又丑又没用... 先优化界面吧”。用户的诉求是**界面去杂物**，绝非让你去破坏底层策略与关联单测！
  2. **正确的极简收敛方式**：仅在 `NotePaperStrictPanel.tsx:252-266` 中物理移除 `<MirrorDriftStatusBar>` 与 `<footer>` 的 DOM 挂载，并注销 Props 透传；
  3. **保留组件文件**：保留 `MirrorDriftStatusBar.tsx` 供 `mirrorThreeWayBridge.test.tsx` 独立测试使用，仅在其文件头标记 `@deprecated 仅保留用于三路底层测试，主编辑界面已拔除挂载`；
  4. **严禁修改 `productMirrorPolicy.ts`** 中的布尔值，保留 `NoteLeafHost.conn-ext.test.tsx` 的断言绿灯。

---

### 缺陷 02【P0 跨方案分裂】：详案 02 完整代码严重滞后，保留手风琴圆角卡片与 .fileItem，与详案 01/04 完全脱节

- **严重级别**：P0（架构与代码严重分裂）
- **涉及文件与行号**：
  - `docs/diff-view-redesign/02-分维详案-行内工具条物理拔除与代码比对专注化.md:838-920`
  - `docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md:765-910`
- **确凿证据与缺陷剖析**：
  在详案 02 第四章 §4.2 给出的“`DiffCardFileList.tsx` 改造后完整源代码（100% 全量呈现，零省略）”中，代码竟然是基于旧手风琴卡片写的：
  ```tsx
  /* 详案 02:838-860 给出的所谓“重构后完整代码” */
  return (
    <div key={f.filePath} className={`${styles.accordionItem} ${active ? styles.accordionActive : ''}`}>
      <div className={styles.accordionHeaderRow}>
        <Tooltip content={f.filePath}>
          <button id={itemId} type="button" className={`${styles.fileItem} ${active ? styles.isActive : ''}`} ...>
            <span className={styles.fileNameLink}>{basename(f.filePath)}</span>
            <span className={styles.fileStat}>...</span>
          </button>
        </Tooltip>
        {sourceMode === 'git' && (
          <div className={styles.hoverActions}>...</div>
        )}
      </div>
      {active && (
        <div className={styles.inlineBody}>
          {renderInlineDiffContent(f)}
        </div>
      )}
    </div>
  );
  ```
  **极其荒谬的现场**：
  - 详案 01 已经彻底把结构重构成 `.flatFileList` $\to$ `.fileNode` $\to$ `.fileRow`（包含三大正交子域）$\to$ `.diffPane`；
  - 详案 02 仅仅删掉了展开体内部的 110 行 `inlineHeader`，却把旧的 `.accordionItem`、旧的 6px/8px 圆角卡片、旧的单一可点击大按钮 `.fileItem`、旧的绝对定位 `.hoverActions` 以及旧的 `.inlineBody` 完整原样保留！
  - 若主控按详案 02 的代码进行落盘，详案 01 的平直直角化重构成果将瞬间荡然无存！
- **整改要求**：
  主控在实现阶段必须以**详案 01 的单轨 AST 树为基准真源（SSOT）**，详案 02 仅作为“切除 inlineHeader 依赖、精简 DiffCard.tsx 父组件”的局部补丁，绝不可使用详案 02 §4.2 的整文件代码覆盖。

---

### 缺陷 03【P1 规范违背】：详案 04 臆造 `<button>` 嵌套 `<button>`，引发 HTML 规范冲突与事件失效

- **严重级别**：P1（HTML 规范与 DOM 渲染灾难）
- **涉及文件与行号**：
  - `docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md:331-332`
- **确凿证据与缺陷剖析**：
  在详案 04 §2.3 中，作者在推导单层悬停时写道：
  > “*文件条目由 `<button type="button" class="fileRow">` 或平直单轨中的行实体承载，独占所有光标响应*”
  
  **严重病理**：
  1. 根据 W3C HTML5 规范 §4.10.6（Interactive Content），`<button>` 元素内部**严禁包含任何可交互内容（Interactive content descendants）**，包括 `<button>`、`<a>`、`<input>` 等；
  2. 根据详案 01 的三大正交子域架构，行内包含：
     - 子域 A 的 `<button class="chevronBtn">`；
     - 子域 B 的 `<button class="fileNameLinkBtn">`；
     - 子域 C 的 `<button class="rowActBtn">`（暂存/放弃修改等）。
  3. 如果将外层 `.fileRow` 定义为 `<button>`，现代浏览器（Blink/WebView2）在解析 DOM 时会自动发生规整破坏（Auto-correction），甚至强制闭合标签，导致内层按钮无法接收正常的鼠标点击与键盘 Tab 焦点事件。
- **整改要求**：
  刚性裁决 `.fileRow` 必须声明为 `<div>` 语义容器（附带 `role="row"` 或由父级 `role="list"` 包裹的 `role="listitem"`），内部各个按钮拥有独立的点击事件，事件流通过 `e.stopPropagation()` 严格隔离。

---

### 缺陷 04【P1 铁律违背】：详案 04 私自声明 8 处 `!important`，公然违规并危及 style-contract 门禁基线

- **严重级别**：P1（违反仓库铁律与门禁基线）
- **涉及文件与行号**：
  - `docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md:646-649, 927-930`
- **确凿证据与缺陷剖析**：
  在详案 04 §4.2 与 §5.1 的施工图代码中，赫然出现了以下代码：
  ```css
  /* 详案 04:646-649 及 927-930 违章代码 */
  .searchInput,
  .searchInput:focus,
  .searchInput:focus-visible {
    border: none !important;
    outline: none !important;
    box-shadow: none !important;
    background: transparent !important;
  }
  ```
  整整 8 处 `!important`！
  更为讽刺的是，在同一份详案的结语第 2011 行，作者自己写道：“*实施过程中，严禁因特异性不足而使用 `!important` 覆盖*”！
  
  **危害剖析**：
  1. [`apps/crish-desktop/src/styles/style-contract.test.ts:331-350`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L331) 明确设置了 `全仓 !important 计数 ≤ 626` 的刚性防回潮棘轮（Ratchet）；
  2. 在 CSS Modules 环境下，`.searchInput:focus` 自身特异性达到 (0, 2, 0)，完全足以自然覆盖默认样式，加 `!important` 属于典型的“盲目打补丁”陋习，直接违反 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §7“严禁补丁、绕过与作弊”。
- **整改要求**：
  彻底拔除这 8 处 `!important`，使用标准纯净属性声明：
  ```css
  .searchInput,
  .searchInput:focus,
  .searchInput:focus-visible {
    border: none;
    outline: none;
    box-shadow: none;
    background: transparent;
  }
  ```

---

### 缺陷 05【P1 铁律违背】：详案 05 顶栏输入框焦点态对比度超标（15%）且加 1px 外阴影环，违反 AGENTS.md §13

- **严重级别**：P1（违反仓库 UI 刚性红线）
- **涉及文件与行号**：
  - `docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md:1421-1425`
- **确凿证据与缺陷剖析**：
  审查详案 05 第七章给出的 CSS 源码：
  ```css
  /* 详案 05:1421-1425 违章代码 */
  .titleInput:focus,
  .titleInput:focus-visible {
    border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 8%, transparent);
    outline: none;
  }
  ```
  **逐条对照 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13「UI：输入框与焦点态」红线**：
  - 铁律条文：“*默认不要重阴影：输入框、搜索框、composer 等默认不要加厚重 box-shadow，保持干净、扁平、轻量*” $\to$ 详案 05 强行添加了 `0 0 0 1px` 外圈阴影环；
  - 铁律条文：“*克制的激活边框：输入或按钮处于 active / focused 时，禁止粗、深、实心黑边（例如厚重 0 0 0 1px 黑环）*”；
  - 铁律条文：“*焦点对比度上限约 10%：任何情况下焦点/激活态不得使用硬实线；相对基线，灰色加深混入文本色不超过约 10%（例如 color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%) 为上限量级）；常规元素优先约 3%–6% 混入以保持柔软*” $\to$ 详案 05 竟然混入了 **15%** 的 `var(--text-primary)`，严重超标破上限！
- **整改要求**：
  严格压回 10% 刚性红线并剔除 `box-shadow` 阴影环，采用符合规范的极简柔软焦点态：
  ```css
  .titleInput:focus,
  .titleInput:focus-visible {
    border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
    box-shadow: none;
    outline: none;
  }
  ```

---

### 缺陷 06【P1 承诺落空】：详案 05 在 CSS 中大量回潮裸写 Hex，且在状态指示器中引入违章 Tailwind 蓝 #3b82f6（破 Zero-Blue 铁律）

- **严重级别**：P1（违反设计系统 Tokens 纪律与 Zero-Blue 铁律）
- **涉及文件与行号**：
  - `docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md:1318-1550`
  - 对照：`docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md:498-530`
- **确凿证据与缺陷剖析**：
  1. 详案 04 在 §3.2 中信誓旦旦地整理出“笔记面板 25 处残留硬编码色值全量清洗表”，声明将全量清退 `#ffffff`, `#111111`, `#696969`, `hsl(35, 10%, 86%)`；
  2. 然而，在详案 05 最终提供的完整样式表 `NotePaperPanel.module.css`（L1318-1550）中，这些坏味道兜底原封不动地全部回潮：
     - L1318: `background: var(--bg-card, #ffffff);`
     - L1319: `color: var(--text-primary, #111111);`
     - L1355: `background: var(--bg-card, #ffffff);`
     - L1373: `color: var(--text-tertiary, #696969);`
     - L1389: `color: var(--text-primary, #111111);`
     - L1407: `color: var(--text-primary, #111111);`
     - L1480: `color: var(--text-tertiary, #696969);`
     - L1929: `border: 2px solid var(--border-color, hsl(35, 10%, 86%));`
  3. 更严重的是，在保存状态指示器样式中，详案 05 居然直接裸写了 Tailwind 蓝：
     ```css
     /* 详案 05:1450 违章代码 */
     .saveStatusSyncing {
       color: var(--color-info, #3b82f6); /* ❌ 裸写十六进制，且违背 Zero-Blue 铁律！ */
     }
     .saveStatusUnsaved {
       color: var(--color-warning, #f59e0b); /* ❌ 裸写十六进制！ */
     }
     ```
     [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §14 明确确立了 **Zero-Blue** 铁律（严禁任何浏览器或 Tailwind 蓝，品牌活态签名为 Emerald Green 翡翠绿）；同时严禁在组件 CSS 中裸写十六进制回退色。
- **整改要求**：
  全面肃清兜底硬编码，规范化为纯净 Token 引用：
  - `background: var(--bg-card);`
  - `color: var(--text-primary);`
  - `color: var(--text-tertiary);`
  - 同步中的颜色统一采用系统权威令牌：`color: var(--brand-primary);`（同步中呈现品牌翡翠绿轻微呼吸，绝不使用违章纯蓝）；
  - 未保存颜色采用系统语义预警令牌：`color: var(--color-warning);`（无裸写 `#f59e0b` 兜底）。

---

### 缺陷 07【P2 门禁违规】：详案 01 与 05 中多处违规采用原生 HTML title 属性，违反 AGENTS.md §12

- **严重级别**：P2（规范性门禁违规）
- **涉及文件与行号**：
  - 详案 01:789: `<span className={...} title={badge.title}>`
  - 详案 01:810: `<button className={styles.fileNameLinkBtn} title={f.filePath}>`
  - 详案 01:819: `<span className={styles.dirPath} title={f.filePath}>`
  - 详案 05:632: `<span ... title="点击编辑标题">`
- **确凿证据与缺陷剖析**：
  [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §12 刚性要求：
  > “*使用自定义 Tooltip：始终使用项目自定义 `<Tooltip>` 组件，不要用原生 HTML `title` 作为主悬停提示。避免浏览器默认气泡：原生 title 观感不一致且陈旧；用 `<Tooltip content={...}>` 包裹可交互元素，以获得圆角胶囊、柔和阴影与主题色一致的提示。*”
  
  详案 01 与详案 05 在给出组件 JSX 时，偷懒大量使用了原生 HTML `title` 属性，渲染后会弹出丑陋陈旧的 Windows 默认矩形黄色/白底气泡。
- **整改要求**：
  全量替换为原子组件 `<Tooltip content={...}>` 包裹目标元素。

---

### 缺陷 08【P2 排版倒退】：详案 04 在操作按钮区域依然采用绝对定位 .hoverActions，与详案 01 的 Flex 盒架构冲突

- **严重级别**：P2（局部排版倒退）
- **涉及文件与行号**：
  - `docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md:389-412`
  - 对照：`docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md:260-262, 1262-1308`
- **确凿证据与缺陷剖析**：
  - 详案 01 经过深度分析，指出原代码“绝对定位覆盖增减统计”是导致视觉闪烁与排版跳动的恶性根源，因此在详案 01 中将其重构为与 `.fileStat` 并排的 Flex 盒容器 `.rowActions`；
  - 但在详案 04 的样式中，作者依然复制了旧的 `position: absolute; right: 8px; top: 50%; transform: translateY(-50%);`，不仅在逻辑上与详案 01 发生冲突，且绝对定位在极窄分屏（320px）下极易脱离文档流遮盖住文件名。
- **整改要求**：
  样式表统一采纳详案 01 的 Flex 盒流式布局 `.statAndActions > .rowActions`，废除任何基于绝对定位的悬浮覆盖。

---

## 四、SLoHT 单层 Hover 体系推导数学性与类名体系冲突剖析

### 4.1 计算机图形学 Alpha 混合公式验证（4.94% 复合深脏灰之谜）

详案 04 提出的 SLoHT 数学推导是本战役极具价值的技术穿透。终审官通过计算机图形学 Porter-Duff Over 算子对其进行了严密验算：

在浅色模式下，背景为纯白 $C_{\text{base}} = 1.0$，叠加两层透明黑 $C_{\text{overlay}} = 0.0$（$\alpha = 0.025$）：
$$
\begin{aligned}
\alpha_{\text{comp}} &= \alpha_1 + \alpha_2 \times (1 - \alpha_1) \\
&= 0.025 + 0.025 \times (1 - 0.025) \\
&= 0.025 + 0.024375 = \mathbf{0.049375} \approx \mathbf{4.94\%}
\end{aligned}
$$
在暗色模式下（基底深灰，$\alpha = 0.035$）：
$$
\alpha_{\text{comp}} = 0.035 + 0.035 \times (1 - 0.035) = \mathbf{0.068775} \approx \mathbf{6.88\%}
$$
**图形学物理现象验证成立**：
当外层容器 `.accordionItem:hover` 与内层按钮 `.fileItem:hover` 同时处于激活状态时，在视觉上直接叠加出接近 **5%~7%** 的深灰色，与激活态（Active 5%~6.5%）的底色完全撞车，让用户产生了强烈的“这个界面很灰、很脏、斑驳分裂”的不良体验。
因此，**SLoHT 核心哲学——“容器层永久锁定 transparent，交互行独占唯一 hover 状态”在理论与物理渲染上 100% 正确且必要**。

---

### 4.2 跨方案类名推导脱节与收敛矩阵 (SSOT 仲裁)

尽管 SLoHT 理论正确，但在实际类名命名上，各分维详案之间出现了严重的“各说各话”现象。终审官正式签发全战役唯一合法类名裁决表（SSOT）：

| 界面节点实体 | PLAN-01 命名 | PLAN-02 命名 | PLAN-04 命名 | PLAN-05 命名 | **终审官 SSOT 裁决唯一定义** | 状态与处置 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **文件列表根容器** | `.flatFileList` | `.fileList` | `.flatFileList` | - | **`.flatFileList`** | 统一采用平直列表容器名，保留 `.fileList` 作为别名映射 |
| **条目物理容器** | `.fileNode` | `.accordionItem` | `.fileNode` | - | **`.fileNode`** | 彻底销毁 `.accordionItem` |
| **条目交互行** | `div.fileRow` | `button.fileItem` | `button.fileRow` | - | **`div.fileRow`** | 必须为 `div`，禁止为 `button`；统一类名 `.fileRow` |
| **代码展开视口** | `.diffPane` | `.inlineBody` | `.diffPane` | - | **`.diffPane`** | 彻底销毁 `.inlineBody`，由平直贴边 `.diffPane` 统一接管 |
| **快捷动作容器** | `.rowActions` | `.hoverActions` | `.hoverActions` | - | **`.rowActions`** | 废弃绝对定位，收敛为 Flex 盒 `.rowActions` |
| **笔记紧凑顶栏** | - | - | `.compactHeader` | `.compactHeader` | **`.compactHeader`** | 严格 32px 偶数净高顶栏 |
| **笔记纸面外壳** | - | - | - | `.panel` | **`.panel`** | 清除 8px 圆角与浮动阴影，100% 满视口平铺 |

---

## 五、主控 Agent 分步整改指令清单 (Actionable Directives)

为确保阶段六实施平滑、零回退、零测试红灯，主控 Agent 必须依序执行以下整改方案：

### 指令 1：解耦测试资产保护与界面拔除 (修补缺陷 01)
- 在 `apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx` 中：
  - 物理删除第 252-266 行关于 `<MirrorDriftStatusBar>` 与 `<footer>` 的 DOM 渲染；
  - 移除组件的 `mirrorDriftReport` 等 4 个死 Props；
- **保留 `MirrorDriftStatusBar.tsx` 物理文件**，不从仓库删除，确保 `mirrorThreeWayBridge.test.tsx` 编译与执行 100% 绿灯；
- **保留 `productMirrorPolicy.ts` 中的常量原值**，严禁将其改为 `false`，确保 `NoteLeafHost.conn-ext.test.tsx` 源码正则匹配 100% 绿灯；
- 在 `NotePaperPanel.module.css` 中保留 `.panel > .footer` 兼容别名规则，确保 `NotePaperPanel.insulate.test.ts` 源码读取断言 100% 绿灯。

### 指令 2：收敛 DiffCardFileList.tsx 单轨基准 (修补缺陷 02 & 03)
- 丢弃详案 02 §4.2 滞后的完整代码；
- 以详案 01 §4.2 为唯一 AST 基准，`.fileRow` 刚性声明为 `<div>`；
- 内部三大正交子域全量换装原子组件 `<Tooltip content={...}>`，物理剔除所有原生 HTML `title={...}`（修补缺陷 07）；
- 展开区标记为 `<div className={styles.diffPane}>`，彻底淘汰 `.inlineBody`。

### 指令 3：净化 DiffCard.module.css 样式表 (修补缺陷 04 & 08)
- 物理删除 lines 374-436 的 8 大废弃选择器；
- 彻底剔除详案 04 中的 8 处 `!important` 声明；
- 采用详案 01 的 Flex 盒流式排版 `.statAndActions > .rowActions`，杜绝绝对定位覆盖；
- 执行 13 处裸写 Hex 与 6 处幽灵 Token 的全量换装。

### 指令 4：规范化 NotePaperPanel.module.css (修补缺陷 05 & 06)
- 压低 `.titleInput:focus` 的焦点对比度混入比至 **10%**：
  `border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);`；
- 拔除 `.titleInput:focus` 的 `box-shadow` 阴影环；
- 清洗整个样式表中残留的 25 处 `#ffffff`, `#111111`, `#696969`, `hsl(35, 10%, 86%)` 回退色；
- 消除状态指示器中的裸写 Hex，将违章蓝 `#3b82f6` 换装为系统翡翠绿品牌 Token `var(--brand-primary)`。

---

## 六、终审结论与签字盖章

```
================================================================================
【战役阶段五 · 终审反幻觉裁决结论】
================================================================================
审计编号：AUDIT-FINAL-UI-TOKENS
审核对象：分维详案 01, 02, 04, 05
查验结论：准入（条件：必须吸收本文 8 大缺陷整改意见）
真实性核定：
  - DiffCard.module.css 8 大选择器：100% 存在，删除边界无误伤
  - DiffCardFileList.tsx 三大正交子域：功能无损，重塑为单轨
  - NotePaperStrictPanel 底部两块区域：物理拔除，测试资产保护已矫正
  - 13 处裸写 Hex 与 6 处幽灵 Token：代码坐标 100% 确凿，权威 Token 全局有效
  - SLoHT 数学推导：图形学 Alpha 混合验证成立，类名体系统一收敛完成

签发角色：UI 组件与 CSS Tokens 真实性终审官
签发日期：2026-09-05
================================================================================
```
