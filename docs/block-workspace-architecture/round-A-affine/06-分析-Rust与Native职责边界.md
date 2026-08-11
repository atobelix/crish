# AFFiNE：Rust / Native 职责边界 vs「状态沉底、重任务交给 Rust」

> **范围**：`reference/markdown_compare/AFFiNE`（v0.27.0 镜像）  
> **读法**：只读盘点；路径为证据；对照本产品 **Notion 皮 + Rust 心**（Tauri + TS + Rust；状态沉底、重任务下沉）。  
> **不做**：工期、人员、业务优先级；不改 AFFiNE 源码。

---

## 0. 一句话结论

| 断言                           | 判定                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AFFiNE 是否「全栈 Rust 心」？  | **否**。编辑热路径（文档模型、块 schema、inline、选区、渲染、Yjs apply）几乎全在 **TS/BlockSuite**。                                                     |
| Rust/Native 实际在干什么？     | **加速与边界能力**：SQLite 持久化、FTS、服务端 y-octo 合并/投影、LLM 契约与 runtime、媒体采集、导入/预览、权限/配额/对象存储等 **I/O·加密·重计算侧车**。 |
| 与本产品「状态沉底」是否同构？ | **不同构**。AFFiNE 是 **「TS 文档内核 + Native 外围加速」**；权威协作状态在浏览器/Electron 渲染进程的 **Yjs**，而非单一 Rust 状态机。                    |
| 「Native 不够沉」有无证据？    | **有**。y-octo/yjs 双栈与显式兼容禁令；同步 merge 在 TS 调 `yjs.mergeUpdates`；Web 与桌面索引实现分叉；产品业务态（core modules）全在 TS。               |

---

## 1. Cargo workspace 与 crate 清单（读到的）

根 `Cargo.toml` workspace members（7 个路径成员）：

```
./packages/backend/native
./packages/common/native
./packages/frontend/mobile-native
./packages/frontend/native
./packages/frontend/native/nbstore
./packages/frontend/native/schema
./packages/frontend/native/sqlite_v1
```

另：`packages/frontend/native/media_capture` 是 `affine_native` 的 path 依赖（未单独列入 workspace members 表，但存在独立 `Cargo.toml`）。

### 1.1 边界总表

| Crate / 包             | 路径                                     | 绑定形态                                   | 主要职责（源码事实）                                                                                                                   | 不负责                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `affine_common`        | `packages/common/native`                 | 库；可选 `hashcash` / `napi`               | Hashcash 铸币与校验；NAPI 错误映射工具                                                                                                 | 文档模型、业务 UI           |
| `affine_native`        | `packages/frontend/native`               | **NAPI cdylib**（`@affine/native`）        | 聚合 re-export：nbstore + sqlite_v1 + media_capture；OneNote 导入会话；Mermaid/Typst 预览 SVG；hashcash                                | BlockSuite 编辑；Yjs 热路径 |
| `affine_nbstore`       | `packages/frontend/native/nbstore`       | NAPI 或 `use-as-lib`                       | **SQLite** 文档 snapshot/updates、blob、peer clocks、blob upload 时钟、**FTS**、`crawl_doc_data`（`affine_doc_loader` + y-octo merge） | 同步策略编排、Web IDB       |
| `affine_schema`        | `packages/frontend/native/schema`        | 纯库                                       | 与 `build.rs` 共享 SQLite schema / import 校验规则                                                                                     | 运行时业务                  |
| `affine_sqlite_v1`     | `packages/frontend/native/sqlite_v1`     | NAPI                                       | **旧版** `SqliteConnection`（WAL、迁移、import schema 校验）                                                                           | 新 nbstore 路径外的产品逻辑 |
| `affine_media_capture` | `packages/frontend/native/media_capture` | 编入 frontend native                       | macOS/Windows 音频采集、解码、麦克风监听、应用列表                                                                                     | 编辑器                      |
| `affine_mobile_native` | `packages/frontend/mobile-native`        | **UniFFI**（`cdylib`/`staticlib`）         | 复用 `affine_nbstore` 的 DocStoragePool；hashcash；移动端 preview                                                                      | 完整产品壳                  |
| `affine_server_native` | `packages/backend/native`                | **NAPI cdylib**（`@affine/server-native`） | 见 §1.3：y-octo、doc 投影、LLM、BackendRuntime、StorageRuntime、权限、许可证…                                                          | Nest/GraphQL 编排层本体     |

