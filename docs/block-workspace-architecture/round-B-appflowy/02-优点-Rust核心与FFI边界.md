# AppFlowy：Rust 心架构优点与 FFI 边界

> **对象**：`reference/markdown_compare/AppFlowy`（shallow clone）  
> **主路径**：`frontend/rust-lib/`  
> **立场**：只谈架构优点与可借鉴机制；壳层是 Flutter，**不可整包复用**。  
> **本产品标尺**：状态沉底、重任务 Rust；壳 Tauri；UI/扩展 TS。  
> **对照结论先行**：**机制可借鉴**（域 crate 切分、事件总线、PB 契约、通知推送、collab 外置）；**壳层不可复用**（Dart FFI / Flutter isolate / MethodChannel 栈）。

---

## 1. 总览：Rust 是产品内核，Flutter 是渲染与交互壳

AppFlowy 前端是 **Flutter + 静态库 `dart_ffi`**，业务真相几乎全部在 Rust：

| 层          | 职责                                                         | 关键路径                             |
| ----------- | ------------------------------------------------------------ | ------------------------------------ |
| Flutter UI  | 渲染、手势、Bloc/状态表现                                    | `frontend/appflowy_flutter/lib/`     |
| Dart 后端桥 | 加载 `dart_ffi`、发事件、收通知流                            | `packages/appflowy_backend/`         |
| FFI 表面    | C ABI：`init_sdk` / `async_event` / `set_stream_port`        | `rust-lib/dart-ffi/`                 |
| 组合根      | 装配全部 Manager + Dispatcher                                | `rust-lib/flowy-core/`               |
| 域插件      | document / folder / database / user / storage / ai / search… | `flowy-*`                            |
| 协同底层    | Yrs/Collab（**外置仓库** AppFlowy-Collab）                   | workspace patch + `collab-integrate` |
| 本地持久    | SQLite（元数据）+ RocksDB/KV（collab 文档）                  | `flowy-sqlite` + collab-plugins      |
| 云端        | `client-api`（AppFlowy-Cloud）经 `flowy-server`              | git dep                              |

工具链：`rust-toolchain.toml` 钉 **1.85**；workspace 成员见 `frontend/rust-lib/Cargo.toml`；构建编排 `frontend/Makefile.toml`（cargo-make，含 Flutter / protobuf / **tauri** 脚本残留）。

**优点核心一句话**：  
**「一个 AFPlugin 事件名 + Protobuf 字节」同时充当命令契约、测试入口与多壳生成目标**——UI 换皮，心不变。

---

## 2. Crate 职责表（完整）

### 2.1 组合与边界层

| Crate                      | 角色                           | 要点 / 证据                                                                                                                                                                                          |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **flowy-core**             | **组合根（Composition Root）** | 持有全部 `*Manager`、`AFPluginDispatcher`、`ServerProvider`、`AppFlowyCollabBuilder`；`init` 内按依赖序 `deps_resolve` 装配；`module::make_plugins` 注册域插件。`flowy-core/src/lib.rs`、`module.rs` |
| **dart-ffi**               | **唯一 C ABI 出口**            | `crate-type = ["staticlib"]`；`extern "C"`：`init_sdk`、`async_event`、`set_stream_port`、`set_log_stream_port`、`rust_log`。`dart-ffi/src/lib.rs`、`binding.h`                                      |
| **lib-dispatch**           | **进程内事件总线**             | `AFPlugin` / `AFPluginDispatcher` / `AFPluginRequest`；事件名全局唯一（重复则 panic）；handler 注入 `AFPluginState` + `AFPluginData`。`lib-dispatch/src/module/module.rs:58-62`、`dispatcher.rs`     |
| **lib-infra**              | 跨域基建                       | 任务调度 `priority_task`、native/wasm 条件编译、校验工具等                                                                                                                                           |
| **lib-log**                | 日志                           | 可挂 `StreamLogSender` 推到 Flutter isolate                                                                                                                                                          |
| **flowy-error**            | 统一错误                       | 多 `impl_from_*` feature；可 codegen 到 Dart/TS                                                                                                                                                      |
| **flowy-notification**     | **推送侧注册表**               | 全局 `NOTIFICATION_SENDER`；`register_notification_sender`；注释明确兼容 Tauri hot reload。`flowy-notification/src/lib.rs:18-21`                                                                     |
| **event-integration-test** | 集成测                         | 绕开 Flutter，直接对 dispatcher / core 做事件级测试                                                                                                                                                  |

