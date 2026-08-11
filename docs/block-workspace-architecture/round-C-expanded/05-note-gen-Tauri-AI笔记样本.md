# 05 · note-gen：Tauri + AI Markdown 笔记样本（同壳对照）

> **调研轮次**：round-C-expanded  
> **样本角色**：**同壳形态（Tauri 2 + TS 前端）下「AI 笔记」能力与上限**——证明路线可行，并标出缺口在编辑器/块/协同而非壳。  
> **代码根**：`reference/markdown_compare/note-gen`  
> **版本线索**：`src-tauri/tauri.conf.json` → `productName: NoteGen`，`version: 0.34.1`；`package.json` → `next@^15`、`@tauri-apps/*@2`、`@tiptap/*@^3.19`  
> **效果锁对齐**：本地优先 MD；AI/Agent 工具面；**不**把 note-gen 当块工作区权威模型。  
> **日期**：2026-08-11

---

## 0. 结论先行

| 判断                                   | 内容                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tauri 是否已有人证明可做 AI 笔记？** | **是。** note-gen（开源、跨桌面+移动、生产发布/更新通道齐全）用 **Tauri 2 壳 + Next 静态前端 + 本地 MD 工作区 + SQLite 辅库 + 远程 LLM** 落地了：记录→整理→写作→RAG→Agent/MCP/Skills 全链路。 |
| **完成度定位**                         | **产品完成度高的「AI 写作 + 碎片整理 + 知识检索」应用**；编辑器是 **TipTap/PM 富文本 MD 面**，不是 Notion/AFFiNE/思源级块宇宙。                                                               |
| **上限缺口在哪？**                     | **编辑器语义模型 / 块 ID / 大文档虚拟化 / 实时协同**——几乎全部落在 **前端文档内核与产品模型**，**不是** Tauri 壳或 IPC 天花板。                                                               |
| **对本产品（同壳）**                   | 可复用：**壳职责切分、AI 网关下沉、Agent 工具注册、混合 RAG、MD 文件真相 + 辅库索引**；必须自研：**权威块树/事务、块级 mutate、协同合并、大文档性能路径**（与 round-A/B 结论一致）。          |

---

## 1. 架构草图：Tauri 前后端职责

### 1.1 总览

```
┌─────────────────────────────────────────────────────────────────┐
│  前端（Next 15 → static out，React 19）                          │
│  apps 面：core/main（file / editor / mark / chat / canvas）      │
│           mobile/* ； setting/*                                   │
│  编辑器：TipTap 3 + ProseMirror + @tiptap/markdown               │
│  状态：Zustand stores + SQLite(plugin-sql) + store.json           │
│  AI/Agent：lib/ai/* 、 lib/agent/* 、 lib/rag* 、 lib/mcp/*       │
└────────────────────────────┬────────────────────────────────────┘
                             │ invoke / plugin API / Channel stream
┌────────────────────────────▼────────────────────────────────────┐
│  Tauri 2 壳（src-tauri，Rust）                                    │
│  职责偏「系统能力 + 进程 + 网络代理」，非文档权威内核：             │
│  · AI HTTP/流式代理（ai.rs）· MCP stdio 进程（mcp.rs）           │
│  · Skills 安装/Python 运行时 · OCR · 截图 · 托盘 · 备份 zip      │
│  · 模糊搜索（jieba/fuzzy）· 云文件夹/WebDAV 辅助 · 打印         │
│  插件：fs / sql(sqlite) / store / http / dialog / shell / …      │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  工作区 .md 文件      sqlite:note.db        远程 LLM / 同步远端
  （文章真相）         （记录/聊/向量/记忆/画布）  Git*/S3/WebDAV…
```

### 1.2 前端职责（产品与文档面）