### 1.2 工作区外、但被依赖的 Rust 生态（侧车）

根 `Cargo.toml` workspace.dependencies 显示大量 **crates.io / 外部** 能力被 native 消费，**不在本 monorepo 成员内**，却定义了「Native 能干什么」：

| 依赖名                               | 用途线索                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `y-octo`                             | 服务端/本地 merge、校验 update 二进制；README 称其为 local-first 核心引擎之一 |
| `affine_doc_loader`                  | 从 y-octo 二进制解析页面/工作区内容、Markdown、搜索投影、canvas 等            |
| `affine_importer` / `onenote_parser` | 导入管线                                                                      |
| `affine_preview`                     | Mermaid / Typst → SVG                                                         |
| `memory-indexer`                     | 客户端 FTS 索引实现（nbstore）                                                |
| `llm_adapter` / `llm_runtime`        | 服务端 Copilot / BYOK                                                         |
| `doc_extractor`                      | 任意文档切块（embedding 源）                                                  |
| `tiktoken-rs`                        | token 计数                                                                    |
| `sqlx`                               | SQLite（客户端）/ Postgres（服务端 runtime）                                  |
| `safefetch` / `image` / 媒体解析栈   | 安全拉取、图片、音视频元数据                                                  |

> 含义：AFFiNE 的 Rust 重心是 **「平台加速层 + 若干外部引擎」**，不是 monorepo 内自研一整套编辑 CRDT。

### 1.3 前端 Native 能力切片（`@affine/native`）

证据：`packages/frontend/native/src/lib.rs`（re-export 聚合）、`index.d.ts`、Electron helper 引用。

| 能力域       | 典型 API / 类型                                                                                                          | 调用方（TS）                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 文档本地存储 | `DocStoragePool`：connect/pushUpdate/getDocSnapshot/setDocSnapshot/getDocUpdates/markUpdatesMerged/peer clocks/blob/fts* | `electron/.../helper/nbstore/handlers.ts` |
| 旧库兼容     | `DocStorage` / `SqliteConnection`、`ValidationResult`                                                                    | workspace handlers、v1 db-adapter         |
| 导入         | `createImportSession` / `nextImportBatch` / OneNote                                                                      | electron main import handlers             |
| 预览         | `renderMermaidSvg` / `renderTypstSvg`                                                                                    | helper/preview                            |
| 录制         | `startRecording` / `decodeAudio` / `ShareableContent`                                                                    | main/recording                            |
| 防滥用       | `mintChallengeResponse` / `verifyChallengeResponse`                                                                      | main/ui/challenge                         |

**关键事实**：`DocStoragePool` 负责 **二进制与时钟的落盘**，不在 Rust 内维护「当前正在编辑的块树」或 Yjs 文档对象。

### 1.4 服务端 Native 能力切片（`@affine/server-native`）

证据：`packages/backend/native/src/lib.rs`、`index.d.ts`、`packages/backend/server/src/native.ts` 再导出。

