# 06 映射：AppFlowy Rust 心 → Tauri 命令/事件 + TS UI + 可选 TS 扩展

> **调研轮次**：round-B-appflowy  
> **效果锁**（见 `docs/block-workspace-architecture/00-调研边界与效果锁.md`）：栈 **Tauri + TypeScript + Rust**；目标 **Notion 的皮（块与丰富交互）+ Rust 的心（极速、低内存、原生协同计算）**；必备 **块操作 / 多人实时协同 / TS 扩展生态**；性能与体验须**双双超过**参考产品。  
> **表述纪律**：机制意图可借鉴；设计句用本产品内化语言，禁止「照抄 AppFlowy」作方案落点。  
> **证据源**：
>
> - AppFlowy：`reference/markdown_compare/AppFlowy/frontend/rust-lib/`
> - 本仓 Tauri 形态：`apps/agent-workbench/src-tauri/`、`apps/crish-desktop/`
> - 本仓 Rust 工作区：`crates/*`、`Cargo.toml`
> - 行级引擎：`reference/markdown-editor/`  
>   **对照**：round-A AFFiNE 映射见 `round-A-affine/08-映射-Tauri-TS-RS与本仓差距.md`（块 UI/扩展偏 TS 巨仓视角）；本文专攻 **AppFlowy 的 crate 切分 + FFI 事件模型** 如何落到本栈。  
>   **日期**：2026-08-10

---

## 0. 结论先行

| 判断             | 内容                                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AppFlowy 心形    | **Flutter UI + C/FFI + 插件式 Rust 内核**：`lib-dispatch` 按 event 字符串路由 → 域 crate handler；变更经 `flowy-notification` **推送**到 Dart isolate；文档权威在 **collab/yrs + DocumentManager**。                                                                          |
| 本栈心形         | **Tauri 2 壳 + React/TS + 重 Rust 内核（Agent 已深）**：`invoke(command)` 请求/响应 + `app.emit(channel)` 事件流；契约以 **serde JSON + 注册表** 为事实源（非 protobuf/FFI）。                                                                                                |
| 可直接消费的映射 | **域 crate 切分** ≈ 本仓 `crates/*` 叶子纪律；**AFPlugin event_map** ≈ Tauri `#[tauri::command]` 分组 + 可选内部 `dispatch`；**Notification** ≈ 命名事件通道（对齐已有 `workbench-run-event` / `Emitter`）；**Document ApplyAction** ≈ RS 权威 `Op` 批处理 + 投影 diff 事件。 |
| 明确不搬         | `dart-ffi` / `allo_isolate` / protobuf `*PB` 全链路 / `flowy-codegen` 生成 Dart-TS 双端；不引入第二套 FFI 运行时。                                                                                                                                                            |
| 超车杠杆         | 块事务/合并/索引 **默认 RS 权威**（AppFlowy 已是此向，本仓可把热路径压到更少 IPC）；TS 扩展只挂 UI/命令/装饰，**不污染** RS apply/merge 热路径；行级 markdown-editor **并存** 服务 Agent 流式，块工作区不吞其职责。                                                           |

---

## 1. AppFlowy Rust 心：可验证切分

### 1.1 Workspace 成员角色（`frontend/rust-lib/Cargo.toml`）

| 角色带          | Crate 证据                                                                                                                          | 职责（机制）                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **装配根**      | `flowy-core`                                                                                                                        | `AppFlowyCore` 持有各 Manager + `event_dispatcher`；`module::make_plugins` 组装 `Vec<AFPlugin>`            |
| **请求分发**    | `lib-dispatch`                                                                                                                      | `AFPluginDispatcher`：event 名 → plugin handler；async + callback                                          |
| **FFI 边界**    | `dart-ffi`                                                                                                                          | `FFIRequest { event, payload }` → `AFPluginRequest`；`init_sdk`；线程上跑 LocalSet + task 队列             |
| **推送**        | `flowy-notification`                                                                                                                | 全局 `NotificationSender` 注册表；`SubscribeObject` 下发；Dart 侧 `DartNotificationSender` 经 isolate port |
| **域实现**      | `flowy-document` / `flowy-folder` / `flowy-database2` / `flowy-user` / `flowy-search` / `flowy-ai` / `flowy-storage` / `flowy-date` | 每域：`event_map` + `event_handler` + `manager` + `entities` + `notification`                              |
| **云/抽象 pub** | `flowy-*-pub`                                                                                                                       | cloud trait、SQL 实体、会话接口——域实现与云实现解耦                                                        |
| **协同集成**    | `collab-integrate`                                                                                                                  | Collab 构建、插件 provider、索引数据                                                                       |
| **本地库**      | `flowy-sqlite` / `flowy-sqlite-vec`                                                                                                 | Diesel/SQLite；向量库                                                                                      |
| **基础设施**    | `lib-infra` / `lib-log` / `flowy-error`                                                                                             | 任务调度、日志、统一错误码                                                                                 |
| **构建期**      | `build-tool/flowy-ast` · `flowy-derive` · `flowy-codegen`                                                                           | 从 `event_map`/`Flowy.toml` 生成 protobuf、Dart event、**TS event**（`ts_event`）                          |
| **集成测**      | `event-integration-test`                                                                                                            | 按 document/folder/database 事件面做端到端                                                                 |