| 域               | 路径证据                                                                                          | 职责                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 壳 UI / 主工作台 | `src/app/core/main/page.tsx`、`left-sidebar.tsx`                                                  | 文件树 + 编辑器 + 记录（mark）+ 聊天/Agent + 画布分栏                 |
| Markdown 编辑    | `src/app/core/main/editor/markdown/tiptap-editor.tsx`                                             | TipTap 可视化 + 源码模式、slash、大纲、AI 建议、Agent diff            |
| 工作区/文章      | `src/lib/workspace.ts`、`src/stores/article.ts`                                                   | 自定义工作区路径或默认 `AppData/article`；`writeTextFile` 落盘 `.md`  |
| 碎片记录         | `src/db/marks.ts`、`src/app/core/main/mark/*`                                                     | 文本/图/链/文件/录音/待办等「原材料」→ 再整理成笔记                   |
| 聊天与 Agent     | `src/app/core/main/chat/*`、`src/lib/agent/*`                                                     | 对话、权限、工具调用、RAG 面板、审批与 diff                           |
| RAG / 知识       | `src/lib/rag.ts`、`src/lib/bm25.ts`、`src/db/vector.ts`、`src/lib/agent/tools/knowledge-tools.ts` | 分块、嵌入、混合检索、重排、统一 knowledge_* 工具                     |
| MCP / Skills     | `src/lib/mcp/*`、`src/lib/skills/*`                                                               | 客户端管理 + 工具桥；安装与脚本执行走 Rust                            |
| 同步             | `src/lib/sync/*`                                                                                  | GitHub/GitLab/Gitee/Gitea、S3、WebDAV、云文件夹；**非 CRDT 实时协同** |
| 画布             | `src/app/core/main/canvas/*`、`src/db/canvases.ts`、`@xyflow/react`                               | 流程图/思维导图等，内容 JSON 存 SQLite                                |

### 1.3 Rust / Tauri 职责（壳与系统）

| 模块     | 路径                                                                               | 角色                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 入口装配 | `src-tauri/src/lib.rs`、`main.rs`                                                  | 插件初始化 + `generate_handler!` 命令表                                                                                        |
| AI 出站  | `src-tauri/src/ai.rs`                                                              | JSON/multipart/流式 chat completion、取消令牌、代理；**前端不直连 OpenAI SDK 出网为主路径**（见 `src/lib/ai/tauri-client.ts`） |
| MCP      | `src-tauri/src/mcp.rs`、`mcp_runtime.rs`                                           | stdio 子进程生命周期、消息读写、运行时安装                                                                                     |
| Skills   | `src-tauri/src/skills.rs`、`skill_runtime.rs`、`remote_skills.rs`                  | 包校验/安装、远程下载、Python 脚本进程                                                                                         |
| 检索加速 | `src-tauri/src/fuzzy_search.rs`、`keywords.rs`                                     | 模糊匹配（rayon 并行）、结巴分词（桌面 `jieba-rs`）                                                                            |
| 数据     | `tauri-plugin-sql` + `sqlx`                                                        | 前端加载 `sqlite:note.db`；Rust 侧重备份/恢复/删除库                                                                           |
| 其它系统 | `screenshot.rs`、`tray.rs`、`ocr_*`、`backup*.rs`、`web_clipper.rs`、`printing.rs` | 截图、托盘、OCR、备份、剪藏、打印                                                                                              |

**关键边界**：文档内容的**权威编辑态**在前端 TipTap/字符串 MD；Rust **不**持有块树/CRDT/事务日志。这与本仓「Rust 心」目标**相反**——note-gen 是 **「重前端应用 + 薄原生能力层」** 的成功样本。

### 1.4 构建与宿主

- 前端：`package.json` → `next build` 产出 `out/`；`tauri.conf.json` → `frontendDist: "../out"`，`devUrl: http://localhost:3456`
- 宿主：Tauri 2，`identifier: com.codexu.NoteGen`，支持 Windows/macOS/Linux 与 iOS/Android 配置分叉
- 关联：`.md` / `.markdown` 文件关联编辑（`tauri.conf.json` `fileAssociations`）

---

## 2. 存储：本地 MD + SQLite 双轨

### 2.1 文档真相 = 工作区 Markdown 文件

| 项         | 证据                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 工作区解析 | `src/lib/workspace.ts`：`store.json` 的 `workspacePath` 或默认相对路径 `article`（`BaseDirectory.AppData`） |
| 读写       | `src/stores/article.ts`：`readTextFile` / `writeTextFile`；新建默认 `新建文件-*.md`                         |
| 产品叙事   | `README.zh-CN.md`：「以普通 Markdown 文件为基础」「可 Git / 其他编辑器打开」                                |

**MD 是契约，不是导出凑合**——与 Obsidian 同类；但**编辑过程**经 TipTap JSON↔Markdown（`@tiptap/markdown`），往返保真取决于扩展覆盖面，而非思源 Lute 级 MD 纪律。

### 2.2 辅库 = `sqlite:note.db`

初始化聚合：`src/db/index.ts` → `Database.load('sqlite:note.db')`，并行初始化：

