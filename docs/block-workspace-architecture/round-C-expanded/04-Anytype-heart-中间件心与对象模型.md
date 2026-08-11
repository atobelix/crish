# Anytype-heart：中间件心与对象模型

> **对象**：`reference/markdown_compare/anytype-heart`（Anytype 中间件 / Middleware）  
> **客户端壳**：`anytype-ts`（Electron + TS，**本仓未克隆**；边界以 heart 内 proto / gRPC / 构建文档推断）  
> **立场**：只读分析；机制可借鉴，**许可禁止商用内化整仓**  
> **本产品标尺**：状态沉底、重任务可在非 UI 语言；壳 Tauri/TS；效果完整度优先于流行栈安全感  
> **文档编号**：Round-C `04`（对齐 `00-筛选与本波目标.md`）

---

## 0. 结论先行

| 问题                                    | 结论                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「心在中间件、壳在 Electron」是否干净？ | **切分很干净**。真相、变更、索引、同步、ACL、加密、对象生命周期全在 Go heart；壳只发 `ClientCommands` RPC、收 `Event` 推送并渲染。移动端甚至不用 gRPC，走 gomobile C 库 + 同一套 PB。                                                                                 |
| 数据模型是什么？                        | **对象图（Object Graph）+ 对象内块树**，不是「纯块树即宇宙」，也不是 MD 文件真相。MD 是导入/导出适配层。                                                                                                                                                              |
| 协同/本地优先？                         | **本地优先 + 自定义 CRDT（any-sync ObjectTree）+ 端到端密钥材料（Wallet/FileKeys）+ 可选协调节点**；索引层（objectstore / Tantivy）是投影，不是源。                                                                                                                   |
| 能否商用内化？                          | **不能整仓内化**。`Any Source Available License 1.0` 仅允许非商用，或商用且仅连 Allowed Networks；二次分发仍须本许可证。                                                                                                                                              |
| 对「上限」的含义                        | **强证明「领域语言不必是 TS」**；与 SiYuan Go kernel 同族（Go 心），与 AppFlowy Rust 心同形（心在壳外、PB 契约）。Go 心在并发与工程速度上友好，但 **CRDT/同步正确性与内存安全路径上 Rust 仍有可验证优势**——选型应抄「心/壳契约」，而非抄 Go 本身或 Anytype 许可代码。 |

---

## 1. 仓库定位与包分层

### 1.1 README 自述

- 标题：**Anytype Heart — Middleware library for Anytype, distributed as part of the Anytype clients.**  
  证据：`reference/markdown_compare/anytype-heart/README.md:1-3`
- 架构入口：`docs/Architecture.md`（Service Locator：`github.com/anyproto/any-sync/app`）
- 许可：`Any Source Available License 1.0`（`LICENSE.md`，README:32）

### 1.2 顶层目录（Go 包分层）

| 路径                  | 职责                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **`core/`**           | 业务真芯：block/editor、object、files、subscription、syncstatus、wallet、space 门面、API、session… |
| **`core/block/`**     | 编辑器宇宙：simple 块类型、smartblock、state、import/export、object cache/creator、treesyncer      |
| **`core/domain/`**    | 领域原语：`Details`、`RelationKey`、`TypeKey`、`ChangeType`、layout…                               |
| **`space/`**          | Space 生命周期、tech space、spacecore、join/load、ACL 周边                                         |
| **`pkg/lib/`**        | 共享库：localstore/objectstore、ftsearch(Tantivy)、pb/model、bundle（系统类型/关系）、schema       |
| **`pb/`**             | 对外契约：`commands.proto` / `events.proto` / `changes.proto` / `service.proto` + 生成代码         |
| **`clientlibrary/`**  | 嵌入式库（移动端 gomobile）：`service/lib.go` 包装 `core.New()`                                    |
| **`cmd/grpcserver/`** | 桌面侧本地 gRPC + gRPC-Web 进程（anytype-ts 默认连 `127.0.0.1:31007/31008`）                       |
| **`util/`**           | 横切工具（pbtypes、queue、crypto 辅助等）                                                          |
| **`metrics/`**        | 遥测拦截器                                                                                         |
| **`docs/`**           | 架构/订阅/proto/构建等长文                                                                         |