### 1.2 文档域事件面（块工作区核心）

`flowy-document/src/event_map.rs` 注册（节选机制）：

| DocumentEvent                                                         | 机制意图                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `CreateDocument` / `OpenDocument` / `CloseDocument`                   | 文档生命周期；open 返回 `DocumentDataPB`                                    |
| `ApplyAction`                                                         | **块操作批**：Insert / Update / Delete / Move / InsertText / ApplyTextDelta |
| `GetDocumentData` / `GetDocumentText` / `GetDocEncodedCollab`         | 快照读取 / 纯文本 / 编码 collab                                             |
| `CreateText` / `ApplyTextDeltaEvent`                                  | 文本 CRDT 增量（与块 action 并列的细粒度写）                                |
| `Redo` / `Undo` / `CanUndoRedo`                                       | 文档级撤销                                                                  |
| Snapshot / Convert / Upload-Download-DeleteFile / `SetAwarenessState` | 快照、导入导出、附件、presence                                              |

**数据形状**（`entities.rs`）：

- `DocumentData`：`page_id` + `blocks: Map<id, Block>` + `meta`（`children_map` + `text_map`）
- `Block`：`id` / `ty`（flavour）/ `data` / `parent` / `children` / 可选 external
- `BlockAction`：动作类型 + payload（block / prev_id / parent_id / text_id / delta JSON）

**变更推送**（`document.rs`）：

- `subscribe_block_changed` → `DocumentNotification::DidReceiveUpdate` + `DocEventPB`（events, is_remote）
- snapshot / sync / awareness 各独立 notification 类型

### 1.3 请求/推送双通道（FFI 事件模型）

```
Flutter/UI
   │  FFIRequest(event: String, payload: bytes/protobuf)
   ▼
dart-ffi ──► AFPluginDispatcher.async_send
   │              │
   │              ▼
   │         AFPlugin (flowy-document / folder / …)
   │              │
   │              ▼
   │         Manager (DocumentManager 等) ──► collab/yrs 状态
   │              │
   │              ▼
   │         NotificationBuilder.send
   ▼              │
FFIResponse ◄─────┘（请求-响应）
   ▲
   │  DartNotificationSender → isolate port（订阅推送）
SubscribeObject / DocumentNotification
```

要点：

1. **命令是「具名 event 字符串 + 二进制 payload」**，不是 Tauri 式按函数签名的 IPC。
2. **写后结果多半不经 response 回完整树**，而是 **notification 推送 diff/事件**。
3. Codegen 把 event 枚举同步到 Dart/TS 客户端，避免手写漂移。

### 1.4 Folder 等「工作区壳」事件

`flowy-folder` 的 `FolderEvent` 覆盖：当前 workspace、view 树 CRUD/Move、trash、favorites/recent、publish/share、lock——即 **知识库导航 + 视图元数据**，与 document 块树正交。块工作区产品面需要 **folder 级 + document 级** 两套命令，不可混成一个 god-crate。

---

## 2. 本仓已定形态（映射锚点）

### 2.1 Tauri 命令面

| 锚点     | 路径                                                             | 形态                                           |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| 注册真源 | `apps/agent-workbench/src-tauri/src/main.rs` `command_registry!` | `(wire 名, 函数路径)`；`generate_handler!`     |
| 清单契约 | `command_manifest.rs` + 前端 manifest 快照                       | 条数/登记/漂移测试                             |
| 命名     | wire 如 `core_run_task`、`workbench_*`、`core_md_render`         | `#[tauri::command(rename = "...")]` 可纠函数名 |
| 序列化   | 主流 `camelCase` serde（见 `ipc-naming-conventions.md`）         | **不用** protobuf                              |

