# AFFiNE 优点：协同 / Local-First / 存储

> **范围**：只读分析 `reference/markdown_compare/AFFiNE` 中与 local-first、实时协同、持久化相关的实现。  
> **本产品对照**：Tauri + TS + Rust；多人实时协同必备；重任务沉 Rust；性能与内存须超过参考。  
> **诚实边界**：未读到的 CRDT 算法细节不编造；Yjs / y-octo 内部合并语义以源码调用点为准，库内部行为标「不确定」。

---

## 1. 协同 / 存储管线素描（本地 → 同步 → 多端）

AFFiNE 的文档数据以 **Yjs 二进制 update** 为交换与持久单位（客户端主路径用 `yjs`；服务端热路径用 Rust **y-octo** 做 apply/merge/校验）。协同不是「整文档覆盖写」，而是 **update 队列 + snapshot 压缩 + clock 水位 + 双向 diff**。

### 1.1 分层总览

```
┌──────────────────────────────────────────────────────────────────────┐
│  编辑层 BlockSuite（Y.Doc / subdocs / Awareness）                      │
│  blocksuite/framework/store + std + sync                             │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ connectDoc / applyUpdate / update 事件
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DocFrontend（nbstore）                                               │
│  内存 Y.Doc ↔ 本地 DocStorage；job 队列 load / apply / save            │
│  packages/common/nbstore/src/frontend/doc.ts                         │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ pushDocUpdate / subscribeDocUpdate
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  本地 SpaceStorage（七类 storage 拼装）                                 │
│  doc / docSync / blob / blobSync / awareness / indexer / indexerSync │
│  Web: IndexedDB   Desktop/Electron: SQLite(Rust DocStoragePool)        │
│  packages/common/nbstore/src/storage/* + impls/idb|sqlite|cloud      │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ DocSyncPeer（local↔remote）     │ BlobSyncPeer / Awareness
                ▼                                 ▼
┌────────────────────────────────┐   ┌─────────────────────────────────┐
│ CloudDocStorage + Socket.IO    │   │ BroadcastChannel（同机多 tab）   │
│ space:push/load/broadcast      │   │ packages/.../broadcast-channel  │
└───────────────┬────────────────┘   └─────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  服务端 SpaceSyncGateway + DocStorageAdapter                          │
│  权限校验 → 落库（snapshot+updates）→ 事件广播 → 可选 y-octo 压缩      │
│  packages/backend/server/src/core/sync/gateway.ts                    │
│  packages/backend/server/src/core/doc/*                              │
│  packages/backend/native（y-octo merge / validate）                   │
└──────────────────────────────────────────────────────────────────────┘
```

另有一条 **非 CRDT 文档内容** 的实时通道：`@affine/realtime` 类型契约 + 同 Socket 上的 `realtime:request|subscribe`，承载权限/成员/评论/配额等 **元数据订阅**，与 doc update 协议分离（见 §2.7）。

### 1.2 本地写路径（离线可工作）

1. 用户编辑 → Y.Doc `update` 事件（非 storage origin）。
2. `DocFrontend` 将 update 排入 **按 doc 的优先级 job 队列**，批量 `mergeUpdates` 后 `storage.pushDocUpdate`。
3. 本地 DocStorage **先追加 updates 表**，并更新 **doc clock（timestamp）**；**不在每次击键时完整 squash snapshot**。
4. 当需要 `getDoc` 读完整态时，`DocStorageBase` 才把 snapshot + pending updates **squash** 成新 snapshot，并 `markUpdatesMerged`（写放大换写延迟）。

证据：

- Update 队列与 squash 设计注释：`packages/common/nbstore/src/storage/doc.ts`（约 257–302 行，`getDocUpdates` / `squash`）。
- Frontend job 模型：`packages/common/nbstore/src/frontend/doc.ts`（load / save / apply）。
- SQLite 侧 `push_update` 仅 INSERT updates + UPSERT clocks：`packages/frontend/native/nbstore/src/doc.rs`（约 68–125 行）。
- IDB 表结构同样是 Snapshots / Updates / Clocks / PeerClocks：`packages/common/nbstore/src/impls/idb/schema.ts`。

