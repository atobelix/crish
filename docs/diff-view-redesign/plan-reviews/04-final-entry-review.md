# 差异与笔记面板详案终审反幻觉严苛审计与准入评审报告 (FINAL-REVIEW-ENTRY)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）
> **评审阶段**：阶段五 · 详案终审反幻觉严苛审计与实施波准入裁决（Final Entry Review）
> **终审编号**：FINAL-REVIEW-ENTRY (04)
> **终审席位**：测试资产与状态机真实性终审官（Test Safety & State Machine Anti-Hallucination Auditor）
> **终审对象**：
> - [`docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md`](file:///c:/Software/conex/docs/diff-view-redesign/05-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF32px%E7%B4%A7%E5%87%91%E9%A1%B6%E6%A0%8F%E9%87%8D%E5%A1%91%E4%B8%8E%E5%BA%95%E9%83%A8%E8%B0%83%E8%AF%95%E5%9D%97%E5%BD%BB%E5%BA%95%E6%8B%94%E9%99%A4.md)（DETAIL-PLAN-05）
> - [`docs/diff-view-redesign/06-分维详案-多笔记综合管理体系与SQLite及IPC后端架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/06-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%A4%9A%E7%AC%94%E8%AE%B0%E7%BB%BC%E5%90%88%E7%AE%A1%E7%90%86%E4%BD%93%E7%B3%BB%E4%B8%8ESQLite%E5%8F%8AIPC%E5%90%8E%E7%AB%AF%E6%9E%B6%E6%9E%84.md)（DETAIL-PLAN-06）
> - [`docs/diff-view-redesign/07-分维详案-立体验证套件与回归测试平滑迁移.md`](file:///c:/Software/conex/docs/diff-view-redesign/07-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AB%8B%E4%BD%93%E9%AA%8C%E8%AF%81%E5%A5%97%E4%BB%B6%E4%B8%8E%E5%9B%9E%E5%BD%92%E6%B5%8B%E8%AF%95%E5%B9%B3%E6%BB%91%E8%BF%81%E7%A7%BB.md)（DETAIL-PLAN-07）
> **输入协同**：
> - 阶段三独立评审报告：[`01-architecture-and-contracts-review.md`](file:///c:/Software/conex/docs/diff-view-redesign/plan-reviews/01-architecture-and-contracts-review.md)（架构单轨性与接口契约）
> - 阶段三独立评审报告：[`02-ui-tokens-and-visual-review.md`](file:///c:/Software/conex/docs/diff-view-redesign/plan-reviews/02-ui-tokens-and-visual-review.md)（UI 视觉规范与 Tokens 纯度）
> - 阶段三独立评审报告：[`03-test-safety-and-state-machine-review.md`](file:///c:/Software/conex/docs/diff-view-redesign/plan-reviews/03-test-safety-and-state-machine-review.md)（测试资产保护与状态机边界）
> - 阶段五笔记专项终审：[`05-note-final-entry-review.md`](file:///c:/Software/conex/docs/diff-view-redesign/plan-reviews/05-note-final-entry-review.md)（FINAL-REVIEW-02 准入裁决）
> **落盘路径**：`docs/diff-view-redesign/plan-reviews/04-final-entry-review.md`
> **审查铁律**：用户最高指令（“系统性做，先考虑架构。以及避免双轨或者多轨、硬编码、功能伪实现、伪连通。项目中的代码应该是清晰的、单轨的、最先进的代码”）、[`.agents/LOGIC_PLAN_NO_RETREAT.md`](file:///c:/Software/conex/.agents/LOGIC_PLAN_NO_RETREAT.md)（反退避全文）、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（纯逻辑规划）、§3（Git 提交权主控独占）、§7（严禁补丁、绕过与作弊，零容忍 `--no-verify`）、§7.1（立体验证纪律）、§9（测试资产保护铁律）、§12（UI 自定义 Tooltip）、§13（输入框焦点对比度 <= 10%）、§14（现代 CSS、禁止裸写 Hex）、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。

---

## 目录

- [一、准入终审裁决与反幻觉严苛定性（Pass / Need-Fix）](#一准入终审裁决与反幻觉严苛定性pass--need-fix)
  - [1.1 终审裁决结论：【有条件准入实施（CONDITIONAL PASS · 阻断补丁先修后行）】](#11-终审裁决结论有条件准入实施conditional-pass--阻断补丁先修后行)
  - [1.2 三位审计官终审核心意见综合矩阵](#12-三位审计官终审核心意见综合矩阵)
  - [1.3 阶段五详案 4 大关键幻觉与破坏性缺陷通报（Blocker Matrix）](#13-阶段五详案-4-大关键幻觉与破坏性缺陷通报blocker-matrix)
- [二、真实查验仓库测试套件（现场穿透剖析）](#二真实查验仓库测试套件现场穿透剖析)
  - [2.1 NotePaperPanel.insulate.test.ts 现场代码穿透与绝缘契约迁移可行性](#21-notepaperpanelinsulatetestts-现场代码穿透与绝缘契约迁移可行性)
  - [2.2 DiffCardFileList.test.tsx 存量用例覆盖范围与业务断言完整性核验](#22-diffcardfilelisttesttsx-存量用例覆盖范围与业务断言完整性核验)
  - [2.3 useNoteDocumentManager 状态机并发极限推演（React 18/19 竞态、闭包与死锁排查）](#23-usenotedocumentmanager-状态机并发极限推演react-1819-竞态闭包与死锁排查)
- [三、严厉反幻觉排查（虚构 API、脱水 Mock 与不可执行代码尸检）](#三严厉反幻觉排查虚构-api脱水-mock-与不可执行代码尸检)
  - [3.1 致命幻觉 1：style-contract.test.ts 中正则表达式语法崩溃（Node.js SyntaxError 实锤）](#31-致命幻觉-1style-contracttestts-中正则表达式语法崩溃nodejs-syntaxerror-实锤)
  - [3.2 致命幻觉 2：useNoteHydrate.race.test.ts 参数类型错乱与 Null 解引用崩溃](#32-致命幻觉-2usenotehydrateracetestts-参数类型错乱与-null-解引用崩溃)
  - [3.3 致命幻觉 3：测试超前断言而源码缺失 Generation Guard 的“虚假安全感”](#33-致命幻觉-3测试超前断言而源码缺失-generation-guard-的虚假安全感)
  - [3.4 契约违规 4：NoteSidebarDrawer.module.css 裸写 Hex、旧式 rgba 与 display:none 回潮](#34-契约违规-4notesidebardrawermodulecss-裸写-hex旧式-rgba-与-displaynone-回潮)
- [四、四段式架构治理声明（To-Do / Not-To-Do / 旧路径清单 / 自检删除面）](#四四段式架构治理声明to-do--not-to-do--旧路径清单--自检删除面)
  - [4.1 【做什么（To-Do）】](#41-做什么to-do)
  - [4.2 【不做什么（Not-To-Do）】](#42-不做什么not-to-do)
  - [4.3 【旧路径清单（Legacy Path Inventory）】](#43-旧路径清单legacy-path-inventory)
  - [4.4 【自检删除面（Self-Inspection Deletion Surface）】](#44-自检删除面self-inspection-deletion-surface)
- [五、准入修复施工补丁（Drop-in Code Patches）](#五准入修复施工补丁drop-in-code-patches)
  - [5.1 补丁 1：style-contract.test.ts 合法 RegExp 与全域覆盖重构源码](#51-补丁-1style-contracttestts-合法-regexp-与全域覆盖重构源码)
  - [5.2 补丁 2：useNoteHydrate.ts 补齐 Generation Guard 真实状态机源码](#52-补丁-2usenotehydratets-补齐-generation-guard-真实状态机源码)
  - [5.3 补丁 3：useNoteHydrate.race.test.ts 合法类型签名与防御断言测试源码](#53-补丁-3usenotehydrateracetestts-合法类型签名与防御断言测试源码)
  - [5.4 补丁 4：useNoteDocumentManager.ts 剔除 Updater 内部副作用与超时刷盘源码](#54-补丁-4usenotedocumentmanagerts-剔除-updater-内部副作用与超时刷盘源码)
  - [5.5 补丁 5：NoteSidebarDrawer.module.css 彻底清退 Hex、rgba 与 display:none 规范源码](#55-补丁-5notesidebardrawermodulecss-彻底清退-hexrgba-与-displaynone-规范源码)
  - [5.6 补丁 6：NotePaperPanel.insulate.test.ts 与样式文件选择器双向收敛源码](#56-补丁-6notepaperpanelinsulatetestts-与样式文件选择器双向收敛源码)
- [六、阶段六实施波准入签发与执行前置打卡清单](#六阶段六实施波准入签发与执行前置打卡清单)

---

## 一、准入终审裁决与反幻觉严苛定性（Pass / Need-Fix）

### 1.1 终审裁决结论：【有条件准入实施（CONDITIONAL PASS · 阻断补丁先修后行）】

测试资产与状态机真实性终审官对分维详案 05、06、07 展开了穿透至 Node.js 运行时底层、源码 AST、React 18/19 并发调度器与真实 Git 树测试套件的“挤干水分”式反幻觉严苛审计。

**终审裁决结论**：**【CONDITIONAL PASS（有条件准入实施）】**。
各分维详案在单轨架构收敛、用户痛点物理切除、数据库版本加固、五重 IPC 闭环上的总体逻辑完备坚实，但详案中提供的部分关键代码存在**“直接在 Node 运行时抛 SyntaxError 崩溃”、“Hook 调用实参类型与声明类型脱节”、“在状态更新函数内部触发级联状态修改的反模式”、以及“CSS 样式文件违规声明 Hex/display:none”**等 4 项直接阻断 CI 门禁的重大幻觉性缺陷。

**放行前提条件**：实施波（Phase 6）必须**无条件采用本终审报告第 [五章](#五准入修复施工补丁drop-in-code-patches) 提供的 6 大 Drop-in 修正补丁**作为基准进行代码落盘，严禁原样照抄详案 06 与 07 中不可执行的伪代码！

---

### 1.2 三位审计官终审核心意见综合矩阵

| 审计维度与席位 | 代表报告 | 审查结论 | 终审定性与核心裁决意见 |
| :--- | :--- | :---: | :--- |
| **席位一：架构单轨性与接口契约** | `01-architecture-and-contracts-review.md` | **PASS (加固)** | 1. 赞同 SQLite v8 迁移门闩（`current_version < 8`），杜绝重启覆盖用户自定标题；<br/>2. 赞同 Tauri IPC 四命令在 `main.rs` 宏、`command_manifest.rs` 与前端快照五重闭环（总数 131 $\to$ 135）；<br/>3. 严禁保留任何双轨空态或伪连通回收站。 |
| **席位二：UI 视觉规范与 Tokens 对比度** | `02-ui-tokens-and-visual-review.md` | **PASS (加固)** | 1. 严格锁定 0px 平直列表与紧凑 32px 顶栏，字数统计锁定 `tabular-nums` 防抖；<br/>2. 严格执行 SLoHT 单层 Hover 架构，彻底剔除父级容器 hover，消灭 4.94% 脏灰；<br/>3. 严查输入框焦点态，边框对比度增量严格限制在 10% 以内（纯光标极简型）；全域清剿原生 HTML `title`，统一换装原子 `<Tooltip>`。 |
| **席位三：测试资产与状态机真实性（本报告）** | `03-test-safety-and-state-machine-review.md`<br/>`04-final-entry-review.md` | **CONDITIONAL PASS** | 1. **严惩测试作弊**：禁止粗暴删测，必须实施“正向解耦交互 + 负向物理清退”双向契约；<br/>2. **现场实锤 4 项代码级幻觉**：Plan 07 静态守卫包含非法正则直接导致 Node 崩溃；Plan 07 竞态测试传参类型错误且测试目标源码缺失防竞态机制；Plan 06 状态机在 updater 内直接调用 setState；Plan 06 侧栏样式裸写 Hex 色值与 `display: none`。<br/>3. 提供完整可编译、可测试的 Drop-in 施工代码直接交付实施。 |

---

### 1.3 阶段五详案 4 大关键幻觉与破坏性缺陷通报（Blocker Matrix）

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               阶段五分维详案反幻觉审查阻断缺陷矩阵                                │
├──────┬──────────────┬─────────────────────────┬──────────────────────────────────┬──────────────┤
│ 编号 │ 缺陷位置     │ 缺陷定性                │ 现场执行表现                     │ 严重级别     │
├──────┼──────────────┼─────────────────────────┼──────────────────────────────────┼──────────────┤
│ H-01 │ 详案 07 L800 │ 静态正则语法崩溃        │ Node.js 运行时抛 SyntaxError:    │ P0 门禁阻断  │
│      │ L814         │ 非法字符类范围运算      │ Range out of order in char class │ (100% 崩溃)  │
├──────┼──────────────┼─────────────────────────┼──────────────────────────────────┼──────────────┤
│ H-02 │ 详案 07 L1312│ Hook 传参契约错乱       │ 传 2 个实参，声明仅收 1 个对象； │ P0 门禁阻断  │
│      │ L1354        │ Null 属性访问崩溃       │ 且 projection 在 loading 时为空  │ (TS+Vitest)  │
├──────┼──────────────┼─────────────────────────┼──────────────────────────────────┼──────────────┤
│ H-03 │ 详案 06 L1433│ React Updater 副作用    │ 在 setDocuments 的 updater 内部  │ P1 运行时隐患│
│      │              │ 状态机级联死锁风险      │ 直接执行 setActiveDocId          │ (并发双跑)   │
├──────┼──────────────┼─────────────────────────┼──────────────────────────────────┼──────────────┤
│ H-04 │ 详案 06 L2072│ 样式刚性门禁回潮        │ 出现 display: none、裸写 Hex     │ P1 样式违规  │
│      │ L2105, L2155 │ 与现代 CSS / 无障碍冲突 │ 及旧式 rgba(0,0,0,0.4) 声明      │ (Gate 拦截)  │
└──────┴──────────────┴─────────────────────────┴──────────────────────────────────┴──────────────┘
```

---

## 二、真实查验仓库测试套件（现场穿透剖析）

### 2.1 NotePaperPanel.insulate.test.ts 现场代码穿透与绝缘契约迁移可行性

#### 2.1.1 现场代码逐行穿透 (L31-40)
查阅真实仓库文件 [`apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts:31-40`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts#L31-L40)：

```typescript
// NotePaperPanel.insulate.test.ts 真实代码 (L31-40)
  it('含 .panel > .header / .footer，flex: 0 0 auto 且 max-height: none', () => {
    expect(css).toContain('.panel > .header');
    expect(css).toContain('.panel > .footer');

    const chrome = ruleBlockAfter(css, '.panel > .header,');
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).toMatch(/width:\s*100%/);
    expect(chrome).toMatch(/min-height:\s*unset/);
  });
```

同时查看第 54 行：
```typescript
    const chrome = ruleBlockAfter(css, '.panel > .header,');
```

#### 2.1.2 绝缘测试的初衷与断裂机理
1. **测试初衷**：
   - 笔记面板挂载在工作区二叉树（`BinaryTree`）的叶子节点内；
   - 上层容器声明了 `.leafBody > * > * { flex: 1 1 0%; }`（选择器特异性 `(0, 1, 0)`）；
   - 为了防止笔记面板的顶栏（`.header`）和底栏（`.footer`）被二叉树强行垂直拉伸均分高度，开发者在 `NotePaperPanel.module.css:709-715` 声明了选择器特异性为 `(0, 2, 0)` 的硬性绝缘规则：
     ```css
     .panel > .header,
     .panel > .footer {
       flex: 0 0 auto;
       max-height: none;
       width: 100%;
       min-height: unset;
     }
     ```
   - `NotePaperPanel.insulate.test.ts` 的核心价值在于**利用源码读盘锁死该特异性与 flex 属性，确保顶栏绝不发生垂直形变与高度坍缩**。
2. **断裂机理与双重陷阱**：
   - **陷阱 1（字符包含断裂）**：第 33 行 `expect(css).toContain('.panel > .footer')` 强行锁死了 `.footer` 的存在。一旦按照用户指令物理删除底部调试块，此行必定当场抛出异常；
   - **陷阱 2（选择器前缀逗号硬匹配）**：第 35 行与第 54 行的 `ruleBlockAfter(css, '.panel > .header,')` 寻找的是**以逗号结尾的字符串**（`.panel > .header,`）。如果重构后删除了 `.footer` 并且 `.header` 或 `.compactHeader` 后面直接紧跟 `{`，则 `ruleBlockAfter` 会直接抛出 `缺少选择器 .panel > .header,`！
3. **从断言 `.footer` 迁移为断言 `.compactHeader` 的可行性判定**：
   - **完全可行且不破坏初衷**：底栏 `.footer` 属于被用户严厉批评的纯调试开发残留（无任何产品级业务交互）；物理删除底栏后，二叉树拉伸威胁依然施加在顶栏上。因此，将绝缘断言收敛至顶栏 `.compactHeader`（或 `.compactHeader, .header`），既完整继承了“对抗二叉树 flex 均分”的物理绝缘初衷，又去除了对死代码的选择器依赖；
   - **必须追加防回潮负向断言**：必须同时断言 `expect(css).not.toContain('.panel > .footer')`，刚性锁定调试底栏彻底清退。

---

### 2.2 DiffCardFileList.test.tsx 存量用例覆盖范围与业务断言完整性核验

#### 2.2.1 现场存量用例覆盖交互全景 (L1-105)
查阅真实仓库文件 [`apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx)，现有测试仅有 3 个用例：

1. **用例 1 (L10-24)**：`should disable Accept button for provisional diff`
   - **覆盖交互**：纯逻辑分类函数 `classifyFileDiff` 针对临时 Diff（`provisional: true`）的计算结果判定；验证在此状态下 `classification.ok === false`，进而推导接受按钮处于 `disabled` 状态；
2. **用例 2 (L26-63)**：`renders inline compare Select with explicit size="sm" preventing overflow`
   - **覆盖交互**：当列表项处于展开状态（`current={dummyFile}`）时，验证行内对比工具栏（`_inlineHeader_`）内部渲染了 `size="sm"`（28px）的高度的下拉选择器，防止单文件视口发生横向/纵向溢出；
3. **用例 3 (L65-105)**：`renders targetDiff additions and deletions when getFileDiffData is provided`
   - **覆盖交互**：当传入 `getFileDiffData` 时，手风琴大按钮的可访问名称（Accessible Name）中必须同时包含文件名、增加行数与删除行数（通过正则 `/main\.ts \+15 −7/` 匹配）。

#### 2.2.2 重构测试是否删除了有效业务断言？
**终审裁定：未删除任何实质性业务断言，而是完成了高质量的正向正交解耦升级与负向物理清退。**

1. **用例 1（纯逻辑临时 Diff）**：
   - 100% 完整保留，逻辑与断言原封不动，未发生任何倒退；
2. **用例 2（行内工具行 `_inlineHeader_` 拔除）**：
   - 用户明确指示：*“去掉每个文件列表里面的顶部工具行，越简单越好”*；
   - 详案 07 将旧用例升级为**“正向呈现代码比对正文 + 负向清除工具行”**组合拳：
     - 正向断言：代码比对正文 `diff-content-direct` 直接挂载；
     - 负向断言：`container.querySelector('[class*="inlineHeader"]')`、`select`、`[data-size="sm"]` 全部为 `null`；
   - 业务断言不仅未丢失，反而强化了对“伪隐藏（display: none）”的物理拦截；
3. **用例 3（统计数字呈现与文件名解耦）**：
   - 旧架构将整行封装在一个单一 `<button>` 内，导致点击任何位置（包含文件名）都只能触发折叠展开，文件名超链接功能完全沦为伪摆设；
   - 详案 07 将用例拆解为两个正交用例：
     - **正交触发用例**：Chevron 按钮只触发折叠展开，文件名超链接只触发独立 Tab 预览；
     - **常驻统计用例**：文件名超链接存在的同时，独立断言增删统计数字 `+42` 与 `−13` 永久可见且数值精准；
   - 结论：**原用例中对“增删数字准确性”的业务断言 100% 得到继承并更加严密**。

---

### 2.3 useNoteDocumentManager 状态机并发极限推演（React 18/19 竞态、闭包与死锁排查）

在详案 06 中，多文档状态机 `useNoteDocumentManager.ts`（L1298-1460）是整场重构的核心中枢。终审官针对 React 18/19 并发渲染、闭包快照及极端连续点击场景展开了深度尸检：

#### 2.3.1 缺陷 1：在 `setDocuments` Updater 内部调用 `setActiveDocId`（React 反模式）
查阅详案 06 第 1428-1436 行：
```typescript
        setDocuments((prev) => {
          const next = prev.filter((d) => d.id !== docId);
          if (activeDocId === docId) {
            // 🔴 严重反模式：在状态更新函数内部直接调用另一个状态的 setter！
            const nextActive = next.length > 0 ? next[0].id : `strict-${wsId}`;
            setActiveDocId(nextActive);
          }
          return next;
        });
```
- **病理危害**：
  - React 官方规范明文严禁在状态更新器（`updater function`）执行期间产生任何外部副作用；
  - 在 React 18/19 StrictMode 环境下，更新器会被**双重执行（Double Invocation）**，导致 `setActiveDocId` 被连续触发两次；
  - 这会打破 React 调度器的更新时序，并在控制台爆出 `Cannot update a component while rendering a different component` 或导致并发调度死锁。
- **治理方案**：
  在删除前先在外部计算出目标文档列表与 `nextActiveDocId`，在同一批处理作用域内平级调用 `setDocuments(next)` 与 `setActiveDocId(nextActiveDocId)`。

#### 2.3.2 缺陷 2：切换前刷盘 `flushPendingDraft` 缺乏超时机制与重入防卫（UI 假死陷阱）
查阅详案 06 第 1357-1365 行：
```typescript
      // 切换前脏数据强制刷盘（BUG-A05 补丁）
      if (flushPendingDraft) {
        try {
          await flushPendingDraft();
        } catch {
          // 刷盘尽力而为，不阻断文档切换
        }
      }
```
- **病理危害**：
  - `flushPendingDraft` 内部通常涉及 SQLite WAL 事务提交与 IPC 跨进程通信；
  - 若底层发生锁争用或异常卡死，`await flushPendingDraft()` 将永久不 resolve；
  - 这将导致后续的 `setActiveDocId(targetDocId)` 永远无法被执行，造成用户点击侧栏笔记时**界面彻底假死、无任何响应**；
  - 此外，当用户 100ms 内连点 5 篇笔记时，会并发触发 5 次 `flushPendingDraft()`，对同一篇文档的正在持久化进程造成严重重入读写冲突。
- **治理方案**：
  必须为 `flushPendingDraft()` 配备 `Promise.race` 包装的**硬性超时守卫（500ms）**，即使底层 I/O 挂起，也绝不阻塞前端视图切换！

---

## 三、严厉反幻觉排查（虚构 API、脱水 Mock 与不可执行代码尸检）

### 3.1 致命幻觉 1：style-contract.test.ts 中正则表达式语法崩溃（Node.js SyntaxError 实锤）

#### 3.1.1 现场代码穿透
查阅分维详案 07 第 799-805 行与第 813-819 行：
```typescript
// 详案 07 第 800 行与 814 行代码：
const radiusMatch = block.match(/border-radius:\s*([var\(--radius-[^)]+\)|[1-9]\d*px])/i);
```

#### 3.1.2 本机环境真实执行尸检
在真实 Node.js v24 环境下直接执行该正则匹配语句：
```powershell
node -e "const r = /border-radius:\s*([var\(--radius-[^)]+\)|[1-9]\d*px])/i;"
```
终端输出：
```
SyntaxError: Invalid regular expression: /border-radius:\s*([var\(--radius-[^)]+\)|[1-9]\d*px])/i: Range out of order in character class
    at makeContextifyScript (node:internal/vm:194:14)
    at compileScript (node:internal/process/execution:388:10)
    ...
```

#### 3.1.3 根因尸检与严厉定性
- **成因剖析**：
  - 详案作者企图使用分支匹配“带有 `var(--radius-*)` 或大于 0 像素的圆角”；
  - 然而作者严重混淆了正则表达式中的**捕获/非捕获分组 `(?:...)`** 与 **字符集 `[...]`**；
  - 在字符集 `[...]` 内，字符 `-` 会被解释为范围操作符。表达式中的 `radius-[^` 试图建立从字符 `'s'`（ASCII 115）到字符 `'['`（ASCII 91）的递增范围；
  - 由于 ASCII 码 $115 > 91$，直接触发 Node.js V8 引擎底层的 `Range out of order in character class` 语法解析致命错误！
- **严重性**：
  **极度严重（P0）**。若直接将此代码写入 `style-contract.test.ts`，Vitest 在编译导入阶段就会全局崩溃，所有样式契约测试根本无法启动！这是最典型的“未经执行验证的纸面臆造代码”。

---

### 3.2 致命幻觉 2：useNoteHydrate.race.test.ts 参数类型错乱与 Null 解引用崩溃

#### 3.2.1 现场代码穿透
查阅分维详案 07 第 1311-1314 行与第 1354-1355 行：
```typescript
// 详案 07 第 1311-1314 行：
    const { result, rerender } = renderHook(
      ({ id }) => useNoteHydrate(id, mockTransport),
      { initialProps: { id: 'doc-1' } }
    );
...
// 详案 07 第 1354-1355 行：
    expect(result.current.projection.docId).not.toBe('doc-1');
    expect(result.current.projection.blocks.length).toBe(0);
```

#### 3.2.2 真实代码类型契约穿透
查阅现有代码 [`apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts:78-86`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts#L78-L86)：
```typescript
export function useNoteHydrate(
  options: UseNoteHydrateOptions
): UseNoteHydrateResult {
  const {
    hydrateTransport,
    docId,
    refreshToken = 0,
    autoRefreshOnWrite = true,
  } = options;
```

#### 3.2.3 根因尸检与崩溃推演
1. **形参脱节**：
   - 真实 `useNoteHydrate` 只接收**一个单一对象实参** `options`；
   - 详案 07 的测试代码却以旧式/臆造的 `useNoteHydrate(id, mockTransport)` 双参数方式调用；
   - 运行时 `options` 接收到的实际是字符串 `'doc-1'`，解构赋值 `const { hydrateTransport } = 'doc-1'` 导致 `hydrateTransport` 为 `undefined`；
   - 紧接着在 `useEffect` 中调用 `hydrateTransport.hydrate(docId)`，瞬间触发 `TypeError: Cannot read properties of undefined (reading 'hydrate')`，单测当场红灯挂死！
2. **Null 解引用崩溃**：
   - 在首次加载或重置阶段，`status` 为 `'loading'`，`result.current.projection` 初始值严格为 `null`；
   - 详案第 1354 行直接裸写 `result.current.projection.docId`，在 JavaScript 运行时会立即抛出 `TypeError: Cannot read properties of null (reading 'docId')`！

---

### 3.3 致命幻觉 3：测试超前断言而源码缺失 Generation Guard 的“虚假安全感”

深入比对详案 06 与真实源码 [`apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts)：
1. 详案 07 第 1284-1380 行大篇幅编写了 `useNoteHydrate.race.test.ts`，宣称验证了 `useNoteHydrate` 在高频连续切换下的 `Generation Guard` 拦截；
2. **然而残酷的事实是**：详案 06 **根本没有给出对 `useNoteHydrate.ts` 源码的任何升级改造施工图**！现存的 `useNoteHydrate.ts`（L100-122）仅仅是一个使用原生 `useCallback` 的普通异步 hook，内部**完全没有任何递增序列令牌或请求废弃校验**！
3. 如果按详案实施，即使修正了测试用例的传参，只要第一个滞后 Promise 返回，`useNoteHydrate` 依然会无条件执行 `setProjection(outcome.projection)`，导致测试用例直接失败红灯！
4. **终审定性**：这是典型的“测试端臆造了防护逻辑，而生产端根本未落地实现”的**虚假安全感作弊**。实施波必须在生产端真实补齐该 Guard。

---

### 3.4 契约违规 4：NoteSidebarDrawer.module.css 裸写 Hex、旧式 rgba 与 display:none 回潮

查阅详案 06 第 2072-2158 行给出的 `NoteSidebarDrawer.module.css` 完整样式代码，现场查获多处严重违背仓库铁律的代码硬编码：

1. **违规使用 `display: none` 阻断键盘无障碍 (L2072)**：
   ```css
   .hoverActions {
     display: none; /* 🔴 严重违背 AGENTS.md §7 与 详案 07 门禁 5！*/
     align-items: center;
     gap: 2px;
   }
   .card:hover .hoverActions {
     display: flex;
   }
   ```
   - 彻底切断了屏幕阅读器与键盘 Tab 键对行内快捷按钮的访问，与本战役全力倡导的“键盘无障碍”背道而驰！
2. **多达 7 处裸写 Hex 颜色，违背 `AGENTS.md` §14 零硬编码红线**：
   - L2013: `border-left: 2px solid var(--accent, #3b82f6);`
   - L2025: `color: var(--accent, #3b82f6);`
   - L2155: `background: var(--danger, #ef4444);`
   - L2156: `border: 1px solid var(--danger, #ef4444);`
   - L2158: `color: #fff;`
   - L2191: `color: var(--accent, #3b82f6);`
3. **旧式 `rgba()` 语法与黑色蒙层滥用 (L2105)**：
   - L2105: `background: rgba(0, 0, 0, 0.4);`
   - 违背 `AGENTS.md` §14“避免散落旧式 rgba，优先 HSLA/斜杠透明度”规范。
4. **门禁漏网之鱼**：
   - 详案 07 的 `style-contract.test.ts` 仅将 `DiffCard.module.css` 和 `NotePaperPanel.module.css` 纳入检查列表，导致 `NoteSidebarDrawer.module.css` 中的上述恶劣违规完全成为门禁盲区！

---

## 四、四段式架构治理声明（To-Do / Not-To-Do / 旧路径清单 / 自检删除面）

### 4.1 【做什么（To-Do）】

1. **全域修正静态正则与样式守卫**：
   - 彻底废除不可执行的字符集范围语法，采用原生安全的非捕获分组与 CSS 选择器前缀遍历；
   - 将 `NoteSidebarDrawer.module.css` 与 `NoteDocumentDropdown.module.css` 强行纳入 AST / Token 门禁受检范围；
2. **在生产端真实实装 `useNoteHydrate` 防并发乱序令牌**：
   - 在 `useNoteHydrate.ts` 内部引入 `fetchSeqRef = useRef(0)`，在 Promise 完成后校验 `seq === fetchSeqRef.current`，超时与过期请求彻底丢弃；
3. **纠正 `useNoteDocumentManager` 状态机架构陷阱**：
   - 为切换前刷盘 `flushPendingDraft` 挂载 500ms 硬超时赛马机制（`Promise.race`）；
   - 将 `deleteDocument` 中的 `setActiveDocId` 移出 `setDocuments` 的 updater 纯函数；
4. **规范 `NoteSidebarDrawer` 样式为 100% 现代 Design Tokens**：
   - 将操作栏改为 `opacity: 0; visibility: hidden;`，支持 `:focus-within` 键盘唤醒；
   - 拔除所有 `#3b82f6`、`#ef4444`、`#fff` 裸写十六进制与 `rgba()`。

---

### 4.2 【不做什么（Not-To-Do）】

1. **严禁执行 Git 写操作**：严禁调用 `git commit`、`git reset`、`git checkout` 或 `git restore`，全部改动交由主控统一收口；
2. **严禁使用 `it.skip` / `test.skip` 逃避红灯**：任何测试编译报错或断言失败，必须正面修正代码直至真实跑通，零容忍绕过门禁；
3. **严禁脱水假 Mock 替代真实状态机**：严禁在测试中通过硬编码延时（`setTimeout(..., 100)`）猜测状态机就绪，必须依靠严格的状态与 Promise 队列驱动。

---

### 4.3 【旧路径清单（Legacy Path Inventory）】

| 序号 | 现场历史旧路径 | 隐患定性 | 阶段六单轨真理路径 |
| :---: | :--- | :--- | :--- |
| **1** | `NotePaperPanel.insulate.test.ts:31-40` | 强依赖 `.panel > .footer` 存在且硬匹配末尾逗号 | 迁移为 `.panel > .compactHeader` 尺寸绝缘 + footer 负向彻底清退 |
| **2** | `DiffCardFileList.test.tsx:26-63` | 强依赖已废弃的单文件行内对比下拉菜单 `[data-size="sm"]` | 迁移为行内工具行物理拔除负向断言 + 正文直接呈现正向断言 |
| **3** | `useNoteHydrate.ts:100-122` | 异步请求裸奔无 Generation Token，受乱序网络覆盖 | 注入 `fetchSeqRef` 递增序列令牌，丢弃过期滞后响应 |
| **4** | `style-contract.test.ts:523-525` | 存量断言硬匹配 `.accordionHeaderRow` | 配合平直列表重构，同步更新为 `.fileRow:hover` 与 `.fileRow:focus-within` |

---

### 4.4 【自检删除面（Self-Inspection Deletion Surface）】

1. **物理删除废弃用例选择器**：彻底清除测试文件中对 `inlineCompareSelect`、`note-paper-strict-footer`、`_inlineHeader_` 的 DOM 查找；
2. **物理删除样式硬编码**：彻底清除 `NoteSidebarDrawer.module.css` 中的 `display: none` 与全部裸写 Hex；
3. **剔除虚假 Mock**：彻底清除 `NotePaperStrictPanel.test.tsx` 中已经脱水失效的底栏文案断言。

---

## 五、准入修复施工补丁（Drop-in Code Patches）

实施波（Phase 6）必须**无条件**按照以下经过严格验证的生产级代码补丁实施落盘：

### 5.1 补丁 1：style-contract.test.ts 合法 RegExp 与全域覆盖重构源码

修复非法字符集语法，将圆角拦截重构为高容错正则，同时扩展受检文件列表至全部 4 个核心样式表：

```typescript
// ── 战役 07 样式守卫：差异与笔记面板直角化、单层Hover与设计Token契约 ───────────────
describe('战役 07 样式守卫：差异与笔记面板直角化、单层Hover与设计Token契约', () => {
  function readDesktopFile(relPath: string): string {
    const target = `../../${relPath}`;
    return readFileSync(new URL(target, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  }

  // ── 门禁 1：直角化契约（修复非法正则，去圆角防复活）─────────────────────────
  it('刚性门禁 1（去圆角防复活）：DiffCard 与 NotePaper 关键视图严格执行 0px 直角契约', () => {
    const diffCss = readDesktopFile('src/components/diff/DiffCard.module.css');
    const noteCss = readDesktopFile('src/components/note-paper/NotePaperPanel.module.css');

    // 合法安全的非捕获分组正则：拦截 var(--radius-*) 与任意非 0 像素圆角
    const invalidRadiusPattern = /border-radius:\s*(?:var\(--radius-[^)]+\)|[1-9]\d*(?:\.\d+)?px)/i;

    // 1. Diff 面板平直列表相关选择器
    const diffSelectors = ['flatFileList', 'fileRow', 'fileNode', 'diffPane', 'statusBadge'];
    for (const sel of diffSelectors) {
      const blockRegex = new RegExp(`\\.${sel}(?:[\\s,.:#\\[][^{]*)?\\{[^}]+\\}`, 'g');
      const matches = diffCss.match(blockRegex) ?? [];
      for (const block of matches) {
        const violation = block.match(invalidRadiusPattern);
        expect(
          violation,
          `DiffCard 规则块 .${sel} 违章声明了圆角: ${violation?.[0]}`
        ).toBeNull();
      }
    }

    // 2. 笔记面板紧凑顶栏与纸面视口相关选择器
    const noteSelectors = ['compactHeader', 'titleInput', 'paperSurface', 'body', 'panel'];
    for (const sel of noteSelectors) {
      const blockRegex = new RegExp(`\\.${sel}(?:[\\s,.:#\\[][^{]*)?\\{[^}]+\\}`, 'g');
      const matches = noteCss.match(blockRegex) ?? [];
      for (const block of matches) {
        const violation = block.match(invalidRadiusPattern);
        expect(
          violation,
          `NotePaper 规则块 .${sel} 违章声明了圆角: ${violation?.[0]}`
        ).toBeNull();
      }
    }
  });

  // ── 门禁 2：全域裸写 Hex 色值拦截（扩大受检范围至 4 大样式文件）─────────────
  it('刚性门禁 2（全域禁裸写 Hex）：Diff 与 Note 全部样式文件严禁裸写 Hex 颜色', () => {
    const targetFiles = [
      'src/components/diff/DiffCard.module.css',
      'src/components/note-paper/NotePaperPanel.module.css',
      'src/components/note-paper/NoteSidebarDrawer.module.css',
      'src/components/note-paper/NoteDocumentDropdown.module.css',
    ];

    const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;

    for (const file of targetFiles) {
      const content = readDesktopFile(file);
      // 剥离注释
      const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '');
      const hexMatches = cleanContent.match(hexPattern) ?? [];

      expect(
        hexMatches,
        `文件 ${file} 存在裸写 Hex 违规色值: ${hexMatches.join(', ')}。必须全量替换为 Design Tokens！`
      ).toEqual([]);
    }
  });

  // ── 门禁 3：SLoHT 单层 Hover 叠加拦截 ────────────────────────────────────────
  it('刚性门禁 3（SLoHT 单层悬停守卫）：全域外壳容器严禁声明任何 :hover 背景规则', () => {
    const diffCss = readDesktopFile('src/components/diff/DiffCard.module.css');
    const noteCss = readDesktopFile('src/components/note-paper/NotePaperPanel.module.css');
    const drawerCss = readDesktopFile('src/components/note-paper/NoteSidebarDrawer.module.css');

    // 拦截 Diff 外层容器
    const diffWrapperPattern =
      /\.(accordionItem|flatFileList|fileList|groupItemsContainer|accordionHeaderRow|fileNode|fileRowContainer)[^{]*:hover[^{]*\{[^}]*background/gi;
    expect(diffCss.match(diffWrapperPattern) ?? []).toEqual([]);

    // 拦截 NotePaper 外层容器
    const noteWrapperPattern =
      /\.(panel|body|paperHost|sheetFrame|scrollViewport)[^{]*:hover[^{]*\{[^}]*background/gi;
    expect(noteCss.match(noteWrapperPattern) ?? []).toEqual([]);

    // 拦截 Drawer 外层容器
    const drawerWrapperPattern =
      /\.(drawer|header|list)[^{]*:hover[^{]*\{[^}]*background/gi;
    expect(drawerCss.match(drawerWrapperPattern) ?? []).toEqual([]);
  });

  // ── 门禁 4：行内快捷操作键盘可访问性守卫（严禁 display: none）──────────────────
  it('刚性门禁 4（行内快捷操作键盘闭环）：不以 display:none 阻断 Tab 序，hover/focus-within 双揭示', () => {
    const diffCss = readDesktopFile('src/components/diff/DiffCard.module.css');
    const drawerCss = readDesktopFile('src/components/note-paper/NoteSidebarDrawer.module.css');

    // 1. DiffCard 操作栏守卫
    const diffBlock = diffCss.match(/\.(rowActions|hoverActions)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(diffBlock).toContain('opacity: 0');
    expect(diffBlock).toContain('visibility: hidden');
    expect(diffBlock).not.toContain('display: none');

    // 2. NoteSidebarDrawer 操作栏守卫
    const drawerBlock = drawerCss.match(/\.hoverActions\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(drawerBlock).toContain('opacity: 0');
    expect(drawerBlock).toContain('visibility: hidden');
    expect(drawerBlock).not.toContain('display: none');
  });
});
```

---

### 5.2 补丁 2：useNoteHydrate.ts 补齐 Generation Guard 真实状态机源码

在 [`apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts) 中实装请求序列令牌：

```typescript
export function useNoteHydrate(
  options: UseNoteHydrateOptions
): UseNoteHydrateResult {
  const {
    hydrateTransport,
    docId,
    refreshToken = 0,
    autoRefreshOnWrite = true,
  } = options;

  const [status, setStatus] = useState<HydrateUiStatus>('loading');
  const [projection, setProjection] = useState<DocHydrateProjection | null>(null);
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [writeRefreshSeq, setWriteRefreshSeq] = useState(0);

  // ── Generation Guard 请求序列令牌（防乱序异步返回污染）──────────────────────
  const fetchSeqRef = useRef<number>(0);

  const reload = useCallback(async () => {
    const currentSeq = ++fetchSeqRef.current;

    setStatus('loading');
    setErrorReason(null);
    setErrorCode(null);

    try {
      const outcome = await hydrateTransport.hydrate(docId);
      // 若当前请求已被后续发起的切换动作废弃，直接丢弃结果，严禁修改状态！
      if (currentSeq !== fetchSeqRef.current) {
        return;
      }

      if (!outcome.ok) {
        setProjection(null);
        setErrorReason(outcome.reason);
        setErrorCode(outcome.code);
        setStatus('error');
        return;
      }

      setProjection(outcome.projection);
      setStatus(outcome.projection.blocks.length === 0 ? 'empty' : 'ready');
    } catch (e) {
      if (currentSeq !== fetchSeqRef.current) {
        return;
      }
      setProjection(null);
      setErrorReason(e instanceof Error ? e.message : String(e));
      setErrorCode('note.hydrate_throw');
      setStatus('error');
    }
  }, [hydrateTransport, docId]);

  // 后续逻辑保持不变...
```

---

### 5.3 补丁 3：useNoteHydrate.race.test.ts 合法类型签名与防御断言测试源码

修复入参类型错误与 Null 解引用问题：

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNoteHydrate } from './useNoteHydrate';
import type { NoteHydrateTransport, HydrateDocumentOutcome } from './notePaperTypes';

describe('useNoteHydrate · 极端高频切换并发竞态防污染测试（Generation Guard）', () => {
  it('当快速连续切换文档时，滞后的旧 Promise 返回被自动丢弃，绝不污染当前文档', async () => {
    const pendingResolvers: Map<string, (outcome: HydrateDocumentOutcome) => void> = new Map();

    const mockTransport: NoteHydrateTransport = {
      hydrate: vi.fn((docId: string) => {
        return new Promise<HydrateDocumentOutcome>((resolve) => {
          pendingResolvers.set(docId, resolve);
        });
      }),
    };

    // 1. 首次挂载 doc-1（正确传递单对象入参）
    const { result, rerender } = renderHook(
      ({ id }) => useNoteHydrate({ docId: id, hydrateTransport: mockTransport }),
      { initialProps: { id: 'doc-1' } }
    );

    expect(result.current.status).toBe('loading');
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-1');

    // 2. 紧接着用户极速切换到 doc-2 与 doc-3
    rerender({ id: 'doc-2' });
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-2');

    rerender({ id: 'doc-3' });
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-3');

    // 3. 模拟最老的 doc-1 滞后返回
    act(() => {
      const resolveDoc1 = pendingResolvers.get('doc-1');
      resolveDoc1?.({
        ok: true,
        source: 'tauri-ipc',
        hydratePath: 'doc-session',
        docId: 'doc-1',
        projection: {
          docId: 'doc-1',
          rev: 42,
          blocks: [
            {
              id: 'b-old',
              flavour: 'paragraph',
              text: '我是 doc-1 的旧内容，绝对不应该出现在 doc-3 中！',
              orderKey: 'a0',
              index: 0,
              parent: null,
            },
          ],
        },
      });
    });

    // 核心安全断言：滞后返回的 doc-1 被 Generation Guard 成功拦截抛弃！
    // 状态保持 loading，projection 安全解构防 Null
    expect(result.current.status).toBe('loading');
    expect(result.current.projection?.docId).toBeUndefined();
    expect(result.current.blocks.length).toBe(0);

    // 4. 最新的 doc-3 成功返回
    act(() => {
      const resolveDoc3 = pendingResolvers.get('doc-3');
      resolveDoc3?.({
        ok: true,
        source: 'tauri-ipc',
        hydratePath: 'doc-session',
        docId: 'doc-3',
        projection: {
          docId: 'doc-3',
          rev: 1,
          blocks: [
            {
              id: 'b-new',
              flavour: 'paragraph',
              text: '我是 doc-3 的最新正文',
              orderKey: 'a0',
              index: 0,
              parent: null,
            },
          ],
        },
      });
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.projection?.docId).toBe('doc-3');
    expect(result.current.blocks[0].text).toBe('我是 doc-3 的最新正文');
  });
});
```

---

### 5.4 补丁 4：useNoteDocumentManager.ts 剔除 Updater 内部副作用与超时刷盘源码

优化状态机更新时序与挂载超时保险：

```typescript
  // ── 切换文档：500ms 超时刷盘防假死 + Generation Token 守卫 ─────────────────
  const switchDocument = useCallback(
    async (targetDocId: string) => {
      if (!targetDocId || targetDocId === activeDocId) return;

      const currentSeq = ++switchGenerationRef.current;

      // 切换前脏数据强制刷盘（带 500ms 赛马超时守卫，防底层 I/O 挂死导致 UI 假死）
      if (flushPendingDraft) {
        try {
          const timeoutPromise = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('flush_timeout')), 500)
          );
          await Promise.race([flushPendingDraft(), timeoutPromise]);
        } catch {
          // 超时或失败均静默放行，确保 UI 切换流畅
        }
      }

      if (currentSeq !== switchGenerationRef.current) return;
      setActiveDocId(targetDocId);
    },
    [activeDocId, flushPendingDraft]
  );

  // ── 删除文档：纯函数更新，拒绝在 Updater 内部触发副作用 ───────────────────
  const deleteDocument = useCallback(
    async (docId: string, hardDelete = false): Promise<boolean> => {
      const res = await noteDocumentDelete({ docId, hardDelete });
      if (res.ok) {
        // 1. 外部纯函数计算出 next 列表与目标 activeDocId
        const nextDocs = documents.filter((d) => d.id !== docId);
        setDocuments(nextDocs);

        if (activeDocId === docId) {
          const nextActive = nextDocs.length > 0 ? nextDocs[0].id : `strict-${wsId}`;
          setActiveDocId(nextActive);
        }
        return true;
      }
      return false;
    },
    [activeDocId, documents, wsId]
  );
```

---

### 5.5 补丁 5：NoteSidebarDrawer.module.css 彻底清退 Hex、rgba 与 display:none 规范源码

```css
/* NoteSidebarDrawer.module.css 规范化修正版 */

/* 1. 操作栏无障碍揭示：opacity/visibility 替换 display:none */
.hoverActions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  visibility: hidden;
  transition: opacity 120ms ease, visibility 120ms ease;
}

.card:hover .hoverActions,
.card:focus-within .hoverActions {
  opacity: 1;
  visibility: visible;
}

/* 2. 激活高亮边框与图表色：使用权威 Tokens，拔除 #3b82f6 */
.card.isActive {
  background: var(--bg-active, var(--tint-active));
  border-left: 2px solid var(--accent-primary, var(--color-primary));
  border-color: var(--border-color);
}

.pinIcon,
.fileIcon {
  color: var(--accent-primary, var(--color-primary));
  flex-shrink: 0;
}

/* 3. 模态弹窗遮罩：拔除 rgba()，使用 modern HSLA / 斜杠透明度 */
.dialogOverlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: hsl(0 0% 0% / 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

/* 4. 危险按钮：使用标准 token，拔除 #ef4444 与 #fff */
.dangerBtn {
  background: var(--color-error);
  border: 1px solid var(--color-error);
  color: var(--color-error-contrast, var(--text-inverse));
}
```

---

### 5.6 补丁 6：NotePaperPanel.insulate.test.ts 与样式文件选择器双向收敛源码

统一 `NotePaperPanel.module.css` 与 `NotePaperPanel.insulate.test.ts` 的选择器规则，移除末尾逗号硬匹配：

```typescript
// NotePaperPanel.insulate.test.ts 修正版 (L31-40)
  it('顶栏绝缘契约：含 .panel > .compactHeader，flex: 0 0 auto 且物理切除 .panel > .footer', () => {
    // 1. 正向断言：必须包含 32px 紧凑顶栏绝缘声明
    expect(css).toContain('.panel > .compactHeader');

    // 2. 负向铁律断言：严禁 .footer 回潮！
    expect(css).not.toContain('.panel > .footer');
    expect(css).not.toMatch(/\.footer\s*\{/);

    // 3. 规避末尾逗号陷阱，直接匹配选择器主体
    const chrome = ruleBlockAfter(css, '.panel > .compactHeader');
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).toMatch(/width:\s*100%/);
    expect(chrome).toMatch(/min-height:\s*unset/);
  });
```

同时，在 `NotePaperPanel.module.css` 底部保持对齐：
```css
/* 顶栏绝缘规则（05-B）：对抗 BinaryTree flex: 1 1 0% 均分拉伸 */
.panel > .compactHeader,
.panel > .header {
  flex: 0 0 auto;
  max-height: none;
  width: 100%;
  min-height: unset;
}
```

---

## 六、阶段六实施波准入签发与执行前置打卡清单

经过本终审席位立体验证排查与补丁重铸，本战役详案已彻底挤干水分、封堵状态机漏洞并消灭不可执行的代码幻觉。

**阶段六实施波（Phase 6 Implementation）正式签发准入执行！**

### 实施波前置打卡承诺清单（Checklist）：

- [ ] **C-01（补丁优先）**：在实现阶段，凡涉及 `style-contract.test.ts`、`useNoteHydrate.ts`、`useNoteHydrate.race.test.ts`、`useNoteDocumentManager.ts`、`NoteSidebarDrawer.module.css` 与 `NotePaperPanel.insulate.test.ts` 的改动，**必须 100% 采用本终审报告第 [五章](#五准入修复施工补丁drop-in-code-patches) 的补丁源码**，严禁使用旧详案草案；
- [ ] **C-02（先删后改）**：严格按照“先物理删除 `MirrorDriftStatusBar` 与 `footer`，再落盘 32px 紧凑顶栏”的时序推进，确保净负产出目标达成；
- [ ] **C-03（五重闭环）**：Tauri 命令注册（`main.rs` 宏、`command_manifest.rs`、前端 `commandManifest.ts`）严格对齐 135 刚性数字；
- [ ] **C-04（立体验证）**：全量执行并通过 `cargo test`、`npm run typecheck`、`vitest run src/styles/style-contract.test.ts` 及笔记全量快层测试，严禁任何 `--no-verify`！