| 表/域                 | 文件                                        | 用途                                                             |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| marks                 | `db/marks.ts`                               | 碎片记录（scan/text/image/link/file/recording/todo）             |
| notes                 | `db/notes.ts`                               | 与 tag 关联的整理结果摘要类记录（仍有 `article/` 目录创建）      |
| chats / conversations | `db/chats.ts`、`conversations.ts`           | 对话与会话                                                       |
| vector_documents      | `db/vector.ts`                              | 分块 + embedding JSON；键前缀 `article:` / `record:` / `canvas:` |
| memories              | `db/memories.ts`                            | 长期记忆 + embedding + 策略字段                                  |
| canvases              | `db/canvases.ts`                            | 画布项目 JSON + undo/redo 栈                                     |
| knowledge_sources 等  | `db/knowledge.ts`、`lib/knowledge-index.ts` | 统一知识来源注册与索引状态                                       |
| activity / tags / …   | 对应 `db/*`                                 | 热力图活动、标签等                                               |

设置与路径偏好：`@tauri-apps/plugin-store` → `store.json`。

### 2.3 同步

- **文件向**：Git 系 + S3 + WebDAV + 云文件夹（`src/lib/sync/*`）——偏 vault 同步/冲突对话框，非 OT/CRDT。
- **结构化数据**：`auto-data-sync-queue` 等对 conversations/records 等可入队同步。
- **无** 多端实时编辑、远端选区、awareness。

---

## 3. 编辑器选型与完成度

### 3.1 选型事实

| 项                 | 结论                                    | 证据                                                                                                           |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 主编辑器           | **TipTap 3 + ProseMirror**              | `tiptap-editor.tsx`：`useEditor` + 大量 `@tiptap/extension-*`                                                  |
| MD 桥              | `@tiptap/markdown`                      | 同文件 import `Markdown`                                                                                       |
| 源码模式           | visual / source 切换                    | footer-bar + `EditorViewMode`；解析失败强制 source                                                             |
| 拖动手柄           | `@tiptap/extension-drag-handle`         | 节点级拖动（PM 切片），**非**持久块 ID                                                                         |
| 公式 / 图          | KaTeX、Mermaid 扩展                     | `math-extension.tsx`、`mermaid-extension.tsx`                                                                  |
| 表格 / 任务 / 代码 | Table*、TaskList、lowlight 代码块       | 扩展列表 ~`tiptap-editor.tsx:1416+`                                                                            |
| Slash              | 自研 slash-command                      | `slash-command/*`                                                                                              |
| AI 内嵌            | 补全/改写/翻译/生成/建议高亮/Agent diff | `ai-completion`、`ai-suggestion*`、`agent-diff-preview-extension`                                              |
| CodeMirror         | **依赖存在未在 src 使用**               | `package.json` 有 `@codemirror/commands`；`src` 无 import                                                      |
| 协同扩展           | **依赖存在，代码未接线**                | `@tiptap/extension-collaboration`、`@tiptap/y-tiptap` 仅出现在 `package.json`，`src` 无 Collaboration/Yjs 引用 |
| UniqueID           | 依赖在 package，**业务未建块 ID 模型**  | 无业务层 blockId 体系                                                                                          |

### 3.2 「块」的真实含义

- TipTap 有 **PM 节点**、拖动手柄、`moveEditorBlock`（切片移动）——这是 **编辑器交互块**，不是知识库块模型。
- RAG 分块 `MarkdownBlock`（`rag.ts` 的 `parseMarkdownBlocks`）是 **检索 chunk**，非可引用/可 mutate 的文档块。
- Agent 编辑契约：`editor-adapter.ts` 的 **行号事务**（`replace_lines` / `insert_*_line`），载荷是 **整篇 Markdown 字符串 + version**，不是 blockId 路径。

### 3.3 虚拟化与大文档

| 位置       | 是否虚拟化   | 证据                                                      |
| ---------- | ------------ | --------------------------------------------------------- |
| 文件树     | **是**       | `file-manager.tsx`：`@tanstack/react-virtual`             |
| 编辑器文档 | **否**       | TipTap 整文档 PM；滚动条为自定义容器滚动，无行/块虚拟列表 |
| 记录列表等 | 常规列表渲染 | mark 多视图组件，未见编辑器级虚拟化                       |

### 3.4 对照：AFFiNE / 思源 / Typora