Agent 自述规模（`AGENTS.md:5-7`）：**Go 中间件**；核心特性：**Block-based editor、object-graph database、CRDT sync、E2E encryption**。

### 1.3 依赖栈要点（`go.mod`）

- **`github.com/anyproto/any-sync`**：同步/ObjectTree/ACL/网络（CRDT 协议所在）
- **`github.com/anyproto/any-store`**：文档型本地存储（索引/队列/部分 store-backed 对象）
- **`github.com/dgraph-io/badger/v4`**：KV（历史/同步存储路径仍见）
- **`github.com/anyproto/tantivy-go`**：全文检索（Rust Tantivy 绑定）
- **IPFS 系**（`go-cid`、`boxo` 等）：内容寻址文件
- **gRPC / grpc-web / gogo protobuf**：客户端边界
- **ethereum/go-ethereum**：命名服务/以太坊地址（Wallet 侧）

---

## 2. 「心在中间件、壳在 Electron」切分是否干净

### 2.1 契约面（唯一命令/事件通道）

桌面客户端边界是 **本地 gRPC 服务 + Protobuf定义**，不是「壳内再实现一半业务」：

1. **命令面**：`pb/protos/service/service.proto` 的 `service ClientCommands`
   - Wallet / Account / Workspace / Space / Object / Block / … 全部 RPC 化
   - 证据：`pb/protos/service/service.proto:8-80`（节选可见 Wallet、Workspace、Account、Space…）
2. **事件面**：`pb/protos/events.proto` + `core/event` 的 `Sender`
   - `Broadcast` / `SendToSession` / `BroadcastToOtherSessions`
   - 证据：`core/event/event.go:25-31`
3. **变更面（持久/同步）**：`pb/protos/changes.proto` 的 `Change`
   - BlockCreate/Update/Remove/Move、DetailsSet、Relation*、ObjectType*、StoreKey*…
   - 证据：`pb/protos/changes.proto:10-66`

桌面进程入口：

```text
anytype-ts (Electron/TS UI)
    │  gRPC / gRPC-Web（默认 127.0.0.1:31007 / 31008）
    ▼
cmd/grpcserver  →  core.New()  →  全量 Go 业务
```

证据：

- `cmd/grpcserver/grpc.go:44-45`：`defaultAddr = "127.0.0.1:31007"`，`defaultWebAddr = "127.0.0.1:31008"`
- `cmd/grpcserver/grpc.go:47-48`：JS 客户端依赖启动日志串确认服务就绪
- `docs/Build.md:59-60`：`make install-dev-js` 构建本地 server 并把 protobuf 绑定拷入 `../anytype-ts`
- gRPC-Web 包装：`cmd/grpcserver/proxy.go`（`improbable-eng/grpc-web`）

### 2.2 多壳同一心

| 壳                   | 接入方式                               | 证据                                                                     |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Desktop `anytype-ts` | 子进程 gRPC + gRPC-Web                 | `cmd/grpcserver`、`docs/Build.md:59-60`                                  |
| iOS / Android        | **gomobile C 库**（非 gRPC）           | `AGENTS.md:87-88`；`clientlibrary/service/lib.go`；`docs/Build.md:65-79` |
| HTTP JSON API        | heart 内 `core/api`（OpenAPI/handler） | `core/api/handler/*`、`core/api/docs/openapi.yaml`                       |

移动端同一 `core.New()`，事件经 `SetEventHandler` / `SetEventHandlerMobile` 把 `pb.Event` 回调或 marshal 成字节：

- `clientlibrary/service/lib.go:25`：`var mw = core.New()`
- `clientlibrary/service/lib.go:52-54`、`71-81`：事件回调 / mobile 字节通道