### 2.2 业务域（实现 + `*-pub` 契约）

模式：**实现 crate 厚、pub crate 薄**。pub 放 cloud trait / 跨域实体，避免 `flowy-document` ↔ `flowy-server` 等循环依赖；实现由 `flowy-core/deps_resolve` 接线。

| Crate                                    | 职责                                                                                 | 协同/存储锚点                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **flowy-document** (+ **document-pub**)  | 文档块：打开/关闭、ApplyAction、文本 delta、undo/redo、snapshot、导入导出、awareness | `collab_document::Document`；`DocumentManager` 用 `DashMap` 管打开文档；`DocumentCloudService` 在 pub |
| **flowy-folder** (+ **folder-pub**)      | 工作区树：view CRUD、收藏/最近、回收站、发布、共享页                                 | `collab_folder`；事件面极宽（workspace/view/trash/publish/share）                                     |
| **flowy-database2** (+ **database-pub**) | 表格/看板/日历等：field/row/cell/filter/sort/group/calculation                       | `collab_database`；`services/` 体量大，业务最重的域之一                                               |
| **flowy-user** (+ **user-pub**)          | 账号、会话、工作区切换、认证用户                                                     | 与 collab / server 生命周期绑定                                                                       |
| **flowy-storage** (+ **storage-pub**)    | 文件上传下载、缓存、uploader                                                         | 文档/附件依赖 `StorageService` trait                                                                  |
| **flowy-search** (+ **search-pub**)      | 搜索                                                                                 | 桌面侧可接索引/tantivy 相关路径                                                                       |
| **flowy-ai** (+ **ai-pub**)              | AI / chat / embedding                                                                | 桌面可初始化 vector DB（`flowy-sqlite-vec`）                                                          |
| **flowy-date**                           | 日期相关事件                                                                         | 小插件，同样走 event_map                                                                              |
| **flowy-server** (+ **server-pub**)      | 本地/云端 ServerProvider 抽象与实现                                                  | 对接 `client-api`（AppFlowy-Cloud git dep）                                                           |

### 2.3 协同与存储

| Crate                                                                               | 职责                     | 说明                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **collab-integrate**                                                                | **产品侧 collab 装配层** | `AppFlowyCollabBuilder`：选 Local / AppFlowyCloud 插件、RocksDB 磁盘插件、snapshot、网络可达性、embedding writer。**不实现 CRDT 本身** |
| **collab / collab-document / collab-folder / collab-database / collab-plugins / …** | CRDT + 本地 KV 插件      | **外置** `AppFlowy-Collab`，workspace `[patch.crates-io]` 钉 revision（`Cargo.toml:150-157`）；底层 **yrs**                            |
| **flowy-sqlite**                                                                    | 用户/元数据 SQLite       | Diesel + migrations；`flowy-database.db`                                                                                               |
| **flowy-sqlite-vec**                                                                | 向量检索扩展             | 桌面 AI 路径                                                                                                                           |

### 2.4 代码生成工具链

| Crate                                        | 职责                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **flowy-ast / flowy-derive / flowy-codegen** | 从 `Flowy.toml` + `#[derive(Flowy_Event, ProtoBuf)]` 生成：Rust protobuf 模块、**Dart event**、以及 **TS event**（`flowy-codegen` feature `ts_event` / `Project::Tauri`） |

各域 `Flowy.toml` 示例（document）：

```toml
proto_input = ["src/event_map.rs", "src/entities.rs", "src/notification.rs", ...]
event_files = ["src/event_map.rs"]
```

**优点**：契约以 Rust 为单一事实源（SSOT），多语言壳共享同一 event 枚举与 PB 消息。

---

## 3. 域如何拆：document / database / folder / collab / storage

### 3.1 统一插件形状（每个业务域同构）