| 维度         | note-gen              | AFFiNE（round-A）     | 思源 SiYuan            | Typora（体验标尺） |
| ------------ | --------------------- | --------------------- | ---------------------- | ------------------ |
| 文档模型     | PM 树 + MD 文件字符串 | BlockSuite 块树 + Yjs | 块 ID + Go kernel 事务 | 源 MD 静默 WYSIWYG |
| 块 ID / 引用 | **无**                | 有                    | 有 + 块引              | 无（文件/标题）    |
| 协同         | 文件同步              | 实时 CRDT             | 同步/发布向            | 无                 |
| 大文档       | 未虚拟化              | 有架构投入与风险面    | 内核侧有成熟路径       | 中等文档体验优     |
| AI 工具面    | **很强**（见 §4）     | 中（产品侧）          | **强**（MCP/Agent）    | 无内生             |
| 本地 MD 纪律 | 强（文件真相）        | 导出/兼容向           | 强（Lute）             | 极强               |
| 壳           | **Tauri 2**           | Electron              | Electron + Go          | 原生向闭源         |

**一句话**：note-gen 在 **AI 与本地 MD 产品闭环** 上可对标甚至超过多数笔记；在 **块交互宇宙与协同/大文档内核** 上明显低于 AFFiNE/思源，写作静默感低于 Typora。

---

## 4. AI 能力面：做到了什么粒度

### 4.1 能力地图

```
用户配置多 Provider（聊天/嵌入/视觉/语音可分模型）
        │
        ├─ 编辑器内：续写 · 章节/摘要/自定义生成 · 润色/缩写/扩写 · 翻译 · 建议 UI
        ├─ 聊天：多轮 · 附件/图片 · 引用选区 · 上下文预算与压缩
        ├─ RAG：MD 结构分块 · embedding · BM25 · 模糊 · 权重融合 · rerank
        ├─ 知识工具：knowledge_search / read / cite（article|record|canvas）
        ├─ Agent：工具注册表 + 权限 + 审批 + diff 预览 + Skills + MCP
        ├─ Memory：embedding 记忆 · 策略/敏感度 · auto 巩固
        └─ 画布：节点/图可由 AI 生成，仍可编辑（非死图）
```

### 4.2 粒度分层

| 层级               | 粒度                                            | 路径证据                                                                     | 备注                                     |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| **字符/选区**      | 光标上下文续写、选区改写                        | `lib/ai/completion.ts`、`rewrite.ts`、`translate.ts`；编辑器 bubble/浮动建议 | 上下文截断（如 full note 6k 字符级限制） |
| **行**             | Agent `replace_lines` / 事务多操作（≤100）      | `lib/agent/editor-adapter.ts`、`editor_apply_transaction`                    | **主结构化编辑粒度**                     |
| **文件**           | note_read/update/create/delete/rename/move/copy | `tool-registry` note__、folder__                                             | 工作区 FS 级                             |
| **记录/标签**      | mark__、tag__                                   | 碎片库 CRUD                                                                  | 「先记录再整理」产品核心                 |
| **知识块（检索）** | chunk + sourceKey                               | `vector_documents`、`knowledge_*`                                            | **检索原子**，非编辑原子                 |
| **会话/记忆**      | conversation compaction、memory_*               | `lib/ai/conversation-*`、`db/memories.ts`                                    | 跨会话偏好/事实                          |
| **外部工具**       | mcp__、skill__、web__、canvas__                 | `tool-registry.ts` 后半                                                      | Agent 扩展面                             |

### 4.3 RAG 实现要点

- 分块：标题上下文 + 代码/表格 atomic（`rag.ts` `parseMarkdownBlocks` / `chunkText`）
- 存储：SQLite `vector_documents`（embedding 为 JSON 字符串）+ 内存缓存 `VectorCache`
- 检索：fuzzy + vector + BM25 加权融合，可选 rerank（`rag.ts` ~1000 行后）
- 来源：`article:` / `record:` / `canvas:` 统一键（`types/knowledge`、vector 迁移 SQL）
- 策略：排除路径、作用域、Agent 策略文件 `rag-agent-policy.ts` / `rag-retrieval-policy.ts`

### 4.4 Agent / MCP / Skills

- **运行时**：`lib/agent/runtime.ts` + `agent-handler.ts`（状态机、steering、trace）
- **工具面**：`tool-registry.ts` 覆盖 editor / note / folder / tag / mark / memory / skill / mcp / knowledge / canvas / web / system…
- **编辑安全**：version 乐观、行号校验、diff 预览扩展、`permission-engine` + 用户审批
- **MCP**：Rust 管 stdio；TS `lib/mcp` 做客户端与 `mcp_call_tool` 桥
- **Skills**：本地包 + 远程安装；桌面可跑校验过的 Python 脚本（`skill_runtime`）