| 模块簇         | 路径提示                                                                                                            | 职责                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Y 二进制       | `merge_updates_in_apply_way`、`validate_doc_update`                                                                 | y-octo apply/merge/校验                                                                              |
| Doc 投影/转换  | `doc.rs` + `affine_doc_loader`                                                                                      | Markdown↔y-octo、root doc 增删、搜索/embedding 投影、公开根文档裁剪                                  |
| Doc 加载/切块  | `doc_loader.rs` + `doc_extractor`                                                                                   | 上传文件 → chunks                                                                                    |
| LLM / Copilot  | `llm/**`、`BackendRuntime::executeCopilot*`                                                                         | prompt 目录、路由策略、BYOK、流式 tool loop                                                          |
| 权限           | `permission/**`                                                                                                     | `evaluate_permission_v1`、角色矩阵 JSON                                                              |
| BackendRuntime | `runtime/backend_runtime/**`                                                                                        | 协调租约、doc compact、embedding worker、invite/mail 配额、auth challenge、workspace stats、artifact |
| StorageRuntime | `runtime/storage_runtime/**` + object_storage                                                                       | blob/doc 清理、S3 兼容对象存储、multipart                                                            |
| 安全/杂项      | content_policy、html_sanitize、safe_fetch、image、license、tiktoken、hashcash、entitlement、file_type、userdata_acl | 边界防护与合规向计算                                                                                 |

**显式兼容缺口（硬证据）**：

```text
// packages/backend/native/index.d.ts / doc_compactor.rs
// compactPendingDocUpdates:
// "Do not use this for snapshots that will be sent back to yjs clients until
//  the y-octo/yjs round-trip compatibility issue is resolved."
```

→ 服务端已用 y-octo 做合并，但 **不能安全把结果当作与客户端 Yjs 互通的权威快照**——双栈未闭合。

### 1.5 绑定与进程位置

| 运行时        | 绑定                            | 进程位置                                |
| ------------- | ------------------------------- | --------------------------------------- |
| Electron 桌面 | NAPI (`@affine/native`)         | **main / helper**（非渲染进程编辑内核） |
| Node 服务     | NAPI (`@affine/server-native`)  | 与 Nest/TS server 同进程侧车            |
| iOS/Android   | UniFFI (`affine_mobile_native`) | 原生壳；存储池镜像桌面 nbstore          |
| 纯 Web        | **无** 上述 native              | IDB + 纯 TS 索引（见 §2）               |

---

## 2. TS 仍主导的领域（重逻辑清单）

### 2.1 编辑与文档权威状态 — BlockSuite（几乎 100% TS）

| 层         | 包/路径                                  | 依赖与事实                                                                    |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| 数据 store | `blocksuite/framework/store`             | **yjs** + y-protocols；`Block`/`Store`/reactive proxy/`flat-native-y` 全在 TS |
| 同步抽象   | `blocksuite/framework/sync`              | doc/blob/awareness engine；默认源 IDB/memory/broadcast                        |
| 编辑 std   | `blocksuite/framework/std`               | inline editor、选区、keymap、clipboard、**gfx** viewport/grid、Lit 宿主       |
| 产品块     | `blocksuite/affine/blocks/*` 等 ~70 微包 | paragraph/list/database/table/surface… 模型+视图 TS                           |
| 数据视图   | `blocksuite/affine/data-view`            | 数据库视图重逻辑 TS                                                           |

**结论**：用户键入 → delta → Y.Text/Y.Map → 视图更新，整条热路径 **不经过 Rust**。

### 2.2 工作区存储编排 — `@affine/nbstore`（TS 主编排）

路径：`packages/common/nbstore/`（README 称 Space Storage）。

| 组件               | 语言               | 说明                                                                           |
| ------------------ | ------------------ | ------------------------------------------------------------------------------ |
| `sync/doc/peer.ts` | **TS**             | 推/拉/合并队列；**直接 `import { mergeUpdates, diffUpdate, ... } from 'yjs'`** |
| `storage/doc.ts`   | **TS**             | `mergeUpdates` 默认 yjs；可注入自定义 merge                                    |
| `impls/sqlite/*`   | TS 适配 + **Rust** | 桌面：TS 包一层 `NativeDBApis` → `DocStoragePool`                              |
| `impls/idb/*`      | **纯 TS**          | Web：IndexedDB + 自研 BM25/tokenizer/inverted-index（`impls/idb/indexer/`）    |
| `impls/cloud/*`    | **TS**             | HTTP/socket 云端 peer                                                          |
| `frontend/*`       | **TS**             | 对接 Y.Doc / awareness 的前端 facade                                           |
| `worker/*`         | **TS**             | 把 storage 丢进 Worker 的 op 客户端                                            |