### 2.2 事件面

| 锚点           | 路径                                                                      | 形态                                            |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Agent 运行事件 | `core_event_bridge.rs`：`EventBridge` + `Emitter` + `TauriEmitter`        | 通道 `workbench-run-event`；载荷 JSON 字符串    |
| 信封/注册表    | `crates/conex-types`：`AgentEvent` + `contracts/engine-events.json`       | 双端事实源；`generate-engine-bindings.mjs` → TS |
| 浏览器/PTY     | `browser://…`、pty 通道                                                   | **一域一通道或共享信封** 已有先例               |
| 前端消费       | `crish-desktop`：`listen` + `invoke`（`chatBridge`、`browserSessionApi`） | 懒订阅、router 分发                             |

### 2.3 已有 crate 习惯（与「文档块」勿混淆）

| Crate                                           | 与块工作区关系                                         |
| ----------------------------------------------- | ------------------------------------------------------ |
| `conex-db` · `blocks.rs`                        | **会话压缩块**（compaction），**不是**文档 Block 树    |
| `conex-markdown` + `markdown_commands`          | 完成态 MD→HTML 渲染热路径（Agent 聊天气泡）            |
| `orchestrator` / `session-loop` / `agent-tools` | Agent 运行时；可消费文档工作区 API，但不应内嵌编辑内核 |
| `conex-fs` / `conex-search`                     | 文件沙箱与搜索——文档附件/全文索引可复用边界            |
| `conex-types`                                   | 跨端事件/错误契约范式——**文档事件应平行扩展同类纪律**  |

### 2.4 前端壳

- `apps/crish-desktop`：React UI、Zustand、API 层 `invoke`/`listen`。
- 块工作区 UI 落此应用（或同 monorepo 共享 package），**不新建 Electron/Flutter 壳**。

---

## 3. 分层映射总表（选型直接消费）

| 分层          | AppFlowy 机制                       | 本栈映射机制                                                          | 建议内化名（逻辑模块）         | 自研 / 不搬                                    |
| ------------- | ----------------------------------- | --------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| **桌面宿主**  | Flutter 引擎 + `dart-ffi` 动态库    | **Tauri 2** `src-tauri` + webview                                     | 已有 workbench 壳              | 不搬 FFI/C ABI                                 |
| **请求入口**  | `FFIRequest.event` + protobuf bytes | `invoke("doc_*" \| "ws_*")` + serde JSON                              | **Command 面**                 | 不搬 event 字符串全局总线（可选内部仍用 enum） |
| **分发器**    | `AFPluginDispatcher` + `AFPlugin`   | Tauri handler 注册 +（可选）RS 内 `DocEngine::handle(Op)`             | **内核 Facade**                | 可借鉴「域插件」切分，不强制再造 lib-dispatch  |
| **域插件**    | `flowy-document` 等 event_map       | 域 crate + 一组 `#[tauri::command]`                                   | 见 §4 crate 边界               | 机制借鉴，命名内化                             |
| **推送**      | `flowy-notification` → isolate      | `app.emit` / `EventBridge` 风格通道                                   | **DocEventBridge**             | 复用 Emitter 抽象；载荷 JSON                   |
| **文档权威**  | `DocumentManager` + collab Document | RS `DocSession` / 块树 + 事务 apply                                   | **crish-doc / conex-doc**      | 权威必须在 RS；CRDT 库可选嵌入                 |
| **块操作**    | `ApplyAction` + `BlockAction*`      | `doc_apply_ops`（批 Op）                                              | **Op 集**                      | 语义对齐 insert/update/delete/move/text        |
| **文本增量**  | `ApplyTextDelta` / CreateText       | `text_edit` Op 或子命令                                               | 并入 Op 或 `doc_text_delta`    | 高频路径需批与合并                             |
| **撤销**      | Undo/Redo/CanUndoRedo 事件          | 内核 undo 栈 + 命令查询                                               | 与 Op 同事务边界               | 自研；与 Agent 外部写协调                      |
| **Awareness** | `SetAwarenessState` + notification  | 独立事件通道 / 可丢字段                                               | **Presence**                   | 不进历史；可丢                                 |
| **工作区树**  | `flowy-folder`                      | `ws_*` 命令 + 本地库表                                                | **crish-workspace**            | 与 Agent workspace 路径概念对齐但数据模型独立  |
| **数据库块**  | `flowy-database2`                   | 后期：flavour=database 的块类型 + 可选 crate                          | **crish-dbview**（可选）       | 勿与 `conex-db` 会话库混名                     |
| **搜索**      | `flowy-search` + tantivy            | 扩展 `conex-search` 或文档索引 crate                                  | 索引在 RS                      | UI 在 TS                                       |
| **存储/附件** | `flowy-storage`                     | `conex-fs` + blob 表                                                  | 附件走 FS 沙箱                 | 权限复用 agent-tools 纪律                      |
| **错误**      | `flowy-error` 码表                  | `CoreError` / 域错误 enum serde                                       | 扩展 `conex-types`             | 与现有前端 `error.kind` 对齐                   |
| **契约生成**  | protobuf + flowy-codegen TS         | **JSON Schema / events 注册表 + 生成脚本**（已有 engine-events 范式） | `contracts/doc-events.json` 等 | 不搬 PB                                        |
| **UI**        | Flutter 编辑器                      | React 块视图 + Widget 叠加                                            | `crish-desktop` 模块           | 体验自研超车                                   |
| **扩展**      | Flutter 侧组件；Rust 少扩展         | **TS 扩展注册表**（块视图/命令/装饰/导入器）                          | §5                             | RS 仅白名单能力                                |