### 4.5 未做到 / 弱的粒度（相对块工作区目标）

- **无 blockId 级 mutate**（不能「改第 3 个列表项节点」而不靠行号/全文）
- **无多文档事务**（跨文件改无统一文档事务日志）
- **无协同编辑时的 AI 冲突语义**
- **无本地大模型运行时**（依赖用户配置的远程 API；OCR/嵌入亦走配置模型）
- 向量在 SQLite JSON 中，**非**专用向量库；规模与并发有上限

---

## 5. 关键：Tauri 路线是否已证明？上限缺口是什么？

### 5.1 已证明部分（壳与产品）

1. **Tauri 2 可承载完整 AI 笔记商业/开源产品**（多平台包、更新、深度链接、移动 Alpha）。
2. **「薄 Rust + 厚 TS」** 足以支撑：文件系统工作区、SQL 辅库、流式 LLM、MCP 子进程、OCR、Skills。
3. **本地优先 MD + 可选同步** 与 AI 可共存，且用户资产不被专有格式锁死。
4. **Agent 工具化笔记工作流**（读库、改文件、检索、记忆、画布）在 Tauri 内可落地，无需 Electron。

### 5.2 上限缺口（且多半不是壳的问题）

| 缺口                    | 表现                            | 根因层                          | 与壳关系                                                           |
| ----------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| **块权威模型**          | 无持久块 ID、块引用、块查询     | 文档模型（前端 PM/字符串）      | 壳无关                                                             |
| **结构化 Agent mutate** | 行号/全文替换，脆弱于重排与并发 | 编辑契约                        | 壳无关                                                             |
| **大文档性能**          | 无编辑器虚拟化                  | 编辑器实现                      | 壳无关（WebView 有上限，但未先做到引擎级虚拟化）                   |
| **实时协同**            | 仅文件/仓库同步                 | 未接 Yjs（依赖闲置）/无 CRDT 心 | 壳可做传输，**缺协同内核**                                         |
| **MD↔富文本往返**       | TipTap 扩展边界                 | 解析/序列化                     | 壳无关                                                             |
| **Rust 未成文档心**     | 无事务日志、无权威块树          | 架构选择                        | **主动选择**，非 Tauri 不能；本产品若要「Rust 心」必须**另行建设** |
| **向量规模**            | SQLite JSON + 全量缓存          | 索引架构                        | 可下沉 Rust/专用库，属增强                                         |

**推论（对齐效果锁）**：

> 用 note-gen 当反证：**「同壳做 AI 笔记」已有上限样本**；其天花板卡在 **编辑器语义与协同/块内核**，不是「Tauri 做不了笔记」。  
> 因此本产品若目标是 **Notion 皮 + 块操作 + 实时协同 + 超参考性能**，不能只复刻 note-gen 的 TipTap+Agent 组合——**必须自研文档权威层**；note-gen 证明的是 **AI 产品层与壳切分**，不是块工作区终局架构。

### 5.3 与五问筛选键（`00-筛选与本波目标.md` §4）

| 问                                | note-gen 答案                                                          |
| --------------------------------- | ---------------------------------------------------------------------- |
| 1. 文档真相在哪？                 | **工作区 MD 文件**；编辑态在 **前端 TipTap**；元数据/索引在 **SQLite** |
| 2. 大文档虚拟化？                 | **文件树有**；**编辑器无**                                             |
| 3. 块 ID + 结构化 mutate？        | **否**；Agent 为 **行级 MD**                                           |
| 4. MD 是契约还是导出？            | **契约（文件真相）**                                                   |
| 5. 理论上限 vs 自研 Tauri+RS+TS？ | AI/整理/检索上限高；**块/协同/内核性能上限低于**「Rust 权威块树」路线  |

---

## 6. 对本产品：同壳可复用 vs 必须自研

### 6.1 同壳可复用思路（机制意图，非抄代码）

