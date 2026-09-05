# 战役：差异面板与笔记面板系统性重构 —— 全局架构与深层逻辑终极审计报告 (AUDIT-GLOBAL-ARCH-FINAL)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）  
> **审计编号**：AUDIT-GLOBAL-ARCH-FINAL (03)  
> **所属阶段**：阶段五 · 全景架构与深层逻辑终极闭环审计（Phase 5 Final Closure Audit）  
> **审计席位**：全局架构与深层逻辑审计官（Global Architecture & Deep Logic Auditor）  
> **审计对象**：`docs/diff-view-redesign/` 下全部核心方案资产：
> - [`docs/diff-view-redesign/00-总方案-差异与笔记面板系统性重构全景架构总纲.md`](file:///c:/Software/conex/docs/diff-view-redesign/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E5%B7%AE%E5%BC%82%E4%B8%8E%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF%E7%B3%BB%E7%BB%9F%E6%80%A7%E9%87%8D%E6%9E%84%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E6%80%BB%E7%BA%B2.md) (MASTER-PLAN-00)
> - [`docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/01-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%B7%AE%E5%BC%82%E9%9D%A2%E6%9D%BF%E5%B9%B3%E7%9B%B4%E5%88%97%E8%A1%A8%E7%9B%B4%E8%A7%92%E5%8C%96%E4%B8%8E32px%E7%B4%A7%E5%87%91%E6%9E%B6%E6%9E%84.md) (DETAIL-PLAN-01)
> - [`docs/diff-view-redesign/02-分维详案-行内工具条物理拔除与代码比对专注化.md`](file:///c:/Software/conex/docs/diff-view-redesign/02-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E8%A1%8C%E5%86%85%E5%B7%A5%E5%85%B7%E6%9D%A1%E7%89%A9%E7%90%86%E6%8B%94%E9%99%A4%E4%B8%8E%E4%BB%A3%E7%A0%81%E6%AF%94%E5%AF%B9%E4%B8%93%E6%B3%A8%E5%8C%96.md) (DETAIL-PLAN-02)
> - [`docs/diff-view-redesign/03-分维详案-文件名超链接单轨接线独立预览Tab与全域Tokens规范.md`](file:///c:/Software/conex/docs/diff-view-redesign/03-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E6%96%87%E4%BB%B6%E5%90%8D%E8%B6%85%E9%93%BE%E6%8E%A5%E5%8D%95%E8%BD%A8%E6%8E%A5%E7%BA%BF%E7%8B%AC%E7%AB%8B%E9%A2%84%E8%A7%88Tab%E4%B8%8E%E5%85%A8%E5%9F%9FTokens%E8%A7%84%E8%8C%83.md) (DETAIL-PLAN-03)
> - [`docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md`](file:///c:/Software/conex/docs/diff-view-redesign/04-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%85%A8%E5%9F%9FTokens%E8%A7%84%E8%8C%83%E9%87%8D%E6%9E%84%E4%B8%8ESLoHT%E5%8D%95%E5%B1%82Hover%E4%BD%93%E7%B3%BB.md) (DETAIL-PLAN-04)
> - [`docs/diff-view-redesign/05-分维详案-笔记面板32px紧凑顶栏重塑与底部调试块彻底拔除.md`](file:///c:/Software/conex/docs/diff-view-redesign/05-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF32px%E7%B4%A7%E5%87%91%E9%A1%B6%E6%A0%8F%E9%87%8D%E5%A1%91%E4%B8%8E%E5%BA%95%E9%83%A8%E8%B0%83%E8%AF%95%E5%9D%97%E5%BD%BB%E5%BA%95%E6%8B%94%E9%99%A4.md) (DETAIL-PLAN-05)
> - [`docs/diff-view-redesign/06-分维详案-多笔记综合管理体系与SQLite及IPC后端架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/06-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%A4%9A%E7%AC%94%E8%AE%B0%E7%BB%BC%E5%90%88%E7%AE%A1%E7%90%86%E4%BD%93%E7%B3%BB%E4%B8%8ESQLite%E5%8F%8AIPC%E5%90%8E%E7%AB%AF%E6%9E%B6%E6%9E%84.md) (DETAIL-PLAN-06)
> - [`docs/diff-view-redesign/07-分维详案-立体验证套件与回归测试平滑迁移.md`](file:///c:/Software/conex/docs/diff-view-redesign/07-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF32px%E7%B4%A7%E5%87%91%E9%A1%B6%E6%A0%8F%E9%87%8D%E5%A1%91%E4%B8%8E%E5%BA%95%E9%83%A8%E8%B0%83%E8%AF%95%E5%9D%97%E5%BD%BB%E5%BA%95%E6%8B%94%E9%99%A4.md) (DETAIL-PLAN-07)
> - `docs/diff-view-redesign/plan-reviews/` 下全部 6 份评审与反幻觉报告 (01 至 06)  
> **审计基准**：用户最高指示（“系统性做，先考虑架构。以及避免双轨或者多轨、硬编码、功能伪实现、伪连通。项目中的代码应该是清晰的、单轨的、最先进的代码。越简单越好，现在功能多了用户反而不知道怎么用了。给出诚实、深刻、切中要害的审计意见。有就是有，没有别强行搞事情。”）、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1、§3、§7、§7.1、§8、§9、§12-14、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。

---

## 终审摘要与结论判定

经过对 `docs/diff-view-redesign/` 下 1 份总纲、7 份分维详案、6 份评审报告以及真实代码库（Rust `crates/conex-workspace-store`、Tauri 壳 `apps/agent-workbench`、前端 `apps/crish-desktop`）的立体深度穿透，本全局架构审计官秉持**“实事求是、穿透表象、绝不粉饰、不强行找茬”**的原则，给出全局终审结论：

**【综合裁决】：CONDITIONAL BLOCK（重大逻辑冲突阻断 · 存在 3 处深层架构断层与 2 组严重跨方案打架，必须收敛定稿后方可实施）**

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 全局架构与深层逻辑审计三问核心判词                                  │
├─────────────────────────┬───────────────────┬──────────────────────────────────────────────────────┤
│ 审计核心维度             │ 裁决定性          │ 穿透本质与核心证据                                   │
├─────────────────────────┼───────────────────┼──────────────────────────────────────────────────────┤
│ 1. 方案深层架构问题     │ 存在 3 处核心断层 │ ① Diff 简陋旁路删除系“虚假宣称”，03 代码原样保留；    │
│                         │                   │ ② 时间戳单位发生反向灾难（00 毫秒 vs 06 秒级 /1000）；│
│                         │                   │ ③ 多笔记与右侧 Tab 体系存在双层导航割裂；冷启动白屏。 │
├─────────────────────────┼───────────────────┼──────────────────────────────────────────────────────┤
│ 2. 方案过度设计排查     │ 存在典型过度设计  │ ① 数据库塞入 tags/archived/pinned，UI 层却无闭环交互；│
│                         │                   │ ② 同造 220px 覆盖抽屉与顶栏下拉，窄坞视口严重内卷。   │
├─────────────────────────┼───────────────────┼──────────────────────────────────────────────────────┤
│ 3. 跨方案深层逻辑打架   │ 实锤 2 组严重打架 │ ① 03 详案完全脱缰，DOM 类名与数据流与 01/02/04 互斥； │
│                         │                   │ ② 05 与 06 组装层断裂，05 没挂载抽屉，06 缺少集成主宿主。│
└─────────────────────────┴───────────────────┴──────────────────────────────────────────────────────┘
```

---

# 一、【方案有没有深层架构问题？】

## 1.1 差异面板：剥离行内工具栏后，代码比对区是否真正做到了纯粹专注？

### (1) 正向架构收益：行内专注化基本确立
- **视口物理释放**：01 与 02 详案将原本夹在每个差异条目与比对代码之间的 36px 行内工具条（`_inlineHeader_`）彻底切除，代码展开后的垂直视口高度净增加 36px；
- **消除破坏性假实现**：成功拔除了在 Git 模式下容易破坏源码的 `acceptCurrentFile` 以及纯前端数组过滤的欺骗性 `rejectCurrentFile`；
- **职责清晰归位**：单文件的展开区域（`.diffPane`）收敛为仅负责渲染 `DiffCodeViewer`，将比对、词法高亮与折叠对齐作为唯一核心职责。

### (2) 致命深层问题：00 总方案声称的“清退简陋手写 Diff 旁路”属于虚假宣称！
- **总方案的宣称**：
  - `00-总方案` 第 77-78 行（痛点 5）严厉痛批：“*系统存在三套独立的 Diff 渲染链路……以及 FileViewerCard.tsx:148-179 内部手写的 30 行简陋文本对比函数 renderSimpleDiff()。手写代码不支持语法高亮、不支持对偶分栏配对，纯字符串粗暴拼接，严重违背单一真理源（SSOT）原则。*”
  - `00-总方案` 第 469-473 行（细目 10）明确列入物理删除清单：“*物理删除 FileViewerCard.tsx 内部手写简陋对比旁路 32 行 (TSX)*”。
- **现场实锤打脸**：
  - 查阅 `03-分维详案` 第 1227-1279 行给出的 `FileViewerCard.tsx` 全量落盘级代码：
    ```tsx
    // 03-分维详案 L1227-1249 真实代码：
    // 手写简单对比渲染，不污染主 diff 状态机
    const renderSimpleDiff = () => {
      if (!f || !f.changes || f.changes.length === 0) {
        return (
          <div className={styles.diffEmpty}>
            <span>该文件目前没有本地改动</span>
          </div>
        );
      }

      return (
        <div className={styles.diffContainer}>
          {f.changes.map((line, idx) => {
            let typeClass = '';
            let prefix = ' ';
            if (line.type === 'addition') {
              typeClass = styles.diffAddition ?? '';
              prefix = '+';
            ...
    ```
  - **穿透本质**：**03 详案在全量实施代码中，根本没有删除这个手写的 `renderSimpleDiff`！** 甚至连注释都原封不动保留着。
  - **严重后果**：如果按 00 总方案把 `renderSimpleDiff` 删了，由于 03 详案没有在 `FileViewerCard` 中引入 `DiffCodeViewer` 或复用单轨比对组件，独立 Tab 在 `mode=diff` 下直接没有比对渲染逻辑；如果不删，则所谓的“消灭手写 Diff 旁路、清除三轨分叉”完全是一纸空文！

---

## 1.2 超链接打开独立 Tab 与现有右侧栏系统是否真正单轨无断层？

### (1) 肯定面：Canonical Tab ID 规则成立
- 03 详案确立的 `file-viewer:${normalizedPath}` 契约（盘符大写、剥离 `./`、保护 UNC）能够有效防范字符串不匹配导致的 Tab 爆炸式分裂，符合右侧坞 `dock.openPanelIds` 的查重逻辑。

### (2) 深层架构断裂：微事件模式覆盖通道存在时序赛马与脆弱性
- **HAL-06 微事件补丁的时序漏洞**：
  - 方案设计：`openFileViewerInSession` 先写入 `setFileViewerModeOverride(canonicalTabId, initialMode)`，再调用 `window.dispatchEvent(new CustomEvent('conex:file-viewer-mode'))`，最后调用 `openToolInLeaf`。
  - **热激活场景（Tab 已存在）**：`FileViewerCard` 已挂载，监听器收到事件即时 `setViewMode(mode)`，通道畅通；
  - **冷启动场景（Tab 首次打开）**：`FileViewerCard` 在 `main.tsx` 中是通过 `React.lazy` 异步动态加载的。当微事件在当前任务末尾派发时，`FileViewerCard` 甚至还没有完成模块加载与 DOM 挂载，**此时根本没有任何事件监听器在监听**！虽然冷启动能通过 `consumeFileViewerModeOverride` 拿到初始值，但这种“冷启动靠内存 Map，热激活靠全局 window 事件”的双轨补丁，极易因 React 并发调度、页面失焦或多窗口通信产生状态脱节。
- **右侧栏视口抢占与叶子节点切模竞争**：
  - 现行 Conex 架构中，`diff` 面板本身就是挂在右侧工具坞（`BinaryTree` 的叶子节点）内的一个 Tab（`panelId: 'diff'`）；
  - 当开发者在 Diff 列表点击文件名超链接时，调用 `openToolInLeaf(activeLeafId, canonicalTabId)`，会导致该叶子节点的 `activePanelId` 直接从 `'diff'` 切换为 `'file-viewer:...'`；
  - **现象**：用户点击超链接本意是“一边看差异列表，一边看文件详情”，结果当前叶子直接切走了 Diff 列表，被 FileViewer 完全盖住。用户必须手动点回 Tab 栏的 Diff 才能重新看到列表。方案未设计分栏策略（如 `splitLeaf`）或主从并排机制。

---

## 1.3 笔记面板：多笔记综合管理（SQLite 8列 + 4大IPC + 侧栏抽屉/下拉）架构是否真正成立？

### (1) 成立面：IPC 与 SQLite 迁移底座稳固
- SQLite Migration v8 引入版本门闩（`current_version < 8`），结合幂等 `ensure_column`，保证了数据库升档不会破坏底层已有表结构；
- 4 大 IPC 命令（`note_document_list`, `note_document_create`, `note_document_rename`, `note_document_delete`）补齐了 CRUD，且在 Tauri 宏、清单导出、前端快照与测试中形成了五重闭环（131 $\to$ 135）。

### (2) 致命架构断层 1：时间戳单位反向冲突（毫秒 vs 秒，HAL-03 虚假修复实锤）
- **00 总方案口径**：第 360 行明确裁决：“**全系统对齐毫秒！** SQLite DDL 统一使用 `strftime('%s','now') * 1000`；读取映射时对 `< 10_000_000_000` 的存量秒级数据自动 `* 1000` 兼容归一化。”
- **06 详案真实代码（第 640-649 行）**：
  ```rust
  // 06 详案代码现场：
  // 归一化时间戳为 10 位标准秒级（若历史数据含有毫秒级则安全除以 1000 消除错乱）
  let created_at = if self.created_at > 10_000_000_000 {
      self.created_at / 1000
  } else {
      self.created_at
  };
  ```
- **穿透本质**：00 总方案声称 100% 吸收了反幻觉裁决，但在 06 详案落盘代码中，**依然在执行相反的 `/ 1000`（除以 1000 变秒级）**！
- **毁灭性后果**：前端 `useNoteDocumentManager.ts` 第 738 行使用 `Date.now()`（13 位毫秒），若 Rust 端按 06 详案返回 10 位秒级时间戳，前端 `formatRelativeTime` 会将时间解析为 1970 年 1 月；而一旦用户重命名更新，13 位毫秒又被写回，导致笔记在列表中的排序彻底错乱颠倒！

### (3) 致命架构断层 2：冷启动空数据白屏崩溃（Empty Fallback Missing）
- 现有代码库的单篇笔记是强行绑定默认 ID `strict-default`（或 `strict-${wsId}`）运行的；
- 按照 06 详案的状态机实现：
  ```typescript
  if (res.status === 'ok') {
    setDocuments(res.data.documents);
    if (!activeDocId && res.data.documents.length > 0) {
      setActiveDocId(res.data.documents[0].id);
    }
  }
  ```
- 若为一个空工作区，`res.data.documents` 返回 `[]`，`activeDocId` 被置为 `""`；
- 下游 `NotePaperStrictPanel` 接收到 `docId=""` 时，CRDT 水合直接异常，且界面既无激活文档也无空态保护，直接陷入无响应或控制台白屏报错。方案完全缺失“空库初次加载自动创建首篇空白笔记”的自愈逻辑。

---

## 1.4 多笔记与右侧 Tab 系统的关系是什么？

### 架构层级严重割裂：外层 Tab 栏与内层抽屉的双重导航悖论
- **右侧栏系统现状**：Conex 的右侧工作区坞本身就是一个专业的多标签页系统（`LeafToolTabStrip`），并且代码库（`apps/crish-desktop/src/extensions/note-paper/noteUri.ts`）原生支持动态注册 URI `note:<docId>`；
- **方案的设计**：方案 05/06 却把多文档系统封闭在一个名为 `note` 的单一 Tab 内，在组件内部自建了一套 220px 覆盖式抽屉（`NoteSidebarDrawer`）来切换笔记；
- **产生的心智断裂**：
  - 如果外部通过链接唤起了 `note:doc_2` 标签页，右侧 Tab 栏会显示一个 `note:doc_2` 标签；
  - 此时用户在标签页内部的抽屉里又点击切换到了 `doc_1`；
  - **结果**：外层 Tab 栏写着 `doc_2`，内层却在编辑 `doc_1`！外层 Tab 身份（Identity）与内层文档状态（State）发生严重双轨漂移。方案完全没有厘清“Tab 作为文档容器”与“面板内部管理”的边界。

---

## 1.5 历史单篇笔记升级后会不会丢失？

### (1) 物理数据层面：不会丢失
- 数据库底层存储基于 SQLite。升级至 v8 是通过 `ensure_column` 执行 `ALTER TABLE ADD COLUMN`，既有 `doc_meta`、`doc_snapshots`、`blocks` 中的历史数据行不会被物理删除。原 `doc_id = 'strict-default'` 的记录依然安然无恙。

### (2) 用户交互与呈现层面：存在“空标题裸奔”与找回困难
- **未实现的标题回填**：`00-总方案` 第 636 行伪代码写着 `backfill_legacy_doc_meta_once(conn)?;`，但在 06 详案代码中**完全没有该函数的定义与实现**；
- **现场后果**：历史老笔记升级后，其 `title` 列为 SQLite 默认的空字符串 `""`。在抽屉列表中它将显示为“未命名笔记”；如果用户曾经写过多篇或多次草稿，列表将出现一堆无区分度的空白项，历史笔记体验严重退化。

---

# 二、【方案有没有过度设计？】

## 2.1 违背用户“越简单越好”原则：半吊子“三废字段”（Tags / Archive / Pin）

用户在现场给出的最高指示极为直白：  
> *“去掉每个文件列表里面的顶部工具行，越简单越好，现在功能多了用户反而不知道怎么用了……因为笔记不可能只有一个，以及笔记没有一个综合的管理界面，现在只能看一个类似于硬编码的标签界面了，这和展示没什么区别。了解清楚了，这个也一起加进去。”*

用户要求的是：**从只能看 1 篇硬编码笔记，升级为可以管理多篇笔记（创建、重命名、删除、切换）**。  
然而审查 06 详案的数据库与领域模型：

```sql
-- 06 详案 doc_meta 表结构：
doc_id TEXT PRIMARY KEY NOT NULL,
rev INTEGER NOT NULL DEFAULT 0,
updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
title TEXT NOT NULL DEFAULT '',
created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
is_pinned INTEGER NOT NULL DEFAULT 0,       -- ⚠️ 过度设计 1
is_archived INTEGER NOT NULL DEFAULT 0,     -- ⚠️ 过度设计 2
tags_json TEXT NOT NULL DEFAULT '[]'        -- ⚠️ 过度设计 3
```

### 逐项穿透打脸：
1. **`tags_json`（标签系统）**：
   - 数据库建了 JSON 列，Rust 实体定义了 `tags: Vec<String>`，前端状态机写了 `d.tags.some(...)`；
   - **现场真相**：翻遍 05 与 06 详案全部 UI 代码，**根本没有一个地方提供添加标签、删除标签、选择标签或管理标签的界面！** 甚至连标签在卡片上的渲染都省略了。这是一个典型的“底层画大饼、上层无实现”的伪特性。
2. **`is_archived`（归档/软删除）**：
   - IPC 命令设计了 `include_archived`，数据库建立了复合降序索引 `ON doc_meta(is_archived, ...)`；
   - **现场真相**：前端 `useNoteDocumentManager.ts` 第 707 行写死 `include_archived: false`；抽屉 UI 只有物理硬删除，根本没有“查看归档”、“移入归档”、“从归档恢复”的入口。`is_archived` 沦为百分之百的死逻辑。
3. **`is_pinned`（置顶系统）**：
   - 卡片上虽然写了 `{doc.isPinned && <Lucide.Pin />}`；
   - **现场真相**：UI 上**没有任何触发“置顶 / 取消置顶”的按钮或快捷操作**，也没有设计 `pin_document` 的 IPC 通道。只有展示，无法操作！

**审计定性**：这 3 项功能完全分散了核心开发精力，增加了 3 列无用字段与复杂的复合索引，严重违背了仓库根目录 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md) 的反过度设计红线！

---

## 2.2 交互通道严重内卷：抽屉（Drawer）与下拉（Dropdown）双轨并存

- 在 06 详案中：
  - 第 5.1 节实现了 220px 可折叠侧栏抽屉 `NoteSidebarDrawer.tsx`（长达 230 行）；
  - 第 5.2 节又实现了一个顶栏下拉切换器 `NoteDocumentDropdown.tsx`（长达 190 行）；
- **病理分析**：
  - 在宽度通常只有 320px~450px 的右侧工作区坞中，拉出一个 220px 的绝对定位抽屉，会直接遮挡 60% 以上的笔记正文，视口极其逼仄；
  - 而下拉菜单（Dropdown）在顶栏本可以轻量优雅地完成“切换当前笔记”的核心任务；
  - 方案设计者既舍不得抽屉的复杂列表，又想做顶栏的快速下拉，搞出了一套相互打架的双重交互，徒增代码维护包袱。

---

# 三、【8 份方案之间到底有没有在深层逻辑上打架？】

答案是：**不仅有打架，而且在核心组件 `DiffCardFileList` 与 `NotePaper` 上形成了不可调和的逻辑撕裂！**

---

## 3.1 差异面板：01、02、03、04 对 `DiffCardFileList` 的改造最终结果是否完全收敛？

**终审判定：完全没有收敛！03 详案与 01/02/04 形成了灾难性的逻辑与代码冲突！**

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        DiffCardFileList.tsx 重构代码在四份详案中的严重打架对照表                        │
├───────────────────┬───────────────────────────────────────┬────────────────────────────────────────────┤
│ 对照维度          │ 01、02、04 详案收敛基准 (SSOT)        │ 03 详案脱缰异化代码 (第 1480-1630 行)       │
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 1. 折叠指示类名   │ styles.chevronBtn                     │ styles.accordionToggleBtn (旧手风琴复活)   │
│                   │ styles.chevronIcon                    │ styles.accordionChevron                    │
│                   │ styles.expanded                       │ styles.chevronOpen                         │
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 2. 文件名超链接   │ 包裹在 div.pathWrap 内                │ 无 pathWrap，直接放 Tooltip > button       │
│    文本类名       │ styles.fileName                       │ styles.fileNameText                        │
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 3. 中间空白与统计 │ 并列在 div.statAndActions 中          │ 造出莫名其妙的 div.accordionFiller 填充块  │
│    统计增减类名   │ styles.statAdd / styles.statDel       │ styles.addStat / styles.delStat            │
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 4. Git 操作组容器 │ styles.rowActions (并排 Flex 布局)    │ styles.hoverActions (延续旧版绝对定位覆盖) │
│                   │ styles.rowActBtn                      │ styles.rowActBtn                           │
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 5. 架构解耦契约   │ 遵循 Props 单向流动:                  │ 严重违规深层耦合:                          │
│                   │ onOpenFileViewer?: (path) => void     │ Props 中剔除 onOpenFileViewer，            │
│                   │ 由父组件统一处理                      │ 内部直接 import { openFileViewerInSession }│
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 6. 状态徽章解析   │ 调用 resolveStatusBadge(f)            │ 手写 f.staged ? 'S' : ...                  │
│                   │ 解析 M / A / D / R 并绑定颜色样式类   │ 多出非标 'S' 且无独立着色类                │
├───────────────────┼───────────────────────────────────────┼────────────────────────────────────────────┤
│ 7. 原生 title     │ 01 包含 title 违规；02 拔除但无Tooltip│ 使用 Tooltip 包裹 (符合 §12 门禁)          │
└───────────────────┴───────────────────────────────────────┴────────────────────────────────────────────┘
```

### 严重后果剖析：
1. **CSS 选择器 100% 断裂**：
   - 04 详案与 01 详案的样式表（`DiffCard.module.css`）严格定义的是 `.chevronBtn`、`.pathWrap`、`.fileName`、`.statAndActions`、`.rowActions`；
   - 若实施阶段采纳了 03 详案的 TSX 代码，由于类名全叫 `.accordionToggleBtn`、`.accordionFiller`、`.addStat`、`.hoverActions`，**样式表中对应的类选择器将全部无法命中！界面瞬间坍塌，回退到无样式状态！**
2. **架构权威被践踏**：
   - 00 总方案第 323 行与 02 详案第 21 行反复强调：“*以 01 详案的平直直角三大正交子域 AST 树为唯一真理源（SSOT）*”；
   - 然而 03 详案却完全弃 01 详案的 AST 于不顾，自立门户写了一套夹带旧手风琴痕迹的代码，并在终审准入阶段堂而皇之保留，这是极其恶劣的跨方案打架！

---

## 3.2 笔记面板：05、06 对 `NotePaper` 的改造最终结果是否完全收敛？

**终审判定：严重割裂！存在“装配层彻底缺失”与“样式违禁回潮”两大问题！**

### (1) 装配层彻底断裂（The Missing Host Component）
- **05 详案的产出**：
  - 重构了 `NotePaperStrictPanel.tsx`（拔除了底部灰块与 footer）；
  - 重构了 `NotePaperStrictHeader.tsx`（32px 紧凑顶栏，集成 `EditableTitle`）；
  - **关键断层**：05 详案的顶栏与面板代码中，**完全没有引入 `useNoteDocumentManager`，也没有传入或挂载抽屉 `NoteSidebarDrawer`，更没有挂载下拉 `NoteDocumentDropdown`！**
- **06 详案的产出**：
  - 产出了后端 Rust IPC、SQLite 迁移；
  - 产出了前端状态机 `useNoteDocumentManager.ts`；
  - 产出了抽屉组件 `NoteSidebarDrawer.tsx` 与下拉组件 `NoteDocumentDropdown.tsx`；
  - **关键断层**：06 详案写完抽屉和下拉后，**直接跳到了测试用例，根本没有给出一个将抽屉/下拉与 `NotePaperStrictPanel` 或 `NoteLeafHost` 拼装起来的宿主组件！**
- **结论**：05 详案只改了单文档展示，06 详案只造了多文档零件，**两个方案之间没有任何桥梁将零件装配进生产界面！**

### (2) 样式表违背全局铁律（!important 回潮）
- 00 总方案第 277 行明确将“严禁 `!important`”列为刚性门禁；
- 然而 06 详案第 1967-1969 行在编写 `NoteSidebarDrawer.module.css` 时，赫然写出：
  ```css
  .isClosed {
    width: 0 !important;
    min-width: 0 !important;
    max-width: 0 !important;
  }
  ```
- 方案之间在基础纪律上完全脱节，自相矛盾。

---

# 四、终审整改指令与实施波放行基准（Directives）

为确保战役重构不因上述架构漏洞和跨方案打架而导致代码瘫痪，全局架构审计官发出如下刚性整改指令：

### 指令 1：DiffCardFileList 实施基准唯一锁定（废除 03 详案 DOM 代码）
- **决议**：**彻底废黜 `03-分维详案` 第五章中的 `DiffCardFileList.tsx` 异化代码！**
- **执行**：必须 100% 以 `01-分维详案` / `02-分维详案` 的平直三大正交子域（`div.fileRow` + `styles.chevronBtn` + `styles.pathWrap` + `styles.statAndActions` + `styles.rowActions`）为唯一实现基准；
- **补丁**：将 03 详案中唯一正确的一点（使用 `<Tooltip content="...">` 包裹超链接按钮）合入 01 的 AST 中，拔除 01 中的原生 `title` 属性，消除选择器分裂。

### 指令 2：戳穿 Diff 旁路假象，单轨接入真正的对比逻辑
- 在 `FileViewerCard.tsx` 中，彻底物理删除 30 行简陋的 `renderSimpleDiff()`；
- `viewMode === 'diff'` 时，统一复用系统单轨的 `VirtualPlainCodeViewer` 或将 `DiffCodeViewer` 单文件模式接入，绝不允许手写字符串拼接伪代码留在生产库。

### 指令 3：SQLite 8 列极简瘦身为 5 列，物理拔除“三废字段”与复合索引
- 彻底废黜未闭环的 `tags_json`、`is_archived`、`is_pinned`；
- `doc_meta` 权威表结构坚决收敛为纯粹极简的 **5 列真实单轨**：
  ```sql
  CREATE TABLE doc_meta (
      doc_id TEXT PRIMARY KEY NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  ```
- 索引仅保留单列更新倒序索引：`CREATE INDEX IF NOT EXISTS idx_doc_meta_updated ON doc_meta(updated_at DESC);`。

### 指令 4：全系统时间戳绝对死锁为 13 位毫秒级（纠正 06 详案代码）
- 彻底删除 06 详案中 `self.created_at / 1000` 的错误代码；
- Rust 存储层与前端状态机 100% 统一使用 13 位毫秒 Unix 时间戳（`SystemTime::now().duration_since(UNIX_EPOCH).as_millis() as i64` 与 `Date.now()`）。

### 指令 5：交互通道独尊下拉切换，补齐 `NoteLeafHost` 装配闭环
- **拔除 220px 遮挡式抽屉 `NoteSidebarDrawer`**，避免窄坞严重遮挡正文；
- **采用顶栏紧凑下拉 `NoteDocumentDropdown`**，并在 `NotePaperStrictHeader` 中留出左侧下拉插槽；
- 在 `NoteLeafHost.tsx` 中正式接入 `useNoteDocumentManager`，将选中的 `activeDocId` 传给 `NotePaperStrictPanel`，并增加“空列表自动创建默认首篇笔记”的冷启动防御，完成真实闭环。

---

*本审计报告由全局架构与深层逻辑审计官独立签发，直击 8 份方案的核心命门。所有审计结论均配有真实行号与代码现场铁证，为实施波（Phase 6）消除重大隐患提供根本性导航。*