---

## 4. 建议的 crate / 模块边界（本产品内化名）

> 下列为**逻辑边界与依赖方向**，供选型消费；不排期、不砍效果。  
> 依赖方向：**叶子无环**；Tauri 壳只装配；TS 不进 RS 热路径。

### 4.1 建议新增 / 扩展的逻辑单元

| 内化名               | 建议落点                                 | 对标 AppFlowy                          | 职责                                                    | 禁止塞入                                  |
| -------------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| **conex-doc-model**  | 新 crate（或 `crates/conex-doc` 子模块） | collab_document blocks 形状            | `Block` / `DocTree` / `Op` / schema 校验 / 纯函数 apply | UI、IPC、网络                             |
| **conex-doc-engine** | 新 crate                                 | `DocumentManager` + document subscribe | 打开文档会话、apply 批、undo、订阅 sink、快照导出       | Tauri 类型、Flutter                       |
| **conex-doc-collab** | 新 crate 或 engine 特性开关              | collab-integrate / yrs                 | 合并、编码状态、同步状态机                              | 具体网络传输实现可换                      |
| **conex-doc-store**  | 新 crate 或 `conex-db` 新表域            | CollabKVDB / 文档持久化                | 文档页元数据、快照、blob 引用；**表前缀 `doc_*`**       | 会话 compaction blocks                    |
| **crish-workspace**  | 新 crate 或 `conex-db` workspace 域      | `flowy-folder`                         | 树/收藏/最近/trash/视图类型                             | 块内容正文                                |
| **conex-doc-index**  | 扩 `conex-search` 或旁路                 | `flowy-search`                         | 全文/块级索引增量                                       | UI 高亮（可回传 offset 给 TS）            |
| **doc 命令面**       | `src-tauri`：`doc_commands.rs` 等        | `event_map` + `event_handler`          | `#[tauri::command]` 薄封装 → engine                     | 业务算法                                  |
| **DocEventBridge**   | `src-tauri` 或 engine 适配器             | `flowy-notification` + Dart sender     | `Emitter` 实现；通道见 §4.3                             | 与 Agent 事件混用同一 type 枚举（应分域） |
| **TS 投影层**        | `packages/*` 或 `crish-desktop/src/doc`  | Flutter BLoC/监听                      | 本地投影、选择集、未确认 Op 乐观层（可选）              | 权威合并                                  |
| **TS 扩展主机**      | 同上                                     | （AppFlowy 弱于 AFFiNE）               | flavour→视图、slash、命令面板                           | 写盘/合并                                 |

### 4.2 与现有 crates 的挂接关系

```
                    ┌─────────────────────────────┐
                    │  apps/agent-workbench       │
                    │  doc_commands / ws_commands │
                    │  DocEventBridge (emit)      │
                    └─────────────┬───────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
   conex-doc-engine        crish-workspace          (existing)
   + collab/store          + conex-db tables        session-loop
          │                       │                 orchestrator
          ▼                       ▼                 agent-tools
   conex-doc-model         conex-fs (附件)          conex-markdown
          │                                             │
          └──────────── 可选：MD↔块 适配 ───────────────┘
                         (导入导出，非热路径)
```