### 2.3 壳侧还剩什么？

从 heart 文档与 Subscriptions 契约可反推壳职责：

- **渲染与交互**：块 UI、输入法、拖拽手势、键盘
- **订阅镜像**：对 object details 做 live query 的客户端镜像（`docs/Subscriptions.md` 明确 anytype-ts 消费方式）
- **会话/token 持有**：Wallet session 后的 token 持久化（proto 注释侧）
- **不负责**：对象树 CRDT 合并、跨设备同步、ACL、全文索引、文件加密密钥树、类型/关系系统真相

### 2.4 切分洁净度判定

**干净，且比「Electron 内 monorepo 半 JS 半 Rust」更极端：**

| 维度       | 判定                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 真相归属   | 100% heart（ObjectTree + state + objectstore 投影）                                                                             |
| 契约稳定性 | Protobuf SSOT；多端共享同一 `ClientCommands`                                                                                    |
| 壳可替换性 | 已证明：TS 桌面 / Swift / Kotlin 三壳                                                                                           |
| 泄漏风险   | 中等——订阅语义、InternalFlags、blank template 等 **产品协议** 仍跨层耦合（见 `docs/Flow.md`），但属于契约层而非业务实现泄漏到壳 |

**对标本产品**：这与 AppFlowy「Rust 心 + Flutter 壳」同形，只是心语言是 Go、壳语言是 TS/Swift/Kotlin。**「心在中间件」是可复用架构结论，不是 Anytype 专属。**

---

## 3. 领域模型：对象 vs 块树 vs MD 文件

### 3.1 官方术语（当前 vs 遗留）

`AGENTS.md:9-20`：

| 当前           | 遗留代码名  | 含义                                  |
| -------------- | ----------- | ------------------------------------- |
| **Object**     | SmartBlock  | 主内容单元（有 ID、类型、属性、块树） |
| **Block**      | SimpleBlock | 对象内的内容块                        |
| **Properties** | Relations   | 对象属性（代码里仍大量 `relation`）   |
| **Space**      | Workspace   | 隔离工作区                            |
| **Details**    | —           | 属性值 map（`map`/GenericMap）        |

### 3.2 三层结构（必须分开）

```text
Space（隔离工作区 / ACL 边界）
  └── Object（SmartBlockType：Page / Type / Relation / FileObject / Chat…）
        ├── Details（属性投影：name、type、layout、自定义 properties）
        ├── Block tree（childrenIds 树：Text / File / Dataview / Table / Link…）
        └── 可选 Store 集合（chat 等 store-backed 对象）
```

#### Object（SmartBlock）

- 类型枚举：`pkg/lib/pb/model/protos/models.proto:21-60`（Page、Home、Archive、Widget、Template、Workspace、STRelation、STType、FileObject、ChatDerivedObject、AccountObject、TechSpaceObject…）
- Go 包装：`pkg/lib/core/smartblock/smartblock.go:10-48`
- 运行时：`core/block/editor/smartblock` — 持有 `objecttree.ObjectTree`，`Apply` 时产出 changes + events
- 工厂：`core/block/editor/factory.go` 按 SmartBlockType 装配 Page/Profile/Archive/Widget/Chat…

**两类持久管线**（`IsStoreBacked`）：

- **经典 ObjectTree + Change 管道**（大多数文档对象）
- **storestate / any-store CRDT 集合**（Chat、AccountObject、Discussion、TechSpaceObject）  
  证据：`pkg/lib/core/smartblock/smartblock.go:76-88`

#### Block（对象内）

- 模型：`models.proto` `message Block` — `id`、`childrenIds`、`oneof content`  
  content：Text / File / Layout / Div / Bookmark / Link / Dataview / Relation / Latex / Table* / Widget / Chat…  
  证据：`models.proto:107-136`
- 实现注册表：`core/block/simple` — `RegisterCreator` + `Block` 接口（Diff/Copy/Validate）  
  证据：`core/block/simple/simple.go:26-33, 68-78`