### 1.3 本地 ↔ 云端同步路径

`Sync` 聚合四条独立管线：`doc` / `blob` / `awareness` / `indexer`（`packages/common/nbstore/src/sync/index.ts`）。

**DocSyncPeer**（核心）：

| 阶段         | 行为                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| 连接         | 等 local / remote / docSync metadata 三连接就绪（超时 30s）               |
| 清单         | 本地全部 docId + 远端 `getDocTimestamps(after)` 增量时钟                  |
| connect 文档 | 比较 **pushed / pulled / remote clock**，决定 `pullAndPush` 或 `pull`     |
| 实时         | 订阅 local/remote `subscribeDocUpdate`，入队 push / save                  |
| 差量         | 用 `encodeStateVectorFromUpdate` + `getDocDiff` / `diffUpdate` 做双向补丁 |
| 失败         | 权限错误按 doc 跳过；其它错误 5s 重试整环                                 |

证据：`packages/common/nbstore/src/sync/doc/peer.ts`（`DocSyncPeer`、`docDiffUpdate`、`mainLoop` / `retryLoop`）。

同步水位 **不塞进 Y 文档本身**，而是独立 `DocSyncStorage` 记录：

- peer remote clock
- peer pulled remote clock
- peer pushed clock

证据：`packages/common/nbstore/src/storage/doc-sync.ts`。

### 1.4 多端实时广播路径

客户端 `CloudDocStorage`：

- 推送：`socket.emitWithAck('space:push-doc-update', { update: base64 })`
- 拉取差量：`space:load-doc` + 可选 `stateVector`
- 清单：`space:load-doc-timestamps`
- 收广播：`space:broadcast-doc-update(s)` → `emit('update', …)`

证据：`packages/common/nbstore/src/impls/cloud/doc.ts`、`.../cloud/socket.ts`。

服务端 `SpaceSyncGateway`：

- Room 分层：`sync`（成员）、`sync-025` / `sync-026`（协议版本兼容）、`{docId}:awareness`
- `doc.updates.pushed` 事件触发广播；0.26+ 可先 **y-octo native merge 压缩** 再 `space:broadcast-doc-updates`，失败回退多条 batch
- 接入时校验 clientVersion（semver 区间）

证据：`packages/backend/server/src/core/sync/gateway.ts`（RoomType、`buildBroadcastPayload`、`onDocUpdatesPushed`）。

### 1.5 编辑内核侧的另一套 Sync（BlockSuite）

BlockSuite `@blocksuite/sync` 提供更底层的 **DocEngine = main DocSource + shadow DocSources**，每个 source 一个 `SyncPeer`：

1. 先起 main peer，`waitForLoaded`
2. 再起 shadow peers
3. 双向：Y.Doc update → push；storage subscribe → applyUpdate

证据：`blocksuite/framework/sync/src/doc/engine.ts`、`peer.ts`、`source.ts`。

与 **nbstore** 的关系（观测结论，非官方文档断言）：

- **nbstore** 是 AFFiNE 产品级 Space 存储/云同步（local-first 主战场）。
- **@blocksuite/sync** 是编辑内核可插拔同步引擎（main/shadow、IndexedDB/Broadcast 等实现）。
- 产品路径上，桌面端本地落盘已下沉到 **Rust SQLite pool**（`DocStoragePool`），再由 nbstore TS 编排云同步。

### 1.6 端到端时序（简化）