| 现有单元               | 挂接方式                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `conex-types`          | 增加 **文档域** 事件/错误契约（独立于 `AgentEvent` 41 种，或并列 namespace）；注册表 + 漂移测试同纪律 |
| `conex-db`             | 新表 `doc_pages` / `doc_snapshots` 等；**永不**复用 `compression_blocks` 语义                         |
| `conex-fs`             | 图片/附件字节与回收站                                                                                 |
| `conex-markdown`       | **导出/导入/Agent 读写 MD**；非编辑主循环                                                             |
| `orchestrator` / Agent | 工具可调用「打开文档 / 插入块 / 读投影」**经 engine API**，禁止工具直接改投影缓存                     |
| `command_manifest`     | 新增 `doc_*` / `ws_*` 登记项与前端快照                                                                |

### 4.3 建议的命令 / 事件命名（wire，可直接进 manifest 草案）

#### 命令（请求-响应，`invoke`）

| Wire 名                                                | 对标 DocumentEvent / Folder        | 输入/输出要点                                      |
| ------------------------------------------------------ | ---------------------------------- | -------------------------------------------------- |
| `doc_create`                                           | CreateDocument                     | pageId?, initialOps? → pageId                      |
| `doc_open`                                             | OpenDocument                       | pageId → DocSnapshot（块图投影）                   |
| `doc_close`                                            | CloseDocument                      | pageId                                             |
| `doc_apply_ops`                                        | ApplyAction（+ 文本 delta 可并入） | pageId, ops[], clientClock? → { serverClock, ack } |
| `doc_get_snapshot`                                     | GetDocumentData                    | pageId → DocSnapshot                               |
| `doc_get_text`                                         | GetDocumentText                    | pageId → plain/md                                  |
| `doc_undo` / `doc_redo` / `doc_can_undo_redo`          | Undo/Redo/Can                      | pageId                                             |
| `doc_set_awareness`                                    | SetAwarenessState                  | pageId, presence                                   |
| `doc_export` / `doc_import`                            | Convert*                           | format, payload                                    |
| `ws_list_tree` / `ws_create_view` / `ws_move_view` / … | FolderEvent 子集                   | 工作区导航                                         |
| `doc_upload_blob` 等                                   | UploadFile…                        | 走 fs 沙箱                                         |

#### 事件（推送，`listen`）

| 通道建议         | 对标 Notification                  | 载荷要点                                              | 背压                               |
| ---------------- | ---------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| `doc-page-event` | DidReceiveUpdate 等                | 顶层 `{ type, pageId, sequence, schemaVersion, ... }` | ops/diff：soft；快照强制：critical |
| 或复用多通道     | sync / snapshot / awareness 拆通道 | `doc-sync-state` / `doc-awareness`                    | awareness：**可丢**                |

**纪律**（对齐现有 Agent 事件）：

1. Rust enum / 注册表为唯一事实源；TS 生成。
2. `schemaVersion` + `sequence` 可重放/去重。
3. **不要**把文档高频 delta 塞进 `workbench-run-event`（通道语义污染 + 背压策略冲突）。

### 4.4 内部是否还要「AFPlugin 式」dispatch？

| 选项                                | 说明                                  | 适用                                                  |
| ----------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| **A. 仅 Tauri 命令 → engine 方法**  | 每命令一个 handler，薄封装            | 默认；与本仓 manifest 铁律一致                        |
| **B. engine 内 Op 枚举总线**        | 单一 `apply(ops)` 入口，命令只构造 Op | **推荐主写路径**（对齐 ApplyAction 批处理）           |
| **C. 再造 lib-dispatch 字符串路由** | event 字符串动态插件                  | **不推荐**；与 manifest/类型安全冲突，且 FFI 历史包袱 |

选型结论（供后续消费）：**对外 Tauri 静态命令表；对内 Op 批处理总线**——取 AppFlowy「ApplyAction 批」之长，弃「全局字符串 event + PB」之短。

---

## 5. TS 扩展如何挂载且不污染 Rust 热路径

### 5.1 热路径定义（必须干净）

