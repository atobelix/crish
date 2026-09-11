# 测试资产保护、状态机边界与防回归门禁独立评审报告 (REVIEW-03)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）
> **评审阶段**：阶段三 · 方案交叉独立评审
> **专项编号**：REVIEW-03
> **评审席位**：测试资产保护、状态机边界与防回归门禁首席评审官
> **输入依据**：
> - 现场代码审计报告：[`docs/diff-view-redesign/analysis/`](file:///c:/Software/conex/docs/diff-view-redesign/analysis/) 全量 8 份审计文档（AUDIT-01 至 AUDIT-08）
> - 独立重构实施方案：[`docs/diff-view-redesign/independent-plans/`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/) 全量 7 份独立方案（PLAN-01 至 PLAN-07）
> **铁律基准**：
> - [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（反退避与纯逻辑规划）、§3（Git 提交权主控独占）、§7（严禁补丁、绕过与作弊，零容忍 `--no-verify`）、§7.1（立体验证纪律）、§9（测试资产保护铁律：测试是一等公民，测试不可丢）
> - [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)（反过度设计硬性红线）
> **产出落盘**：`docs/diff-view-redesign/plan-reviews/03-test-safety-and-state-machine-review.md`

---

## 四段式架构治理声明（To-Do / Not-To-Do / 旧路径清单 / 自检删除面）

### 1. 【做什么（To-Do）】
1. **穿透审查 7 份方案的测试资产破坏面**：
   - 逐行审查 `style-contract.test.ts`、`DiffCardFileList.test.tsx`、`NotePaperStrictPanel.test.tsx`、`WorkspaceEmptyState.strict.test.tsx`、`NotePaperStrictHeader.test.tsx`、`NotePaperPanel.insulate.test.ts` 等核心单测文件；
   - 纠正方案中“乐观假设用例天然通过”的违规认知，严禁粗暴删除核心用例，制定平滑升级为新 DOM 正向断言与死代码负向断言的双向安全契约。
2. **极端并发与状态机极限边界审查**：
   - 审查 PLAN-07 多笔记高频切换（如 100ms 内连点 10 次）下的异步 Promise 竞争、IME 输入泄漏、编辑焦点残留与 `doc_id` 串入风险；
   - 审查 PLAN-03 连续快速点击超链接时的 Zustand 同步去重与带查询参数（`?mode=diff`）下的 Tab 身份分裂缺陷。
3. **防回归自动化门禁硬度评估**：
   - 审查 AST/正则守门脚本的覆盖盲区，补齐“去圆角防复活”、“`.fileNode` 父级 hover 防复活”、“全域样式文件裸写 Hex 拦截”等刚性断言。
4. **输出阻断清单与测试补齐必修项**：
   - 明确判定结论，形成可以直接交由实施波落地的代码级测试修正方案。

### 2. 【不做什么（Not-To-Do）】
1. **严禁执行 Git 写操作**：
   - 绝对严禁执行 `git commit`、`git reset`、`git checkout` 或 `git restore`，代码修改权归主控独占；
2. **严禁放行破坏 CI 门禁的缺陷方案**：
   - 凡存在用例断裂风险或测试断言缩水的方案，一律不予签发 Pass，必须标注 Need-Fix 并提出刚性补齐条款；
3. **严禁借“重构”之名行“删测逃避”之实**：
   - 测试是系统资产，严禁以“UI 变了所以测试不要了”为借口剔除断言；被废弃的 UI 特性必须转为确保其“物理清退、零回潮”的负向断言（Negative Assertions）。

### 3. 【旧路径清单（Legacy Path Inventory）】
全面盘点本战役重构直接波及的 **6 个核心测试文件** 与 **14 个关联测试用例**：

| 序号 | 受影响测试文件 | 受波及测试用例 / 断言块 | 诱发改动的方案 | 潜在破损风险分析 |
| :---: | :--- | :--- | :---: | :--- |
| **1** | [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) | `DiffCard.hoverActions 不以 display:none 阻断 Tab 序` (L513-526) | PLAN-01<br/>PLAN-04 | 类名由 `.accordionHeaderRow` 改写为 `.fileRow`，正则匹配旧类名将直接报错抛异常。 |
| **2** | [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) | `DiffCardFileList 列表语义已降级为 role="list"` (L528-536) | PLAN-01 | 列表重构可能误改 `aria-label` 或破坏 `role="list"` 语义。 |
| **3** | [`apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx) | `renders inline compare Select with explicit size="sm"...` (L26-63) | PLAN-01<br/>PLAN-02 | 单文件行内对比下拉菜单被物理拔除，DOM 找不到 `data-size="sm"`，测试必定崩溃红灯。 |
| **4** | [`apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx) | `renders targetDiff additions and deletions...` (L65-105) | PLAN-01<br/>PLAN-03 | 行内按钮被拆分为展开箭头与超链接，`getByRole('button', { name: /main\.ts \+15 −7/ })` 无法命中。 |
| **5** | [`apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx) | `should disable Accept button for provisional diff` (L10-24) | PLAN-02 | 纯逻辑测试虽不受影响，但传参中包含废弃 Props，导致类型检查告警。 |
| **6** | [`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx) | `w5b_strict_footer_declares_demo_neq_EL_boundary` (L353-379) | PLAN-06 | 底部 `<footer>` 物理拔除后，`getByTestId('note-paper-strict-footer')` 抛出节点未找到错误。 |
| **7** | [`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx) | `w5b_strict_refresh_reloads_projection` (L219-280) | PLAN-05 | 顶栏重构字数徽标后，断言 `note-paper-strict-count` 必须保持正则匹配 `/2/`。 |
| **8** | [`apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.strict.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.strict.test.tsx) | `测试 W5-B 会计边界` (L110-113) | PLAN-06 | 同样依赖 `note-paper-strict-footer`，直接引发测试崩溃。 |
| **9** | [`apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx) | `slash 只读徽章无原生 title；hover 出 Tooltip` (L35-50) | PLAN-05 | 顶栏调试探针 `note-paper-strict-slash-mode` 物理移除，测试用例找不到挂载节点。 |
| **10** | [`apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx) | `slash 可写徽章 hover 文案对应 writable` (L52-64) | PLAN-05 | 同上，找不到节点，无法测试 Tooltip。 |
| **11** | [`apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts) | `含 .panel > .header / .footer，flex: 0 0 auto...` (L31-40) | PLAN-06 | **重大破损点**：PLAN-06 拟删除 `.panel > .footer`，直接导致 `expect(css).toContain('.panel > .footer')` 失败！ |
| **12** | [`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.line-budget.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.line-budget.test.ts) | `模块头保留 SD-04-R / <400 目标与诚实边界` (L58-66) | PLAN-05<br/>PLAN-06 | 清理 import 时若误删头部免责声明与 SD-04-R 注释，该行数契约测试将拦截报错。 |

### 4. 【自检删除面（Self-Inspection Deletion Surface）】
- **允许清退的测试面**：
  1. 仅限已被物理彻底拔除的无效 UI 控件的选择器断言（如单文件展开区内部的对比维度下拉框选择器 `inlineCompareSelect`，以及 `note-paper-strict-footer` 的物理 DOM 存在性检查）；
- **强制承接的新断言面**：
  1. **等价机器可读契约承接**：原 `footer` 中的 `W5B_STRICT_BOUNDARY` 会计边界断言，100% 迁移至容器 `<section>` 的 `data-boundary` 属性断言；
  2. **绝对物理清退负向断言**：所有拔除项必须追加 `expect(screen.queryByTestId('...')).toBeNull()`，形成刚性防回潮闭环；
  3. **产品级交互语义正向断言**：为平直列表 32px 紧凑行、Chevron 展开指示器、单轨文件名超链接、多文档受管切换补充精准正向用例。

---

## 1. 测试安全与状态机评审结论（Pass / Need-Fix）

### 1.1 总体裁决：**【Need-Fix（必须整改后方可放行进入实施波）】**

经测试资产与状态机专项全面交叉审查，7 份方案在整体架构收敛、反过度设计、代码净负产出方面的方向高度正确，但在**测试断言平滑迁移的精细度**、**极端并发竞争防护**以及**防回归门禁的覆盖硬度**上存在 **7 项关键技术阻断（Blockers）**。必须在进入实施波前完成修正。

### 1.2 方案逐项审查评分与阻断矩阵

| 方案编号 | 方案主题 | 审查裁决 | 核心测试与状态机隐患定性 |
| :---: | :--- | :---: | :--- |
| **PLAN-01** | 差异面板平直列表化与去圆角 | **Need-Fix** | **断言失效隐患**：对 `DiffCardFileList.test.tsx` 用例 3 做出了“天然保持通过”的错误预判，未考虑按钮解耦后的可访问名称断裂；且**完全缺失“去圆角”自动化防回归门禁**。 |
| **PLAN-02** | 差异行内顶部工具行彻底拔除 | **Pass** | **优秀标杆**：对已废弃的单文件工具栏用例给出了“负向拔除断言 + 正向正文渲染”的无损平滑替换范式，未粗暴删测。 |
| **PLAN-03** | 文件名超链接独立预览 Tab | **Need-Fix** | **Tab 分裂隐患**：将 `?mode=diff` 查询参数直接嵌入 `panelId`，导致同一物理文件因模式不同在右侧坞中分裂为多个重复 Tab；未设计多 Tab 幂等防重测试用例。 |
| **PLAN-04** | Hover 令牌与设计规范化 | **Need-Fix** | **正则漏检盲区**：提出的防父级 Hover 正则未包含 PLAN-01 新引入的包裹层 `.fileNode`；裸写 Hex 门禁未覆盖笔记面板样式文件。 |
| **PLAN-05** | 笔记 32px 紧凑顶栏重塑 | **Pass** | **契约保持良好**：保留了关键 testId 映射（`note-paper-strict-count` 等），对 `NotePaperStrictHeader.test.tsx` 提出了 Tooltip 语义平移方案。 |
| **PLAN-06** | 笔记底部灰色块彻底拔除 | **Need-Fix** | **门禁直接破坏**：在删除 CSS 中的 `.panel > .footer` 时，**完全遗漏了 `NotePaperPanel.insulate.test.ts:31-40` 的源码断言**，直接执行将导致 CI 门禁当场失败！ |
| **PLAN-07** | 多笔记综合管理体系 | **Need-Fix** | **致命竞态漏洞**：`useNoteHydrate.ts` 缺少请求序列令牌（Generation/Sequence Token），快速切换笔记将导致 Promise 乱序返回错乱渲染；且未在编辑器挂载 `key={activeDocId}`，存在草稿与 IME 焦点串染。 |

---

## 2. 现有核心测试资产影响面与平滑迁移方案审查（逐个测试文件列出）

### 2.1 [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts)

#### 现场断言审查：
- **现有用例（L513-526）**：
  ```typescript
  const block = css.match(/\.hoverActions\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(block).toContain('opacity: 0');
  expect(block).toContain('visibility: hidden');
  expect(block).not.toContain('display: none');
  expect(css).toContain('.accordionHeaderRow:hover .hoverActions');
  expect(css).toContain('.accordionHeaderRow:focus-within .hoverActions');
  expect(css).toContain('.accordionHeaderRow:focus-within .fileStat');
  ```
- **病灶与风险**：
  PLAN-01 将手风琴行容器 `.accordionHeaderRow` 重命名为平直行 `.fileRow`。如果直接修改 CSS 而未协同更新该测试，`expect(css).toContain('.accordionHeaderRow...')` 将导致 CI 立即红灯。

#### 平滑迁移规范：
实施批次必须协同演进该用例，**绝对禁止直接注释或删除**。应升级为双向兼容或新架构正向断言：
```typescript
// 改造后的 style-contract.test.ts
it('DiffCard 行内快捷操作不以 display:none 阻断 Tab 序，且在悬停与聚焦时双揭示', () => {
  const css = readFile('src/components/diff/DiffCard.module.css').replace(/\r\n/g, '\n');
  const block = css.match(/\.(rowActions|hoverActions)\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(block, '快捷操作容器应存在').toContain('opacity: 0');
  expect(block).toContain('visibility: hidden');
  expect(block).not.toContain('display: none');

  // 兼容新平直列表选择器体系
  const hasRowHover = css.includes('.fileRow:hover .rowActions') || css.includes('.fileRow:hover .hoverActions');
  expect(hasRowHover, '必须支持行级 hover 揭示快捷操作').toBe(true);

  const hasRowFocus = css.includes('.fileRow:focus-within .rowActions') || css.includes('.fileRow:focus-within .hoverActions');
  expect(hasRowFocus, '必须支持行级 focus-within 键盘无障碍揭示').toBe(true);

  // 刚性防回归：确保统计数字绝对不含有 opacity: 0 暴力隐藏反模式
  const hideStatMatch = css.match(/\.fileRow[^{]*:hover[^{]*\.fileStat\s*\{[^}]*opacity:\s*0/);
  expect(hideStatMatch, '严禁在 hover 时隐藏统计数字').toBeNull();
});
```

---

### 2.2 [`apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx)

#### 现场用例审查与纠偏：
1. **用例 1：`should disable Accept button for provisional diff`**：
   - 审查结论：校验纯函数 `classifyFileDiff`，保留即可。清理调用处的废弃 Props 传参。
2. **用例 2：`renders inline compare Select with explicit size="sm" preventing overflow`**：
   - 审查结论：PLAN-02 提出的改造方案完全合格。将对已拔除下拉框的选择器查找，转换为**正向断言代码正文直接呈现 + 负向断言工具行绝不渲染**：
     ```typescript
     expect(container.querySelector('[class*="inlineHeader"]')).toBeNull();
     expect(queryByLabelText('对比维度选择')).toBeNull();
     expect(getByText('diff content')).toBeDefined();
     ```
3. **用例 3：`renders targetDiff additions and deletions when getFileDiffData is provided`**：
   - **重大纠偏**：PLAN-01 声称此用例“天然保持通过”，**这是严重不符事实的错误判断！**
   - 现场代码第 103 行原为：
     ```typescript
     const btn = getByRole('button', { name: /main\.ts \+15 −7/ });
     ```
     原架构中整个条目是一个巨大的 `<button className={styles.fileItem} aria-label={`${name} +${add} −${del}`}>`，因此无障碍名称包含了文件名与增减数字。
   - 在 PLAN-01 与 PLAN-03 中，条目被拆解为：
     - 折叠 Chevron 按钮（`aria-label="展开 main.ts 差异代码"`）；
     - 超链接按钮（`aria-label="独立预览文件 main.ts"`，文本仅为 `main.ts`）；
     - 独立的统计容器 `<span className={styles.fileStat}>+15 −7</span>`（在按钮外部）。
   - **执行后果**：若不做迁移，`getByRole('button', { name: /main\.ts \+15 −7/ })` 在重构后的 DOM 中**绝对无法匹配到任何单一按钮**，单测当场挂死！
   - **必修迁移方案**：
     ```typescript
     it('renders targetDiff additions and deletions when getFileDiffData is provided', () => {
       // ...渲染组件...
       // 1. 验证文件节点容器与无障碍列表项角色
       const fileNode = container.querySelector('[role="listitem"]');
       expect(fileNode).toBeDefined();

       // 2. 验证独立超链接按钮可访问
       expect(getByRole('button', { name: /独立预览.*main\.ts|main\.ts/ })).toBeInTheDocument();

       // 3. 验证增删统计数字常驻呈现且数值准确
       expect(container.textContent).toMatch(/\+15/);
       expect(container.textContent).toMatch(/−7/);
     });
     ```

---

### 2.3 [`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx) 与 [`WorkspaceEmptyState.strict.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.strict.test.tsx)

#### 审查结论：
- PLAN-06 提出的会计锚点迁移方案**完全可行且高度规范**。
- 将原本展示在界面底部 `<footer>` 上的免责声明 `W5B_STRICT_BOUNDARY`（如 `可演示≠EL-01|≠EL-01`、`EL-08|S5|W5-C`）下沉到根 `<section data-testid="note-paper-strict-panel">` 的 `data-boundary` 属性中；
- 断言改造为：
  ```typescript
  const panel = screen.getByTestId('note-paper-strict-panel');
  expect(panel).toHaveAttribute('data-package-id', 'W5-B');
  expect(panel).toHaveAttribute('data-track', 'strict');
  expect(panel.getAttribute('data-boundary')).toMatch(/可演示≠EL-01|≠EL-01/);
  // 刚性拦截底部灰色块回潮
  expect(screen.queryByTestId('note-paper-strict-footer')).toBeNull();
  ```
- 既彻底清除了侵占视口的物理灰色 DOM，又通过 HTML5 标准 `data-*` 契约完整保全了架构会计门禁。

---

### 2.4 [`apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts)

#### 🔴 重大阻断性发现（PLAN-06 严重遗漏）：
- **现场断言定位**：
  [`NotePaperPanel.insulate.test.ts:31-40`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts#L31-L40)：
  ```typescript
  it('含 .panel > .header / .footer，flex: 0 0 auto 且 max-height: none', () => {
    expect(css).toContain('.panel > .header');
    expect(css).toContain('.panel > .footer'); // 🔴 硬性断言 .footer 必须在样式表中！

    const chrome = ruleBlockAfter(css, '.panel > .header,'); // 🔴 硬性匹配逗号连接的选择器！
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).toMatch(/width:\s*100%/);
    expect(chrome).toMatch(/min-height:\s*unset/);
  });
  ```
- **致命隐患**：
  PLAN-06 在第 421-432 行中规划：“将 `.panel > .footer` 彻底剔除，修改为 `.panel > .header { flex: 0 0 auto; ... }`”。一旦照此执行，`NotePaperPanel.insulate.test.ts` 第 33 行与第 35 行将立即爆出未捕获断言异常！
- **必修迁移方案**：
  实施批次必须同步重写该测试用例，从“检查 header/footer 绝缘”升级为“仅检查 header 绝缘，并断言 footer 样式已被物理删除”：
  ```typescript
  it('顶栏绝缘契约：含 .panel > .header，flex: 0 0 auto 且已清除 .panel > .footer', () => {
    expect(css).toContain('.panel > .header');
    // 刚性断言：footer 绝缘规则必须已物理拔除
    expect(css).not.toContain('.panel > .footer');

    const chrome = ruleBlockAfter(css, '.panel > .header');
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).toMatch(/width:\s*100%/);
    expect(chrome).toMatch(/min-height:\s*unset/);
  });
  ```

---

### 2.5 [`apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx)

#### 审查与迁移：
- 该文件测试了 Tooltip 控制器在顶栏徽章上的行为。由于 PLAN-05 清理了纯内部排查用的 `note-paper-strict-slash-mode` 徽章，原测试用例找不到元素；
- **迁移规范**：
  将 Tooltip 悬停测试平移挂载在重构后产品级的 `note-paper-strict-count`（字数明细 Tooltip）以及 `IconButton`（刷新/复制/导出 Tooltip）上，既能 100% 覆盖 Tooltip 控制器逻辑，又拔除了对底层技术探针的依赖。

---

## 3. 多文档切换与异步 Tab 激活状态机极限边界与防竞态审查

### 3.1 PLAN-07 多笔记高频切换与输入竞态（Race Condition）穿透审查

#### 场景 1：极速并发切换（100ms 内连点 10 篇笔记）
- **代码现场审计（`useNoteHydrate.ts:100-138`）**：
  ```typescript
  const reload = useCallback(async () => {
    setStatus('loading');
    try {
      const outcome = await hydrateTransport.hydrate(docId); // 异步 I/O
      if (!outcome.ok) { ... return; }
      setProjection(outcome.projection);                      // 状态更新
      setStatus(outcome.projection.blocks.length === 0 ? 'empty' : 'ready');
    } ...
  }, [hydrateTransport, docId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken, writeRefreshSeq]);
  ```
- **状态机缺陷定性**：
  1. `reload()` 内部是异步调用，且**完全缺失请求序列号（Request Sequence ID）或 `AbortController` 机制**；
  2. 当用户在侧栏快速从 `doc-1` 连续点击到 `doc-10` 时，10 个 `hydrate()` 异步 Promise 同时在后台执行；
  3. 若 `doc-1` 包含大量历史块导致 SQLite I/O 耗时较长（如 150ms），而后点击的 `doc-10` 为空文档在 10ms 内即返回；
  4. 则 `doc-10` 先解析完成并将状态置为 ready；随后 `doc-1` 的旧 Promise 滞后解析，触发 `setProjection(doc-1.projection)`。
  5. **最终结果**：界面顶栏与侧栏显示当前激活的是 `doc-10`，但主编辑纸面上渲染的却是 `doc-1` 的旧内容！发生严重的**异步读回乱序脏写缺陷**！

#### 场景 2：切换瞬间文本输入与草稿串写
- **病灶分析**：
  1. 用户在 `doc-A` 中正在编辑文本，在防抖刷盘（如 300ms debounce）尚未触发的临界瞬间，突然在侧栏点击切换至 `doc-B`；
  2. 若 `NotePaperStrictPanel` 沿用同一组件实例而未重置，防抖闭包中如果捕获了可变的引用，或者未在卸载时执行立即强制持久化（Flush on Unmount），会导致用户在 `doc-A` 输入的文字被带入 `doc-B` 提交，造成**跨文档文本串染**；
  3. IME 中文输入法合成态（Composition）在切换瞬间若未主动派发 `blur`，未上屏的拼音字母会残留在下一个文档的焦点块中。

#### 🔴 必须执行的四大状态机防竞态必修补齐项：
1. **引入递增请求令牌（Generation Guard）**：
   在 `useNoteHydrate.ts` 中植入 `latestRequestIdRef`。任何异步 resolve 返回后，必须严格断言 `reqId === latestRequestIdRef.current`，凡旧请求直接丢弃：
   ```typescript
   const reqSeqRef = useRef(0);
   const reload = useCallback(async () => {
     const thisSeq = ++reqSeqRef.current;
     setStatus('loading');
     try {
       const outcome = await hydrateTransport.hydrate(docId);
       if (thisSeq !== reqSeqRef.current) return; // 拦截并丢弃过期乱序返回！
       // ...执行状态更新...
     } catch (e) {
       if (thisSeq !== reqSeqRef.current) return;
       // ...执行错误处理...
     }
   }, [hydrateTransport, docId]);
   ```
2. **强制使用 React Key 隔离组件实例（Zero Leaking）**：
   在宿主渲染 `NotePaperStrictPanel` 时，必须强制指定：
   ```tsx
   <NotePaperStrictPanel key={activeDocId} docId={activeDocId} ... />
   ```
   利用 React 原生 Diff 机制，在 `docId` 切换时**完整销毁旧组件 DOM 树与 Hook 闭包**，确保 IME 状态、输入框焦点、撤销栈代理与本地临时状态 100% 物理重置，从根本上绝灭串染可能！
3. **切换前防抖强制刷盘（Flush on Switch）**：
   `useNoteDocumentManager` 在执行 `switchDoc(newDocId)` 前，必须同步调用当前编辑器的 `flushDraft()`，确保上一篇笔记的任何残余文字先安全落盘 SQLite，随后再变更 `activeDocId`。
4. **宿主写锥联动绑定（Binding Sync）**：
   针对前文审计发现的 `NoteLeafHost` 静态钉死问题，`NoteLeafHost` 必须感知 `activeDocId` 的动态变化，使 `paper.slashBinding.sink` 与 `paper.mdPrefixBinding.sink` 动态绑定至当前文档，杜绝写锥落入旧文档。

---

### 3.2 PLAN-03 独立预览 Tab 快速点击防重与身份分裂审查

#### 场景审查：快速连续点击同一超链接 5 次是否会开出 5 个 Tab？
- **代码现场审计（`openTool.ts:125-148`）**：
  ```typescript
  export function openToolInLeaf(leafId: string, panelId: string): void {
    // ...
    const dock = readLeafDock(node);
    const openPanelIds = dock.openPanelIds.includes(mapped)
      ? dock.openPanelIds
      : [...dock.openPanelIds, mapped];

    updateLeafDock(id, {
      collapsed: false,
      openPanelIds,
      activePanelId: mapped,
    });
  }
  ```
- **分析结论（前半部分 Pass）**：
  `openToolInLeaf` 是纯粹的**同步 Zustand 状态流转**。用户在 100ms 内连续点击 5 次：
  - 第 1 次点击：同步写入 `openPanelIds` 并设置 `activePanelId`；
  - 第 2~5 次点击：`dock.openPanelIds.includes(mapped)` 立即判定为 `true`，数组不追加，仅执行聚焦。
  - 底层文件读取的异步 IPC（`readTextFile`）仅在 Tab 挂载后按 `filePath` 发起，其本身内部带有 `let active = true; return () => { active = false; };` 的取消保护。
  - **因此：相同 `panelId` 的快速连续点击绝不会导致右侧栏创建出 5 个重复 Tab！**

#### 🔴 隐蔽的 Tab 身份分裂缺陷（Need-Fix）：
- **缺陷剖析**：
  PLAN-03 在构造 `panelId` 时，将查询参数写死拼接：
  ```typescript
  const query = initialMode === 'diff' ? '?mode=diff' : '';
  const panelId = `file-viewer:${normalized}${query}`;
  ```
  - 用户从 Diff 面板点击超链接打开了 `file-viewer:src/main.ts?mode=diff`；
  - 随后用户在文件树或通过其他快捷键打开该文件，传入默认模式，构造出 `file-viewer:src/main.ts`；
  - Zustand 的 `includes(mapped)` 采用全字符串精确比对，判定两者不相等！
  - **后果**：右侧标签栏同时出现两个针对 `src/main.ts` 的 Tab！
- **必修补正契约**：
  在 Dock 状态机中，Tab 容器的**身份真理键（Identity SSOT）必须是规范化物理路径**，查询参数仅作为视图内部初始状态消费：
  ```typescript
  // 规范化 Tab 唯一标识：不包含 query
  const canonicalPanelId = `file-viewer:${normalized}`;
  // 模式参数通过 ViewContext 或在 openToolInLeaf 内部按 canonical 匹配去重
  ```

---

## 4. 自动化防回归门禁（AST / Style-Contract）硬度评估

### 4.1 父级 Hover 复活拦截硬度评估

- **PLAN-04 提出的正则门禁**：
  ```typescript
  const invalidHoverRe = /\.(accordionItem|flatFileList|fileList|groupItemsContainer|accordionHeaderRow):hover\s*\{[^}]*background/g;
  ```
- **漏洞定性（Need-Fix）**：
  1. **漏检 PLAN-01 新引入的包裹层 `.fileNode`**！PLAN-01 将每行外部包装命名为 `.fileNode`。如果后续开发人员误在 `.fileNode:hover` 上写背景，由于白名单遗漏，该门禁完全失灵，Porter-Duff 4.94% 脏灰将瞬间复活！
  2. 正则未考虑换行与属性前缀变种（如 `background-color`、CSS Modules 嵌套选择器）。
- **加固后的刚性 AST/正则守门代码**：
  ```typescript
  it('刚性门禁 1：差异面板全域容器与外壳包装层严禁声明任何 :hover 背景规则', () => {
    const diffCss = readFile('src/components/diff/DiffCard.module.css').replace(/\r\n/g, '\n');
    // 全面覆盖新老所有外壳与容器类名（含 fileNode, flatFileList, fileRowContainer）
    const wrapperSelectorPattern =
      /\.(accordionItem|flatFileList|fileList|groupItemsContainer|accordionHeaderRow|fileNode|fileRowContainer)[^{]*:hover[^{]*\{[^}]*background/gi;
    const violations = diffCss.match(wrapperSelectorPattern) ?? [];
    expect(violations, `发现违章外层容器 hover 背景注入：${violations.join('; ')}`).toEqual([]);
  });
  ```

---

### 4.2 去圆角防复活门禁缺失评估（🔴 严重遗漏项）

- **评估现状**：
  用户最高裁决：“*差异界面的每个文件改成列表就行了，去掉圆角。越简单越好*”。
  但纵观 PLAN-01、PLAN-02 与 PLAN-04，**没有任何一份方案在 `style-contract.test.ts` 中为“去圆角”建立自动化阻断测试**！
  若无门禁，未来重构随时可能因样式复用重新带回 `border-radius: 6px`。
- **必修新增门禁代码**：
  ```typescript
  it('刚性门禁 6（新增）：差异文件平直列表与比对视口严格执行 0px 直角契约（去圆角防复活）', () => {
    const diffCss = readFile('src/components/diff/DiffCard.module.css').replace(/\r\n/g, '\n');

    // 1. 抽取 .flatFileList、.fileRow、.fileNode、.diffPane 规则块
    const flatSelectors = ['flatFileList', 'fileRow', 'fileNode', 'diffPane'];
    for (const sel of flatSelectors) {
      const blockMatch = diffCss.match(new RegExp(`\\.${sel}\\s*\\{[^}]+\\}`, 'g')) ?? [];
      for (const block of blockMatch) {
        // 严禁声明大于 0 的圆角
        const radiusMatch = block.match(/border-radius:\s*([var\(--radius-[^)]+\)|[1-9]\d*px])/i);
        expect(radiusMatch, `选择器 .${sel} 违章声明了圆角：${radiusMatch?.[0]}`).toBeNull();
      }
    }
  });
  ```

---

### 4.3 裸写 Hex 与幽灵 Token 门禁硬度评估

- **漏洞定性**：
  PLAN-04 的 Gate 2 仅对 `DiffCard.module.css` 做了 Hex 检查。然而本次战役是**差异面板与笔记面板系统性重构**，`NotePaperPanel.module.css` 在 PLAN-05 和 PLAN-06 中同样经历了近百行清理，却处于裸写色值门禁的真空地带！
- **加固方案**：
  将裸写 Hex 与幽灵 Token 扫描范围扩大至 `components/diff/` 与 `components/note-paper/` 两个模块目录下的全部 CSS 文件。

---

## 5. 测试验收清单与测试补齐必修项

根据 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §7.1 立体验证纪律，重构方案进入执行波前，必须将下列测试补齐项全量落实到实施任务书中：

### 5.1 实施波测试补齐与迁移矩阵（必修执行表）

| 序号 | 目标测试文件 | 必修实施动作（Action） | 验收断言标准与防退避保护 | 对应方案编号 |
| :---: | :--- | :--- | :--- | :---: |
| **T-01** | `DiffCardFileList.test.tsx` | 重构用例 2 与用例 3，适配平直单轨行结构与无工具行新规范 | • `queryByLabelText('对比维度选择')` 为 null<br/>• 超链接按钮与增删统计数字独立可测，零崩溃 | PLAN-01<br/>PLAN-02 |
| **T-02** | `style-contract.test.ts` | 接入 6 大刚性样式门禁（包含补齐的去圆角门禁与 `.fileNode` 拦截） | • 拦截父级 hover 背景<br/>• 拦截裸写 Hex<br/>• 拦截幽灵 Token<br/>• 拦截平直列表大于 0 的圆角 | PLAN-01<br/>PLAN-04 |
| **T-03** | `NotePaperPanel.insulate.test.ts` | 同步迁移绝缘测试，移除 `.panel > .footer` 依赖并设负向断言 | • 断言 `.panel > .header` 保持 0 0 auto<br/>• 断言样式表内 `.panel > .footer` 零留存 | PLAN-06 |
| **T-04** | `NotePaperStrictPanel.test.tsx` | 将会计边界断言迁移至 `data-boundary` 属性，添加 footer 负向断言 | • `getAttribute('data-boundary')` 匹配 W5-B 边界<br/>• `queryByTestId('note-paper-strict-footer')` 为 null | PLAN-06 |
| **T-05** | `WorkspaceEmptyState.strict.test.tsx` | 同步迁移 `data-boundary` 断言 | • 空态下的 W5-B 架构会计断言保持 100% 绿灯 | PLAN-06 |
| **T-06** | `NotePaperStrictHeader.test.tsx` | 将 Tooltip 控制器测试迁移至字数徽标与 IconButton | • 保证 TooltipController 单元测试资产零受损 | PLAN-05 |
| **T-07** | `useNoteHydrate.test.ts` *(新增)* | 编写异步高频切换并发竞态回归测试（10 次快切） | • 确保使用 `reqSeqRef` 令牌，旧 Promise 乱序返回绝不污染当前文档 | PLAN-07 |
| **T-08** | `openTool.test.ts` | 补充多 Tab 幂等性与规范化路径防分裂测试 | • 无论是否携带查询参数，相同文件路径绝对不产生重复 Tab | PLAN-03 |

---

### 5.2 实施阶段必须顺序通过的全量门禁命令流水线

本评审严格申明：实施波改动完成后，必须在本地 pwsh7 终端中无跳过、零 `--no-verify` 地跑通以下全量门禁流水线：

```powershell
# 1. 静态行数门禁扫描（确保净负产出，严格阻断膨胀）
npm run check:line-counts

# 2. 严格 TypeScript 类型检查（确保 Props 清理干净，零 any 残留）
npm run typecheck

# 3. 差异面板与样式契约专项单元测试（包含全部平滑迁移与防回归断言）
npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts
npx vitest run apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx
npx vitest run apps/crish-desktop/src/components/diff/DiffCard.perf.test.tsx

# 4. 笔记面板全套单测与绝缘契约测试
npx vitest run apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts
npx vitest run apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.test.tsx
npx vitest run apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.test.tsx
npx vitest run apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.line-budget.test.ts
npx vitest run apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.strict.test.tsx

# 5. 前端快层全量门禁覆盖率运行
npm run test:coverage -- --project=unit

# 6. 后端存储与 SQLite 迁移测试（针对 PLAN-07）
cargo test -p conex-workspace-store
```

---

## 6. 首席评审官签署与交接指示

- **评审裁定**：本评审报告对 7 份方案出具 **Need-Fix** 修正指导；
- **后续动作**：方案制定 Agent 必须即刻吸收本报告中的 7 项阻断性风险与补齐伪代码，将修正措施合流收敛至最终方案实现总文档中；
- **底线红线**：后续代码实施过程中，任何试图删除测试用例、绕过样式契约检查、使用 `--no-verify` 的行为，一律视为严重违规并就地阻断。