```
端 A 击键 → Y.apply 本地 → DocFrontend.save → 本地 SQLite/IDB updates
       → DocSyncPeer.push → CloudDocStorage.space:push-doc-update
       → Server 校验/落库 → broadcast room
端 B socket 收 update → CloudDocStorage.emit → DocSyncPeer.save → 本地 updates
       → DocFrontend.apply → Y.applyUpdate → 界面更新
端 B Awareness（光标等）走 space:update-awareness / broadcast-awareness-update（独立通道）
```

离线：A 只写本地；上线后靠 clock 清单 + pullAndPush 收敛。  
同机多 tab：awareness 可用 BroadcastChannel；doc 也可挂 broadcast-channel storage（web worker 装配）。

---

## 2. 优点清单 + 证据路径

### 2.1 Local-first 是架构默认，不是开关补丁

- **产品叙事**明确 local-first + 实时协同：`AFFiNE/README.md`（Features: Local-first & Real-time collaborative）。
- **SpaceStorage** 以本地为 `local`，云端等为 `remotes` 的 peer 模型（`Sync` 构造：`storages.local` / `storages.remotes`）。
- 本地完整可写；云只读/权限失败时 **按 doc 跳过** 而非拖垮整工作区（`isRemotePermissionError` + `runRemoteDocJob`）。

**优点**：离线可用性、数据主权感、云故障降级路径清晰。

### 2.2 存储抽象干净：七类 storage + Dummy 默认

`SpaceStorage` 固定七种类型，缺省 Dummy，可组合：

| 类型                  | 职责                           |
| --------------------- | ------------------------------ |
| doc                   | 文档二进制与 squash            |
| docSync               | 同步水位元数据                 |
| blob / blobSync       | 附件与上传标记                 |
| awareness             | 在线状态（非持久 CRDT 主数据） |
| indexer / indexerSync | 搜索索引与爬取进度             |

证据：`packages/common/nbstore/src/storage/index.ts`、`storage.ts`；README 用法：`packages/common/nbstore/README.md`。

**优点**：同步逻辑不绑死某种 DB；Web(IDB)/桌面(SQLite)/云(Socket) 实现可替换；测试可用 Dummy。

### 2.3 Snapshot + Pending Updates：写路径轻、读路径合并

`DocStorageBase.getDoc`：有 pending updates 才 squash → set snapshot → mark merged。注释明确为 **写性能** 设计。

证据：`packages/common/nbstore/src/storage/doc.ts`。

服务端 `DocStorageAdapter` 同样 squash 管线，并优先 **native apply**、回退 yjs merge。

证据：`packages/backend/server/src/core/doc/storage/doc.ts`、`merge-updates.ts`。

**优点**：高频协同击键不每次重写整文档；合并点可控（读时 / 广播压缩 / 后台）。

### 2.4 同步状态机可观测 + 优先级队列（当前文档优先）

- Peer 级 / Doc 级状态流：`peerState$` / `docState$` / `DocFrontend.state$`（含 syncing、retrying、errorMessage）。
- UI throttle 1s，避免状态风暴。
- `addPriority(docId, n)` + `AsyncPriorityQueue`：根文档、当前打开文档可抬优先级。

证据：

- `packages/common/nbstore/src/sync/doc/peer.ts`、`frontend/doc.ts`
- 产品侧用法：`packages/frontend/core/src/modules/workspace/entities/engine.ts`（rootDoc priority 100）
- BlockSuite 侧同类设计：`blocksuite/framework/sync/src/doc/peer.ts` 状态图注释（pull root → subdocs → queue apply/push）

**优点**：大工作区后台同步时，前台打开文档仍可快速收敛；状态可做同步指示器。

### 2.5 Diff / Clock 双保险的对账模型

- 时钟：`getDocTimestamps(after)` 增量发现新版本。
- 内容：`getDocDiff(stateVector)` / `docDiffUpdate` 处理 **state vector 相等但 tombstone 集合不同** 的情况（注释写明 localDiff vs remoteDiff）。

证据：`packages/common/nbstore/src/sync/doc/peer.ts` 中 `docDiffUpdate`。