| 热路径（RS）                              | 非热路径（TS 可做）           |
| ----------------------------------------- | ----------------------------- |
| `apply_ops` / 合并 / 校验 schema 权威子集 | 块 React 渲染、动画、拖放预览 |
| undo 栈提交                               | slash 菜单候选排序 UI         |
| 持久化与编码 collab 更新                  | 主题、快捷键绑定展示          |
| 索引增量（可选异步）                      | 导入向导、设置面板            |
| awareness 合并（轻量）                    | 远程光标 **绘制**             |

**铁律**：扩展代码默认 **不能** 在 apply 前后插入同步 RS 回调；需要钩子时用 **异步、可跳过、有预算** 的订阅（post-apply 事件），失败不得回滚已提交 Op（除非显式事务扩展协议，后期再定）。

### 5.2 扩展挂载面（仅 TS）

| 扩展点                | 注册内容                            | 与 RS 关系                                                   |
| --------------------- | ----------------------------------- | ------------------------------------------------------------ |
| **BlockView**         | `flavour → React 组件`              | 只读投影 props；写 → `doc_apply_ops`                         |
| **InlineDecoration**  | 装饰器（提及、链接预览）            | 显示层；持久属性经 Op                                        |
| **Command**           | 命令面板/快捷键 → 构造 Op 或打开 UI | 无直接 FS                                                    |
| **Widget**            | slash / 拖柄 / 浮动条               | 纯 UI；提交时调 API                                          |
| **Importer/Exporter** | MD/HTML/CSV → Op 序列               | 可先在 TS 解析，**大文档**应 `spawn_blocking` 或 RS 解析命令 |
| **Schema 扩展（软）** | TS 侧 JSON Schema 补字段            | RS 未知字段：**透传保留** 或 拒绝策略需版本化（选型）        |

### 5.3 为何不在 RS 挂插件 DLL

| 维度          | 说明                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| AppFlowy 实际 | 扩展重心在 Flutter；Rust 是固定域插件（compile-time `make_plugins`），不是用户热插拔 |
| 本产品目标    | **TS 扩展生态**；热更新/社区块类型在 webview 侧更自然                                |
| 安全          | RS 插件 = 原生代码权限；与 `conex-sandbox` / agent 工具红线冲突面大                  |
| 性能          | 用户扩展若进 apply 会拖垮「超过 AppFlowy」的延迟目标                                 |

### 5.4 可选：RS「能力白名单」供扩展调用

扩展若需算力（大文档转换、全文检索）：

1. 只暴露 **稳定 Tauri 命令**（已在 manifest 登记）。
2. 扩展通过前端 SDK `invoke` 调用，**不**获得任意 Rust 符号。
3. 与 Agent 工具同源权限模型时可复用审计事件。

---

## 6. 与 markdown-editor 行级引擎的关系选项（边界，不写工期）

> 资产保护：`reference/markdown-editor/` 测试与源码入库纪律见 `Agents.md`；改引擎必跑 `npm test`。

### 6.1 两套模型对照

| 维度     | markdown-editor（行级）             | AppFlowy/本产品块树                 |
| -------- | ----------------------------------- | ----------------------------------- |
| 权威结构 | `lines: string[]` + 行 AST / 偏移树 | 块 id 树 + text_map / CRDT 文本     |
| 编辑粒度 | 行 splice、grapheme、表格单元格     | BlockAction / Op：块级 + 文本 delta |
| 主场景   | AI 流式 append、聊天历史、源码向 MD | 知识库、嵌套块、协同、数据库块      |
| 协同     | 无（分析结论：协作后置）            | 有（collab/yrs 或本栈 RS 合并）     |
| 本仓消费 | 专项 e2e + 单元门禁；体验资产       | 待建块工作区                        |

### 6.2 关系选项（互斥或组合需产品锁效果，此处只标边界）

| 选项                       | 边界描述                                                              | 优点                                     | 风险 / 禁区                                                                         |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| **R1 并存双核**            | 聊天/Agent 流式 **永远** 行级；工作区笔记 **永远** 块树；仅导入导出桥 | 职责清晰；不破坏流式热路径；测试资产独立 | 两套交互需产品一致的「皮」；用户可能困惑两种编辑器                                  |
| **R2 块树权威 + 行级投影** | 打开块文档时生成只读或受限 MD 行缓冲供「源码模式」；保存回灌 Op       | 一种权威；源码党友好                     | 往返保真（表格/嵌套）难；禁止双向同时可写                                           |
| **R3 行级权威 + 块 UI 壳** | 继续 lines[]，块操作只是 UI 分组                                      | 复用现引擎                               | **达不到** Notion 向嵌套/协同/块数据库；与效果锁冲突 → **默认否决**，除非效果锁修改 |
| **R4 渐进合并**            | 文本 paragraph 块内部复用行级渲染/IME/表格实现，树结构仍块权威        | 复用 IME/虚拟滚动/表格资产               | 必须 **明确接口**：行引擎是块内 editor embed，不持有页级权威                        |