- 状态容器：`core/block/editor/state.State` — `blocks map`、`details`、`changes`、object type keys  
  证据：`core/block/editor/state/state.go:51-75, 108-119`

#### Details / Properties / Types

- `domain.Details = GenericMap[RelationKey]`（`core/domain/details.go:20-24`）
- 对象类型键：`domain.TypeKey`；关系键：`domain.RelationKey`（`core/domain/types.go`）
- 系统类型/关系有 **Revision**，marketplace 高 revision 可升级空间内系统对象（`docs/Flow.md:55-74`）
- Layout 与 GC 资格：`core/domain/layout.go`（basic/note/todo/set/collection/file…）

#### Space

- 用户 Space + **Tech Space**（账号级：空间列表、设备、account object）  
  证据：`AGENTS.md:30-34`；SmartBlockType 中 TechSpace*
- 同步与 ACL 边界在 space 级（any-sync commonspace）

### 3.3 与「纯块树」模型对比

|           | Anytype                                         | 纯块树（如部分 outliner / 早期 Notion 想象） |
| --------- | ----------------------------------------------- | -------------------------------------------- |
| 身份单元  | **Object ID**（可有类型、模板、布局）           | 往往只有 block id                            |
| 属性      | 一等 **Details/Relations**，可查询/订阅         | 常塞进块 fields 或侧车                       |
| 集合/看板 | **Dataview 块 + Set/Collection 对象**           | 常靠查询视图临时拼                           |
| 图关系    | 对象链接 + backlinks 关系注入（`docs/Flow.md`） | 块引用                                       |
| 类型系统  | ObjectType / Relation 自身也是对象              | 通常无元对象                                 |

Anytype 是 **「对象图数据库 + 每个对象内嵌块编辑器」**，不是「全世界只有一棵块树」。

### 3.4 与 MD 文件模型对比

|           | Anytype                          | MD 文件真相（Obsidian/部分 Logseq）       |
| --------- | -------------------------------- | ----------------------------------------- |
| 源真相    | **加密/CRDT ObjectTree 变更**    | 文件系统上的 `.md`                        |
| 块 ID     | 块有 id，但是对象子结构          | 可有 block id 嵌在 md（思源/Logseq 风格） |
| 类型/属性 | 结构化 Relations + schema export | YAML front matter / 约定                  |
| 互操作    | **Import/Export 适配**           | 原生可 diff/git                           |

MD 在 heart 中的位置：

- 导入：`core/block/import/markdown/`（anymark 解析、YAML front matter、**JSON Schema 确定性导入**）  
  证据：`SCHEMA_IMPORT.md` — `schemas/*.schema.json` 定义 type/relation，无 schema 时回退 YAML
- 导出：`core/block/export/`
- **MD 不是运行时真相**，是边界格式；round-trip 靠 schema 补强，而非「编辑即写 md」

### 3.5 变更与历史语义

- `Change` 是 CRDT/历史元素：可含 `content` 列表或整包 `Snapshot`（`changes.proto:10-32`）
- 业务级 `ChangeType` **APPEND ONLY** 序列化进 CRDT，禁止插入重排（`core/domain/types.go:37-55`）
- Apply 标志：`NoHistory` / `NoEvent` / `DoSnapshot` / `NotPushChanges`…（`smartblock.go:60-70`）
- Undo 在 heart：`core/block/undo`、`core/undo.go`（壳不自己做对象级 undo 真相）

### 3.6 索引是投影

- **ObjectStore**（`pkg/lib/localstore/objectstore`）：每 space 索引 details/links；跨 space 查询；全文队列；file encryption keys  
  证据：`objectstore/service.go` 头注释 Responsibility
- **Tantivy** 全文：`pkg/lib/localstore/ftsearch`
- 订阅：对 details 的 live query（`docs/Subscriptions.md`）——客户端不直接扫 ObjectTree 做列表