**优点**：不是纯「最大 timestamp 覆盖」；在 Yjs 语义下对删除集差异有显式分支（具体 Y 内部保证以 yjs 为准，**未在本仓库复读 yjs 源码**）。

### 2.6 连接层工程化：自动重连、共享连接、Worker 隔离

- `AutoReconnectConnection`：连接超时、错误后 delay 重连、refCount 语义。
- `share(connection)`：同 shareId 单例，避免重复开库。
- Web：`nbstore.worker.ts` + `StoreManagerClient`（MessageChannel Op 调用），存储与同步可离主线程。
- Desktop：Electron helper 将 `NativeDBApis` 绑到 Rust `DocStoragePool`。

证据：

- `packages/common/nbstore/src/connection/connection.ts`、`shared-connection.ts`
- `packages/frontend/apps/web/src/nbstore.worker.ts`、`packages/common/nbstore/src/worker/client.ts`
- `packages/frontend/apps/electron/src/helper/nbstore/handlers.ts`

**优点**：UI 线程不被 squash/索引拖死；DB 连接不重复打开。

### 2.7 文档协同通道 vs 元数据实时通道分离

- **文档 CRDT**：`space:*` Socket 事件（load/push/broadcast/awareness）。
- **业务元数据实时**：`@affine/realtime` 的 RequestMap / TopicMap（workspace.access、doc.grants、comment.changed、quota…），经 `realtime:request|subscribe` 与同一 socket 复用。

证据：`packages/common/realtime/src/index.ts`；`packages/common/nbstore/src/impls/cloud/socket.ts` 中 `ServerEvents` / `ClientEvents` 并列；`packages/common/nbstore/src/realtime/manager.ts`。

**优点**：高 churn 的编辑 update 与低频权限/评论事件解耦；类型契约集中，前后端不易漂移。

### 2.8 Awareness 独立于文档持久化

- AwarenessSync 向 local + remotes 广播 update，并支持 `onCollect` 拉齐。
- 云端 `space:join-awareness` / `space:broadcast-awareness-update`。
- 同机 `BroadcastChannelAwarenessStorage`。

证据：`packages/common/nbstore/src/sync/awareness/index.ts`；`impls/broadcast-channel/awareness.ts`；`impls/cloud/socket.ts`。

**优点**：光标/选区等短暂状态不污染文档 history / snapshot；断开即可丢弃。

### 2.9 Blob 同步独立、带重试与配额错误面

`BlobSyncPeer`：下载指数退避（只读远程少重试）、上传标记 `setBlobUploadedAt`、`OverCapacity` / `OverSize` 错误类型。

证据：`packages/common/nbstore/src/sync/blob/peer.ts`；`storage/errors/*`。

**优点**：大附件失败不阻塞文本协同；可单独展示上传进度/容量。

### 2.10 服务端热路径已部分 Rust 化（y-octo）

- `merge_updates_in_apply_way`：Rust `y_octo::Doc` 顺序 apply 再 encode。
- `validate_doc_update`：spawn_blocking 解码校验，拒超大/非法 update。
- 广播多 update 时 native merge 压缩。
- 后端 native 还含 doc_compactor、embedding、object storage 等运行时。

证据：

- `packages/backend/native/src/lib.rs`
- `packages/backend/server/src/core/doc/merge-updates.ts`（metrics：engine=native|yjs）
- `packages/backend/server/src/core/sync/gateway.ts` `buildBroadcastPayload`
- `packages/backend/native/Cargo.toml` 依赖 `y-octo`

**优点**：与「重计算下沉」方向一致；merge/校验不占 Node 事件循环；有 metrics 与 slow 告警。

### 2.11 客户端本地库已是 Rust SQLite + FTS + crawl

Electron：`DocStoragePool` 暴露 pushUpdate、snapshot、peer clocks、blob、FTS、crawlDocData。