**默认推荐供选型**：**R1 为产品边界底线 + R4 为块内复用**——即

- 页级：块树 RS 权威（AppFlowy 向、超车点在 RS 性能与 IPC 批次）；
- 块内富文本/MD 单元：可嵌入 markdown-editor 的渲染与输入子系统；
- Agent 消息流：不迁块树。

### 6.3 适配器边界（MD ↔ 块）

| 方向       | 职责归属                | 约束                                            |
| ---------- | ----------------------- | ----------------------------------------------- |
| MD → 块树  | 导入器（大文件优先 RS） | 不丢 commonmark 门禁语义；扩展语法进 block data |
| 块树 → MD  | 导出器 / Agent 只读工具 | 稳定可 diff；round-trip 允许信息子集            |
| 流式 token | **仅行级**              | 禁止每个 token `doc_apply_ops`                  |

### 6.4 与 `conex-markdown` 的边界

| 组件             | 用途                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| `conex-markdown` | 完成态 HTML、高亮、消毒（聊天气泡、预览卡）                                       |
| markdown-editor  | 可编辑行级体验、IME、虚拟滚动                                                     |
| 块工作区         | 结构编辑 + 协同；预览可调用 `conex-markdown` 对某块 data 渲染，**不经**整页行缓冲 |

---

## 7. AppFlowy → 本栈：事件路径对照（实现选型用）

### 7.1 打开文档

| 步骤 | AppFlowy                          | 本栈                             |
| ---- | --------------------------------- | -------------------------------- |
| 1    | Flutter 调 event `OpenDocument`   | `invoke('doc_open', { pageId })` |
| 2    | handler → `DocumentManager::open` | engine open → store 加载         |
| 3    | 返回 `DocumentDataPB`             | 返回 `DocSnapshot` JSON          |
| 4    | subscribe_block_changed           | 注册 page 到 DocEventBridge      |
| 5    | UI 持有完整 map                   | TS 投影 store hydrate            |

### 7.2 应用块操作

| 步骤 | AppFlowy                               | 本栈                                              |
| ---- | -------------------------------------- | ------------------------------------------------- |
| 1    | `ApplyAction` + `Vec<BlockActionPB>`   | `doc_apply_ops` + `ops[]`                         |
| 2    | `document.write().apply_action`        | engine 事务 apply（可合并）                       |
| 3    | response 空 Ok                         | ack + clock                                       |
| 4    | notification DidReceiveUpdate + events | emit `doc-page-event` type=`ops-applied` / `diff` |
| 5    | 本地与远程 UI 同源更新                 | 本地若乐观更新需用 sequence 校准                  |

### 7.3 远程协同更新

| 步骤 | AppFlowy                      | 本栈                      |
| ---- | ----------------------------- | ------------------------- |
| 1    | collab 插件收更新             | collab 层收更新           |
| 2    | block_changed(is_remote=true) | 同 sink，`origin: remote` |
| 3    | isolate 推送                  | `doc-page-event`          |
| 4    | Flutter 重绘                  | React 投影 patch          |

### 7.4 与 Agent 运行时交错

| 场景                        | 建议                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Agent 写打开中的 `.md` 文件 | `conex-fs` 变更通知 → 文档引擎 **外部变更** 策略（提示重载 / 三路合并），禁止静默覆盖未推送 Op |
| Agent 要改块文档            | 工具调用 `doc_apply_ops`（带 agent 身份 origin），进同一合并与审计                             |
| 压缩块 `conex-db::blocks`   | 会话摘要域，**零交叉**                                                                         |

---

## 8. 超过 AppFlowy 体验的架构检查点（映射后果）