**不变量**：UI 列表/搜索读投影；打开对象时走 cache.Do → SmartBlock → State；同步合并在 ObjectTree。

---

## 4. 协同 / 加密 / 本地优先机制要点

### 4.1 本地优先

1. 所有编辑先落本地 ObjectTree / store，再 diff-sync 到 peer
2. 账号/钱包在本地 `rootPath`（Wallet RPC 带 rootPath）
3. 离线可用：索引与对象缓存本地；同步状态另轨（`core/syncstatus`）
4. 局域网同步显式开关：`AccountEnableLocalNetworkSync`（service.proto:52）

### 4.2 CRDT / 同步边界

| 层       | 组件                                   | 说明                                                    |
| -------- | -------------------------------------- | ------------------------------------------------------- |
| 协议与树 | **any-sync** `objecttree` / `synctree` | 对象级变更树；heart 依赖不重复实现底层 CRDT             |
| 业务变更 | `pb.Change` + `state` apply            | 块/详情/关系操作编码进树                                |
| 同步调度 | `core/block/object/treesyncer`         | 对接 `commonspace` TreeManager；优先同步打开对象/聊天等 |
| Space    | `space/spacecore`、`space/load.go`     | space 装载、storage、spacesyncproto                     |
| 第二管线 | any-store storestate                   | Chat 等集合型 CRDT                                      |
| 内容寻址 | IPFS 兼容 CID                          | 文件块                                                  |

`treesyncer` 直接 import any-sync 的 `objecttree`、`synctree`、`treemanager`、`peermanager`（`treesyncer.go:9-20`）。  
`source` 包把 ObjectTree 接到业务 Source（`core/block/source/interface.go`）。

**边界一句话**：  
**「合并正确性」在 any-sync；「语义正确性（块位置、详情、限制、模板）」在 heart state/smartblock。**

### 4.3 加密与身份

- **Wallet**：助记词 / account key / device key / master key / ethereum key  
  证据：`core/wallet/wallet.go:34-49`；依赖 `any-sync/util/crypto`、`accountdata`
- **文件密钥**：`Change.FileKeys`、objectstore 存 file encryption keys（service 注释）
- **配置注释**：部分历史 `disableEncryption` 已 deprecated 无效（proto 文档串）
- **身份资料**：对称加密缓存路径见 `docs/ParticipantObjectsRefactoring.md`（encryption keys 持久化讨论）
- Agent 概述写明 **E2E encryption**（`AGENTS.md:7`）

商用产品叙事上的「本地加密 + 可选网络」与代码结构一致：**密钥在客户端 heart，不在壳。**

### 4.4 ACL / 分享

- Space 级邀请、审批、权限变更：`service.proto` Space* RPC（Invite/Join/ParticipantPermissions…）
- `core/acl/`、any-sync `commonspace/object/acl`
- SmartBlock Apply 可带 `IgnoreNoPermissions` 等标志

### 4.5 实时 UI 契约：Subscription + Event

- 订阅 = **对象 details 的实时查询**（初始快照 + 增量事件），不是 Yjs awareness  
  证据：`docs/Subscriptions.md:11-23`
- 桌面一次打开一个 space 可有 **数十个并发订阅**（类型单例、dataview 视图、widget…）——创建/销毁必须便宜
- 事件总线与 session 路由在 heart，壳只消费

---

## 5. 与 AppFlowy Rust 心、SiYuan Go kernel 对照

> 本仓已有 AppFlowy 深研：`docs/block-workspace-architecture/round-B-appflowy/02-优点-Rust核心与FFI边界.md`。  
> SiYuan 同波文档：`01`/`02`（若已落盘则交叉；此处按公开架构常识 + Round-C 目标对齐 heart 视角）。

### 5.1 对照表

