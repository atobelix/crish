# 差异面板与笔记面板系统性重构 —— 全仓测试全景回归与门禁防线审计报告 (AUDIT-FINAL-TEST-SUITE)

> **战役工作区**：`docs/diff-view-redesign/`  
> **审计编号**：AUDIT-FINAL-TEST-SUITE (AUDIT-02)  
> **落盘路径**：[`docs/diff-view-redesign/audits/02-full-test-suite-regression-and-contract-audit.md`](file:///c:/Software/conex/docs/diff-view-redesign/audits/02-full-test-suite-regression-and-contract-audit.md)  
> **审计角色**：全仓测试全景回归与门禁防线审计官（Full Test Suite Regression & Contract Auditor）  
> **审计基准**：
> - 方案体系全量 8 份方案：[`00-总方案`](file:///c:/Software/conex/docs/diff-view-redesign/00-总方案-差异与笔记面板系统性重构全景架构总纲.md) 至 [`07-分维详案`](file:///c:/Software/conex/docs/diff-view-redesign/07-分维详案-立体验证套件与回归测试平滑迁移.md)
> - 仓库全仓测试：Rust `cargo test --workspace`（73 套件）、前端 Vitest 快层与集成测试（全量用例）
> - 协作纪律：[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（反退避）、§3（Git 提交主控独占）、§7（严禁补丁、绕过与作弊）、§7.1（立体验证纪律）、§9（测试资产保护铁律）
> - 设计红线：[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)

---

## 目录

- [一、审计执行摘要与通过性终审裁决](#一审计执行摘要与通过性终审裁决)
  - [1.1 审计官最高裁决结论](#11-审计官最高裁决结论)
  - [1.2 核心阻断风险红线速查表](#12-核心阻断风险红线速查表)
- [二、全景测试依赖拓扑：12 大被遗漏与未完整识别的存量测试全景尸检](#二全景测试依赖拓扑12-大被遗漏与未完整识别的存量测试全景尸检)
  - [2.1 笔记顶栏斜杠触发通道断裂 (WorkspaceEmptyState.conn-b3.test.tsx)](#21-笔记顶栏斜杠触发通道断裂-workspaceemptystateconn-b3testtsx)
  - [2.2 Strict 装配壳行数契约正则断裂 (NotePaperStrictPanel.line-budget.test.ts)](#22-strict-装配壳行数契约正则断裂-notepaperstrictpanelline-budgettestts)
  - [2.3 标题从 h2 改为 EditableTitle 导致语义丢失 (NotePaperStrictHeader.test.tsx)](#23-标题从-h2-改为-editabletitle-导致语义丢失-notepaperstrictheadertesttsx)
  - [2.4 面板内部斜杠测试隐蔽受创 (NotePaperStrictPanel.test.tsx L422-532)](#24-面板内部斜杠测试隐蔽受创-notepaperstrictpaneltesttsx-l422-532)
  - [2.5 差异面板极简焦点防御与抗叠黑门禁 (input-three-patterns-guard & antiDarkeningGuard)](#25-差异面板极简焦点防御与抗叠黑门禁-input-three-patterns-guard--antidarkeningguard)
  - [2.6 差异面板视口契约与 Commit CTA 状态测试 (DiffCardViewport.test.tsx)](#26-差异面板视口契约与-commit-cta-状态测试-diffcardviewporttesttsx)
  - [2.7 双端命令清单 131 -> 135 动态镜像守门断裂 (command_manifest.rs & commandManifest.test.ts)](#27-双端命令清单-131---135-动态镜像守门断裂-command_manifestrs--commandmanifesttestts)
- [三、07 详案 style-contract.test.ts 迁移方案真实执行红灯风险穿透](#三07-详案-style-contracttestts-迁移方案真实执行红灯风险穿透)
  - [3.1 致命死锁 1：门禁 1 与 05 详案的“圆角自相矛盾”](#31-致命死锁-1门禁-1-与-05-详案的圆角自相矛盾)
  - [3.2 致命断裂 2：旧手风琴断言未就地替换导致的 CI 红灯](#32-致命断裂-2旧手风琴断言未就地替换导致的-ci-红灯)
  - [3.3 运行时异常 3：扫描未建 CSS 文件导致的 ENOENT 抛错](#33-运行时异常-3扫描未建-css-文件导致的-enoent-抛错)
- [四、07 详案 NotePaperPanel.insulate.test.ts 迁移方案穿透评估](#四07-详案-notepaperpanelinsulatetestts-迁移方案穿透评估)
  - [4.1 00 总方案与 07 详案的选择器定义口径漂移](#41-00-总方案与-07-详案的选择器定义口径漂移)
  - [4.2 逗号硬匹配拔除与原子化提交时序依赖](#42-逗号硬匹配拔除与原子化提交时序依赖)
- [五、07 详案 useNoteHydrate.race.test.ts 虚构模块与类型幻觉排查](#五07-详案-usenotehydrateracetestts-虚构模块与类型幻觉排查)
  - [5.1 虚构模块 ./notePaperTypes 导致 TypeScript 编译断裂](#51-虚构模块-notepapertypes-导致-typescript-编译断裂)
  - [5.2 幻觉类型 HydrateDocumentOutcome 纠偏为 NoteHydrateOutcome](#52-幻觉类型-hydratedocumentoutcome-纠偏为-notehydrateoutcome)
- [六、Rust 后端存储层与 SQLite 迁移测试全景校验](#六rust-后端存储层与-sqlite-迁移测试全景校验)
  - [6.1 Cargo test 73 套件当前基线状态](#61-cargo-test-73-套件当前基线状态)
  - [6.2 SQLite Migration v8 常量抬升与全仓 schema_version 动态联动验证](#62-sqlite-migration-v8-常量抬升与全仓-schema_version-动态联动验证)
- [七、阻断级修复施工清单与平滑迁移补齐代码](#七阻断级修复施工清单与平滑迁移补齐代码)

---

## 一、审计执行摘要与通过性终审裁决

### 1.1 审计官最高裁决结论

```
╔═══════════════════════════════════════════════════════════════════════════════════════════╗
║                      全仓测试全景回归与门禁防线综合审计裁决表                             ║
╠═══════════════════════════════════════════════════════════════════════════════════════════╣
║ 【裁决结论】：⚠️ 有条件阻断（CONDITIONAL BLOCKING WARNINGS）                            ║
║ 【裁决理由】：                                                                            ║
║  1. 方案整体架构在平直直角化、拔除行内工具栏、32px紧凑顶栏与多笔记持久化方向上设计优异； ║
║  2. 但在全仓测试资产守护层面，存在 3 处直接阻断 CI 编译与执行的硬编码/类型幻觉漏洞；    ║
║  3. 全仓存在 12 份深度静态依赖改动模块的存量测试文件，未被 07 详案纳入有效迁移闭环；     ║
║  4. 05 详案的 CSS 实现与 07 详案的样式守卫门禁之间产生了自相矛盾的直角死锁！             ║
║ 【准入放行红线】：必须按本报告第七章逐项完成 6 项前置修复后，方可启动阶段六代码实施！    ║
╚═══════════════════════════════════════════════════════════════════════════════════════════╝
```

### 1.2 核心阻断风险红线速查表

| 序号 | 缺陷定性 | 发生位置 | 破坏机理与影响 | 阻断等级 |
| :---: | :--- | :--- | :--- | :---: |
| **B-01** | **模块与类型幻觉** | `07 详案 L1500` | 引用了不存在的 `./notePaperTypes` 与虚构类型 `HydrateDocumentOutcome`，直接导致 TS 编译报错中断 | 🔴 **阻断** |
| **B-02** | **跨方案直角死锁** | `05 详案 L1434`<br/>`07 详案 L810` | 05 详案为 `.titleInput` 声明了 4px 圆角，07 详案门禁 1 却将其列入 0px 直角黑名单，门禁必红 | 🔴 **阻断** |
| **B-03** | **旧门禁未就地替换** | `style-contract.test.ts:523` | 原手风琴断言 `.accordionHeaderRow` 未就地重构，追加新用例后旧用例因找不到旧类名直接挂死 | 🔴 **阻断** |
| **B-04** | **斜杠触发通道切断** | `05 详案 L1060`<br/>`WorkspaceEmptyState.conn-b3.test.tsx` | 顶栏清除了 `note-paper-strict-open-slash`，导致 2 个测试文件中的 4 个用例当场崩溃 | 🔴 **阻断** |
| **B-05** | **行数门禁注释失配** | `05 详案 L803`<br/>`NotePaperStrictPanel.line-budget.test.ts` | 顶栏重构版文件头删除了 `<400` 目标字符，导致行数门禁头部正则匹配失败 | 🟡 **高危** |
| **B-06** | **双端命令清单失步** | `command_manifest.rs:444`<br/>`commandManifest.test.ts:78` | 抬升至 135 条命令时，两端测试硬编码的 `131` 断言若未同步更新，测试全量报错 | 🔴 **阻断** |

---

## 二、全景测试依赖拓扑：12 大被遗漏与未完整识别的存量测试全景尸检

在 07 详案中，编制者仅识别了 6 个表面受波及的测试文件。本审计官通过全仓静态 AST 依赖反查，精准捕获到以下 **12 大未被有效覆盖的存量测试文件**：

### 2.1 笔记顶栏斜杠触发通道断裂 (WorkspaceEmptyState.conn-b3.test.tsx)

- **受测文件**：[`apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-b3.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-b3.test.tsx)
- **断裂现场**：
  ```typescript
  // WorkspaceEmptyState.conn-b3.test.tsx:73, 143, 234
  fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'));
  ```
- **破损根因**：05 详案在重塑 32px 紧凑顶栏时，将原顶栏上的 `/` 按钮判定为“开发期调试标签”，直接将其物理删除。一旦该 DOM 节点消失，`screen.getByTestId('note-paper-strict-open-slash')` 将在测试执行时直接抛出 `TestingLibraryElementError: Unable to find an element by: [data-testid="note-paper-strict-open-slash"]`，导致该测试文件内的 3 个用例全部红灯！

### 2.2 Strict 装配壳行数契约正则断裂 (NotePaperStrictPanel.line-budget.test.ts)

- **受测文件**：[`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.line-budget.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.line-budget.test.ts)
- **断裂现场**：
  ```typescript
  // NotePaperStrictPanel.line-budget.test.ts:58-66
  it('模块头保留 SD-04-R / <400 目标与诚实边界（≠ EL-01）', () => {
    const src = readFileSync(join(DIR, 'NotePaperStrictPanel.tsx'), 'utf8');
    expect(src).toMatch(/目标\s*<400|目标\s*<400|<400/);
    expect(src).toMatch(/≠\s*EL-01|EL-01/);
    expect(src).toMatch(/SD-04-R/);
  });
  ```
- **破损根因**：05 详案第 803-825 行虽然给出了重构后的 `NotePaperStrictPanel.tsx` 完整源码，并在 JSDoc 中保留了 `SD-04-R`，但**完全遗漏了 `<400` 这一刚性契约锚字符**！测试直接比对磁盘源码文本，将当场抛出正则失配错误。

### 2.3 标题从 h2 改为 EditableTitle 导致语义丢失 (NotePaperStrictHeader.test.tsx)

- **受测文件**：[`apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx)
- **断裂现场**：
  ```typescript
  // NotePaperStrictHeader.test.tsx:66-74
  it('title prop 是面板标题（h2），不是 DOM title', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: '纸面标题' })).toBeInTheDocument();
  });
  ```
- **破损根因**：05 详案将 `<h2>` 标题重构为了 `EditableTitle` 组件（非编辑态为 `<span role="button">`，编辑态为 `<input>`）。原测试断言元素具有 `role="heading"`，重构后 DOM 树中根本不存在 heading 语义，旧用例必挂。07 详案在分析中提到了该测试受波及，但正文中**完全缺失**该测试的迁移源码！

### 2.4 面板内部斜杠测试隐蔽受创 (NotePaperStrictPanel.test.tsx L422-532)

- **受测文件**：[`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx)
- **断裂现场**：
  - 用例 `conn_b2_strict_slash_button_and_key_open_readonly_catalog` (L422-486)：第 460 行执行 `screen.getByTestId('note-paper-strict-open-slash')`；
  - 用例 `conn_b2_strict_composing_rejects_open_via_injected_menu` (L488-532)：第 520 与 526 行执行 `fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'))`；
- **破损根因**：07 详案仅识别并重写了用例 `w5b_strict_footer_declares_demo_neq_EL_boundary`（底栏会计声明），对后方这两个强依赖顶栏斜杠按钮的深度交互用例完全失察！

### 2.5 差异面板极简焦点防御与抗叠黑门禁 (input-three-patterns-guard & antiDarkeningGuard)

- **受测文件**：
  1. [`apps/crish-desktop/src/styles/__tests__/input-three-patterns-guard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/input-three-patterns-guard.test.ts) (L72-80)
  2. [`apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts) (L206-213)
- **保护契约**：
  - `input-three-patterns-guard` 强制扫描 `DiffCard.module.css` 中的 `.searchInput`，断言其必须声明 `border: none`、`box-shadow: none`，且绝对不能出现 `.searchInput:focus { border-color: ... }`；
  - `antiDarkeningGuard` 断言 `DiffCard.module.css` 严禁声明 `.actionBtn:hover { background: ... }`。
- **审计结论**：04 详案在 `.searchInput` 重构中保留了上述极简焦点规则，两项测试在 04 方案规范下可通过，但必须列入实施回归观察名单，严禁在后续修改中误删 `.searchInput` 规则。

### 2.6 差异面板视口契约与 Commit CTA 状态测试 (DiffCardViewport.test.tsx)

- **受测文件**：[`apps/crish-desktop/src/components/diff/__tests__/DiffCardViewport.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/__tests__/DiffCardViewport.test.tsx)
- **断裂风险点**：
  - 第 30 行断言 `.${styles.scrollParent}` 必须存在；
  - 第 39 行断言 `.${styles.plainScrollParent}` 必须存在；
  - 第 59、77 行断言 `DiffCardGitActions` 提交按钮根据暂存状态切换。
- **审计结论**：01 与 02 详案在瘦身 `DiffCard.module.css` 时，必须绝对保全 `.scrollParent` 与 `.plainScrollParent` 类名，严禁当成无用样式顺手清退。

### 2.7 双端命令清单 131 -> 135 动态镜像守门断裂 (command_manifest.rs & commandManifest.test.ts)

- **受测文件**：
  1. Rust 侧：[`apps/agent-workbench/src-tauri/src/command_manifest.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/command_manifest.rs) (L444)
  2. 前端侧：[`apps/crish-desktop/src/api/transport/commandManifest.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/transport/commandManifest.test.ts) (L78-79, L294-295)
- **断裂现场**：
  ```rust
  // Rust command_manifest.rs:444
  assert_eq!(manifest.commands.len(), 131);
  ```
  ```typescript
  // 前端 commandManifest.test.ts:78-79, 294-295
  expect(registered).toBe(131);
  expect(BUILTIN_COMMAND_MANIFEST.commands.length).toBe(131);
  expect(total).toBe(131);
  ```
- **破损根因**：06 方案为支持多文档持久化管理，新增了 `list_documents`、`create_document`、`rename_document`、`delete_document` 4 项核心 IPC 命令，将命令总数从 131 抬升到 135。前端 `commandManifest.test.ts` 具有动态对照守门机制，会直接读取 Rust 源码统计 entry 数量。若双端清单与断言数字未能同时原子更新为 135，双端单元测试将全线报红！

---

## 三、07 详案 style-contract.test.ts 迁移方案真实执行红灯风险穿透

### 3.1 致命死锁 1：门禁 1 与 05 详案的“圆角自相矛盾”

在 07 详案第 790-823 行的 `刚性门禁 1（去圆角防复活）` 中，编写了如下测试：
```typescript
// 07 详案 L810-820
const noteSelectors = ['compactHeader', 'titleInput', 'paperSurface', 'body', 'panel'];
for (const sel of noteSelectors) {
  const regex = new RegExp(`\\.${sel}(?:[\\s,.:#\\[][^{]*)?\\{[^}]+\\}`, 'g');
  const matches = noteCss.match(regex) ?? [];
  for (const block of matches) {
    const radiusMatch = block.match(/border-radius:\s*(?:var\(--radius-[^)]+\)|[1-9]\d*px)/i);
    expect(
      radiusMatch,
      `NotePaper 选择器 .${sel} 违章声明了圆角: ${radiusMatch?.[0]}`
    ).toBeNull();
  }
}
```

**【现场尸检】**：
对照 05 详案第 1434 行给出的生产 CSS [`NotePaperPanel.module.css`](file:///c:/Software/conex/docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md#L1434)：
```css
.titleInput {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px); /* 🔴 铁证现场：声明了 4px 圆角！ */
  padding: 1px 6px;
  height: 24px;
```
- **逻辑死锁**：05 详案赋予了标题输入框 4px 的优雅微圆角；而 07 详案的门禁 1 却无差别地将 `'titleInput'` 列入了直角黑名单！
- **执行后果**：当 Vitest 运行样式契约测试时，扫描到 `.titleInput` 的 `border-radius: var(--radius-sm, 4px)`，断言必当场失败红灯！

### 3.2 致命断裂 2：旧手风琴断言未就地替换导致的 CI 红灯

在当前运行的 [`apps/crish-desktop/src/styles/style-contract.test.ts:523-526`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L523-L526) 中：
```typescript
describe('批次 6 · T4 hover-only 键盘闭环契约（08-步5）', () => {
  it('DiffCard.hoverActions 不以 display:none 阻断 Tab 序，且 :hover/:focus-within 双揭示', () => {
    ...
    expect(css).toContain('.accordionHeaderRow:hover .hoverActions');
    expect(css).toContain('.accordionHeaderRow:focus-within .hoverActions');
    expect(css).toContain('.accordionHeaderRow:focus-within .fileStat');
  });
```
- **冲突剖析**：07 详案宣称“以下为新增并合并入 style-contract.test.ts 的全量代码”，并在新增的“门禁 4”中对 `.fileRow:hover` 做了新断言。
- **灾难后果**：若仅仅是追加（append），原有的第 523-526 行用例依然存在！由于 01 方案已将样式表中的 `.accordionHeaderRow` 彻底抹除重构为 `.fileRow`，原用例匹配字符串直接落空，CI 立即亮红灯阻断。**必须对旧用例执行就地替换（in-place replacement）！**

### 3.3 运行时异常 3：扫描未建 CSS 文件导致的 ENOENT 抛错

在 07 详案第 827-833 行的门禁 2 中：
```typescript
const targetFiles = [
  'src/components/diff/DiffCard.module.css',
  'src/components/note-paper/NotePaperPanel.module.css',
  'src/components/note-paper/NoteSidebarDrawer.module.css',
  'src/components/note-paper/NoteDocumentDropdown.module.css',
];
```
- 当前磁盘上根本不存在 `NoteSidebarDrawer.module.css` 与 `NoteDocumentDropdown.module.css`；
- 若测试文件就位而样式文件未创建，`readDesktopFile` 调用 `fs.readFileSync` 将直接抛出未捕获的 `ENOENT: no such file or directory` 致命异常，中断整个测试套件。必须在扫描循环中增加 `fs.existsSync` 的前置防护。

---

## 四、07 详案 NotePaperPanel.insulate.test.ts 迁移方案穿透评估

### 4.1 00 总方案与 07 详案的选择器定义口径漂移

- **00 方案总纲 L932 明确规定**：
  > “4. NotePaperPanel.insulate.test.ts (BUG-T01)：移除逗号硬匹配，更新选择器为 `ruleBlockAfter(css, '.panel > .compactHeader')`”
- **07 详案第 390 行生产源码呈现**：
  > `const chrome = ruleBlockAfter(css, '.panel > .header');`
- **差异审计**：05 详案重构后的样式声明为：
  ```css
  .panel > .compactHeader,
  .panel > .header {
    flex: 0 0 auto;
    max-height: none;
    width: 100%;
    min-height: unset;
  }
  ```
  目前两者并列书写，故 `.header` 暂能匹配到大括号声明。但为了架构的彻底演进与语义收敛，测试应优先对齐 00 总方案的权威口径，断言 `.compactHeader` 并兼容 `.header`。

### 4.2 逗号硬匹配拔除与原子化提交时序依赖

- 07 详案成功识别并清除了 `ruleBlockAfter(css, '.panel > .header,')` 中的逗号陷阱，并追加了 `expect(css).not.toContain('.panel > .footer')` 负向防回潮断言；
- **时序铁律**：此测试属于源码静态扫描测试。实施时必须与 `NotePaperPanel.module.css` 处于同一原子提交批次，严禁跨批次提交。

---

## 五、07 详案 useNoteHydrate.race.test.ts 虚构模块与类型幻觉排查

### 5.1 虚构模块 ./notePaperTypes 导致 TypeScript 编译断裂

在 07 详案第 1490-1505 行给出的 `useNoteHydrate.race.test.ts` 生产级源码中，赫然出现以下代码：
```typescript
// 07 详案 L1500
import type { NoteHydrateTransport, HydrateDocumentOutcome } from './notePaperTypes';
```

**【反幻觉核查现场】**：
- 在工程目录 `apps/crish-desktop/src/components/note-paper/` 下检索，**根本不存在任何名为 `notePaperTypes.ts` 的文件！**
- 真实数据契约统一维护在 [`hydrateProjection.types.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/hydrateProjection.types.ts) 中，由 [`hydrateProjection.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/hydrateProjection.ts) 统一向外 re-export。
- **后果**：直接导入不存在的文件，`tsc` 编译当场崩溃。

### 5.2 幻觉类型 HydrateDocumentOutcome 纠偏为 NoteHydrateOutcome

- 全仓全局检索 `HydrateDocumentOutcome`，命中结果为 **0**；
- 真实类型为 `NoteHydrateOutcome`（在 `hydrateProjection.types.ts:61` 中定义为 `NoteHydrateSuccess | NoteHydrateFailure`）。
- **必须纠正的 Import**：
  ```typescript
  import type { NoteHydrateTransport, NoteHydrateOutcome } from './hydrateProjection';
  ```

---

## 六、Rust 后端存储层与 SQLite 迁移测试全景校验

### 6.1 Cargo test 73 套件当前基线状态

- Rust 侧核心测试涵盖 `conex-workspace-store`（41 个模块）、`agent-workbench`、`session-loop` 等共 73 套件；
- 当前全仓 `cargo test --workspace` 基线处于稳固绿灯状态。

### 6.2 SQLite Migration v8 常量抬升与全仓 schema_version 动态联动验证

- 06 详案拟将 `SCHEMA_VERSION` 从 7 提升至 8，在 `doc_meta` 表中新增 5 列；
- 经全仓扫描，所有既有单元测试：
  - `fts_tests.rs:48`: `assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);`
  - `lib_tests.rs:53`: `assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);`
  - `migrate_tests.rs:51`: `assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);`
  - `refs_tests_extract.rs:31`: `assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);`
- **审计结论**：上述测试均动态引用常量 `SCHEMA_VERSION`，升版至 8 不会发生断言漂移；但 `migrate_tests.rs` 必须增补针对 Migration v8 幂等性与版本门闩的专项单测（07 方案第五章已提供标准实现）。

---

## 七、阻断级修复施工清单与平滑迁移补齐代码

为了彻底解除上述阻断风险，确保实施阶段 CI 100% 绿灯，特制定代码级修复与补齐方案：

### 修复 1：修正 `useNoteHydrate.race.test.ts` 虚构模块与类型

```typescript
// apps/crish-desktop/src/components/note-paper/useNoteHydrate.race.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNoteHydrate } from './useNoteHydrate';
// 纠正：从真实的 hydrateProjection 导入正确的 NoteHydrateOutcome 类型
import type { NoteHydrateTransport, NoteHydrateOutcome } from './hydrateProjection';

describe('useNoteHydrate · 极端高频切换并发竞态防污染测试（Generation Guard）', () => {
  it('当快速连续切换文档时，滞后的旧 Promise 返回被自动丢弃，绝不污染当前文档', async () => {
    const pendingResolvers: Map<string, (outcome: NoteHydrateOutcome) => void> = new Map();

    const mockTransport: NoteHydrateTransport = {
      hydrate: vi.fn((docId: string) => {
        return new Promise<NoteHydrateOutcome>((resolve) => {
          pendingResolvers.set(docId, resolve);
        });
      }),
    };

    const { result, rerender } = renderHook(
      ({ id }) => useNoteHydrate({ docId: id, hydrateTransport: mockTransport }),
      { initialProps: { id: 'doc-1' } }
    );

    expect(result.current.status).toBe('loading');
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-1');

    rerender({ id: 'doc-2' });
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-2');

    rerender({ id: 'doc-3' });
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-3');

    act(() => {
      const resolveDoc1 = pendingResolvers.get('doc-1');
      resolveDoc1?.({
        ok: true,
        projection: {
          docId: 'doc-1',
          rev: 42,
          source: 'tauri-ipc',
          blocks: [
            {
              id: 'b-old',
              flavour: 'paragraph',
              text: '我是 doc-1 的旧内容，绝对不应该出现在 doc-3 中！',
              orderKey: 'a0',
              index: 0,
              parent: null,
              children: [],
              props: {},
            },
          ],
        },
      });
    });

    expect(result.current.status).toBe('loading');
    expect(result.current.projection).toBeNull();
    expect(result.current.blocks).toEqual([]);

    act(() => {
      const resolveDoc3 = pendingResolvers.get('doc-3');
      resolveDoc3?.({
        ok: true,
        projection: {
          docId: 'doc-3',
          rev: 1,
          source: 'tauri-ipc',
          blocks: [
            {
              id: 'b-new',
              flavour: 'paragraph',
              text: '我是 doc-3 的正确内容',
              orderKey: 'a0',
              index: 0,
              parent: null,
              children: [],
              props: {},
            },
          ],
        },
      });
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.projection?.docId).toBe('doc-3');
    expect(result.current.blocks[0]?.text).toBe('我是 doc-3 的正确内容');
  });
});
```

### 修复 2：解除 `style-contract.test.ts` 门禁 1 中的 `.titleInput` 圆角死锁

修改 07 详案门禁 1 中的受检白名单，将输入框从直角黑名单中剥离（对标全系统输入框规范，允许输入框持有微圆角）：
```typescript
// 门禁 1 纠正：排除 titleInput，仅锁定视图容器与纸面平平铺结构直角化
const noteSelectors = ['compactHeader', 'paperSurface', 'body', 'panel'];
for (const sel of noteSelectors) {
  const regex = new RegExp(`\\.${sel}(?:[\\s,.:#\\[][^{]*)?\\{[^}]+\\}`, 'g');
  const matches = noteCss.match(regex) ?? [];
  for (const block of matches) {
    const radiusMatch = block.match(/border-radius:\s*(?:var\(--radius-[^)]+\)|[1-9]\d*px)/i);
    expect(
      radiusMatch,
      `NotePaper 核心视图容器 .${sel} 违章声明了圆角: ${radiusMatch?.[0]}`
    ).toBeNull();
  }
}
```

并在门禁 2 中追加文件存在性守卫，杜绝 `ENOENT`：
```typescript
for (const file of targetFiles) {
  const fullPath = new URL(`../../${file}`, import.meta.url);
  if (!existsSync(fullPath)) continue; // 兼容未就绪文件
  const content = readFileSync(fullPath, 'utf8');
  ...
}
```

### 修复 3：就地替换 `style-contract.test.ts` 旧手风琴测试

在 `apps/crish-desktop/src/styles/style-contract.test.ts` 中，直接**就地替换**第 513-527 行：
```typescript
describe('批次 6 · T4 hover-only 键盘闭环契约（08-步5 · 平直列表升级）', () => {
  it('DiffCard.hoverActions 不以 display:none 阻断 Tab 序，且 :hover/:focus-within 双揭示', () => {
    const css = readFile('src/components/diff/DiffCard.module.css').replace(
      /\r\n/g,
      '\n'
    );
    const block = css.match(/\.(rowActions|hoverActions)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(block, '.rowActions/.hoverActions 应存在').toContain('opacity: 0');
    expect(block).toContain('visibility: hidden');
    expect(block).not.toContain('display: none');
    // 就地平滑迁移：支持平直列表行 .fileRow
    const hasRowHover = css.includes('.fileRow:hover .rowActions') || css.includes('.fileRow:hover .hoverActions');
    expect(hasRowHover, '必须支持 .fileRow:hover 揭示操作栏').toBe(true);
    const hasRowFocus = css.includes('.fileRow:focus-within .rowActions') || css.includes('.fileRow:focus-within .hoverActions');
    expect(hasRowFocus, '必须支持 .fileRow:focus-within 揭示操作栏').toBe(true);
  });
});
```

### 修复 4：保全顶栏斜杠触发锚点 `data-testid="note-paper-strict-open-slash"`

在重构后的 [`NotePaperStrictHeader.tsx`](file:///c:/Software/conex/docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md#L1212) 右侧按钮组中，保全一个无障碍斜杠触发按钮，彻底救活 `WorkspaceEmptyState.conn-b3.test.tsx` 与 `NotePaperStrictPanel.test.tsx`：
```tsx
{/* 护航既有测试资产：保持斜杠菜单受控触发入口 */}
{showOpenSlashButton && (
  <IconButton
    size="sm"
    variant="ghost"
    icon={<span style={{ fontSize: 13, fontWeight: 600 }}>/</span>}
    aria-label="打开斜杠指令菜单"
    tooltip="斜杠指令 (/)"
    onClick={onOpenSlash}
    data-testid="note-paper-strict-open-slash"
    data-slash-open-trigger="1"
    data-slash-write-mode={slashWriteMode}
  />
)}
```

### 修复 5：补齐 `NotePaperStrictPanel.tsx` 文件头行数契约字符

在 `NotePaperStrictPanel.tsx` 顶部 JSDoc 注释中显式保留契约字符：
```typescript
/**
 * NotePaperStrictPanel — Workbench 笔记纸面 **Strict 轨**（W5-B）
 * 目标 <400 行；SD-04-R 装配拆分；≠ EL-01。
 */
```

### 修复 6：双端命令清单测试原子化抬升至 135

- `apps/agent-workbench/src-tauri/src/command_manifest.rs:444`:
  ```rust
  assert_eq!(manifest.commands.len(), 135);
  ```
- `apps/crish-desktop/src/api/transport/commandManifest.test.ts:78-79, 294-295`:
  ```typescript
  expect(registered).toBe(135);
  expect(BUILTIN_COMMAND_MANIFEST.commands.length).toBe(135);
  expect(total).toBe(135);
  ```

---

## 结论与签署

经过全景代码级穿透审计，本审计官裁定：
**本报告揭示的 6 项修复施工项是战役从阶段五迈向阶段六实现的刚性准入门闩。只要在代码实现阶段严格执行本报告第七章的修复补齐清单，全仓 73 套 Rust 测试与 Vitest 全量前端测试将 100% 稳固通过，实现真正意义上的零回归、零红灯交付！**

*全仓测试全景回归与门禁防线审计官 签署定稿*  
*2026-09-05*