**结论**：Rust nbstore 是 **SQLite + FTS 后端实现**；**同步算法、clock map、merge 语义** 仍在 TS。Web 甚至连 FTS 也在 TS 重写了一套。

### 2.3 产品壳与业务状态 — `@affine/core` 等

| 域               | 证据                                                                                   | 语言                    |
| ---------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| 60+ 业务 modules | `packages/frontend/core/src/modules/*`（workspace、doc、cloud、quota、AI、peek-view…） | TS/React                |
| DI / 状态        | `@toeverything/infra` Framework + LiveData；另 jotai / rxjs / signals                  | TS                      |
| GraphQL / 实时   | `@affine/graphql`、socket 客户端                                                       | TS                      |
| 服务端业务       | `packages/backend/server`（Nest 量级，再 `import` server-native）                      | **TS 编排 + Rust 侧车** |
| UI 双栈          | React 壳 + Lit 块组件 + 桥接                                                           | TS                      |

### 2.4 CRDT 双栈现实

| 位置                | 引擎                                      | 用途                                              |
| ------------------- | ----------------------------------------- | ------------------------------------------------- |
| 客户端热路径        | **yjs**（含 yarn patch）                  | 编辑、diff、merge、history                        |
| 服务端/本地索引辅助 | **y-octo**                                | compact（受限）、validate、doc_loader 投影、crawl |
| README 叙事         | y-octo 被 freestyle 称为 local-first 核心 | 与「编辑仍 yjs」并存                              |

这不是「Rust 心已就绪、TS 只是皮」，而是 **编辑权威在 Yjs，Rust 吃二进制侧任务**。

---

## 3. 边界对照表（能力 × 归属）

| 能力                     | AFFiNE 归属                     | 「状态沉底」理想归属（本产品对照）                 | 同构？                |
| ------------------------ | ------------------------------- | -------------------------------------------------- | --------------------- |
| 块 schema / 树 CRUD      | BlockSuite TS                   | 契约可 TS 扩展，**运行时树**宜 Rust 或双端一致内核 | ❌                    |
| 实时编辑 apply/merge     | yjs TS                          | 单一 CRDT 内核（Rust）+ TS 投影                    | ❌                    |
| 本地持久化（桌面）       | Rust SQLite                     | Rust                                               | ✅ 部分               |
| 本地持久化（Web）        | TS IndexedDB                    | WASM/Rust 或接受 Web 特化                          | △                     |
| 同步 peer 策略           | TS nbstore                      | 可 Rust 状态机 + 事件；或协议在 Rust               | ❌                    |
| 全文检索（桌面）         | Rust FTS                        | Rust                                               | ✅                    |
| 全文检索（Web）          | TS BM25                         | 若要一致体验应同源内核                             | ❌ 分叉               |
| 服务端 doc compact       | Rust y-octo（**不可回灌 yjs**） | 单一引擎则可回灌                                   | △ 未闭合              |
| Markdown/导入/投影       | 服务端/本地 Rust loader         | Rust 批处理                                        | ✅                    |
| LLM 契约与执行           | 服务端 Rust runtime 加重        | 可选 Rust                                          | ✅ 服务侧重           |
| 媒体采集/解码            | Rust OS API                     | Rust                                               | ✅                    |
| 权限评估矩阵             | 服务端 Rust                     | 可 Rust                                            | ✅ 服务侧             |
| 配额/租约/embedding 队列 | 服务端 BackendRuntime Rust      | 可 Rust                                            | ✅ 服务侧             |
| UI / 快捷键 / IME / 选区 | TS                              | **应留 TS**（或 WebView 宿主）                     | ✅ 应在 TS            |
| 产品导航、设置、云账号   | TS                              | TS                                                 | ✅ 应在 TS            |
| 块扩展/插件              | TS 微包生态                     | **TS 扩展层**                                      | ✅ 方向对，但内核未沉 |