| 维度      | **Anytype-heart (Go)**                | **AppFlowy rust-lib (Rust)**             | **SiYuan kernel (Go)**                     |
| --------- | ------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| 心语言    | Go 1.26 线                            | Rust 1.85 钉版本                         | Go                                         |
| 壳        | Electron TS / iOS / Android           | Flutter（Dart FFI）                      | Electron + TS Protyle                      |
| 契约      | Protobuf `ClientCommands` + Events    | Protobuf + AFPlugin 事件名               | 多为 HTTP/API + 事件；块操作经 kernel      |
| 文档真相  | ObjectTree CRDT（any-sync）           | Yrs/Collab（外置 AppFlowy-Collab）       | 本地仓库 + 事务队列；块树/MD 纪律强        |
| 模型      | **对象图 + 对象内块**                 | document / folder / database 分域 collab | **块 ID 一等 + 层级笔记**；偏 MD 可导出    |
| 本地存储  | any-store + Badger 路径 + Tantivy     | SQLite 元数据 + RocksDB collab           | 文件/库 + 本地路径                         |
| 协同      | P2P + 可选协调节点                    | 云（AppFlowy-Cloud）或本地 collab 插件   | 多为自建同步/仓库，非 any-sync 型 P2P CRDT |
| 加密叙事  | 强（Wallet + file keys + E2E）        | 依赖部署与云路径                         | 本地为主                                   |
| FFI 形态  | gRPC 子进程 **或** gomobile           | `dart_ffi` staticlib C ABI               | 常为本地 HTTP 内核进程                     |
| 许可      | **Source Available（商用受限）**      | 多组件开源（需逐仓核验）                 | AGPL 常见（需核验具体模块）                |
| AI 工具面 | 有 AI RPC（Autofill/WritingTools 等） | flowy-ai 域                              | **MCP/Agent 工具面突出**（Round-C 重点）   |

### 5.2 结构同构点（值得抄的「形」）

三者都验证：

1. **UI 语言 ≠ 领域真相语言**
2. **契约层（PB/HTTP API）隔离壳与心**
3. **列表/搜索用投影或查询层，编辑用权威状态机**

Anytype 与 AppFlowy 更近：**重协同 CRDT + 多端心**。  
Anytype 与 SiYuan 更近：**都是 Go 中间件/内核 + Electron 壳**，但数据哲学分叉——Anytype 对象图/CRDT，SiYuan 块仓库/MD 纪律。

### 5.3 差异对「块工作区」选型的含义

| 需求                                         | 更接近谁                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| 类型系统、关联数据库、P2P 加密空间           | Anytype 模型                                                                         |
| 文档/看板/数据库分 crate、Rust 内存安全 CRDT | AppFlowy                                                                             |
| Agent 可操作块 ID、MD 可审计、事务队列       | SiYuan                                                                               |
| 本产品「AI 工作栈 + 块 + 本地」              | **机制拼盘**：SiYuan 的 AI/块可操作 + AppFlowy/Anytype 的心壳分离；**不要整仓 fork** |

---

## 6. 许可风险：能否商用内化

### 6.1 许可证事实

文件：`reference/markdown_compare/anytype-heart/LICENSE.md`

- 名称：**Any Source Available License 1.0**
- 授权范围（`LICENSE.md:7-9`）：
  - **(a) Non-Commercial Use**，或
  - **(b) Commercial Use in Allowed Networks**（`https://networks.any.coop` 明示网络）
- 再分发必须仍用本许可证；**不得**把原 Software 改成别的许可证（`LICENSE.md:11-16`）
- **禁止 sublicense/转让权利**（`LICENSE.md:18-20`）
- 违规或专利主张可立即终止（`LICENSE.md:22-28`）
- AS IS、无担保（`LICENSE.md:30-33`）
- Commercial Use 定义很宽：任何非 Non-Commercial 即商用；Non-Commercial 不含「促成经济价值交易且不在 Allowed Networks」（`LICENSE.md:40-45`）

### 6.2 对本产品的操作结论

