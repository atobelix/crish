# 笔记面板分维详案终审准入报告 (FINAL-REVIEW-02)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）
> **评审阶段**：阶段五 · 详案终审准入裁决（Final Entry Review）
> **终审编号**：FINAL-REVIEW-02
> **评审席位**：笔记系统与多文档管理首席终审官（Chief Reviewer for Note Architecture & Multi-Doc Systems）
> **评审对象**：
> - [`docs/diff-view-redesign/00-总方案-差异与笔记面板系统性重构.md`](file:///c:/Software/conex/docs/diff-view-redesign/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E5%B7%AE%E5%BC%82%E4%B8%8E%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF%E7%B3%BB%E7%BB%9F%E6%80%A7%E9%87%8D%E6%9E%84.md)
> - [`docs/diff-view-redesign/03-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md`](file:///c:/Software/conex/docs/diff-view-redesign/03-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF32px%E7%B4%A7%E5%87%91%E9%A1%B6%E6%A0%8F%E9%87%8D%E5%A1%91%E4%B8%8E%E5%BA%95%E9%83%A8%E8%B0%83%E8%AF%95%E5%9D%97%E5%BD%BB%E5%BA%95%E6%8B%94%E9%99%A4.md)
> - [`docs/diff-view-redesign/04-分维详案-多笔记综合管理体系与并发隔离架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/04-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%A4%9A%E7%AC%94%E8%AE%B0%E7%BB%BC%E5%90%88%E7%AE%A1%E7%90%86%E4%BD%93%E7%B3%BB%E4%B8%8E%E5%B9%B6%E5%8F%91%E9%9A%94%E7%A6%BB%E6%9E%B6%E6%9E%84.md)
> **落盘路径**：`docs/diff-view-redesign/plan-reviews/05-note-final-entry-review.md`
> **铁律基准**：用户最高指示（“避免双轨或者多轨、硬编码、功能伪实现、伪连通”）、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1（反退避）、§3（Git提交权主控独占）、§7（严禁补丁、绕过与作弊）、§7.1（立体验证纪律）、§9（测试资产保护）、§13（输入框焦点对比度 <= 10%）及 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。

---

## 1. 终审裁决结论（PASS / NEED-FIX）

### 1.1 裁决结论：【准入实施（PASS）】

经首席终审官对分维详案 03、分维详案 04 与 00 总方案进行穿透式三方比对、底层 Rust 存储与 IPC 注册真源复核、以及前端 CSS Modules / React 状态机并发极限推演，**终审裁决为：准入实施（PASS）**。

### 1.2 裁决依据与评审官定性简述

1. **痛点切除彻底，净负产出目标可度量**：
   - 详案 03 对用户严厉批评的两个底部灰色大块（`MirrorDriftStatusBar` 与 `footer`）采取了**物理切除 JSX 渲染节点**的纯净方案，彻底清退 293 行死组件 `MirrorDriftStatusBar.tsx` 与 95 行废弃 CSS，杜绝 `display: none` 欺骗；
   - 彻底切断上游 `NoteLeafHost.tsx` 的无用后台轮询调度器（`enableMirrorDetectSchedule: false`），解除底层 `note_detect_mirror_drift` Tauri IPC 的持续无效消耗。
2. **顶栏视觉规范与焦点态红线严格合规**：
   - 顶栏全面重塑为 32px 紧凑单轨架构，行内标题即时编辑框（`EditableTitle`）的边框色与焦点态完全遵循 `AGENTS.md` §13 规范（`color-mix` 混入度严格锁定在 10%~15%，零粗黑框、零厚重阴影）；
   - 字数统计徽标锁定 `font-variant-numeric: tabular-nums`，数字变动零跳动抖动；
   - 彻底肃清 `rev=4`、`139 块`、`slash=writable` 等开发者调试标签；全域使用原子 `<Tooltip>` 清退原生 HTML `title` 属性（BUG-V06）。
3. **多文档架构单轨落地，防并发乱序与数据安全闭环**：
   - 详案 04 建立了完整的 Master-Detail 折叠侧栏与顶栏快捷下拉切换体系，彻底废黜 `strict-${wsId}` 单一合成 ID 死锁；
   - **BUG-A04（SQLite v8 门闩）**：数据回填逻辑严格限制在 `current_version < 8` 判定分支内，且仅回填标题为默认占位的历史记录，杜绝启动时无条件全表扫描覆盖用户自定义标题；
   - **BUG-A05（并发乱序与脏刷盘）**：`useNoteDocumentManager` 引入递增请求序列令牌（Generation Token）抛弃过期响应，切换前强制调用 `flushCurrentDocument` 自动刷盘，主容器绑定 `key={activeDocId}` 保证 React 树纯净重置与 IME 输入隔离；
   - **BUG-A06（假回收站零容忍）**：彻底从侧栏抹除无 API 支撑的假“回收站”图标，删除动作直连后端真实 `note_document_delete` IPC 命令并配带二次确认弹窗，实现零伪连通、零伪实现。
4. **测试平滑迁移契约齐备**：
   - 针对 `NotePaperPanel.insulate.test.ts` 的绝缘选择器断言断裂问题（BUG-T01），详案制定了精准的测试协同迁移方案，负向断言拦截 footer 回潮，确保 CI 门禁全绿。

---

## 2. 底部灰色块彻底拔除与全高视口准备度审查

### 2.1 物理切除渲染树 vs 欺骗性隐藏（Zero Cheat）
- **核查内容**：`NotePaperStrictPanel.tsx:252-266` 现有代码挂载了 `<MirrorDriftStatusBar>` 与 `<footer className={styles.footer} data-testid="note-paper-strict-footer">`。
- **详案对策核实**：
  - 详案 03 第 40-58 行明确要求直接从 JSX 树中物理删除上述节点，`renderBodyContent()` 直接作为主视口闭合；
  - 严禁使用 CSS `display: none` 或 `visibility: hidden` 伪装隐藏；
  - 经核查，删除后 `NotePaperStrictPanel` 根容器仅包含顶栏与 `.body`，物理 DOM 彻底清净。

### 2.2 上游 NoteLeafHost 无用轮询调度器彻底解耦
- **代码现场**：[`apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.tsx:60-65`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/note-paper/NoteLeafHost.tsx#L60-L65) 原本在宿主中执行 `useWorkspaceEmptyStateMirrorSlot`，通过定时器定期调用 Tauri 后端 `note_detect_mirror_drift`。
- **详案解耦深度核实**：
  1. 详案将 `enableMirrorDetectSchedule` 强制置为 `false`，彻底停掉后台定时器轮询任务；
  2. 同步清理 `NotePaperStrictPanelProps` 上的 4 项废弃属性：
     - `mirrorDriftReport`
     - `mirrorWatchSource`
     - `showMirrorDriftBar`
     - `onMirrorThreeWay`
  3. 清除 `NotePaperStrictPanel.tsx` 顶部的死引用：`MirrorDriftStatusBar`、`W5B_STRICT_BOUNDARY`、`EDITOR_SURFACE_NOTE_PAPER`；
  4. 终审审查确认：**解耦彻底，前后端无残留死循环调用链路**。

### 2.3 主编辑区 100% 弹性全高视口恢复
- **CSS 几何结构核查**：
  - 原容器存在 `border-radius: 8px`、边框与悬浮阴影，导致笔记与分屏边缘出现割裂感；
  - 详案重构 `.panel`：
    ```css
    .panel {
      display: flex;
      flex-direction: column;
      flex: 1 1 0%;
      height: 100%;
      min-height: 0;
      width: 100%;
      background: var(--bg-card);
      border-radius: 0;
      border: none;
      box-shadow: none;
      overflow: hidden;
      box-sizing: border-box;
    }
    ```
  - 重构 `.body`：
    ```css
    .body {
      display: flex;
      flex-direction: column;
      flex: 1 1 0%;
      height: 100%;
      min-height: 0;
      width: 100%;
      overflow: auto;
      background: var(--bg-card);
    }
    ```
  - 终审评估：彻底释放了底部灰色块霸占的 70~110px 宝贵垂直空间，恢复 100% 弹性全高纯净书写视口。

---

## 3. 32px 顶栏重塑与测试平滑迁移审查

### 3.1 32px 紧凑顶栏（NotePaperHeader）与产品级功能矩阵
- **DOM 拓扑核查**：
  - 顶栏高度严格死锁为 32px（`height: 32px; min-height: 32px; max-height: 32px;`），与系统其他卡片顶栏（DiffCard、FilesCard）像素级一致；
  - 彻底拔除了原顶栏堆砌的 `W5-B/strict`、`rev={resolvedRev}`、`139 块`、`slash=writable` 等开发者底层调试探针；
  - 功能矩阵由低质调试态转为生产力套件：
    - **左侧**：侧栏展开/收起开关 + 笔记图标 + `EditableTitle` 行内编辑 + 柔和保存状态徽标；
    - **右侧**：`wordCountBadge`（字数统计）+ 复制全文 Markdown + 导出 .md 文件 + 刷新 + 清空（确认弹窗）+ 关闭标签。

### 3.2 EditableTitle 与 Tabular-Nums CSS 规约开箱即用性
- **焦点对比度规约（AGENTS.md §13 刚性校验）**：
  - 详案中 `.titleInput` 的静态边框使用：
    `border: 1px solid color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);`
  - 激活/获得焦点态使用：
    `border-color: color-mix(in srgb, var(--border-color) 85%, var(--text-primary) 15%);`
    `box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 8%, transparent);`
  - 混入比严格控制在 10%~15% 的微弱柔和区间，彻底杜绝粗实黑边和强对比阴影；
- **排版稳定性校验**：
  - 字数统计徽标 `.wordCountBadge` 显式声明：
    `font-variant-numeric: tabular-nums;`
    `font-family: var(--font-mono);`
  - 当笔记字数从 999 变为 1000 时，等宽字符宽度保持不变，顶栏右侧按钮绝无微晃抖动。
- **Tooltip 规范（BUG-V06 校验）**：
  - 详案 03 第 188-198 行显示 `EditableTitle` 外层使用 `<Tooltip content="点击编辑笔记标题">` 包裹，所有操作按钮统一封装为标准原子 `<Tooltip>`，零原生 HTML `title` 属性。

### 3.3 NotePaperPanel.insulate.test.ts 绝缘测试平滑迁移审查 (BUG-T01)
- **现场破损点审查**：
  - 现场代码 [`apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts:31-40, 54`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.insulate.test.ts#L31-L40)：
    ```typescript
    it('含 .panel > .header / .footer，flex: 0 0 auto 且 max-height: none', () => {
      expect(css).toContain('.panel > .header');
      expect(css).toContain('.panel > .footer'); // 🔴 删除 .footer 后此处必定红灯！
      const chrome = ruleBlockAfter(css, '.panel > .header,'); // 🔴 逗号硬匹配！
      ...
    });
    ```
- **详案协同迁移方案核实**：
  1. 测试用例重塑为“顶栏与主体绝缘契约”，移除对 `.panel > .footer` 存在的断言，追加负向断言：
     ```typescript
     expect(css).toMatch(/\.panel\s*>\s*(?:\.compactHeader|\.header)/);
     expect(css).not.toMatch(/\.panel\s*>\s*\.footer/);
     ```
  2. 辅助函数 `ruleBlockAfter` 调用移除多余的英文逗号（改为匹配 `.panel > .compactHeader` 或 `.panel > .header`）；
  3. 原 `footer` 中断言的 `W5B_STRICT_BOUNDARY` 会计边界下沉至 `<section data-boundary={W5B_STRICT_BOUNDARY}>`，并在 `NotePaperStrictPanel.test.tsx` 中追加：
     `expect(screen.queryByTestId('note-paper-strict-footer')).toBeNull();`
  4. 终审评估：**迁移方案既守护了组件 CSS 绝缘契约，又彻底杜绝了 CI 门禁报红，完全放行**。

---

## 4. SQLite v8 迁移与 Rust IPC 命令闭环审查

### 4.1 SQLite Migration v8 幂等性与版本门闩审查 (BUG-A04)
- **现场代码审计**：
  - 当前 Rust 仓库 [`crates/conex-workspace-store/src/lib.rs:131`](file:///c:/Software/conex/crates/conex-workspace-store/src/lib.rs#L131) 声明：
    `pub const SCHEMA_VERSION: i64 = 7;`
- **详案升级逻辑核实**：
  1. **抬升版本常量**：升级为 `pub const SCHEMA_VERSION: i64 = 8;`；
  2. **加列操作纯幂等**：通过 `ensure_column` 为 `doc_meta` 扩充 `title`、`created_at`、`is_pinned`、`is_archived`、`tags_json`；
  3. **复合覆盖索引**：`CREATE INDEX IF NOT EXISTS idx_doc_meta_list ON doc_meta(is_archived, is_pinned DESC, updated_at DESC);`，支撑侧栏秒级响应；
  4. **版本门闩（BUG-A04 补丁）**：
     - `backfill_legacy_doc_meta(conn)` 严格封装在 `if current_version < 8 { ... }` 分支内，仅在老版本升至 v8 时执行一次；
     - 回填语句限定 `SELECT doc_id FROM doc_meta WHERE title = '无标题笔记'`，绝不触碰已有标题；
     - 终审提醒实施波：在截断标题时，必须使用字符感知（`chars().take(30)` 或 grapheme），防止中文字符序列断裂。

### 4.2 Tauri IPC 注册闭环五重防线审查 (T-F 06 刚性门禁)
现场代码验证显示，Tauri IPC 命令注册受到多重测试与清单刚性守护。详案 04 规划的四大命令（`list`, `create`, `rename`, `delete`）必须形成以下完整的**五重闭环**：

```
[1. 底层存储] crates/conex-workspace-store/src/store_backend.rs
      │ (实现 list_documents, create_document, rename_document, delete_document)
      ▼
[2. 命令声明] apps/agent-workbench/src-tauri/src/note_commands.rs
      │ (声明 #[tauri::command] note_document_* 并在模块头 pub use 导出)
      ▼
[3. Tauri 宏注册] apps/agent-workbench/src-tauri/src/main.rs
      │ (在 command_registry! 宏中注册 4 个二元组)
      ▼
[4. Rust 清单真源] apps/agent-workbench/src-tauri/src/command_manifest.rs
      │ (COMMAND_MANIFEST 追加 4 条目，总数/注册面由 131 更新为 135，更新单测)
      ▼
[5. 前端快照与单测] apps/crish-desktop/src/api/transport/commandManifest.ts
        (BUILTIN_COMMAND_MANIFEST 同步追加 4 条目，commandManifest.test.ts 更新条数 135)
```
- **终审评估**：详案清晰锁定了这一闭环，消除了历史单点修改导致的 `command-contract-drift` 门禁爆红风险。

### 4.3 状态机 Generation Token 与未保存数据刷盘审查 (BUG-A05)
- **竞态场景推演**：
  - 用户在 100ms 内快速连点侧栏的 10 篇笔记，若依赖异步 Promise 回调且无取消机制，耗时较长的旧请求滞后 resolve 会无差别覆盖新请求的内容。
- **详案防卫架构核实**：
  1. **请求序列令牌（Generation Token）**：
     - 在 `useNoteHydrate.ts` 与 `useNoteDocumentManager.ts` 中维护 `const fetchGenerationRef = useRef(0);`；
     - 每次发起请求时 `const currentToken = ++fetchGenerationRef.current;`；
     - 在 Promise 完成时严格比对 `if (currentToken !== fetchGenerationRef.current) return;`，过期返回直接丢弃；
  2. **切换前自动刷盘（Flush Dirty Before Switch）**：
     - 在执行 `switchDocument(targetDocId)` 前，检测 `if (isDirty)`，优先执行 `await flushCurrentDocument()`，确保编辑草稿安全写入 SQLite 后再切换 ID；
  3. **React Key 物理重置子树**：
     - 编辑器外层挂载 `<NotePaperStrictPanel key={activeDocId} docId={activeDocId} />`；
     - 切换时由 React 协调器彻底卸载旧实例，IME 拼音合成态、光标焦点与撤销栈彻底重置，杜绝跨文档串染。

### 4.4 彻底抹除假回收站审查 (BUG-A06)
- **审查结论**：
  - 详案 04 彻底抹除了侧栏底部的“回收站”项；
  - 删除交互收敛为：侧栏笔记卡片右上角 `...` 菜单提供 `删除笔记`，点击后弹出标准 `ConfirmDialog` 二次确认弹窗，确认后真实触发 `note_document_delete` IPC 并刷新侧栏；
  - 零假图标、零伪连通，完全符合架构单轨与诚实开发红线。

---

## 5. 实施阶段首轮代码修改操作清单（Checklist）

实施波代理必须严格按照**“先删死代码、再建新单轨、最后更新门禁”**的逻辑顺序推进首轮代码修改：

### 阶段 1：死代码与灰色块物理清剿（先删）
- [ ] **S1.1 清理 `NotePaperStrictPanel.tsx`**：
  - 物理删除 lines 252-266 的 `<MirrorDriftStatusBar>` 与 `<footer>` 节点；
  - 移除 `MirrorDriftStatusBar`、`W5B_STRICT_BOUNDARY`、`EDITOR_SURFACE_NOTE_PAPER` 的 import；
  - 从组件 Props 接口中移除 `mirrorDriftReport`, `mirrorWatchSource`, `mirrorUnpushedOpCount`, `showMirrorDriftBar`, `onMirrorThreeWay` 5 项废弃属性；
  - 根容器 `<section>` 补充 `data-boundary={W5B_STRICT_BOUNDARY}`。
- [ ] **S1.2 切除 `NoteLeafHost.tsx` 轮询**：
  - 将 `enableMirrorDetectSchedule` 设为 `false`，停止定时检测轮询；
  - 移除传递给 `NotePaperStrictPanel` 的 4 项死 Props。
- [ ] **S1.3 清理 `NotePaperPanel.module.css` 95 行死样式**：
  - 物理删除 lines 542-625（11 个漂移状态栏样式）与 lines 530-538（`.footer` 规则）；
  - 删除 `.badge`、`button.badge`、`.badgeSilent` 等遗留类。
- [ ] **S1.4 标记清退 `MirrorDriftStatusBar.tsx`**：
  - 物理清空或标记废弃 293 行的死组件。

### 阶段 2：32px 紧凑顶栏与视口重塑（改）
- [ ] **S2.1 重写 `NotePaperStrictHeader.tsx`**：
  - 肃清 `W5-B/strict`、`rev=4`、`139 块`、`slash=writable` 等调试标签；
  - 接入 `EditableTitle` 行内编辑组件与侧栏折叠触点；
  - 右侧挂载等宽字数徽标（`wordCountBadge`）与操作按钮组（复制/导出/清空/关闭），全量套用原子 `<Tooltip>`。
- [ ] **S2.2 补齐 CSS 32px 规范 (`NotePaperPanel.module.css`)**：
  - 写入 `.compactHeader`（32px 死锁）、`.headerLeftGroup`、`.headerRightGroup`；
  - 写入 `.titleInput`（焦点边框使用 10%~15% 混入比，满足 AGENTS.md §13）；
  - 写入 `.wordCountBadge`（`tabular-nums` + `font-mono`）；
  - 重构 `.panel` 与 `.body`（`flex: 1 1 0%; height: 100%; border-radius: 0;`）。

### 阶段 3：SQLite v8 与 Rust IPC 五重闭环（扩）
- [ ] **S3.1 SQLite Migration v8 (`crates/conex-workspace-store`)**：
  - 在 `lib.rs` 中将 `SCHEMA_VERSION` 升级为 `8`（注意类型保持 `i64`）；
  - 在 `migrate.rs` 中通过 `ensure_column` 为 `doc_meta` 扩列；
  - 在 `if current_version < 8` 中带门闩执行 `backfill_legacy_doc_meta`；
  - 在 `store_backend.rs` 中实现 `list_documents`, `create_document`, `rename_document`, `delete_document`。
- [ ] **S3.2 Tauri IPC 闭环与清单同步**：
  - 在 `note_commands.rs` 暴露 4 个命令实现并 `pub use`；
  - 在 `apps/agent-workbench/src-tauri/src/main.rs` 的 `command_registry!` 注册 4 个命令；
  - 在 `command_manifest.rs` 追加 4 条目，总数/注册数 131 $\to$ 135，更新 `manifest_count_matches_registered_surface`；
  - 在前端 `commandManifest.ts` 追加 4 条目；
  - 在前端 `commandManifest.test.ts` 更新条数断言为 135。

### 阶段 4：前端多笔记状态机与 Master-Detail 交互（联）
- [ ] **S4.1 状态机落地 (`useNoteDocumentManager.ts`)**：
  - 落地 `fetchGenerationRef` 序列令牌防异步乱序；
  - 落地 `switchDocument` 前 `flushDirtyBeforeSwitch` 自动刷盘逻辑；
  - 废黜 `strict-${wsId}` 死锁，改由活动文档 ID 驱动。
- [ ] **S4.2 响应式侧栏抽屉 (`NoteSidebarDrawer.tsx`)**：
  - 220px 宽度可折叠侧栏，包含 `+ 新建笔记`、搜索框、笔记列表（按更新时间倒序）；
  - 卡片集成置顶标记、修改时间、删除菜单（带二次确认）；
  - **绝对不挂假回收站图标**。
- [ ] **S4.3 主宿主组装 (`NoteLeafHost.tsx`)**：
  - 组装顶栏、侧栏与主编辑区；
  - 严格绑定 `<NotePaperStrictPanel key={activeDocId} docId={activeDocId} />`。

### 阶段 5：测试契约平滑协同更新（验）
- [ ] **S5.1 协同更新 `NotePaperPanel.insulate.test.ts`**：
  - 更新 lines 31-40，移除 `.panel > .footer` 包含断言，改为 `.not.toContain('.panel > .footer')`；
  - 修正 `ruleBlockAfter(css, '.panel > .header')` 选择器匹配。
- [ ] **S5.2 协同更新 `NotePaperStrictPanel.test.tsx` 与 `WorkspaceEmptyState.strict.test.tsx`**：
  - 将原先在 footer 上断言的 `W5B_STRICT_BOUNDARY` 迁移至 section 的 `data-boundary`；
  - 追加 `expect(screen.queryByTestId('note-paper-strict-footer')).toBeNull();`。
- [ ] **S5.3 跑通全量门禁**：
  - `cargo test -p conex-workspace-store`
  - `cargo test --bin conex-agent-workbench`
  - `npm run typecheck`
  - `npx vitest run src/components/note-paper`
  - `npx vitest run src/api/transport/commandManifest.test.ts`

---

## 6. 终审结论总结

分维详案 03 与分维详案 04 经深度交叉审查，在**彻底拔除灰色调试噪点、规范 32px 紧凑顶栏、加固 SQLite 幂等迁移、构建五重 IPC 闭环、消除高频并发乱序、以及杜绝功能伪实现**等关键架构维度上已形成完全闭环的实施指南。

**终审准入结论：【准入实施（PASS）】。同意全面放行进入阶段六实施波（Phase 6 Implementation）。**