```
flowy-<domain>/
  event_map.rs      # 枚举 DomainEvent + AFPlugin::event(事件, handler)
  event_handler.rs  # async fn(AFPluginData<PB>, AFPluginState<Weak<Manager>>)
  manager.rs        # 域门面：打开对象、调 collab、发 notification
  entities.rs       # Protobuf 载荷（*PB）
  notification.rs   # 推送枚举 + builder
  deps / cloud via *-pub
```

`flowy-core::module::make_plugins` 一次性挂上：

- user / folder / database / document / date / search / ai / file_storage  
  （`flowy-core/src/module.rs:12-38`）

**优点**：

1. **横向扩展按域加 crate + 注册一行**，不在 UI 层写领域逻辑。
2. **Manager 持长期状态**（打开的 Document、Database 编辑器等），handler 无状态。
3. **Weak\<Manager\> 注入**，生命周期与 core 绑定，避免 FFI 长生命周期环。
4. **域间依赖用 trait（pub crate）+ core 接线**，而不是互相 `use` 实现细节。

### 3.2 Document

- 事件面（节选）：`CreateDocument` / `OpenDocument` / `ApplyAction` / `ApplyTextDeltaEvent` / `Undo`/`Redo` / snapshot / convert / file upload / `SetAwarenessState`（`flowy-document/src/event_map.rs`）。
- `DocumentManager`：`documents: DashMap<Uuid, Arc<RwLock<Document>>>`；经 `AppFlowyCollabBuilder` 建 collab；订阅变更后 `document_notification_builder` 推 `DidReceiveUpdate` 等。
- 块操作语义落在 **collab-document**（Yjs/Yrs 文档模型），本 crate 做产品 API + 解析/导入。

### 3.3 Folder

- 工作区导航与权限/发布相关命令全集在 Rust（`FolderEvent` 枚举很长）。
- UI 只发「建 view / 移 view / 读 trash」，不持有权威树状态。
- core 里 `register_handlers` 把 document/database/ai 的「创建 view 时的内容工厂」挂到 folder（跨域协作点在 core，不在 Flutter）。

### 3.4 Database2

- 最重业务域之一：`services/` 下 field type_option、filter/sort/group、board/calendar 等。
- 仍只通过 `event_map` 暴露给壳；**计算与视图物化在 Rust**。

### 3.5 Collab（分层清晰）

```
UI 壳
  → event (ApplyAction / OpenDocument …)
    → flowy-document Manager
      → collab-integrate::AppFlowyCollabBuilder
        → AppFlowy-Collab (Document/Folder/Database + plugins)
          → 本地 RocksDB/KV + 可选云同步插件
```

**优点**：CRDT/同步演进与产品事件 API 解耦；产品可换云策略（Local vs AppFlowyCloud provider）。

### 3.6 Storage

- 独立 event 插件 + `StorageService` trait；document 只持 `Weak<dyn StorageService>`。
- 文件流水线（cache / uploader / sqlite 索引）不污染文档块逻辑。

---

## 4. 事件 / 命令如何进出 Rust（读到什么 → 写什么）

### 4.1 入站：Dart → C → Dispatcher → Handler

```
Flutter UI / Service
  → Dispatch.asyncRequest(FFIRequest { event, payload })
       // dispatch.dart: FFIRequest.writeToBuffer()
  → ffi.async_event(port, ptr, len)
       // C ABI
  → dart-ffi: FFIRequest::from_u8_pointer → AFPluginRequest
  → 专用线程 + LocalSet Runner 收 Task
  → AFPluginDispatcher::boxed_async_send_with_callback
  → 按 event 字符串找到唯一 AFPlugin handler
  → handler 解 PB → 调 Manager → 返回 AFPluginEventResponse
  → FFIResponse { payload, code } 经 allo_isolate 回写 Dart port
  → Dart 反序列化为业务 PB 或 FlowyError
```

**读到的字节契约（入）**：

| 字段      | 类型   | 含义                                          |
| --------- | ------ | --------------------------------------------- |
| `event`   | string | 事件名（由 `Display` on enum 生成，全局唯一） |
| `payload` | bytes  | 输入 Protobuf（`*PayloadPB` / `*PB`）         |