证据：`packages/frontend/apps/electron/src/helper/nbstore/handlers.ts`；`packages/frontend/native/nbstore/src/{lib,doc,storage}.rs`（WAL、迁移、连接池）。

**优点**：桌面路径已具备「磁盘真源 + 原生索引」形态，而非纯浏览器 IDB。

### 2.12 历史版本：基于 Y 的可合并回滚，而非只存全文快照列表

`HistoricalDocStorage.rollbackDoc`：用 UndoManager 在「新→旧」方向生成 **revert update** 再 `pushDocUpdate`，并强制记一条 history。

证据：`packages/common/nbstore/src/storage/history.ts`。

**优点**：回滚本身也是协同可合并的 update，而不是破坏性覆盖（具体冲突语义依赖 Y UndoManager 行为——**未在此仓库验证边界用例**）。

### 2.13 协议版本兼容与权限前置

- 客户端版本决定进 `sync-025` 还是 `sync-026` room。
- join / push 前做 space/doc action 断言与 userdata subject 授权。

证据：`gateway.ts`（`getSyncProtocolRoomType`、`assertDocActionAllowed`、`authorizeUserdataDocSubject`）。

**优点**：演进协议不强制全体客户端同日升级；安全边界在网关而非纯客户端信任。

### 2.14 索引爬取与文档存储松耦合

Indexer 可从 Y.Doc `readAllBlocksFromDoc` 爬块字段，也可走 SQLite `crawlDocData`（native）。

证据：`packages/common/nbstore/src/sync/indexer/crawler.ts`；`impls/sqlite/doc.ts` `crawlDocData`。

**优点**：搜索可异步、可降优先级，不阻塞协同主环。

---

## 3. 适合沉到底层（未来 Rust）vs 留在 TS

对照本产品 **Tauri + TS + RS** 目标；下列为 **效果向** 分层建议，非 AFFiNE 现状照搬清单。

### 3.1 适合沉到 Rust（高收益 / 与 AFFiNE 已证方向一致）

| 能力                                                   | 原因                                 | AFFiNE 证据锚点                                                                                      |
| ------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| CRDT apply / merge / encode / state-vector diff        | CPU 密集、可并行、内存敏感           | y-octo `merge_updates_in_apply_way`；`DocStorageBase`/`DocSyncPeer` 频繁 `mergeUpdates`/`diffUpdate` |
| Update 合法性校验与大小上限                            | 防坏包拖垮进程                       | `validate_doc_update`                                                                                |
| 本地文档/Blob 持久化（SQLite/自定义）                  | IO、WAL、连接池、批量写              | `frontend/native/nbstore`                                                                            |
| 同步引擎内核（job 调度、clock 水位、pull/push 状态机） | 长生命周期、需严格不变量；与 UI 解耦 | `DocSyncPeer` / BlockSuite `SyncPeer`                                                                |
| FTS / 块爬取投影                                       | 大文档扫描                           | FTS APIs、`crawlDocData`、reader                                                                     |
| 服务端 squash / 广播压缩 / 历史压缩                    | 多租户 CPU                           | gateway `buildBroadcastPayload`、doc_compactor                                                       |
| 连接与重试策略的底层实现                               | 可统一移动/桌面/服务端               | 概念上对应 AutoReconnect，但实现可原生                                                               |

### 3.2 适合留在 TS（或薄绑定层）

| 能力                                 | 原因                                          |
| ------------------------------------ | --------------------------------------------- |
| 编辑器视图绑定、选区、IME、块 UI     | DOM/React/Lit 生态；变更频率高                |
| Block flavour 扩展、业务 schema 声明 | 插件与产品迭代                                |
| GraphQL / 业务 API、计费、邀请流     | 非协同热路径                                  |
| Realtime 元数据订阅的产品语义编排    | 权限 UI、评论列表等                           |
| Awareness 的展示（头像、光标层）     | 依赖 UI；底层可只传二进制                     |
| 同步状态到 UI 的 throttle 展示       | 薄适配即可                                    |
| 协议 DTO / 类型生成                  | TS 类型系统友好（可与 Rust 共享 schema 工具） |