| 行为                                                   | 是否可行                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 阅读/架构调研/对照写文档                               | ✅ 是（本文件）                                                                  |
| 个人/学术研究运行                                      | ✅ 通常属 Non-Commercial                                                         |
| **把 heart 链进商用产品或内化源码**                    | ❌ 除非仅连 Allowed Networks 且完整遵守条款——**与自有商业网络/私有部署目标冲突** |
| 复制大段实现进本仓                                     | ❌ 高风险；许可证粘性 + 再分发约束                                               |
| 借鉴**思想**：心壳分离、对象+块、订阅投影、Change 管道 | ✅ 自行重写，保持干净室纪律                                                      |

**与 Round-C `00` 纪律一致**：「不 fork / 不嵌入 AGPL 或 Source-Available 整仓」。

---

## 7. 对上限的含义（本波关键）

### 7.1 Go heart 是否证明「领域语言不必是 TS」？

**是，而且证据极强。**

1. **多端已量产**：同一 Go 心支撑 TS 桌面 + iOS + Android（gRPC vs gomobile）。
2. **重逻辑全在心**：CRDT 应用、索引、订阅、ACL、文件、钱包——壳不重复实现。
3. **契约是 PB 不是「TS 类型导出凑合」**：`ClientCommands` 生成多语言绑定（`docs/Build.md` protos-swift/java/js）。
4. **同波 SiYuan** 再次用 Go kernel 证明这条路在笔记领域可走通。

因此：**「编辑器 UI 在 TS」≠「对象模型/事务/同步必须在 TS」。**  
把领域沉到 Go/Rust/其它系统语言，是已验证上限路径，不是冒险猎奇。

### 7.2 相对 Rust 心路径：优 / 劣

|                | **Go heart（Anytype / SiYuan 族）**  | **Rust 心（AppFlowy 族）**                    |
| -------------- | ------------------------------------ | --------------------------------------------- |
| 工程吞吐       | 团队迭代快、包生态熟、gRPC 一等      | 编译期约束重，正确性局部更硬                  |
| 并发模型       | goroutine 适合大量订阅/IO            | async + 所有权，适合零成本抽象与 FFI 控制     |
| CRDT/协同库    | any-sync 自研生态；Yrs 主生态在 Rust | **Yrs 原生**；collab 栈成熟在 Rust            |
| FFI 到 TS 壳   | gRPC 子进程最省事；或 cgo/gomobile   | wasm / napi / uniFFI / 子进程皆可；Tauri 更贴 |
| 内存/安全      | GC；长跑需控碎片与泄漏               | 无 GC 抖动；unsafe 面可控时上限更高           |
| 与本仓 Tauri   | 可并行跑 Go 侧车（类 anytype-ts）    | **同进程或同 toolchain 更贴 Tauri+RS**        |
| 许可可内化样本 | Anytype **不可**；SiYuan 需看 AGPL   | 需逐组件，但存在更友好开源组合                |

**不是「Go 劣于 Rust」的笼统判决，而是路径匹配：**

- 若上限瓶颈是 **CRDT 正确性、嵌入式协同库、与 Tauri 同语言心** → Rust 心路径通常不丢上限。
- 若上限瓶颈是 **领域服务化、多端一套中间件、订阅/索引/对象图** → Go heart **已证明可达**，且不必先会 Rust。
- **错误结论**：「必须用 TS 做领域才能对接前端」——被 Anytype 直接证伪。
- **错误结论**：「选了 Go 就优于 Rust 心」——许可与 Yrs 生态并不支持该断言。

### 7.3 对本产品架构上限的可执行推论

1. **锁定「心/壳切分」**，不要锁定「必须 Go」或「必须复刻 Anytype 对象宇宙」。
2. **PB（或等价 IDL）命令 + 事件** 是跨语言心的最小充分契约（Anytype/AppFlowy 双证）。
3. **对象图 vs MD 块仓** 是产品语义选择：要关联数据库/类型系统偏对象图；要 Agent 改文件可审计偏 MD+块 ID（SiYuan）。可分层：权威块 ID 图 + 可选 MD 投影。
4. **同步**：可学「ObjectTree 级变更 + 投影订阅」，实现用自研或更友好许可的 CRDT，**不搬 any-sync 源码**。
5. **上限不被「当前壳是 TS」拉低**——Anytype 已用生产级体量证明中间件心；本仓若走 Tauri，Rust 心与 Go 侧车都是合法上限路径，按正确性/可验证性/契约一致性选，不按星数或「业界都用 X」。

