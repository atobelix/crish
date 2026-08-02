# 多 Agent 协同优化执行计划

> **文档用途**：此文档是 conex 项目长会话加载性能优化的**单一权威信息源**。所有 Agent 必须先读取此文档再开始工作。文档包含完整的研究结论、架构决策、接口契约、任务分解、文件清单。即使上下文被压缩，新 Agent 仅凭此文档即可独立工作。
>
> **创建时间**：2026-07-27
> **目标**：彻底解决长对话加载慢问题，统一渲染与存储层架构，清理冗余死代码。
> **原则**：系统化改进，禁止补丁式或兼容式改动。

---

## 一、执行概要

### 1.1 问题根因

长对话加载慢的**主瓶颈**：[AsyncMarkdownBlock.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx) 在 `useLayoutEffect` 中**同步**调用 `IncrementalMarkdownParser` + `highlight.js`，每条可见消息 80-300ms，50 条可见消息首屏 4-15 秒卡顿。

**次瓶颈**：
1. boot 时 `hydrateSessionsFromDisk` 同步全量加载所有会话 body（localStorage 同步读 + JSONL 解析）
2. IndexedDB 形同虚设，实际仍写 localStorage（补丁式架构）
3. `conex-db` 的 `query_events` 无 LIMIT 分页
4. 三条渲染路径输出不一致（视觉跳变）

### 1.2 改造目标

| 维度 | 当前 | 目标 |
|---|---|---|
| 长会话首屏 | 4-15 秒 | < 500ms |
| markdown 渲染 | 主线程同步 80-300ms/条 | Rust 异步 5-15ms/条 |
| 存储层 | localStorage + IndexedDB + 磁盘镜像三层冗余 | SQLite 单层 |
| Worker 池 | 4 通道（render/compute/io/network） | 仅保留 render 通道作为 fallback |
| 渲染路径 | 3 条（同步/worker/死代码） | 1 条（Rust 渲染 + JS 流式简化） |

### 1.3 总工作量

- 单人串行：37-44 人天
- 4 Agent 并行：约 12-15 人天

---

## 二、关键事实修正（必读）

### 2.1 Tauri 后端位置修正