### 3.3 灰色地带（需设计验证，勿先判死）

| 点                        | 说明                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 是否继续 Yjs 线协议       | AFFiNE 客户端是 Yjs；服务端 y-octo 兼容其 update 二进制。本产品若自研 CRDT，需重做全链路，**不能**声称「读到了更优 CRDT 算法细节」。 |
| DocFrontend 是否全沉 Rust | 与编辑器 Y.Doc 生命周期强耦合；可「Rust 存盘 + TS 持 Doc」或「Rust 持 Doc + 投影到 TS」两条路径，效果需压测。                        |
| 历史回滚 UndoManager 路径 | 当前依赖 yjs UndoManager（`history.ts`）；沉底层时要有等价「可合并 revert update」策略。                                             |
| y-octo 与 yjs 互操作边界  | 仓库注释曾提及 round-trip 兼容议题（native index.d.ts 附近表述）；**具体不兼容场景本轮未穷尽**。                                     |

---

## 4. 对本产品协同设计的效果启发

> 目标：多人实时协同；重任务 Rust；性能/内存超参考。以下为 **效果启发**，不是照抄 AFFiNE。

### 4.1 必须保留的效果结构

1. **本地真源优先**：未联网可写可读；上线后收敛，而非「云权威覆盖本地未推送编辑」。
2. **Update 流 + 延迟压缩**：击键路径只追加；合并在读/空闲/服务端广播等可控点。
3. **文档协同与元数据实时分离**：编辑包与权限/评论/配额通道分开，避免互相阻塞与类型膨胀。
4. **按文档的同步状态与优先级**：打开中的文档优先同步；UI 能区分 loaded / syncing / error。
5. **Awareness 非持久**：光标类状态独立通道、可丢。
6. **Blob 独立管线**：附件失败不卡文本。
7. **权限错误可局部隔离**：单 doc 无权限不应重启整个 workspace 同步环。

### 4.2 相对 AFFiNE 可追求的「超过」点（效果锁，不降级）

| 维度             | AFFiNE 观察                                     | 本产品可压过的方向                                                   |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| 客户端 CRDT/合并 | 主路径仍大量 TS yjs                             | 编辑热路径 merge/apply 全程 Rust，TS 只收投影/命令                   |
| 内存             | Y.Doc 全量在 JS 堆                              | 大文档分页/按块投影；非活动 subdoc 不常驻 JS                         |
| 线程模型         | Worker + Electron helper 已有，但仍多层 TS 编排 | Tauri 侧单进程 Rust 同步运行时，减少 MessageChannel/JSON/base64 拷贝 |
| 编码开销         | 云路径多处 base64（socket 事件）                | 二进制帧（或压缩二进制），避免 base64 膨胀                           |
| 同步内核         | TS 状态机 + 5s 整环重试                         | 更细粒度退避、持久化 outbox、可取消 inflight                         |
| 可验证性         | 有 unit/e2e，但 codec 双引擎                    | 强制「Rust 为唯一 codec 真源」，消除 native/yjs 双路径漂移           |

### 4.3 可直接借鉴的工程模式（抽象层，非抄类名）

1. **PeerStorageOptions&lt;Local, Remotes&gt;**：同一套 sync 逻辑驱动多后端。
2. **DocSync 元数据与文档内容分表**：clock 水位可独立清/重建（`clearClocks` / `resetSync`）。
3. **main 先就绪再 shadow**（BlockSuite DocEngine）：保证「磁盘权威」先于「云 shadow」，降低空文档闪烁。
4. **广播侧合并压缩 + 失败回退 batch**：实时带宽与正确性兼顾。
5. **协议版本 room 分流**：长期多端并存时演进成本可控。

### 4.4 明确不照搬 / 需警惕