**写出的字节契约（出，请求-响应）**：

| 字段      | 含义                              |
| --------- | --------------------------------- |
| `code`    | Ok / Err / Internal               |
| `payload` | 成功：输出 PB；失败：错误 PB 字节 |

证据：

- `dart-ffi/src/model/ffi_request.rs`、`ffi_response.rs`
- `dart-ffi/src/lib.rs`：`async_event`、`Runner`、`post_to_flutter`
- `appflowy_backend/lib/dispatch/dispatch.dart`：`_sendToRust` 用 `singleCompletePort`
- `binding.h`：稳定 C API 面

**同步路径**：`sync_event` 在当前树中为 **unimplemented**（仅返回空包并打 error）——**生产路径是全异步 + isolate port**。

### 4.2 出站推送：Rust Notification → Isolate Port → Dart Stream

与请求-响应分离的 **单向通知通道**：

1. Dart `FlowySDK.init`：`set_stream_port(RustStreamReceiver.shared.port)` + `store_dart_post_cobject`。
2. Rust `register_notification_sender(DartNotificationSender)`。
3. 域内 `NotificationBuilder::new(id, ty, source).payload(...).build()` → 全局 sender → `isolate.post(SubscribeObject bytes)`。
4. Dart `RustStreamReceiver` 广播 `SubscribeObject`，UI 按 `source` + `id` + `ty` 过滤（如 Document / `DidReceiveUpdate`）。

**读到的推送契约**：

| 字段                | 含义                                |
| ------------------- | ----------------------------------- |
| `source`            | 域标识，如 `"Document"`             |
| `id`                | 实体 id（如 document_id / view_id） |
| `ty`                | 域内通知枚举 i32                    |
| `payload` / `error` | 可选 PB 字节                        |

**优点**：

- **命令路径**（RPC 式）与 **观察路径**（推送）分离，避免轮询。
- 协同远端更新、同步状态、awareness 均可走同一推送管道。
- `flowy-notification` 注释已考虑 **多壳 / hot reload 重复注册**（先 `unregister_all`）。

### 4.3 初始化边界

`init_sdk(port, config_c_str)`：

1. 解析 Dart 侧 JSON/serde 配置 → 写 env / cloud yaml。
2. 关掉旧 core DB（若有）。
3. 起 **独立 OS 线程** + `AFPluginRuntime` + `LocalSet` 任务泵。
4. `AppFlowyCore::new` 装配全部 Manager 与 plugins。
5. 返回 `0` / `-1`。

之后所有业务只经 `async_event`，**不再经 MethodChannel 传业务**（MethodChannel 仅 `getPlatformVersion` 一类平台信息）。

### 4.4 事件名与类型安全

Rust 侧：

```rust
#[derive(..., Flowy_Event)]
pub enum DocumentEvent {
  #[event(input = "OpenDocumentPayloadPB", output = "DocumentDataPB")]
  OpenDocument = 1,
  ...
}
```

- `lib-dispatch` 用 **事件 Display 字符串** 做路由键。
- codegen 生成 Dart（及历史 Tauri TS）的强类型 `DocumentEventOpenDocument` 等调用包装。
- 集成测试可直接 `AFPluginRequest::new(event).payload(...)`，**同一契约三端复用**（Rust 测 / Dart / 曾存在的 TS）。

---

## 5. FFI 边界清单（清楚 / 不确定）

### 5.1 清楚的边界

| 项目         | 结论                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ABI 表面     | 极窄：`init_sdk`、`async_event`、`sync_event`（空实现）、`set_stream_port`、`set_log_stream_port`、`rust_log`、`link_me_please`、`set_env`(deprecated) |
| 序列化       | **Protobuf**（非 JSON 主路径）；请求/响应/通知均为 bytes                                                                                               |
| 线程模型     | FFI 调用线程 → channel → **专用 runtime 线程 LocalSet**；回包 **allo-isolate**                                                                         |
| 库形态       | 默认 **staticlib** `dart_ffi`（Makefile `CRATE_TYPE`）；按平台产出 `.a` / `.so` / `.dll`                                                               |
| 业务状态位置 | **全在 Rust Manager / collab**；Flutter 不持权威文档 CRDT                                                                                              |
| 域边界       | 一域一 AFPlugin；事件名全局唯一                                                                                                                        |
| 云与本地     | `flowy-server` + collab cloud plugin；sqlite 元数据 vs collab KV 分离                                                                                  |
| 多壳意图     | codegen 含 `ts_event` 与 `Project::Tauri`；Makefile 有 `tauri.toml` 与 `TAURI_BACKEND_SERVICE_PATH`（**机制为多壳准备**）                              |

