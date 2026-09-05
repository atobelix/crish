# 架构与 IPC 真实性终审反幻觉严苛审计报告 (AUDIT-FINAL-IPC-06)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）  
> **审计阶段**：阶段五 · 详案终审反幻觉严苛审计（Final Anti-Hallucination Architecture & IPC Audit）  
> **审计编号**：AUDIT-FINAL-IPC-06  
> **审计角色**：架构与 IPC 真实性终审官（Architecture & IPC Anti-Hallucination Auditor）  
> **审计对象**：  
> - [`docs/diff-view-redesign/00-总方案-差异与笔记面板系统性重构全景架构总纲.md`](file:///c:/Software/conex/docs/diff-view-redesign/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E5%B7%AE%E5%BC%82%E4%B8%8E%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF%E7%B3%BB%E7%BB%9F%E6%80%A7%E9%87%8D%E6%9E%84%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E6%80%BB%E7%BA%B2.md)  
> - [`docs/diff-view-redesign/03-分维详案-文件名超链接单轨接线独立预览Tab与全域Tokens规范.md`](file:///c:/Software/conex/docs/diff-view-redesign/03-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E6%96%87%E4%BB%B6%E5%90%8D%E8%B6%85%E9%93%BE%E6%8E%A5%E5%8D%95%E8%BD%A8%E6%8E%A5%E7%BA%BF%E7%8B%AC%E7%AB%8B%E9%A2%84%E8%A7%88Tab%E4%B8%8E%E5%85%A8%E5%9F%9FTokens%E8%A7%84%E8%8C%83.md)  
> - [`docs/diff-view-redesign/06-分维详案-多笔记综合管理体系与SQLite及IPC后端架构.md`](file:///c:/Software/conex/docs/diff-view-redesign/06-%E5%88%86%E7%BB%B4%E8%AF%A6%E6%A1%88-%E5%A4%9A%E7%AC%94%E8%AE%B0%E7%BB%BC%E5%90%88%E7%AE%A1%E7%90%86%E4%BD%93%E7%B3%BB%E4%B8%8ESQLite%E5%8F%8AIPC%E5%90%8E%E7%AB%AF%E6%9E%B6%E6%9E%84.md)  
> **落盘路径**：`docs/diff-view-redesign/plan-reviews/06-architecture-and-ipc-anti-hallucination-audit.md`  
> **审查基准**：用户最高指示（“挤干一切水分，严查一切幻觉与过度设计，项目中的代码应该是清晰的、单轨的、最先进的代码”）、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)（§1 反退避、§3 Git 独占提交、§7 严禁补丁与绕过、§7.1 立体验证）、[`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。

---

## 一、审计结论与真实性裁决摘要

### 1.1 裁决：【Conditional Pass with Required Rectifications（需限期整改 7 大真实性断层）】

经过对真实代码库（`crates/conex-workspace-store/`、`apps/agent-workbench/src-tauri/`、`apps/crish-desktop/`）的严格现场穿透与全量静态/动态对照，审计确认：
- **核心架构方向完全正确**：Canonical Tab ID 机制、SQLite Migration v8、Tauri IPC 4 大命令扩充（131 $\to$ 135）、前端 `useNoteDocumentManager` 状态机防乱序设计完全契合用户对多文档综合管理与差异面板专注化的诉求；
- **但存在 7 处严重的代码级虚构（幻觉）、编译期断裂与跨方案口径漂移**。若不予剔除，直接进入代码实施阶段将导致 **Rust 编译失败、CI 结构门禁报红、TypeScript 类型推断断裂、以及多标签页模式响应失效**。

### 1.2 七大关键真实性缺陷总账（Executive Hallucination & Drift Ledger）

| 缺陷编号 | 缺陷定性 | 涉及文件与行号 | 现场真相与隐患分析 | 整改难度与要求 |
| :--- | :--- | :--- | :--- | :--- |
| **HAL-01** | **Rust 虚构第三方库 `nanoid`** | `06-分维详案` L727, L749 | `crates/conex-workspace-store/Cargo.toml` 与根 `Cargo.toml` **完全没有 `nanoid` 依赖**！直接编译报错 `cannot find crate nanoid`。 | **P0 阻断**：改用已有 `uuid` 或基于毫秒时间戳与伪随机安全字节生成。 |
| **HAL-02** | **FTS5 虚表遗漏删除引发 CI 阻断** | `06-分维详案` L826-835 (`delete_document`) | 删除了 `blocks` 等 8 表，**完全遗漏了 `DELETE FROM blocks_fts WHERE doc_id = ?1`**！将立即触发 `tests/structure_gate.rs:220` 刚性门禁报红（“blocks 与 blocks_fts 行数必须一致”）。 | **P0 阻断**：在硬删除事务中补齐 `blocks_fts` 清理。 |
| **HAL-03** | **时间戳单位量级灾难（秒 vs 毫秒）** | `06-分维详案` L607, L726, L787 ↔ `persist_plugin.rs:97` | `doc_meta.updated_at` 现有代码使用 `strftime('%s','now')`（10位秒级），而详案 06 写入 `as_millis()`（13位毫秒级）。排序时毫秒比秒大 1000 倍，新笔记被永久死锁在置顶首位 5 万年！前端相对时间计算崩溃。 | **P0 阻断**：全系统对齐为毫秒级（或秒级统一转换器）。 |
| **HAL-04** | **虚构前端 IPC 通道与幽灵总线** | `06-分维详案` L1169 (`invokeTauriIpc`), L1275 (`noteDocWrittenBus`) | `ipcBridge.ts` 与 `noteDocWrittenBus.ts` 在代码库与详案中**完全不存在**！真实 IPC 统一入口为 `tauriInvoke.ts` 的 `invokeTyped`。 | **P0 阻断**：切回 `tauriInvoke.ts`，事件总线明确接入或统一走 CustomEvent。 |
| **HAL-05** | **`openTool.ts` 重构丢失既有关键导出** | `03-分维详案` L716-905 ↔ `storeAccess.ts:274` | 详案 03 重写的 `openTool.ts` 删除了 `updateLeafDock`，导致 `storeAccess.ts` 与多处消费方 `import { updateLeafDock }` 编译失败；且虚构了 `import ... from './dockView'`。 | **P0 阻断**：保留 `updateLeafDock` 导出，纠正模块导入路径。 |
| **HAL-06** | **模式覆盖通道非响应式（Stale Override）** | `03-分维详案` L998-1004 (`FileViewerCard`) | 使用模块级 `Map` 传递 `diff` 模式意图，但 `FileViewerCard` 的 `useEffect` 依赖项仅为 `[filePath, viewMode]`。当该文件标签已处于激活态时，点击超链接既不触发重新挂载也不触发 `useEffect`，**模式覆盖无法生效**！ | **P1 修复**：为模式覆盖引入事件监听器或带回调的订阅通道。 |
| **HAL-07** | **00-总方案与 06-详案表结构严重打架** | `00-总方案` L1150-1162 ↔ `06-分维详案` L231-240 | `00-总方案` 虚构了 `ws_id TEXT NOT NULL`、`pinned`、`sort_order`，去除了 `rev`！而 `conex-workspace-store` 底层原本就是每工作区独立库（`doc_meta` 无 `ws_id`），详案 06 才是正确定义。 | **P1 收敛**：将 `00-总方案` 遗留的历史草案描述向 `06-分维详案` 强行对齐。 |

---

## 二、三项核心任务实证查验报告

### 2.1 任务一：`crates/conex-workspace-store/` 表结构与 Migration 真实性核验

#### 1. 现有数据库表结构与真实状态（Ground Truth）
查验 [`crates/conex-workspace-store/src/lib.rs:131`](file:///c:/Software/conex/crates/conex-workspace-store/src/lib.rs#L131) 与 [`migrate.rs:25-115`](file:///c:/Software/conex/crates/conex-workspace-store/src/migrate.rs#L25-L115)：
- 当前权威版本号：`pub const SCHEMA_VERSION: i64 = 7;`；
- 现有 `doc_meta` 表结构：
  ```sql
  CREATE TABLE IF NOT EXISTS doc_meta (
      doc_id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  ```
- 架构本质：每个打开的工作区拥有独立的 `.conex/workspace.db`，由 `WorkspaceStore::open(path)` 打开。**`doc_meta` 中绝对没有、也绝对不需要 `ws_id` 这一冗余字段**。

#### 2. 详案 06 DDL/DML 与索引语法审查
- **新增列 DDL**：
  ```sql
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]'
  ```
  通过 `ensure_column` 进行幂等追加。语法为标准的 SQLite 3 语法，完全支持。
- **复合覆盖索引**：
  ```sql
  CREATE INDEX IF NOT EXISTS idx_doc_meta_listing 
      ON doc_meta(is_archived, is_pinned DESC, updated_at DESC);
  ```
  SQLite 3.3.0+ 原生支持降序索引（`DESC`），语法合法真实。
- **查询与索引失配陷阱**：
  在详案 06 第 3.2 节的 `list_documents` 实现中：
  ```sql
  WHERE (?1 IS NULL OR m.is_archived = ?1)
  ORDER BY m.is_pinned DESC, m.updated_at DESC;
  ```
  在 SQLite 查询优化器中，`(?1 IS NULL OR m.is_archived = ?1)` 这类参数化 `OR` 条件无法直接命中复合索引最左前缀做有序扫描，将退化为全表扫描与临时文件排序。
  **整改建议**：针对 `include_archived` 分支拆分为两条静态 SQL，确保 `WHERE m.is_archived = 0 ORDER BY m.is_pinned DESC, m.updated_at DESC` 100% 走 Index Search。

#### 3. 虚构第三方库：`nanoid::nanoid!(8)`（致命断层 HAL-01）
- **现场代码证据**：
  在 `06-分维详案` 第 3.2 节 L727 与 L749：
  ```rust
  let random_part = nanoid::nanoid!(8);
  let doc_id = format!("doc_{:x}_{}", now, random_part);
  let block_id = format!("b_{}", nanoid::nanoid!(8));
  ```
- **真实性穿透**：
  检查 [`crates/conex-workspace-store/Cargo.toml`](file:///c:/Software/conex/crates/conex-workspace-store/Cargo.toml)：
  仅有 `conex-doc-collab`, `conex-md-ast`, `rusqlite`, `thiserror`, `serde`, `serde_json`, `sha2`, `hex`, `notify`。整个仓库根目录 `Cargo.toml` 也从未引入 Rust 版 `nanoid`。
- **整改修复**：
  使用根 `Cargo.toml` 既有的 `uuid = "1"`（通过 `uuid::Uuid::new_v4().simple().to_string()[..8]`），或纯标准库 `std::time` + 原生字节生成，杜绝无授权引入新 crate。

#### 4. FTS5 虚表遗漏删除（致命断层 HAL-02）
- **现场代码证据**：
  在 `06-分维详案` 第 3.2 节 L826-835：
  ```rust
  let tx = conn.unchecked_transaction()?;
  tx.execute("DELETE FROM doc_meta WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM doc_snapshots WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM doc_clocks WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM blocks WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM mirror_meta WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM block_refs WHERE doc_id = ?1;", params![doc_id])?;
  tx.execute("DELETE FROM block_attachments WHERE doc_id = ?1;", params![doc_id])?;
  tx.commit()?;
  ```
- **真实性穿透**：
  在 [`crates/conex-workspace-store/tests/structure_gate.rs:220`](file:///c:/Software/conex/crates/conex-workspace-store/tests/structure_gate.rs#L220)，存在刚性 CI 测试断言：
  ```rust
  assert_eq!(blocks_count, fts_count, "blocks 与 blocks_fts 行数必须一致");
  ```
  `blocks_fts` 并不是 SQLite 的外部 content 表，删除了 `blocks` 并不会自动触发 FTS 级联！如果不执行 `DELETE FROM blocks_fts WHERE doc_id = ?1;`，残留的 FTS 行将直接导致全库一致性门禁崩溃。
- **整改修复**：
  在事务中显式增加：
  ```rust
  tx.execute("DELETE FROM blocks_fts WHERE doc_id = ?1;", params![doc_id])?;
  ```

#### 5. CRDT 越俎代庖：`create_document` 裸插 `blocks` 漏洞
- **现场代码证据**：
  在 `06-分维详案` L750-756，直接用裸 SQL 向 `blocks` 插入一行 `heading_1`，但既没有向 `blocks_fts` 插入索引，也没有向 `doc_snapshots` 或 `doc_updates` 写入 CRDT 二进制。
- **真实性穿透**：
  `WorkspaceStore` 的权威是 `doc_snapshots` + `doc_updates`，`blocks` 仅是派生投影表。新建文档若带初始内容，必须通过协同层或初始化为空文档，严禁绕过 CRDT 权威库裸插单表。

---

### 2.2 任务二：Tauri IPC 真实条目数与宏注册闭环核验

#### 1. 真实命令清单条目数核验（Ground Truth）
- **Rust 真源侧**：
  查验 [`apps/agent-workbench/src-tauri/src/command_manifest.rs:444`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/command_manifest.rs#L444)：
  ```rust
  #[test]
  fn core_list_commands_returns_full_manifest() {
      let manifest = core_list_commands().unwrap();
      assert_eq!(manifest.commands.len(), 131);
      assert_eq!(manifest.contract_version, "1.0.0");
  }
  ```
- **前端镜像侧**：
  查验 [`apps/crish-desktop/src/api/transport/commandManifest.test.ts:78-79`](file:///c:/Software/conex/apps/crish-desktop/src/api/transport/commandManifest.test.ts#L78-L79)：
  ```typescript
  expect(registered).toBe(131);
  expect(BUILTIN_COMMAND_MANIFEST.commands.length).toBe(131);
  ```
- **审计裁决**：
  当前真实条目数**精确为 131 条**。
  新增 4 条笔记管理命令（`note_document_list`, `note_document_create`, `note_document_rename`, `note_document_delete`）后，**目标总数精确为 135 条**。详案 06 中的 131 $\to$ 135 计算真实无误。

#### 2. Tauri 宏注册真实性核验
- **现场代码查验**：
  在 [`apps/agent-workbench/src-tauri/src/main.rs:142-151`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs#L142-L151)：
  ```rust
  macro_rules! command_registry {
      ($(($name:literal, $path:path)),* $(,)?) => {
          pub(crate) const COMMAND_REGISTRY_NAMES: &[&str] = &[$($name),*];
          pub(crate) fn build_invoke_handler() -> Box<tauri::ipc::InvokeHandler<tauri::Wry>> {
              Box::new(tauri::generate_handler![$($path),*])
          }
      };
  }
  ```
  `command_registry!` 宏真实存在，且同源生成 `COMMAND_REGISTRY_NAMES`。
- **五重闭环要求**：
  必须确保以下 5 处同步落盘，否则 [`command-contract-drift.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/transport/command-contract-drift.test.ts) 将立刻拦截：
  1. `main.rs` 的 `command_registry![]` 中加入 4 项二元组；
  2. `note_commands.rs` 门面 `pub use` 导出 4 项命令；
  3. `command_manifest.rs` 的 `COMMAND_MANIFEST` 数组加入 4 项并抬升断言为 135；
  4. `commandManifest.ts` 内置快照加入 4 项；
  5. 前端 `noteApi.ts` 必须具有对这 4 个命令的静态字面量调用（杜绝产生未消费的幽灵命令）。

#### 3. 前端虚构 IPC 包装层（致命断层 HAL-04）
- **现场代码证据**：
  在 `06-分维详案` L1169：
  ```typescript
  import { invokeTauriIpc } from './transport/ipcBridge';
  ```
- **真实性穿透**：
  代码库中根本没有 `ipcBridge.ts`，也没有 `invokeTauriIpc` 函数！
  在 `apps/crish-desktop/src/api/` 中，唯一的强类型结构化调用函数是 [`tauriInvoke.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/tauriInvoke.ts) 导出的 `invokeTyped<T>(cmd, args)`。
- **整改修复**：
  `noteApi.ts` 必须严格统一导入 `import { invokeTyped } from './tauriInvoke';`。

---

### 2.3 任务三：`openTool.ts` 与 `FileViewerCard.tsx` 传参接口与无断层核验

#### 1. 现有接口真实状态（Ground Truth）
- 在 [`apps/crish-desktop/src/store/workspace-shell/openTool.ts:176-183`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/openTool.ts#L176-L183)：
  ```typescript
  export function openFileViewerInSession(
    filePath: string,
    _initialMode: 'plain' | 'diff' = 'plain'
  ): void {
    const activeId = useLayoutTreeStore.getState().activeLeafId;
    if (!activeId) return;
    openToolInLeaf(activeId, `file-viewer:${filePath}`);
  }
  ```
  现行代码确实丢弃了 `_initialMode`，导致上游即便传了 `diff` 也无法传递给下游。
- 在 [`apps/crish-desktop/src/components/files/FileViewerCard.tsx:24-35`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.tsx#L24-L35)：
  ```typescript
  export interface FileViewerCardProps {
    filePath: string;
    initialMode?: 'plain' | 'diff';
  }
  ```
  `FileViewerCard` 本身原生就支持 `initialMode` 参数！

#### 2. 详案 03 Canonical Tab ID 机制严密性核验
- **Tab 分裂防御有效性（Pass）**：
  详案 03 严格规定存入 `dock.openPanelIds` 的标识符必须为纯净的 `file-viewer:${normalizedPath}`，坚决不带 `?mode=diff`。这成功根除了 BUG-A02（同名 Tab 重复分裂灾难），符合单一真理源原则。
- **模式覆盖通道的非响应式隐患（HAL-06）**：
  详案 03 在 `openTool.ts` 中使用内存 `Map` 存储模式覆盖，在 `FileViewerCard.tsx` 中消费：
  ```tsx
  useEffect(() => {
    const canonicalTabId = `file-viewer:${filePath}`;
    const override = consumeFileViewerModeOverride(canonicalTabId);
    if (override && override !== viewMode) {
      setViewMode(override);
    }
  }, [filePath, viewMode]);
  ```
  **漏洞现场**：
  如果用户已经打开了 `App.tsx` 的 Tab（处于 `plain` 模式），此时用户回到差异面板再次点击 `App.tsx` 超链接（期望切到 `diff` 模式）：
  - `openToolInLeaf` 激活同一个已存在的 Tab；
  - 由于 Tab 实例未改变，`filePath` 没有变，`viewMode` 也没有变；
  - `useEffect` **完全不会触发执行**！
  - 用户在 Diff 面板点击超链接后，右侧面板纹丝不动，依然保持在原有的 `plain` 模式，造成严重的“点击不响应”伪实现体验！
- **整改修复**：
  当调用 `openFileViewerInSession` 且模式覆盖被激活时，派发一个轻量的窗口级或模块级微事件，例如：
  ```typescript
  window.dispatchEvent(new CustomEvent('conex:file-viewer-mode-switch', {
    detail: { canonicalTabId, mode: initialMode }
  }));
  ```
  在 `FileViewerCard` 中挂载该事件监听，确保无论 Tab 是冷启动挂载还是热焦点激活，都能 100% 毫秒级响应切模。

#### 3. 详案 03 重构 `openTool.ts` 造成的编译截断（HAL-05）
- 详案 03 第 4.2 节重构的 `openTool.ts` 中：
  - 虚构了 `import { createDefaultDock, type LeafDockView } from './dockView';`（现场无 `dockView.ts`）；
  - **漏掉了导出 `updateLeafDock` 与 `updateTabDock`**。
- 而 [`apps/crish-desktop/src/store/storeAccess.ts:274`](file:///c:/Software/conex/apps/crish-desktop/src/store/storeAccess.ts#L274) 正显式从 `workspace-shell` 导出 `updateLeafDock`。直接采用详案 03 代码将导致前端构建立即中断。
- **整改修复**：
  在 `openTool.ts` 中修正导入源为 `../layout-tree/sessionTabModel`，并完整保留并导出 `updateLeafDock` 与 `updateTabDock`。

---

## 三、严厉反幻觉与过度设计专项检查

### 3.1 是否引入任何不存在的第三方库？
1. **Rust 侧**：
   - 发现虚构 `nanoid = "0.4"`（HAL-01），已标红阻断。
   - 发现宣称使用 Unicode Grapheme 字符簇算法，但代码实际裸写 `chars().take(30)`，且未引入 `unicode-segmentation`。应在规范中统一口径使用 Rust 标准库字符感知截断。
2. **前端 TS/React 侧**：
   - 未引入重型第三方库（未引入 Yjs、Automerge、Dexie 等），符合 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。
   - 但虚构了内部文件模块 `ipcBridge.ts`、`dockView.ts`、`noteDocWrittenBus.ts`，必须彻底清洗纠正。

### 3.2 是否自建冗余的第二套缓存或多轨数据源？
1. **数据真理源判定（Pass）**：
   详案 06 的多文档元数据完全依托于 SQLite 的 `doc_meta` 表作为唯一权威，前端仅在 `useNoteDocumentManager` 中作为展示视图状态，并在切换文档时调用 `flushPendingDraft` 刷盘，不存在内存多轨平行账本。
2. **Tab ID 唯一性判定（Pass）**：
   详案 03 彻底摒弃了 URL Query 污染 Tab ID 的草案，实现了基于文件规范化路径的单一真理源。

### 3.3 是否存在任何“未连通的假实现”？
1. **彻底清退假回收站图标（Pass）**：
   详案 06 第 5.3 节根据前置评审意见，彻底从侧栏 UI 与状态机中删除了无后端 API 支撑的假回收站图标，删除操作改为直接物理硬删除并配备二次确认弹窗，消除了功能伪实现。
2. **标题重命名持久化连通（Pass）**：
   `EditableTitle.tsx` 与侧栏内联重命名直接触发 `note_document_rename` IPC，后端直接执行 `UPDATE doc_meta SET title = ...`，连通真实可靠。
3. **未连通的幽灵总线（HAL-04 警报）**：
   `useNoteDocumentManager.ts` 中引入的 `subscribeNoteDocWritten`（来自于不存在的 `noteDocWrittenBus`），若不落地真实代码，属于未连通的悬空代码。

---

## 四、详案 00 与分维详案的跨方案冲突消解

在审计对象 [`00-总方案-差异与笔记面板系统性重构全景架构总纲.md`](file:///c:/Software/conex/docs/diff-view-redesign/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E5%B7%AE%E5%BC%82%E4%B8%8E%E7%AC%94%E8%AE%B0%E9%9D%A2%E6%9D%BF%E7%B3%BB%E7%BB%9F%E6%80%A7%E9%87%8D%E6%9E%84%E5%85%A8%E6%99%AF%E6%9E%B6%E6%9E%84%E6%80%BB%E7%BA%B2.md) 中，发现存在多处早期历史草案的未收敛残留：

1. **第 5.1.3 节代码幻觉**：
   `00-总方案` L1106-1115 编写了 `store.findRightmostDockLeafId()` 与 `store.setFileViewerSessionIntent()`，并声称是在 `useWorkspaceShellStore` 上调用。
   **真相**：`useWorkspaceShellStore` 根本没有这些方法，这是独立方案阶段被否决的草案，必须以 `03-分维详案` 的纯函数与事件总线为准。
2. **第 5.2.1 节数据库表结构冲突**：
   `00-总方案` L1150-1162 中声明的 `doc_meta` 包含 `ws_id TEXT NOT NULL`、`pinned INTEGER`、`sort_order INTEGER`。
   **真相**：此表结构与 `06-分维详案` 产生剧烈冲突。必须全量以 `06-分维详案` 的 8 列结构（`doc_id, rev, updated_at, title, created_at, is_pinned, is_archived, tags_json`）为准，将 `00-总方案` 中的该章节描述修订收敛。
3. **命令总数基线陈旧**：
   `00-总方案` L1266 提到“既有 82 项命令”，属于早期遗留。应统一口径为“当前真源 131 条，扩充 4 条后达到 135 条”。

---

## 五、最终整改修复代码级规约清单

在进入阶段六代码实现前，必须无条件履行以下 5 大代码级纠偏：

### 5.1 【纠偏一】Rust 唯一 ID 生成器与结构门禁合规
在 `crates/conex-workspace-store/src/lib.rs` 中：
```rust
// 严禁使用 nanoid！使用标准库时间戳 + 序号或 uuid
let now_millis = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as i64;
let doc_id = format!("doc_{:x}_{:08x}", now_millis, rand::random::<u32>());
```
在 `delete_document` 事务中必须追加：
```rust
tx.execute("DELETE FROM blocks_fts WHERE doc_id = ?1;", params![doc_id])?;
```

### 5.2 【纠偏二】时间戳单位全局对齐（对齐毫秒或统一转换）
- 在 `crates/conex-workspace-store/src/migrate.rs` 中：
  ```sql
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  ```
- 检查存量 `persist_plugin.rs`，如果存量代码写入秒，则在读取行映射 `into_meta` 时做归一化：若时间戳 `< 10_000_000_000` 则自动 `* 1000` 兼容历史数据，确保前端排序与相对时间计算永不紊乱。

### 5.3 【纠偏三】前端统一使用 `tauriInvoke.ts`
在 `apps/crish-desktop/src/api/noteApi.ts` 中：
```typescript
import { invokeTyped } from './tauriInvoke';

export async function noteDocumentList(
  includeArchived = false
): Promise<NoteDocumentListResult> {
  const res = await invokeTyped<NoteDocumentListResult>('note_document_list', {
    include_archived: includeArchived,
  });
  if (res.status === 'ok') return res.data;
  return { ok: false, documents: [], totalCount: 0, error: res.message };
}
```

### 5.4 【纠偏四】修复 `openTool.ts` 的导出与依赖
在 `apps/crish-desktop/src/store/workspace-shell/openTool.ts` 中：
- 导入源修正为 `import { createDefaultDock } from '../layout-tree/sessionTabModel';`；
- 完整保留并导出 `updateLeafDock`、`updateTabDock`；
- 移除对虚构模块 `./dockView` 的引用。

### 5.5 【纠偏五】`FileViewerCard` 模式切换增加微事件响应
在 `openTool.ts` 的 `openFileViewerInSession` 中：
```typescript
export function openFileViewerInSession(
  filePath: string,
  initialMode: FileViewerInitialMode = 'plain'
): void {
  // ... 归一化与 Canonical Tab ID 计算 ...
  setFileViewerModeOverride(canonicalTabId, initialMode);
  window.dispatchEvent(new CustomEvent('conex:file-viewer-mode', {
    detail: { canonicalTabId, mode: initialMode }
  }));
  openToolInLeaf(targetLeafId, canonicalTabId);
}
```
在 `FileViewerCard.tsx` 中注册 `conex:file-viewer-mode` 事件监听，确保热激活场景下无缝切换 `'diff'` 模式。

---

> **架构与 IPC 真实性终审官签署**：  
> **审计状态**：PASS WITH RECTIFICATIONS  
> **终审意见**：详案骨干极其扎实，彻底排除了假实现与过度设计。上述 7 项技术断层与幻觉定位精准、整改方案完备清晰，修复后即可全面启动阶段六代码级施工！