---

## 8. 关键路径证据索引

| 主题                    | 路径                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| 项目说明 / 许可声明     | `reference/markdown_compare/anytype-heart/README.md`                              |
| Source Available 全文   | `…/LICENSE.md`                                                                    |
| Agent 术语与架构要点    | `…/AGENTS.md`                                                                     |
| 组件注册                | `…/docs/Architecture.md`、`core/anytype/bootstrap.go`                             |
| 客户端 RPC              | `…/pb/protos/service/service.proto`                                               |
| 变更 CRDT 载荷          | `…/pb/protos/changes.proto`                                                       |
| 块/对象模型             | `…/pkg/lib/pb/model/protos/models.proto`                                          |
| SmartBlock 类型         | `…/pkg/lib/core/smartblock/smartblock.go`                                         |
| SmartBlock 运行时       | `…/core/block/editor/smartblock/smartblock.go`                                    |
| State                   | `…/core/block/editor/state/state.go`                                              |
| Simple Block            | `…/core/block/simple/simple.go`                                                   |
| 编辑门面                | `…/core/block/service.go`                                                         |
| 工厂                    | `…/core/block/editor/factory.go`                                                  |
| 领域 Details/ChangeType | `…/core/domain/details.go`、`types.go`                                            |
| 树同步                  | `…/core/block/object/treesyncer/treesyncer.go`                                    |
| Source/ObjectTree       | `…/core/block/source/interface.go`                                                |
| 对象索引                | `…/pkg/lib/localstore/objectstore/service.go`                                     |
| 事件发送                | `…/core/event/event.go`                                                           |
| 桌面 gRPC               | `…/cmd/grpcserver/grpc.go`、`proxy.go`                                            |
| 嵌入式库                | `…/clientlibrary/service/lib.go`                                                  |
| Wallet                  | `…/core/wallet/wallet.go`                                                         |
| 订阅契约                | `…/docs/Subscriptions.md`                                                         |
| 构建进 anytype-ts       | `…/docs/Build.md`                                                                 |
| MD schema 导入          | `…/core/block/import/markdown/SCHEMA_IMPORT.md`                                   |
| 依赖                    | `…/go.mod`                                                                        |
| 本波筛选                | `docs/block-workspace-architecture/round-C-expanded/00-筛选与本波目标.md`         |
| AppFlowy 对照           | `docs/block-workspace-architecture/round-B-appflowy/02-优点-Rust核心与FFI边界.md` |

---

## 9. 一页纸备忘

```text
anytype-ts / Swift / Kotlin
        │  Protobuf ClientCommands + Events
        ▼
┌──────────────── anytype-heart (Go) ────────────────┐
│  core/block (state, smartblock, simple, import)    │
│  core/domain (details, types, change kinds)        │
│  objectstore + tantivy  (query projection)         │
│  subscription + event   (live UI contract)         │
│  wallet + files + acl                              │
│  space/*  ──► any-sync (ObjectTree CRDT, P2P)      │
└────────────────────────────────────────────────────┘
        │
        ▼
  本地 any-store / tree storage / 加密文件块
```

**可借鉴**：心壳干净切分、对象+块双层模型、Change 管道、订阅投影、多端一共心。  
**不可借鉴为内化**：Source Available 源码与 any-sync 粘连栈。  
**上限结论**：领域语言可以是 Go/Rust；TS 只做壳不降真理上限；Rust 心在 CRDT/Tauri 贴合上仍具优势，但 **「非 TS 心」已被 Anytype 证成必选项而非可选项。**