---

## 4. 对「Notion 皮 + Rust 心」的启示

### 4.1 该交给 Rust 的（从 AFFiNE 正反两面抽）

1. **单一文档/协同内核**
   - AFFiNE 教训：yjs（热）与 y-octo（冷）分裂 → compact 注释直接禁止回灌客户端。
   - 本产品应：**一种 CRDT/OT 实现** 同时服务编辑热路径与服务端合并；禁止「仅加速合并却不能互通」。

2. **持久化与时钟**
   - AFFiNE 桌面已做对一半：`DocStoragePool` 管 snapshot/updates/peer clocks/blob。
   - 可强化：把 **merge 默认实现** 也沉到同一 crate，避免 `peer.ts` 再调 yjs。

3. **索引与爬取**
   - `crawl_doc_data` + FTS 在 Rust 合理；应用 **同一解析器** 生成搜索单元，避免 Web/桌面两套 tokenizer。

4. **批量/重计算**
   - 导入（OneNote）、Markdown 双向、embedding 切块、图片/HTML 消毒、tiktoken、hashcash：AFFiNE 模式可借鉴——**批处理与边界安全**适合 Rust。

5. **服务端运行时侧车**
   - `BackendRuntime` / `StorageRuntime`：租约、配额、清理、对象存储——适合与 DB 紧耦合的长任务，**不必**塞进编辑内核，但应有清晰 IPC/事件边界。

### 4.2 该留在 TS 扩展层的

1. **Notion 皮**：块视图、slash menu、拖拽手感、选区 UX、IME、主题、布局 shell。
2. **扩展生态**：块类型注册、adapter（Markdown/HTML 的「产品规则」可配置）、应用级 module（收藏、期刊、分享菜单）。
3. **壳与平台胶水**：Tauri command 映射、React 状态投影、路由、账号 UI。
4. **弱一致业务态**：sidebar 折叠、peek-view 开闭、feature flag——不必进 CRDT 内核。

### 4.3 推荐分层（相对 AFFiNE 的「纠正同构」）

```text
┌─────────────────────────────────────────────┐
│ TS：Notion 皮 / 扩展 / 壳投影（只读或命令）   │
├─────────────────────────────────────────────┤
│ 窄 IPC：命令 + 事件 + 二进制/快照句柄         │
├─────────────────────────────────────────────┤
│ Rust 心：文档状态机 · CRDT · 同步 · 存储 · 索引 │
│        （可选）服务端同款 crate 同构部署       │
└─────────────────────────────────────────────┘
```

AFFiNE 实际更接近：

```text
┌─────────────────────────────────────────────┐
│ TS 心：Yjs + BlockSuite + nbstore 编排 + core │
├──────────────┬──────────────────────────────┤
│ NAPI 侧车     │  IDB/TS 索引（Web）          │
│ SQLite/FTS/   │                              │
│ 媒体/导入     │                              │
├──────────────┴──────────────────────────────┤
│ 服务端：Nest TS 编排 + 大块 server-native     │
└─────────────────────────────────────────────┘
```

---

## 5. 「Native 不够沉」的缺口（证据支持）