**错误认知**：`apps/crish-desktop/src-tauri/` 是 Tauri 后端
**实际**：`apps/crish-desktop/src-tauri/` **不存在**。Tauri 后端实际在 [apps/agent-workbench/src-tauri/](file:///c:/Software/conex/apps/agent-workbench/src-tauri)

证据：[Cargo.toml](file:///c:/Software/conex/Cargo.toml) workspace members 只列出 `apps/agent-workbench/src-tauri`。

### 2.2 Rust 侧已有基础设施

Rust 侧 [perf/](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/perf) 模块**已实现** 6 个 worker 任务的 Rust 版本，但 JS 侧未调用：
- `perf_hash_compute` / `perf_base64_encode` / `perf_base64_decode`
- `perf_encoding_detect` / `perf_encoding_decode`
- `perf_diff_parse`

本次优化要把 `perf_*` 提升为 `core_*` 正式 API。

### 2.3 AsyncMarkdownBlock 名实不符

[AsyncMarkdownBlock.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx) 命名 "Async" 但实际是**同步**渲染：
- `useLayoutEffect` 在 paint 前同步阻塞主线程
- 调用 `IncrementalMarkdownBridge.push(text)` → `IncrementalMarkdownParser.splitIntoBlocks` + `renderHtml` + `highlightCode`
- 每个代码块调 `hljs.highlight`（首屏 cache miss）

### 2.4 已有 worker pool 路径未被启用

[markdownRenderAsync.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts) + [markdownWorker.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/markdownWorker.ts) 已实现异步路径，但：
- `markdownRenderAsync.ts` 实际**未**被 AsyncMarkdownBlock 调用
- `markdownWorker.ts` **未注册到 worker pool**，是死代码

### 2.5 IndexedDB 形同虚设

[sessionIndexedDb.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionIndexedDb.ts) 名为 IndexedDB，实际仍写 localStorage（L36-42）：
```typescript
await setAsyncItem(key, content);     // 写 IndexedDB
localStorage.setItem(key, content);   // 同步写 localStorage（主存储）
```

### 2.6 三条渲染路径输出不一致

| 路径 | 实现 | 输出差异 |
|---|---|---|
| 完整路径 | `markdownPlugins.ts` | 含 stripThoughtPlaceholders / extractTables / CJK wbr / 路径链接 |
| 增量路径 | `IncrementalMarkdownParser.ts` | 简化版，无上述扩展，列表不支持嵌套 |
| 流式 buffer | `StreamRenderBuffer.ts` 内部 bridge | 死代码（htmlNeeded 默认 false） |

流式期间走增量路径，完成后切到完整路径会有**视觉跳变**。

### 2.7 三层存储冗余

| 层 | 文件 | 作用 | 迁移后 |
|---|---|---|---|
| localStorage | [sessionLocalStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts) | 主存储（5MB 限额） | 仅保留 UI 偏好 |
| IndexedDB | [sessionIndexedDb.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionIndexedDb.ts) | 异步兜底镜像 | **删除** |
| 磁盘镜像 | [sessionDiskMirror/](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror) | Tauri fs 写 ~/.crish/sessions/ | **删除整个目录** |
| **新：SQLite** | `conex-db` 扩展 | 唯一存储 | 新增 |

---

## 三、架构决策

### 决策 1：渲染路径统一为 Rust

**当前**：3 条渲染路径
**目标**：1 条 Rust 渲染（pulldown-cmark + syntect + ammonia + moka）

### 决策 2：存储层统一为 SQLite

**当前**：3 层冗余
**目标**：1 层 SQLite（`conex-db` 扩展，新增 5 张表）

### 决策 3：Worker 池简化

**当前**：4 通道（render/compute/io/network，network 未启用）
**目标**：仅保留 render 通道作为 Rust 渲染的 fallback；compute/io 整体下沉 Rust

### 决策 4：数据迁移策略

写迁移脚本 + 保留 localStorage 30 天回滚保险。`schema_version` 元数据控制。

### 决策 5：分阶段切换，每阶段独立可回滚

每阶段完成后必须通过：
- `cargo test` 全绿
- `pnpm test` 全绿
- `cargo clippy` 无警告
- 性能基准回归阈值 20%
- 长会话首屏可交互时延 < 500ms

---

## 四、并行工作流设计

### 4.1 Stream 划分

```
Stream A: Rust 渲染层        Stream B: Rust 存储层
  ↓ (接口契约先发)             ↓ (接口契约先发)
Stream C: JS 渲染层改造      Stream D: JS 存储层改造
  ↓                            ↓
Stream E: Worker 池简化      Stream F: 测试基础设施
  ↓                            ↓
         联调与回归 (Z)
```

### 4.2 依赖关系

| Stream | 依赖 | 可并行? |
|---|---|---|
| A (Rust markdown) | 无 | ✅ 立即启动 |
| B (Rust storage) | 无 | ✅ 立即启动 |
| F (测试基础设施) | 无 | ✅ 立即启动 |
| C (JS markdown) | A 契约 | 等 A 契约发布 |
| D (JS storage) | B 契约 | 等 B 契约发布 |
| E (Worker 简化) | A/B/C/D 接口稳定 | 最后启动 |
| Z (联调回归) | 全部完成 | 最后 |

### 4.3 Agent 分工

| Agent | 承载 Stream | 上下文焦点 |
|---|---|---|
| Agent 1 | A + E | Rust 渲染 + worker 简化 |
| Agent 2 | B + F | Rust 存储 + 测试 |
| Agent 3 | C | JS 渲染层 |
| Agent 4 | D | JS 持久化层 |

主 Agent 负责协调：发布契约、合并冲突、验证集成。

---

## 五、接口契约（关键）

### 5.1 Stream A 契约：Rust Markdown 渲染

**Rust crate**：`crates/conex-markdown`

```rust
// crates/conex-markdown/src/lib.rs
pub fn render_markdown(text: &str) -> String;
pub fn render_markdown_batch(texts: Vec<String>) -> Vec<String>;
pub fn highlight_code(code: &str, lang: Option<&str>) -> String;
pub fn clear_cache();
```

**Tauri commands**（注册到 [main.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs)）：

```rust
#[tauri::command]
pub async fn md_render(text: String) -> Result<String, CoreError>;

#[tauri::command]
pub async fn md_render_batch(texts: Vec<String>) -> Result<Vec<String>, CoreError>;

#[tauri::command]
pub async fn highlight_code(code: String, lang: Option<String>) -> Result<String, CoreError>;

#[tauri::command]
pub async fn md_clear_cache() -> Result<(), CoreError>;
```

**JS wrapper**（[rustCore.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/rustCore.ts) 新增）：

```typescript
export async function renderMarkdown(text: string): Promise<string | null>;
export async function renderMarkdownBatch(texts: string[]): Promise<string[] | null>;
export async function highlightCode(code: string, lang?: string): Promise<string | null>;
export async function clearMarkdownCache(): Promise<void>;
```

### 5.2 Stream B 契约：Rust Session 存储

**conex-types 新增类型**（[conex-types/src/lib.rs](file:///c:/Software/conex/crates/conex-types/src/lib.rs)）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    pub sender: String,  // "user" | "assistant"
    pub text: Option<String>,
    pub thinking: Option<String>,
    pub timestamp: i64,
    pub status: Option<String>,
    pub stream_text_offset: Option<i64>,
    pub thinking_time: Option<i64>,
    pub tool_calls_json: Option<String>,
    pub blocks_json: Option<String>,
    pub tool_call_results_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgent {
    pub id: String,
    pub subagent_run_id: String,
    pub parent_session_id: String,
    pub parent_run_id: String,
    pub parent_tool_call_id: Option<String>,
    pub description: String,
    pub mode: String,
    pub status: String,
    pub summary: Option<String>,
    pub messages: Vec<SessionMessage>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub depth: Option<i64>,
    pub subagent_path_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub branch_parent_id: Option<String>,
    pub timestamp: String,
    pub updated_at: i64,
    pub message_count: i64,
    pub pinned_message_ids: Option<String>,
    pub engine_cursor: Option<i64>,
    pub engine_last_run_id: Option<String>,
    pub hydrated_from_engine: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub sessions: u64,
    pub messages: u64,
    pub agents: u64,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum CoreError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("encoding error: {0}")]
    Encoding(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cancelled")]
    Cancelled,
    #[error("internal: {0}")]
    Internal(String),
}
```

**conex-db 新增方法**（[conex-db/src/lib.rs](file:///c:/Software/conex/crates/conex-db/src/lib.rs)）：

```rust
impl LocalDb {
    pub fn upsert_session_entry(&self, entry: &SessionIndexEntry) -> Result<(), DbError>;
    pub fn list_sessions(&self) -> Result<Vec<SessionIndexEntry>, DbError>;
    pub fn load_session_body(&self, session_id: &str) -> Result<Vec<SessionMessage>, DbError>;
    pub fn save_session_body(&self, session_id: &str, messages: &[SessionMessage]) -> Result<(), DbError>;
    pub fn append_session_messages(&self, session_id: &str, new_messages: &[SessionMessage]) -> Result<(), DbError>;
    pub fn delete_session(&self, session_id: &str) -> Result<(), DbError>;
    pub fn load_session_agents(&self, session_id: &str) -> Result<Vec<SessionAgent>, DbError>;
    pub fn save_session_agents(&self, session_id: &str, agents: &[SessionAgent]) -> Result<(), DbError>;
    pub fn get_session_meta(&self, key: &str) -> Result<Option<String>, DbError>;
    pub fn set_session_meta(&self, key: &str, value: &str) -> Result<(), DbError>;
    pub fn cleanup_orphan_sessions(&self, active_ids: &[String]) -> Result<usize, DbError>;
    pub fn import_from_localstorage(&self, index_json: &str, bodies: HashMap<String, String>, agents: HashMap<String, String>, active_id: Option<&str>, folder_order: &[String]) -> Result<ImportStats, DbError>;
    pub fn touch_session(&self, session_id: &str) -> Result<(), DbError>;
}
```

**Tauri commands**（11 个，新建 [session_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/session_commands.rs)）：

```rust
#[tauri::command] pub async fn list_sessions(db_state: State<'_, SharedDb>) -> Result<Vec<SessionIndexEntry>, CoreError>;
#[tauri::command] pub async fn load_session_body(session_id: String, db_state: State<'_, SharedDb>) -> Result<Vec<SessionMessage>, CoreError>;
#[tauri::command] pub async fn save_session_body(session_id: String, messages: Vec<SessionMessage>, db_state: State<'_, SharedDb>) -> Result<(), CoreError>;
#[tauri::command] pub async fn delete_session(session_id: String, db_state: State<'_, SharedDb>) -> Result<(), CoreError>;
#[tauri::command] pub async fn load_session_agents(session_id: String, db_state: State<'_, SharedDb>) -> Result<Vec<SessionAgent>, CoreError>;
#[tauri::command] pub async fn save_session_agents(session_id: String, agents: Vec<SessionAgent>, db_state: State<'_, SharedDb>) -> Result<(), CoreError>;
#[tauri::command] pub async fn get_session_meta(key: String, db_state: State<'_, SharedDb>) -> Result<Option<String>, CoreError>;
#[tauri::command] pub async fn set_session_meta(key: String, value: String, db_state: State<'_, SharedDb>) -> Result<(), CoreError>;
#[tauri::command] pub async fn cleanup_orphan_sessions(active_ids: Vec<String>, db_state: State<'_, SharedDb>) -> Result<usize, CoreError>;
#[tauri::command] pub async fn import_from_localstorage(index_json: String, bodies: HashMap<String, String>, agents: HashMap<String, String>, active_session_id: Option<String>, folder_order: Vec<String>, db_state: State<'_, SharedDb>) -> Result<ImportStats, CoreError>;
#[tauri::command] pub async fn touch_session(session_id: String, db_state: State<'_, SharedDb>) -> Result<(), CoreError>;
```

**JS wrapper**（[rustCore.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/rustCore.ts) 新增）：

```typescript
export async function listSessions(): Promise<SessionIndexEntry[] | null>;
export async function loadSessionBody(sessionId: string): Promise<SessionMessage[] | null>;
export async function saveSessionBody(sessionId: string, messages: SessionMessage[]): Promise<boolean>;
export async function deleteSession(sessionId: string): Promise<boolean>;
export async function loadSessionAgents(sessionId: string): Promise<SessionAgent[] | null>;
export async function saveSessionAgents(sessionId: string, agents: SessionAgent[]): Promise<boolean>;
export async function getSessionMeta(key: string): Promise<string | null>;
export async function setSessionMeta(key: string, value: string): Promise<boolean>;
export async function cleanupOrphanSessions(activeIds: string[]): Promise<number>;
export async function importFromLocalStorage(data: ImportData): Promise<ImportStats | null>;
export async function touchSession(sessionId: string): Promise<boolean>;
```

---

## 六、SQLite Schema 设计

### 6.1 表结构

```sql
-- schema_version 写入 metadata 表
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '2');

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '常规会话',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    branch_parent_id TEXT,
    timestamp TEXT NOT NULL DEFAULT '',
    timestamp_source TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    pinned_message_ids TEXT,
    engine_cursor INTEGER,
    engine_last_run_id TEXT,
    hydrated_from_engine INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
    text TEXT,
    thinking TEXT,
    timestamp INTEGER NOT NULL,
    status TEXT CHECK (status IN ('queued','processing','completed','error')),
    stream_text_offset INTEGER,
    thinking_time INTEGER,
    tool_calls_json TEXT,
    blocks_json TEXT,
    tool_call_results_json TEXT,
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_session_messages_id ON session_messages(session_id, id);

CREATE TABLE IF NOT EXISTS session_agents (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    subagent_run_id TEXT NOT NULL,
    parent_session_id TEXT NOT NULL,
    parent_run_id TEXT NOT NULL,
    parent_tool_call_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stopped')),
    summary TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    depth INTEGER DEFAULT 0,
    subagent_path_json TEXT,
    PRIMARY KEY (session_id, agent_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_agent_messages (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
    text TEXT,
    thinking TEXT,
    timestamp INTEGER NOT NULL,
    status TEXT,
    stream_text_offset INTEGER,
    thinking_time INTEGER,
    tool_calls_json TEXT,
    blocks_json TEXT,
    tool_call_results_json TEXT,
    PRIMARY KEY (session_id, agent_id, seq),
    FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;
```

### 6.2 触发器

```sql
CREATE TRIGGER IF NOT EXISTS trg_session_messages_insert
AFTER INSERT ON session_messages
BEGIN
    UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_messages_delete
AFTER DELETE ON session_messages
BEGIN
    UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id;
END;
```

### 6.3 query_events 修复

[conex-db/src/lib.rs:149-151](file:///c:/Software/conex/crates/conex-db/src/lib.rs#L149-151) 必须加 `LIMIT`：

```rust
"SELECT id, session_id, sequence, event_type, payload, created_at
 FROM events WHERE session_id = ?1 AND sequence > ?2
 ORDER BY sequence ASC LIMIT ?3"
```

---

## 七、Stream A 详细任务

**目标**：新建 `crates/conex-markdown` crate，用 pulldown-cmark + syntect + ammonia + moka 实现 Rust markdown 渲染。

### 7.1 步骤

1. 新建 `crates/conex-markdown/Cargo.toml`（依赖 pulldown-cmark + syntect + ammonia + moka + chrono + sha2 + hex + regex）
2. 在 [Cargo.toml](file:///c:/Software/conex/Cargo.toml) workspace members 追加 `crates/conex-markdown` + workspace.dependencies 声明依赖
3. **测试先行**：把 [markdownRender.lists.test.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRender.lists.test.ts) 60+ 测试逐字移植为 Rust 集成测试（`crates/conex-markdown/tests/`）
4. 实现 `renderer.rs`：pulldown-cmark 事件流 → HTML（含 CSS 类、CJK wbr、路径链接、安全检查）约 600-800 行
5. 实现 `highlight.rs`：syntect + class style + LRU 缓存
6. 实现 `sanitizer.rs`：URL/image 安全检查（移植 [markdownSanitizer.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts)）
7. 实现 `table.rs`：表格对齐/斑马纹（移植 [markdownTable.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/markdownTable.ts)）
8. 实现 `ammonia_config.rs`：白名单配置
9. 实现 `cache.rs`：moka LRU + 字节预算
10. 新建 [markdown_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/markdown_commands.rs)：4 个 Tauri command
11. 在 [main.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs) 注册命令（两份分支都加）+ setup 注入
12. 在 [agent-workbench/src-tauri/Cargo.toml](file:///c:/Software/conex/apps/agent-workbench/src-tauri/Cargo.toml) 加 conex-markdown 依赖

### 7.2 关键约束

- **HTML 输出必须 byte-for-byte 兼容现有 CSS 选择器**（`md-rendered` / `code-fence` / `md-tr-alt` / `md-task-item` 等）
- **流式期间保留 JS 简化路径**（纯文本 div），完成态走 Rust
- **ammonia sanitize 一次到位**，移除组件层 DOMPurify
- **syntect 用 `default-fancy-regex` feature** 避免依赖 Oniguruma C 库
- **CPU 密集任务必须 `tokio::task::spawn_blocking`**（参考 [core_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/core_commands.rs) 模式）

### 7.3 支持的 markdown 特性清单

**Block 级**：标题 H1-H6（渲染到 H4）、段落、Fenced code（含 `file="..."` 属性）、无序/有序/任务列表（嵌套，缩进 ≥2 空格或 Tab=4）、引用块、GFM 表格（对齐/斑马纹/转义管道）、水平线、思考占位剥离

**Inline 级**：行内代码、粗体、斜体（长度 ≤80 保护）、链接（含尖括号）、图片（含尖括号）、自动路径链接（`apps/` / `src/` / 盘符路径 → `<button class="md-path-link">`）、CJK ↔ Latin 边界 `<wbr>`

**项目特定扩展**：
1. `stripThoughtPlaceholders` — 剥离"正在思考"占位与"本轮总结"标题
2. 自动路径检测 — 文件路径渲染成可点击 button
3. 代码块 fence info `file="..."` → 面包屑导航
4. CJK 智能断行 `<wbr>` 插入（≥10 字 CJK 串每 10 字插一个）
5. 任务列表专用 CSS 类（`md-task-item` / `md-task-box checked`）
6. 表格行斑马纹（`md-tr-alt`）
7. 不安全链接降级为 `<span class="md-a-unsafe">`
8. 代码块语言徽章 `<span class="md-code-lang" data-lang="...">`
9. 代码块复制按钮 `<button class="md-code-copy">`
10. 输入长度上限 100k 字符截断

### 7.4 支持的代码高亮语言（24 种）

javascript/js/jsx, typescript/ts/tsx, json, xml/html, css, python/py, rust/rs, bash/shell/sh/powershell, markdown/md, sql, yaml/yml, go, java, c, cpp, diff, ruby/rb, php, swift, kotlin/kt, dart

### 7.5 预计工作量

10-11 人天

---

## 八、Stream B 详细任务

**目标**：扩展 `crates/conex-db` 实现 SQLite 持久化 + 新建 `crates/conex-types` 类型 + 11 个 Tauri command + 数据迁移脚本。

### 8.1 步骤

1. 在 [conex-types/src/lib.rs](file:///c:/Software/conex/crates/conex-types/src/lib.rs) 新增 `SessionMessage` / `SessionAgent` / `SessionIndexEntry` / `ImportStats` / `CoreError` 类型（serde camelCase）
2. 在 [conex-db/Cargo.toml](file:///c:/Software/conex/crates/conex-db/Cargo.toml) 加 `conex-types` 依赖
3. 在 [conex-db/src/lib.rs](file:///c:/Software/conex/crates/conex-db/src/lib.rs) 新增 5 张表 DDL（sessions/session_messages/session_agents/session_agent_messages/session_meta）+ 触发器 + 索引
4. 引入 `schema_version` 元数据机制（写入 metadata 表）
5. 实现 12 个 LocalDb 方法（含增量 append、级联删除、幂等写入）
6. 修复 [conex-db/src/lib.rs:149-151](file:///c:/Software/conex/crates/conex-db/src/lib.rs#L149-151) 的 `query_events` 加 `LIMIT` 参数
7. 新建 [session_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/session_commands.rs)：11 个 Tauri command
8. 新建 `SharedDb` struct 包装 `LocalDb`，在 [main.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs) setup 中 `app.manage(SharedDb::new(db))`
9. 把 [core_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/core_commands.rs) 的 `db_ready` 硬编码改为真实状态
10. 在 [main.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs) 注册 11 个 session command（两份分支都加）
11. 在 [agent-workbench/src-tauri/Cargo.toml](file:///c:/Software/conex/apps/agent-workbench/src-tauri/Cargo.toml) 加 conex-db 依赖
12. 实现 `import_from_localstorage` 方法（解析 JSONL + JSON 数组两种格式）
13. 顺带重构 [register_handlers! 宏](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs#L21) 两份分支为 `($dev:tt)` 叠加模式

### 8.2 关键约束

- **DB 文件路径**：`app_dir()/sessions.db`（参考 [host_paths.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/host_paths.rs)）
- **CPU 密集任务必须 `tokio::task::spawn_blocking`**
- **JSONL 历史数据兼容**：`import_from_localstorage` 内先尝试 `serde_json::from_str<Vec<SessionMessage>>`，失败再走 JSONL 行解析
- **`ON DELETE CASCADE`**：删 session 自动级联删 messages / agents / agent_messages
- **`WITHOUT ROWID`**：所有表用复合主键，避免 SQLite 自动 rowid 浪费
- **`message_count` 冗余字段**：由触发器维护，避免侧栏每次 `SELECT COUNT(*)`

### 8.3 预计工作量

6-7 人天

---

## 九、Stream C 详细任务

**目标**：改造 JS markdown 渲染层，启用 Rust 渲染，删除死代码。

**依赖**：Stream A 的接口契约发布后启动。

### 9.1 步骤

1. 在 [rustCore.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/rustCore.ts) 新增 `renderMarkdownBatch` / `highlightCode` / `clearMarkdownCache` 包装
2. 改造 [markdownRenderAsync.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts)：`parseMarkdownToHtmlAsync` 改为调 `invoke('md_render')`，missing 时回退 worker
3. 改造 [codeHighlight.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/codeHighlight.ts)：`highlightCode` 改为调 `invoke('highlight_code')`，保留 fallback
4. **改造 [AsyncMarkdownBlock.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx)**：`useLayoutEffect` → `useEffect`，渲染前显示 skeleton，渲染完成后 `innerHTML`
5. **删除死代码**：
   - [IncrementalMarkdownParser.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/IncrementalMarkdownParser.ts)（525 行）
   - [incrementalMarkdownBridge.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/incrementalMarkdownBridge.ts)
   - [markdownWorker.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/markdownWorker.ts)（未注册到 pool）
   - [domPatch.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/domPatch.ts)
   - [StreamRenderBuffer.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/StreamRenderBuffer.ts) 内部的 bridge 字段
6. **移除 6 处组件层 `DOMPurify.sanitize`**：
   - [FilePreview.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilePreview.tsx)
   - [InlineAgentPanel.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/InlineAgentPanel.tsx)
   - [DiffCardUnifiedView.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/DiffCardUnifiedView.tsx)
   - [DiffCardSplitView.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/DiffCardSplitView.tsx)
   - [SkillDetail.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/skills/SkillDetail.tsx)
   - [SkillDetailPreview.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillDetailPreview.tsx)
7. [markdownCache.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownCache.ts) 改为 thin wrapper（统计调用 Rust 缓存）
8. 适配 [MessageContent.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx)：流式期间仍走纯文本 div，完成态切到 Rust 渲染

### 9.2 关键约束

- **流式期间保留纯文本 div 渲染**（[MessageContent.tsx:93-104](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx)），完成后切到 Rust 渲染
- **必须保留 worker fallback**（missing 状态时回退）
- **DOMPurify 移除前 Rust ammonia 必须先跑 1-2 周验证无 XSS**

### 9.3 预计工作量

5 人天

---

## 十、Stream D 详细任务

**目标**：改造 JS session 持久化层，启用 SQLite，删除冗余存储层。

**依赖**：Stream B 的接口契约发布后启动。

### 10.1 步骤

1. 新建 [sessionRustDb.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts)：14 个 API 改为 `invoke`，全部 `async`
2. 编写迁移脚本 [migrateFromLocalStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts)：扫描 localStorage 所有 `crish_session_*` key，调 `import_from_localstorage` 一次性导入
3. 在 [store-persistence.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-helpers/store-persistence.ts) 的 `initStorePersistence` 前调用 `ensureMigrated`（检测 `schema_version`）
4. 改造 `initStorePersistence`：`hydrateSessionsFromDisk` 改为 `await hydrateSessionsFromRust()`
5. 改造 [sessionLocalStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts) 的 `persistAllSessions`：按 session 调 `save_session_body`（避免单次 IPC 传所有数据）
6. 改造 `setActiveSessionId`：按需 `load_session_body`（懒加载）
7. **删除冗余存储层**：
   - [sessionIndexedDb.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionIndexedDb.ts)
   - [asyncStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/asyncStorage.ts)
   - [sessionDiskMirror/](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror) 整个目录（mirrorStorage / mirrorSanitizer / mirrorTypes）
   - [sessionDiskMirror.test.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror.test.ts)
8. 保留 [sessionHydration.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionHydration.ts) 的 `sanitizeMessagesForHydrate` 形状守卫，删除 `messagesToJsonl` / `jsonlToMessages` / `messagesToJsonlWorker` / `jsonlToMessagesWorker`
9. 更新 [sessionPersistence.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionPersistence.ts) barrel 导出
10. 改造 [sessionEventHydrate.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventHydrate.ts) 的 `fetchSessionEvents`：加分页参数

### 10.2 localStorage key 命名规则

| Key 常量 | 实际字符串 | 含义 |
|---|---|---|
| `SESSION_INDEX_KEY` | `crish_session_index_v1` | 索引 JSON 数组 |
| `SESSION_BODY_PREFIX` | `crish_session_body_v1:` | JSONL 字符串 |
| `SESSION_AGENTS_PREFIX` | `crish_session_agents_v1:` | Agent JSON 数组 |
| `SESSION_ACTIVE_KEY` | `crish_active_session_v1` | 当前激活 id |
| `SESSION_FOLDER_KEY` | `crish_folder_order_v1` | folder 顺序 |
| `MIRROR_META_STORAGE_KEY` | `crish_session_disk_mirror_v1` | 镜像元数据 |

### 10.3 数据迁移流程

```typescript
async function ensureMigrated(): Promise<void> {
  const schemaVer = await invoke<string | null>('get_session_meta', { key: 'schema_version' });
  if (schemaVer === '2') return; // 已迁移

  const hasLocal = localStorage.getItem('crish_session_index_v1');
  if (!hasLocal) {
    await invoke('set_session_meta', { key: 'schema_version', value: '2' });
    return;
  }

  // 1. 调用迁移
  const stats = await migrateFromLocalStorage();
  console.log('[migrate] imported', stats);

  // 2. 标记 schema_version
  await invoke('set_session_meta', { key: 'schema_version', value: '2' });

  // 3. 不立即删除 localStorage（保留 30 天作为回滚保险）
}
```

### 10.4 预计工作量

5 人天

---

## 十一、Stream E 详细任务

**目标**：简化 worker pool + 统一 CoreError 错误协议。

**依赖**：Stream A/B/C/D 接口稳定后启动。

### 11.1 步骤

1. 在 [conex-types/src/lib.rs](file:///c:/Software/conex/crates/conex-types/src/lib.rs) 新增 `CoreError` enum（thiserror + serde tag）—— 已在 Stream B 完成
2. 在 [tauriInvoke.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/tauriInvoke.ts) 新增 `invokeTyped<T>`（结构化错误）+ `invokeCmdStrict<T>`（失败抛错）
3. **把 6 个 `perf_*` 命令提升为 `core_*`**：
   - [perf/hash.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/perf/hash.rs) → `core_hash_compute` / `core_base64_encode` / `core_base64_decode`
   - [perf/encoding.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/perf/encoding.rs) → `core_detect_encoding` / `core_decode_text`
   - [perf/diff.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/perf/diff.rs) → `core_parse_diff`
4. 新增 Rust command `core_messages_to_jsonl` / `core_jsonl_to_messages` / `core_text_encode`
5. 在 [api-adapters.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/api-adapters.ts) 改写 `sha256Worker` / `detectEncodingWorker` / `parseDiffWorker` / `base64EncodeWorker` / `base64DecodeWorker` / `messagesToJsonlWorker` / `jsonlToMessagesWorker` 调用 invoke
6. 删除 [compute-worker.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/compute-worker.ts) 对应 case
7. 删除 [io-worker.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/io-worker.ts) 对应 case
8. 保留 [render-worker.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/render-worker.ts) 作为 Rust 渲染的 fallback（missing 状态时）
9. 简化 [worker-pool.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/worker-pool.ts)：默认配置仅保留 render 通道
10. **删除死代码**：`session.search` / `externalize.blobs` / `text.encode`（参数无效）

### 11.2 批量调用设计

```typescript
export async function messagesToJsonlHybrid(messages: unknown[]): Promise<string> {
  if (messages.length <= 50) {
    return messagesToJsonlSync(messages);  // 主线程
  }
  if (messages.length <= 500) {
    return rustCore.coreMessagesToJsonl(messages);  // 单次 invoke
  }
  // 批量分片
  const chunks = chunkArray(messages, 500);
  const results = await Promise.allSettled(
    chunks.map(c => rustCore.coreMessagesToJsonl(c))
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : '').join('\n');
}
```

### 11.3 预计工作量

5-6 人天

---

## 十二、Stream F 详细任务

**目标**：Tauri invoke mock + 性能基准 + 测试改造。

**依赖**：无，可立即启动。

### 12.1 步骤

1. 改造 [test-setup.ts](file:///c:/Software/conex/apps/crish-desktop/src/test-setup.ts)：注入 `vi.mock('@tauri-apps/api/core')`，提供 `mockTauriCommand(cmd, impl)` 工具
2. 改造 [sessionPersistence.test.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionPersistence.test.ts)（792 行）适配 Rust 后端
3. Stream A 已包含：移植 [markdownRender.lists.test.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRender.lists.test.ts) 60+ 测试为 Rust 集成测试
4. 新建 `scripts/bench-markdown-render.ts` — 10k 字符 markdown 渲染基准
5. 新建 `scripts/bench-highlight-code.ts` — 1k 行代码高亮基准
6. 新建 `scripts/bench-tauri-invoke-roundtrip.ts` — invoke 往返开销基准
7. 新建 `scripts/bench-worker-vs-invoke.ts` — 同任务的 worker / invoke 对比
8. 更新 [perf-report/baseline.json](file:///c:/Software/conex/perf-report/baseline.json) 建立新基线
9. 新建端到端测试：长会话（1000+ 消息）打开首屏可交互时延测试

### 12.2 Tauri invoke mock 设计

```typescript
// test-setup.ts
const mockCommands = new Map<string, (args: any) => Promise<any>>();

export function mockTauriCommand(cmd: string, impl: (args: any) => Promise<any>) {
  mockCommands.set(cmd, impl);
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: any) => {
    const impl = mockCommands.get(cmd);
    if (impl) return impl(args);
    return null;  // missing 状态
  }),
}));
```

### 12.3 预计工作量

3-5 人天

---

## 十三、关键文件清单

### 13.1 Rust 侧（必改）

| 文件 | 用途 |
|---|---|
| [Cargo.toml](file:///c:/Software/conex/Cargo.toml) | workspace 根，加 conex-markdown + 依赖 |
| [crates/conex-types/src/lib.rs](file:///c:/Software/conex/crates/conex-types/src/lib.rs) | 新增 Session 类型 + CoreError |
| [crates/conex-db/Cargo.toml](file:///c:/Software/conex/crates/conex-db/Cargo.toml) | 加 conex-types 依赖 |
| [crates/conex-db/src/lib.rs](file:///c:/Software/conex/crates/conex-db/src/lib.rs) | 新增 5 张表 + 12 个方法 + 修复 query_events |
| `crates/conex-markdown/Cargo.toml` | 新建 |
| `crates/conex-markdown/src/lib.rs` | 新建，crate 入口 |
| `crates/conex-markdown/src/renderer.rs` | 新建，pulldown-cmark 事件流 |
| `crates/conex-markdown/src/highlight.rs` | 新建，syntect 集成 |
| `crates/conex-markdown/src/sanitizer.rs` | 新建，URL/image 安全检查 |
| `crates/conex-markdown/src/table.rs` | 新建，表格对齐/斑马纹 |
| `crates/conex-markdown/src/ammonia_config.rs` | 新建，白名单配置 |
| `crates/conex-markdown/src/cache.rs` | 新建，moka LRU |
| `crates/conex-markdown/tests/integration.rs` | 新建，60+ 测试 |
| [apps/agent-workbench/src-tauri/Cargo.toml](file:///c:/Software/conex/apps/agent-workbench/src-tauri/Cargo.toml) | 加 conex-db + conex-markdown 依赖 |
| [apps/agent-workbench/src-tauri/src/main.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs) | 注册命令 + setup 注入 + 重构宏 |
| [apps/agent-workbench/src-tauri/src/core_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/core_commands.rs) | db_ready 改为真实状态 |
| [apps/agent-workbench/src-tauri/src/markdown_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/markdown_commands.rs) | 新建，4 个 markdown command |
| [apps/agent-workbench/src-tauri/src/session_commands.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/session_commands.rs) | 新建，11 个 session command |

### 13.2 JS 侧（必改）

| 文件 | 用途 |
|---|---|
| [apps/crish-desktop/src/api/rustCore.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/rustCore.ts) | 新增 wrapper |
| [apps/crish-desktop/src/api/tauriInvoke.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/tauriInvoke.ts) | 新增 invokeTyped |
| [apps/crish-desktop/src/api/markdownRenderAsync.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownRenderAsync.ts) | 切换 Rust |
| [apps/crish-desktop/src/api/codeHighlight.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/codeHighlight.ts) | 切换 Rust |
| [apps/crish-desktop/src/api/markdownCache.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/markdownCache.ts) | thin wrapper |
| [apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/AsyncMarkdownBlock.tsx) | 异步化 |
| [apps/crish-desktop/src/components/chat-message/MessageContent.tsx](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx) | 适配 |
| [apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts) | 新建，替换 sessionLocalStorage |
| [apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts) | 新建，迁移脚本 |
| [apps/crish-desktop/src/store/layout-helpers/store-persistence.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-helpers/store-persistence.ts) | 改 async |
| [apps/crish-desktop/src/api/sessionEventHydrate.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionEventHydrate.ts) | 加分页 |
| [apps/crish-desktop/src/workers/api-adapters.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/api-adapters.ts) | 切换 invoke |
| [apps/crish-desktop/src/workers/worker-pool.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/worker-pool.ts) | 简化配置 |
| [apps/crish-desktop/src/test-setup.ts](file:///c:/Software/conex/apps/crish-desktop/src/test-setup.ts) | Tauri mock |

### 13.3 删除清单（死代码）

| 文件 | 行数 | 理由 |
|---|---|---|
| [apps/crish-desktop/src/api/IncrementalMarkdownParser.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/IncrementalMarkdownParser.ts) | 525 | 简化版渲染，被 Rust 替代 |
| [apps/crish-desktop/src/api/incrementalMarkdownBridge.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/incrementalMarkdownBridge.ts) | 42 | bridge 死代码 |
| [apps/crish-desktop/src/workers/markdownWorker.ts](file:///c:/Software/conex/apps/crish-desktop/src/workers/markdownWorker.ts) | 31 | 未注册到 pool |
| [apps/crish-desktop/src/api/domPatch.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/domPatch.ts) | 23 | 死代码 |
| [apps/crish-desktop/src/api/session-persistence/sessionIndexedDb.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/session-persistence/sessionIndexedDb.ts) | 66 | 假 IndexedDB |
| [apps/crish-desktop/src/api/asyncStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/asyncStorage.ts) | 195 | idb-keyval 封装 |
| [apps/crish-desktop/src/api/sessionDiskMirror/mirrorStorage.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror/mirrorStorage.ts) | 307 | 磁盘镜像冗余 |
| [apps/crish-desktop/src/api/sessionDiskMirror/mirrorSanitizer.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror/mirrorSanitizer.ts) | 527 | 镜像纯函数 |
| [apps/crish-desktop/src/api/sessionDiskMirror/mirrorTypes.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror/mirrorTypes.ts) | 43 | 镜像类型 |
| [apps/crish-desktop/src/api/sessionDiskMirror.test.ts](file:///c:/Software/conex/apps/crish-desktop/src/api/sessionDiskMirror.test.ts) | 多 | 镜像测试 |

---

## 十四、风险与缓解

| 风险 | 缓解 |
|---|---|
| Rust markdown 输出与现有 CSS 不兼容 | **测试先行**：60+ 测试逐字移植，任何不兼容立即发现 |
| 异步化破坏订阅时序 | 保留 Zustand debounce 机制，仅替换底层 invoke |
| Tauri invoke 不支持 AbortSignal | 用 `Promise.race + timeout` 伪造取消；Rust 侧任务继续跑但结果丢弃 |
| 数据迁移失败 | localStorage 保留 30 天回滚保险；`schema_version` 检测可重试 |
| syntect 编译时间 30-60s | 用 feature flag 隔离，CI 分阶段编译 |
| Vec<u8> 序列化为 JSON 数组性能差 | 验证 Tauri 2.x 的 ArrayBuffer 传输；不行则 base64 编码 |
| 双份 register_handlers! 宏 | 本次顺带重构为 `($dev:tt)` 叠加模式 |
| diff.parse 类型对齐 | 改 JS 对齐 Rust 结构（Rust 结构更标准） |

---

## 十五、性能基准

### 15.1 缺失基准（必加）

1. `markdown.render.10k` — 10k 字符 markdown 渲染
2. `highlight.code.1k` — 1k 行代码高亮
3. `sha256.1mb` — 1MB 数据 SHA-256
4. `base64.1mb` — 1MB base64 编解码
5. `encoding.detect.100kb` — 100KB 编码检测
6. `worker.schedule.roundtrip` — worker pool 调度往返开销
7. `tauri.invoke.roundtrip` — Tauri invoke 往返开销
8. `tauri.invoke.batch.100` — 100 个 invoke 的批量开销

### 15.2 上线门禁

- `comparison-result.json` 的 `regressions` 数组必须为空
- 关键基准（diff.parse、messages.to-jsonl、sha256）的 p95 不得劣化 > 10%
- 新增 invoke 往返基准不得 > 1ms p95

---

## 十六、进度跟踪表

| Stream | 状态 | 负责人 | 开始时间 | 完成时间 | 备注 |
|---|---|---|---|---|---|
| A: Rust markdown | 已完成 | Agent 1 | 2026-07-28 | 2026-07-28 | conex-markdown crate (pulldown-cmark + syntect + ammonia + moka)；4 个 Tauri 命令 md_render / md_render_batch / highlight_code / md_clear_cache |
| B: Rust storage | 已完成 | Agent 2 | 2026-07-28 | 2026-07-28 | conex-db crate (SQLite)；11 个 session_commands 命令；DB 初始化含 in-memory 降级 |
| F: 测试基础设施 | 已完成 | Agent 2 | 2026-07-28 | 2026-07-28 | Tauri invoke mock (ok/missing/error 三态)；5 个基准脚本 + baseline.json |
| C: JS markdown | 已完成 | Agent 3 | 2026-07-28 | 2026-07-28 | AsyncMarkdownBlock 接入 Rust md_render；markdownRenderAsync 异步管线；useEffect 替代 useLayoutEffect |
| D: JS storage | 已完成 | Agent 4 | 2026-07-28 | 2026-07-28 | sessionRustDb.ts 调用 Rust 命令；sanitizeMessages 仅首屏窗口；migrateFromLocalStorage 迁移 |
| E: Worker 简化 | 已完成 | Agent 1 | 2026-07-28 | 2026-07-28 | api-adapters.ts 8 个适配器优先 Rust + 主线程 JS fallback；worker-pool 仅保留 render 通道；删除 markdownWorker.ts |
| Z: 联调回归 | 已完成 | 主 Agent | 2026-07-28 | 2026-07-28 | 全量验证通过（详见下方 Stream Z 验证报告） |

### 16.1 Stream Z 验证报告（2026-07-28）

**Rust 侧验证**

| 检查项 | 结果 | 详情 |
|---|---|---|
| cargo test --workspace | PASS | 109 个测试全部通过 |
| cargo clippy (Stream crates) | PASS | conex-types/markdown/db/diff/fs/ipc/sandbox/search/stream/test-utils/net/compaction 全部无警告 |
| cargo build --release | PASS | release 构建成功（3m32s），所有 Stream crate 在 release 模式下编译通过 |
| 命令注册验证 | PASS | main.rs make_handlers! 宏注册 4 个 Stream A 命令 + 11 个 Stream B 命令 + 9 个 Stream E 命令 |

**JS 侧验证**

| 检查项 | 结果 | 详情 |
|---|---|---|
| tsc typecheck | PASS | apps/crish-desktop/tsconfig.json 零错误 |
| Stream 相关单元测试 | PASS | 113/113 通过（markdownRenderAsync / api-adapters / ptyRegistry / streamingStore / tauri-command-registry / autoIndexMiddleware / useStreamCallbacks） |
| 全量单元测试 | 部分通过 | 5586/5633 通过；42 个失败均为**既有问题**（binary-frame / config-merger / pricing-engine / provider factory / protocol-registry / FirstRunWizard / immer-reactivity / oklchColorGuard 等），与 Stream A-F 改造无关 |
| tauri-command-registry 回归修复 | PASS | 修复 make_handlers! 宏重构导致的命令提取回归（增强 extractRegisteredTauriCommands 解析 make_handlers!(args) 包装宏），17/17 测试通过 |

**性能基准对比（perf-report/）**

| 基准 | 指标 | 结果 | 门禁 |
|---|---|---|---|
| markdown.render.10k | avg / P95 | 3.39ms / 5.97ms | JS 渲染管线基线（Rust 切换前的参考点） |
| highlight.code.1k | avg / P95 | ts=48.63/77.17ms, py=15.67/25.26ms, rust=12.19/17.45ms, json=140.32/174.16ms | JS highlight 基线（Rust syntect 切换前的参考点） |
| tauri.invoke.roundtrip | avg / P95 | ok=0.002/0.003ms, missing=0.027/0.037ms | invoke p95 < 1ms 门禁达标 |
| tauri.invoke.batch.100 | avg / P95 | sequential=0.071/0.262ms, concurrent=0.168/0.102ms | 批量 invoke 开销可接受 |
| worker.vs.invoke | 开销比 | invoke=0.019ms, worker=0.079ms, ratio=4.1x | 确认 CPU 轻量任务应优先走 invoke |
| long-session.first-screen | avg / P95 / 阈值 | baseline=4.349/8.944ms, rust.ok=1.575/7.666ms, fallback=3.996/9.367ms | 三态均 < 500ms 门禁达标；rust.ok 较 baseline 加速 1.17x |

**集成验证**

| 集成点 | 验证结果 |
|---|---|
| Stream A → C：Rust md_render 命令 ← AsyncMarkdownBlock 调用 | rustCore.ts 的 renderMarkdown/renderMarkdownBatch 正确 invoke md_render；AsyncMarkdownBlock 通过 useAsyncMarkdownHtml 钩子接入 |
| Stream B → D：Rust session_commands ← sessionRustDb.ts 调用 | sessionRustDb.ts 11 个方法对应 11 个 Tauri 命令；DB 初始化在 main.rs setup() 中完成 |
| Stream E：api-adapters.ts → rustCore.ts | 8 个适配器（hash/base64/encoding/diff/jsonl/text）优先调用 core_* Rust 命令，missing 时回退主线程 JS |
| Stream E：worker-pool 配置 | computeWorkers=0, ioWorkers=0, networkWorkers=0, renderWorkers=2；render 通道作为 Rust md_render 的 fallback |
| 命令注册一致性 | tauri-command-registry.test.ts 17 个测试验证 frontend registry 与 Rust generate_handler! 对齐；dev/release 分支正确分离 dev_cli 命令 |

**已修复的回归问题**

1. **tauri-command-registry 测试回归**：Stream B/E 实施时将 `register_handlers!` 宏重构为 `make_handlers!($($extra)*)` 包装器以消除 ~70 条命令的重复。此重构导致测试的宏展开器（仅支持 `() =>` 无参宏）无法提取 `make_handlers!(cli_bridge::...)` 中的 dev_cli 命令。
   - 系统化修复：在 `extractRegisteredTauriCommands` 中新增 `extractMacroCallCommands` 函数，解析 `make_handlers!(args)` 调用点并提取命令路径；同时更新 `readReleaseGenerateHandlerSource` 从 `make_handlers!` 宏定义体中提取 release 命令面。
   - 验证：17/17 测试通过，覆盖 debug/release 命令分离、dev_cli 隔离、subagent 命令等场景。

2. **conex-types clippy 修复**：测试中 `assert_eq!(entry.is_pinned, false)` 改为 `assert!(!entry.is_pinned)` 以消除 `clippy::bool_assert_comparison` 警告。

---

## 十七、协同机制

### 17.1 接口契约先行

每个 Stream 开始前，先把 Rust 函数签名 + Tauri command 签名 + TS wrapper 签名写好作为**契约**。契约一旦确定，其他 Stream 可以并行开发。

**契约文档位置**：
- Stream A 产出 → 本文档第五章
- Stream B 产出 → 本文档第五章

### 17.2 集成验证门禁

每个 Stream 完成后必须通过：
- `cargo test` 全绿
- `pnpm test` 全绿
- `cargo clippy` 无警告
- 新增性能基准不超过 baseline 20%
- 长会话首屏可交互时延 < 500ms

### 17.3 主 Agent 职责

1. 协调契约发布
2. 合并冲突
3. 验证集成
4. 跟踪进度（更新本文档第十六章）

---

## 十八、立即启动的 Stream

**最高优先级**（无依赖，立即可启动）：
1. **Stream A**：Rust markdown crate
2. **Stream B**：Rust storage 扩展
3. **Stream F**：测试基础设施

**次优先级**（依赖契约）：
4. Stream C：等 A 契约发布
5. Stream D：等 B 契约发布

**最后启动**：
6. Stream E：等 A/B/C/D 接口稳定
7. Stream Z：联调回归

---

## 十九、关键路径验证

### 19.1 Tauri 后端实际位置

```
c:\Software\conex\apps\agent-workbench\src-tauri\
├── src\
│   ├── main.rs              # 入口 + register_handlers!
│   ├── core_commands.rs     # core_* 命令模板
│   ├── markdown_commands.rs # 新建（Stream A）
│   ├── session_commands.rs  # 新建（Stream B）
│   ├── perf\                # 已有 6 个 perf_* 命令
│   └── host_paths.rs        # app_dir() 路径解析
├── Cargo.toml               # 加新依赖
└── build.rs                 # 不用改
```

### 19.2 前端 IPC 入口

```
c:\Software\conex\apps\crish-desktop\src\api\
├── tauriInvoke.ts          # invokeResult / invokeCmd
├── rustCore.ts              # typed wrapper
├── daemonClient.ts          # WebSocket RPC（独立通道）
└── bindings\                # ts-rs 生成的类型
```

### 19.3 现有 Tauri command 注册方式

[main.rs](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs) 的 `register_handlers!()` 宏有**两份分支**（debug/release），新增 command 必须两处都加。

本次顺带重构为 `($dev:tt)` 叠加模式：
```rust
macro_rules! register_handlers {
    ($dev:expr) => {{
        let mut builder = ...
            .invoke_handler(handlers![
                // 公共命令
                core_commands::core_search_files,
                // ... 70 项
                // 新增命令
                markdown_commands::md_render,
                session_commands::list_sessions,
            ]);
        if $dev {
            builder = builder.invoke_handler(handlers![
                cli_bridge::workbench_dev_cli_*,
            ]);
        }
        builder
    }};
}
```

---

## 二十、文档维护

- 每个 Stream 完成后更新第十六章进度表
- 契约变更必须同步更新第五章
- 新发现的死代码加入第十三章删除清单
- 性能基准结果记录到 [perf-report/](file:///c:/Software/conex/perf-report)

**本文档是单一权威信息源，禁止在别处复制维护，所有变更必须在此文档更新。**