- **不要**把 `@affine/realtime` 的业务 topic 表当文档 CRDT。
- **不要**假设「用了 Yjs 就自动解决冲突」——本仓库体现的是 **工程管线**，不是算法论文。
- **双引擎 merge（yjs + y-octo）** 带来运维 metrics 能力，也带来一致性风险；本产品应尽量 **单一 codec 实现**。
- Worker + 多层 frontend 抽象好测，但拷贝与调度延迟是性能税；Tauri 路线应用 IPC/共享内存把税打掉，而不是再叠一层 TS peer。

---

## 5. 诚实边界与未尽项

| 项                                                 | 状态                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Yjs / y-octo 内部 CRDT 算法细节                    | **未深入读库源码**；仅记录调用方式（apply_update_v1、mergeUpdates、diffUpdate） |
| 多副本因果/并发下的用户可见收敛用例                | 有后端 blocksute 相关测试文件，**本轮未逐条复述**                               |
| 索引 BM25 与协同一致性                             | IDB indexer 有 BM25 实现，**未评估实时正确性**                                  |
| 移动端 native 存储差异                             | 存在 `mobile-native` / Capacitor nbstore 插件，**未完整对照桌面**               |
| 服务端 PG 表结构与对象存储细节                     | storage adapter 存在，**未展开 schema**                                         |
| 与 BlockSuite store 的权威绑定点（产品内唯一入口） | 前端模块较多，**「唯一引擎入口」需另文跟踪**                                    |

---

## 6. 关键路径索引（便于复核）

| 主题                        | 路径                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| Space 存储用法              | `packages/common/nbstore/README.md`                              |
| SpaceStorage / 七类 storage | `packages/common/nbstore/src/storage/`                           |
| DocFrontend                 | `packages/common/nbstore/src/frontend/doc.ts`                    |
| Doc 同步 peer               | `packages/common/nbstore/src/sync/doc/peer.ts`                   |
| 总 Sync                     | `packages/common/nbstore/src/sync/index.ts`                      |
| Cloud Socket 协议           | `packages/common/nbstore/src/impls/cloud/socket.ts`              |
| Cloud Doc                   | `packages/common/nbstore/src/impls/cloud/doc.ts`                 |
| IDB schema                  | `packages/common/nbstore/src/impls/idb/schema.ts`                |
| SQLite TS 适配              | `packages/common/nbstore/src/impls/sqlite/`                      |
| Rust 本地库                 | `packages/frontend/native/nbstore/src/`                          |
| Electron 绑定               | `packages/frontend/apps/electron/src/helper/nbstore/handlers.ts` |
| BlockSuite Sync             | `blocksuite/framework/sync/src/doc/`                             |
| 服务端网关                  | `packages/backend/server/src/core/sync/gateway.ts`               |
| 服务端 merge                | `packages/backend/server/src/core/doc/merge-updates.ts`          |
| y-octo NAPI                 | `packages/backend/native/src/lib.rs`                             |
| Realtime 契约               | `packages/common/realtime/src/index.ts`                          |
| 历史回滚                    | `packages/common/nbstore/src/storage/history.ts`                 |

---

## 7. 小结

AFFiNE 在协同与 local-first 上的**真正优点**不在营销口号，而在：

1. **本地可写真源 + remotes 同步** 的 peer 架构；
2. **update 队列 / snapshot squash / clock 水位 / state-vector diff** 组成的可恢复管线；
3. **doc / blob / awareness / indexer / 业务 realtime** 的通道切分；
4. **可观测状态 + 文档优先级**；
5. **服务端与桌面存储已向 Rust（y-octo / SQLite）下沉**，TS 负责编排与编辑绑定。

对本产品：应内化上述**效果结构**，并用 **更彻底的 Rust 热路径、更少拷贝、单一 codec** 去超过参考；禁止把「简化版离线缓存」或「仅云权威」伪装成 local-first 完成。