| #   | 缺口                           | 证据                                                                  | 影响                                            |
| --- | ------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------- |
| G1  | **编辑权威不在 Rust**          | `@blocksuite/store` 依赖 yjs；无 native 参与 apply                    | 热路径内存/主线程仍绑 JS 引擎                   |
| G2  | **CRDT 双栈未闭合**            | `compactPendingDocUpdates` 文档禁止回灌 yjs 客户端                    | 服务端 merge 不能成为唯一真相                   |
| G3  | **同步 merge 在 TS**           | `nbstore/.../peer.ts`、`storage/doc.ts` 用 `yjs.mergeUpdates`         | 桌面虽有 Rust 存储，合并语义仍 JS               |
| G4  | **Web/桌面存储与索引分叉**     | `impls/idb` 全 TS BM25 vs `DocStoragePool.fts*`                       | 行为/性能不一致；「Rust 心」不可达 Web          |
| G5  | **Native 挂在壳进程**          | Electron helper 调 `@affine/native`；渲染层 BlockSuite 仍 Yjs         | 跨进程拷贝 update 二进制，状态未沉到「一处」    |
| G6  | **产品状态巨石在 TS**          | `@affine/core` 60+ modules；infra DI 多层                             | 「状态沉底」对业务态未发生                      |
| G7  | **服务端能力很沉，编辑侧很浅** | `affine_server_native` 体量远大于编辑相关 native                      | Native 投资偏 **云/AI/运维**，非 **块编辑内核** |
| G8  | **外部引擎拼装**               | y-octo / affine_doc_loader / memory-indexer / llm_* 多在 workspace 外 | 版本与兼容由拼装承担（已体现在 G2）             |

> **表述纪律**：以上是「相对本产品目标」的架构缺口，不是否定 AFFiNE 产品完成度。其服务端 Runtime 与桌面 SQLite 已是实质 Rust 投资；**不够沉的是文档编辑与协同热路径**。

---

## 6. 与本产品目标的同构判定（摘要）

| 本产品口号      | AFFiNE 现实                              | 自研动作提示                                                         |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| 状态沉底        | 状态浮在 Yjs + 多层 TS DI                | 定义唯一权威文档状态（Rust），TS 只订订阅                            |
| 重任务交给 Rust | 重 I/O/LLM/索引已下沉；**编辑 merge 未** | 把 merge/diff/compact/search parse 与编辑同源                        |
| Notion 皮       | BlockSuite + React 皮很厚                | 可借鉴交互与块类型表，**不抄 Yjs 绑内核**                            |
| TS 扩展生态     | 微包爆炸式块扩展                         | 扩展协议挂在内核之上，避免「一功能一 monorepo 包」债（见 `04-缺点`） |
| 超过参考性能    | Web 无 native；双 UI 运行时              | 热路径少桥接；Web 需 WASM 或接受能力降级策略                         |

---

## 7. 关键源码索引（复核用）

| 主题                       | 路径                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workspace members          | `Cargo.toml:1-11`                                                                                          |
| Frontend native 聚合       | `packages/frontend/native/src/lib.rs`                                                                      |
| DocStoragePool API         | `packages/frontend/native/nbstore/src/lib.rs`                                                              |
| FTS / crawl / y-octo merge | `packages/frontend/native/nbstore/src/indexer.rs`                                                          |
| Server native 入口         | `packages/backend/native/src/lib.rs`                                                                       |
| Compact 兼容注释           | `packages/backend/native/src/runtime/backend_runtime/doc_compactor.rs` ~333-336；`index.d.ts` compact 文档 |
| TS 同步 merge              | `packages/common/nbstore/src/sync/doc/peer.ts`；`storage/doc.ts`                                           |
| BlockSuite yjs store       | `blocksuite/framework/store/package.json`                                                                  |
| Electron 调 native         | `packages/frontend/apps/electron/src/helper/nbstore/handlers.ts` 等                                        |
| 上游叙事                   | 根 `README.md` Upstreams（BlockSuite / y-octo / napi-rs / yjs）                                            |
| 复杂度并列缺点             | `docs/block-workspace-architecture/round-A-affine/04-缺点-复杂度与工程DX.md`                               |

---

## 8. 交付说明

- **产出文件**：本文件。
- **方法**：读 workspace `Cargo.toml`、各 native `src`/`index.d.ts`、nbstore TS 同步与 IDB 实现、BlockSuite store 依赖、server `native.ts` 边界。
- **边界表**：§1.1、§3、§5。
- **对「不够沉」**：§5 八条均有路径级证据；最强单点是 **y-octo compact 禁止回灌 yjs** 与 **peer merge 使用 yjs**。