### 5.2 标为不确定 / 需注意

| 项目                             | 说明                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 本 shallow 树是否仍维护 Tauri 壳 | Makefile/codegen **残留** Tauri 路径；本调研**未验证** `appflowy_tauri` 目录是否在本 clone 完整可构建 |
| `sync_event`                     | 明确未实现；是否有调用方残留未全仓扫死                                                                |
| Web/WASM 路径                    | `lib-infra` / collab 有 wasm 分支；与桌面 staticlib FFI **不是同一边界**                              |
| 性能细节                         | isolate post 的吞吐/大 payload 拷贝成本：架构上可见「全量 bytes 拷贝」，**未在本调研做基准**          |
| Collab revision 与 Cloud rev     | 钉 git rev；升级需脚本（`update_collab_rev.sh` 等）——工程优点也是耦合点                               |

---

## 6. 架构优点（相对「UI 写业务」的对照）

1. **心厚壳薄**：打开文档、块 action、数据库 filter/group、文件夹树、同步与 snapshot 均在 Rust；Flutter 专注布局与输入。
2. **插件化事件总线**：类似「进程内 gRPC」——可测、可 codegen、可换壳。
3. **`*-pub` 打破循环依赖**：cloud trait 与实现分离，core 做 DI。
4. **协同内核外置**：Yrs/collab 独立演进；integrate 层只做产品装配。
5. **双通道 I/O**：RPC（async_event）+ Push（notification stream），契合协同「命令 + 观察」。
6. **SSOT 契约**：`Flowy_Event` + `Flowy.toml` → Dart/TS/PB 同源，减少手写桥接错误。
7. **集成测试可无 UI**：`event-integration-test` 直接打 dispatcher。
8. **生命周期显式**：`Weak` + `upgrade_document` 模式，Manager 释放可观测。

---

## 7. 对「Rust 心 + TS 皮」（本产品）的映射启发

> 本产品：**Tauri + TypeScript + Rust**；状态沉底；扩展在 TS。  
> AppFlowy 壳是 Flutter——下列只迁移**机制**，不迁移 Dart/Flutter 栈。

### 7.1 机制可借鉴（建议内化，勿点名抄库）

| AppFlowy 机制                  | 映射到本产品                                                       | 注意                                                      |
| ------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 域 crate + Manager + event_map | `crates/` 下按 document/workspace/db/collab 切 crate；每域命令枚举 | 事件名全局唯一；组合根单独 crate                          |
| `lib-dispatch` 风格总线        | Tauri `invoke` 或自研 command router → 同一套 handler              | 可用 Tauri command 代替 C ABI，**不必** staticlib+isolate |
| Protobuf / 二进制契约          | 可用 PB、Bincode、或 JSON+schema；**关键是 SSOT + codegen**        | TS 侧生成类型；扩展插件只依赖公开 schema                  |
| Notification 推送              | Tauri `emit` / 事件通道推送文档 delta、同步状态                    | 与 invoke 响应分离                                        |
| `*-pub` trait                  | 云同步、存储、AI 用 trait 放 pub crate，core 接线                  | 避免 UI 或域实现互相硬依赖                                |
| collab 与产品 API 分层         | 协同引擎 crate ≠ 产品 command crate                                | 块操作 API 稳定，引擎可换                                 |
| 元数据 SQL vs 文档 CRDT 分存   | 工作区索引/权限/设置 vs 文档 OT/CRDT 存储分离                      | 与「状态沉底」一致                                        |
| codegen 多目标                 | AppFlowy 已有 `ts_event` 思路 → 本产品应 **TS first** 生成         | 不必保留 Dart 目标                                        |
| 无 UI 事件集成测               | Rust 侧直接打 command router 做门禁                                | 对齐本仓「测试是资产」                                    |