| 思路                                 | note-gen 做法                       | 本仓可落点                                                                   |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------- |
| **AI 出站下沉壳**                    | Rust `ai_*` 代理流式 + 取消         | 已有/可对齐 session 出站与取消；避免渲染进程散落密钥与 CORS 坑               |
| **双轨存储**                         | MD 真相 + SQLite 索引/会话/记忆     | 笔记文件走 `conex-fs`；会话/向量/记忆走 `conex-db`；**勿把块权威塞进仅前端** |
| **混合 RAG**                         | vector + BM25 + fuzzy + rerank      | 检索策略可借鉴；索引实现优先 RS                                              |
| **Agent 工具注册 + 风险分级 + 审批** | `tool-registry` + permission + diff | 对齐 agent-tools / 工作区沙箱；**mutate 应升到块/事务 API**                  |
| **先记录后整理**                     | marks → organize → MD               | 产品叙事可参考；数据模型仍应服务块工作区                                     |
| **MCP/Skills 进程隔离**              | Rust 管子进程                       | 与「子 Agent/工具面」纪律兼容；注意嵌套派发红线是本仓产品规则                |
| **工作区自定义路径**                 | `workspacePath` + 相对/绝对路径选项 | 与 workspace 沙箱、`path_within_root` 同类问题                               |
| **移动/桌面同前端资产**              | Next + Tauri mobile 分叉            | 壳策略参考；本仓已定 crish-desktop / workbench                               |

### 6.2 必须自研（不可用 note-gen 当终局）

| 必须自研                      | 理由                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| **权威文档模型（块树/事务）** | note-gen 权威在前端字符串；本产品锁定 **Rust 心**                           |
| **块 ID、引用、结构化命令**   | Agent 批量改与正确性依赖此层                                                |
| **实时协同与 awareness**      | 依赖未接线；且本产品不宜以 Yjs 前端为权威                                   |
| **大文档虚拟化编辑路径**      | 需行级/块级虚拟化与映射（`reference/markdown-editor` 资产可衔接）           |
| **MD 适配层（块树 ↔ MD）**    | note-gen 是「MD 原生 + 富文本投影」；本产品是「块权威 + MD 契约」时方向不同 |
| **性能与内存对标**            | Tauri 壳相同不能自动得到；内核与渲染策略自研                                |

### 6.3 与 `markdown-editor` / 本仓既有资产

| 资产                        | 与 note-gen 关系                                                  | 建议                                                   |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `reference/markdown-editor` | note-gen **不用**该引擎；其虚拟滚动/行映射/流式是 note-gen 缺口区 | **保留并强化**，服务 AI 流式与源码向；块工作区另层适配 |
| TipTap 路线                 | note-gen 证明 TipTap 可做「够用的 AI MD 编辑」                    | 可作**过渡 UI**或对照，**不宜**作权威块模型            |
| 本仓 Agent 循环             | note-gen Agent 在 TS；本仓 session-loop 在 RS                     | 工具面可对照能力清单；运行时保持本仓权威               |

---

## 7. 路径证据索引（速查）

| 主题           | 绝对路径（仓库内）                                                 |
| -------------- | ------------------------------------------------------------------ |
| 依赖与脚本     | `reference/markdown_compare/note-gen/package.json`                 |
| Tauri 配置     | `…/src-tauri/tauri.conf.json`                                      |
| Rust 入口/命令 | `…/src-tauri/src/lib.rs`、`main.rs`                                |
| AI 代理        | `…/src-tauri/src/ai.rs`；`…/src/lib/ai/tauri-client.ts`            |
| MCP            | `…/src-tauri/src/mcp.rs`；`…/src/lib/mcp/*`                        |
| 编辑器         | `…/src/app/core/main/editor/markdown/tiptap-editor.tsx`            |
| 工作区         | `…/src/lib/workspace.ts`；`…/src/stores/article.ts`                |
| SQLite 聚合    | `…/src/db/index.ts`                                                |
| 向量/RAG       | `…/src/db/vector.ts`；`…/src/lib/rag.ts`；`…/src/lib/bm25.ts`      |
| Agent 工具     | `…/src/lib/agent/tool-registry.ts`；`editor-adapter.ts`；`tools/*` |
| 同步           | `…/src/lib/sync/*`                                                 |
| 画布           | `…/src/db/canvases.ts`；`…/src/app/core/main/canvas/*`             |
| 产品说明       | `…/README.zh-CN.md`                                                |

---

## 8. 收束

**note-gen 是「同壳 AI 笔记」的强样本，不是「块工作区」的强样本。**

- **证明**：Tauri + TS 可以做出带 RAG/Agent/MCP/Skills/多端的本地 MD 笔记产品。
- **缺口**：块模型、块级 Agent、实时协同、大文档虚拟化——**编辑器/内核问题**。
- **对本产品**：复用 **壳切分、AI 工具面、混合检索、MD 文件真相**；**权威块树与协同与性能内核必须自研**，不得把 note-gen 的 TipTap 整树当作终局架构。