| 目标体验      | 映射层动作                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- |
| 更低输入延迟  | 批 Op、合并 text delta、避免每键 FFI/protobuf；关键路径可 **本地乐观 + 异步 ack**（严格时钟） |
| 更低内存      | 大文档分页/窗口化投影；RS 侧块存储紧凑；TS 不持第二份完整 yrs 镜像（若 collab 在 RS）         |
| 更强扩展      | TS 扩展主机 + 未知 flavour 占位；RS schema 透传策略版本化                                     |
| 与 Agent 一体 | 同一 Tauri 壳；文档命令与工具审计统一；行级流式不被块树拖垮（R1）                             |
| 工程 DX       | 弃 PB/codegen 双端地狱；沿用 `engine-events` 式注册表 + manifest 漂移测试                     |

---

## 9. 本仓差距快照（供后续轮次，不排序）

| 域         | 现状                                   | 相对 AppFlowy 心                           |
| ---------- | -------------------------------------- | ------------------------------------------ |
| 块文档模型 | 无（compaction blocks 同名异义）       | 缺 DocumentData/ApplyAction 整层           |
| 工作区树   | Agent 文件树 / 产出目录，非 view 树    | 缺 folder 级产品模型                       |
| 协同       | 多设备 WS 面偏 Agent/设备，非文档 CRDT | 缺文档 sync                                |
| IPC 范式   | 成熟（命令清单 + 事件桥）              | **可直接承载** doc 域                      |
| 行级编辑   | 强（markdown-editor 资产）             | AppFlowy 不以此为主；本仓应 **保留并隔离** |
| 扩展       | 设置/技能/MCP 偏 Agent                 | 缺块 flavour 扩展主机                      |

---

## 10. 选型消费清单（DoD 对齐）

后续方案/实现任务可直接勾选：

1. **是否采用「对外 Tauri 静态命令 + 对内 Op 批」**（§4.4 B）——默认是。
2. **文档事件是否独立通道 `doc-page-event`**（§4.3）——默认是，与 `workbench-run-event` 隔离。
3. **crate 是否按 model / engine / store / workspace 切开**（§4.1）——依赖方向不可逆。
4. **TS 扩展是否禁止进入 apply 热路径**（§5.1）——强制。
5. **与 markdown-editor 取 R1+R4 还是改效果锁**（§6.2）——产品确认前实现不得默认 R3。
6. **契约是否复制 conex-types 注册表纪律**——强制；不引入 protobuf 主路径。
7. **命名**：文档块 API 使用 `doc_*` / `ws_*`；禁止与 `conex-db` compaction `blocks` 混用术语「block」而不加前缀（对外文档写「文档块 / 压缩块」）。

---

## 11. 证据索引（路径）

| 主题            | 路径                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| Workspace 成员  | `reference/markdown_compare/AppFlowy/frontend/rust-lib/Cargo.toml`                  |
| 插件组装        | `.../flowy-core/src/module.rs` · `lib.rs`（`AppFlowyCore`）                         |
| 分发器          | `.../lib-dispatch/src/dispatcher.rs`                                                |
| FFI 请求        | `.../dart-ffi/src/model/ffi_request.rs` · `lib.rs`                                  |
| 文档事件        | `.../flowy-document/src/event_map.rs` · `event_handler.rs`                          |
| 块实体          | `.../flowy-document/src/entities.rs`                                                |
| 变更订阅        | `.../flowy-document/src/document.rs` · `notification.rs`                            |
| Folder 事件     | `.../flowy-folder/src/event_map.rs`                                                 |
| 通知总线        | `.../flowy-notification/src/lib.rs`                                                 |
| TS 事件 codegen | `.../build-tool/flowy-codegen/src/ts_event/`                                        |
| 本仓命令注册    | `apps/agent-workbench/src-tauri/src/main.rs`                                        |
| 本仓事件桥      | `apps/agent-workbench/src-tauri/src/core_event_bridge.rs`                           |
| 本仓事件契约    | `crates/conex-types/src/events.rs` · `contracts/engine-events.json`                 |
| MD 渲染命令     | `apps/agent-workbench/src-tauri/src/markdown_commands.rs`                           |
| 压缩块（勿混）  | `crates/conex-db/src/blocks.rs`                                                     |
| 行级引擎        | `reference/markdown-editor/src/core/`                                               |
| 效果锁          | `docs/block-workspace-architecture/00-调研边界与效果锁.md`                          |
| AFFiNE 对照映射 | `docs/block-workspace-architecture/round-A-affine/08-映射-Tauri-TS-RS与本仓差距.md` |

---

_本文件为调研映射产出：机制对齐与边界锁定，不含工期与实现补丁。_