### 7.2 壳层不可复用（明确排除）

| AppFlowy 项                                    | 原因                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| `dart-ffi` + `allo-isolate` + `RawReceivePort` | Dart VM 专用；Tauri 用 IPC/webview，不是 isolate port  |
| Flutter Bloc/插件目录结构                      | UI 框架绑定                                            |
| `appflowy_backend` MethodChannel 包装          | 移动/桌面 Flutter 插件模型                             |
| staticlib 链进 Flutter runner                  | Tauri 链的是 Rust 主进程 + 命令，不是把 core 链进 Dart |
| `Makefile.toml` Flutter 产物路径 / podspec     | 构建图不同                                             |

### 7.3 推荐映射草图（逻辑层，非工期）

```
[TS UI / 扩展]
    │  invoke(command, payload)          emit(notification)
    ▼                                         ▲
[Tauri command / 事件桥]  ────────────────────┘
    │
    ▼
[Rust: CommandDispatcher ≈ AFPluginDispatcher]
    │  注册
    ├── document  Manager  ──► collab/document engine
    ├── workspace/folder Manager
    ├── database Manager（若需要）
    ├── storage Manager
    └── sync/cloud adapters（trait）
    │
    ├── SQLite/KV 元数据与会话
    └── CRDT/协作存储
```

**与 AppFlowy 对齐的不变量**：

- UI **不**持有权威文档状态；只持有视图投影。
- 重计算（协同 merge、索引、导入导出、批量 DB 运算）在 Rust。
- 扩展（TS）只通过 **稳定 command + notification schema** 触达心，不直连存储。

**与 AppFlowy 应主动不同的点**（贴合本产品）：

- 边界用 **Tauri IPC** 而非 C ABI isolate（更简单、同进程或清晰主进程模型）。
- 扩展生态在 **TS**，codegen **优先 TS**。
- 块编辑体验与扩展模型可参考 AFFiNE/BlockSuite 调研（round-A），**心**的沉底方式参考本节 AppFlowy。

---

## 8. 证据索引（路径）

| 主题                          | 路径                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workspace 成员 / collab patch | `frontend/rust-lib/Cargo.toml`                                                                             |
| 工具链                        | `frontend/rust-lib/rust-toolchain.toml`（1.85）                                                            |
| 组合根                        | `flowy-core/src/lib.rs`、`module.rs`、`deps_resolve/`                                                      |
| FFI                           | `dart-ffi/src/lib.rs`、`model/*`、`binding.h`                                                              |
| 分发器                        | `lib-dispatch/src/dispatcher.rs`、`module/module.rs`                                                       |
| Document 事件                 | `flowy-document/src/event_map.rs`、`event_handler.rs`、`manager.rs`                                        |
| Folder 事件                   | `flowy-folder/src/event_map.rs`                                                                            |
| Collab 装配                   | `collab-integrate/src/collab_builder.rs`                                                                   |
| 通知                          | `flowy-notification/src/lib.rs`、`builder.rs`；`flowy-document/src/notification.rs`                        |
| Dart 桥                       | `appflowy_flutter/packages/appflowy_backend/lib/{ffi,dispatch/dispatch,rust_stream,appflowy_backend}.dart` |
| 构建 / 多壳残留               | `frontend/Makefile.toml`；`scripts/makefile/tauri.toml`；`flowy-codegen` `Project::Tauri`                  |
| 域 Flowy 配置                 | `flowy-document/Flowy.toml`                                                                                |

---

## 9. 一句话收束

AppFlowy 的 Rust 心优点不在「用了 Flutter」，而在：**域 crate 切分 + 全局唯一事件插件 + Protobuf 契约 codegen + 请求/通知双通道 + collab 外置装配**。  
对本产品（Tauri + TS 皮）：**抄边界与沉底策略，不抄 Dart FFI 与 Flutter 壳**；用 invoke/emit 替换 isolate port，用 TS codegen 替换 Dart event 生成，即可落到同一类「Rust 心」架构。
