# 06 · Docmost — TipTap + Yjs 团队协同样本（经典 JS 协同上限）

> **代码根**：`reference/markdown_compare/docmost`（约 v0.95.0）  
> **角色**：Round C「经典 JS 协同」上限与代价样本——**不是**推荐本产品照搬栈。  
> **范围**：编辑器、Hocuspocus/Yjs、页面三份存储、权限/Space、实时协同、大文档/性能线索。  
> **边界**：只读源码与既有 AFFiNE 分析；无运行基准处标**推断**；不编造未出现的 GC/压缩管线。

---

## 0. 结论先行

| 维度          | Docmost 事实                                                                          | 对本产品裁决含义                                                                          |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **协同权威**  | 运行时权威在 **Y.Doc（JS yjs）**；落库时再投影为 TipTap JSON + 纯文本                 | 若权威永远停在浏览器/Node Yjs，Agent 写盘与大文档合并都卡在 **V8 主线程 + 整文档 encode** |
| **热路径**    | 击键 → TipTap/y-prosemirror → Yjs update → WS → Hocuspocus 内存 Doc → 防抖落库        | 协同热路径**整层在 JS**；服务端只是「同构 JS CRDT 宿主」，不是 Rust 权威                  |
| **三份存储**  | `content` (jsonb) + `ydoc` (bytea) + `text_content` (text) + 派生 `tsv`               | 写放大与一致性靠**同事务覆盖写**；无 update 队列/差量 snapshot 管线                       |
| **产品模型**  | Workspace → Space（成员角色）→ Page（可选页级权限）                                   | **可学**：Space/角色/页限制的产品分层                                                     |
| **与 AFFiNE** | 同属「Yjs 为文档真相」；AFFiNE 多了 local-first 队列、y-octo 服务端合并、块宇宙       | Docmost 更「薄」、更接近 Wiki 协同；**上限同样受 JS CRDT 主导**                           |
| **不可学**    | 把 CRDT 留在浏览器/Node 当**唯一**可写真相，API/Agent 只能经 Yjs 整段 replace/prepend | 本产品需要 **可结构化 mutate 的权威层**（Rust/内核），JS 只持投影                         |

**一句话**：Docmost 是「TipTap 团队 Wiki + Hocuspocus」的**最小完整协同样板**——权限与 Space 模型清晰；存储是经典三副本；**协同与写权威全在 JS Yjs**，因此它定义的是**经典栈的上限与税**，不是 AI 工作栈笔记应追求的架构天花板。

---

## 1. 栈与目录地图

| 层            | 位置                               | 技术                                                              |
| ------------- | ---------------------------------- | ----------------------------------------------------------------- |
| 客户端编辑器  | `apps/client/src/features/editor/` | TipTap 3.29 + Collaboration / CollaborationCaret                  |
| 协同 Provider | 同上 + `collab-socket.ts`          | `@hocuspocus/provider` / `provider-react`，文档名 `page.{pageId}` |
| 本地离线缓存  | `page-editor.tsx`                  | `y-indexeddb`（IndexedDB 镜像 Y.Doc）                             |
| 扩展包        | `packages/editor-ext/`             | 自定义节点（表格/媒体/transclusion 等）                           |
| 协同服务      | `apps/server/src/collaboration/`   | `@hocuspocus/server` + 可选 RedisSync 多实例                      |
| 业务 API      | `apps/server/src/core/page/`       | 创建/元数据；**内容变更也走 Yjs 事件**                            |
| 持久化        | PostgreSQL `pages` 表              | jsonb / bytea / text + tsvector                                   |

依赖锚点（根 `package.json`）：

- `@hocuspocus/*` **4.5.0**
- `@tiptap/*` **3.29.2**，`@tiptap/y-tiptap` **3.0.7**
- `yjs` **^13.6.30**，`y-prosemirror` **1.3.7**，`y-indexeddb` **9.0.12**

协同进程可独立起：`pnpm collab` → `apps/server/src/collaboration/server/collab-main.ts`（默认端口 `COLLAB_PORT` / 3001）。

---

## 2. 协同热路径在哪一层

### 2.1 分层素描

```
用户击键 / 粘贴
    │
    ▼
TipTap Editor  (apps/client …/page-editor.tsx)
    │  Collaboration.configure({ document: provider.document })
    │  （y-prosemirror / y-tiptap 绑定 PM ↔ Y.XmlFragment 'default'）
    ▼
Y.Doc（浏览器 JS 堆）  ←→  y-indexeddb 本地镜像
    │  HocuspocusProvider WS  binary updates + Awareness
    ▼
/collab WebSocket  (CollabWsAdapter → CollaborationGateway)
    │  可选 RedisSync：文档锁 + 跨实例代理 socket
    ▼
Hocuspocus 内存 Document（Node yjs）
    │  debounce 10s / maxDebounce 45s → onStoreDocument
    ▼
PersistenceExtension
    │  TiptapTransformer.fromYdoc → content jsonb
    │  Y.encodeStateAsUpdate → ydoc bytea
    │  jsonToText → text_content → 触发 tsv
    ▼
PostgreSQL pages 行（事务内整列更新）
    │  旁路：history 队列 / mention / AI / transclusion 索引
```

**热路径结论**：

1. **输入热路径**在浏览器：TipTap + Yjs 绑定，无 Rust/WASM 文档权威。
2. **多人合并热路径**在 **Hocuspocus 进程内的 JS Y.Doc**（+ 可选 Redis 把连接粘到「文档所有者」实例）。
3. **持久化不在热路径上**：`debounce: 10000`、`maxDebounce: 45000`（`collaboration.gateway.ts`），即最坏约 45s 才强制落库一次；期间真相在内存 Y.Doc。
4. REST 读页返回的是 **`content` JSON**（静态首屏）；真正可写态要等 collab **synced** 后切换到协同编辑器（`page-editor.tsx` 的 `showStatic` 门闩）。

### 2.2 客户端接线证据

| 职责                    | 路径证据                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Room 名 / token / flush | `apps/client/src/features/editor/page-editor.tsx`：`HocuspocusRoom name={\`page.${pageId}\`}`，`flushDelay={500}` |
| 共享 WS                 | `apps/client/src/features/editor/collab-socket.ts`：单例 `HocuspocusProviderWebsocket`，引用计数 + 5s 优雅断开    |
| Collab 扩展             | `extensions/extensions.ts`：`Collaboration.configure({ document, provider })` + `CollaborationCaret`              |
| 本地持久                | `page-editor.tsx`：`new IndexeddbPersistence(provider.configuration.name, provider.document)`                     |
| 空闲断连                | 隐藏页 + 5 分钟 idle → `socket.disconnect()`；可见再 `connect()`                                                  |
| 首屏策略                | 未 Connected+synced 前渲染只读 `StaticPageEditor(content)`，避免空白闪烁                                          |
| 本地 React Query 缓存   | `onUpdate` 防抖 3s 写 `pages` query 的 `content`，**非权威落盘**                                                  |
| WS URL                  | `apps/client/src/lib/config.ts`：`getCollaborationUrl()` → `/collab`，http→ws / https→wss                         |

`shouldRerenderOnTransaction: false` 减轻 React 重渲染，但 **PM 文档与 Y 绑定仍全量在编辑器进程**——没有文档级虚拟化线索。

### 2.3 服务端接线证据

| 职责            | 路径证据                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Hocuspocus 配置 | `collaboration.gateway.ts`：extensions = Auth + Persistence + Logger；可选 `RedisSyncExtension`                                |
| 连接入口        | `adapter/collab-ws.adapter.ts`：HTTP upgrade 路径 `/collab`                                                                    |
| 鉴权            | `extensions/authentication.extension.ts`：JWT `JwtType.COLLAB` → Space 角色 → 页级权限 → `readOnly`                            |
| 加载            | `persistence.extension.ts` `onLoadDocument`：优先 `page.ydoc` apply；否则 `TiptapTransformer.toYdoc(page.content)`；否则空 Doc |
| 落库            | 同文件 `onStoreDocument`：fromYdoc + encodeStateAsUpdate + jsonToText，事务更新三列                                            |
| 旁路写内容      | `collaboration.handler.ts`：`updatePageContent` / 评论 mark 均 `openDirectConnection` + `transact` 改 Y 文档                   |

**Agent/API 写内容也必须进入 Yjs**：

```272:287:apps/server/src/core/page/services/page.service.ts
  async updatePageContent(...) {
    const prosemirrorJson = await this.parseProsemirrorContent(content, format);
    const documentName = `page.${pageId}`;
    await this.collaborationGateway.handleYjsEvent(
      'updatePageContent',
      documentName,
      { operation, prosemirrorJson, user },
    );
  }
```

`operation === 'replace'` 时：**删光 XmlFragment 再 `Y.applyUpdate` 整文档**（`collaboration.handler.ts`）。这是典型「CRDT 权威在协同服务器」模型——**没有**独立的结构化块 API 绕过 Yjs。

### 2.4 Redis 多实例（扩展，非算法换代）

`extensions/redis-sync/` 注释标明源来自 Hocuspocus PR #1008：

- 文档级 **Redis 锁**（默认 TTL 10s）决定哪个 collab 节点「拥有」文档；
- 非所有者上的客户端消息经 pub/sub **代理**到所有者；
- `customEvents` 把评论 mark / `updatePageContent` 路由到持有该 Doc 的实例。

这解决的是 **水平扩展与连接粘滞**，**不改变**「权威仍是某进程内 JS Y.Doc」的事实。

---

## 3. 三份存储：代价与一致性

### 3.1 Schema 事实

`pages` 表（`apps/server/src/database/migrations/20240324T086300-pages.ts`）：

| 列             | 类型         | 角色                                                                                    |
| -------------- | ------------ | --------------------------------------------------------------------------------------- |
| `content`      | **jsonb**    | TipTap/ProseMirror JSON——REST 读、历史、导出、搜索 headline 的结构源                    |
| `ydoc`         | **bytea**    | `Y.encodeStateAsUpdate` 全量状态——协同加载优先路径                                      |
| `text_content` | **text**     | `generateText(json)` 纯文本——全文检索原料                                               |
| `tsv`          | **tsvector** | 触发器由 title + `text_content`（截断 1e6 字符）生成（`20250729T213756-…tsvector..ts`） |

TypeScript 实体：`apps/server/src/database/types/db.d.ts`（`Pages`：`content` / `ydoc` / `textContent`）。

按需加载：`page.repo.ts` 用 `includeContent` / `includeYdoc` / `includeTextContent` 开关——**默认列表查询不带 ydoc/content**，避免列表炸行。

### 3.2 写路径：何时三者一起变

**主路径（协同落库）** — `PersistenceExtension.onStoreDocument`：

1. `tiptapJson = TiptapTransformer.fromYdoc(document, 'default')`
2. `ydocState = Buffer.from(Y.encodeStateAsUpdate(document))`
3. `textContent = jsonToText(tiptapJson)`（失败仅 warn，可为 null）
4. 事务内 `findById(..., withLock, includeContent)`
5. `isDeepStrictEqual(tiptapJson, page.content)` → **跳过写**（避免无变更刷盘）
6. 否则 `updatePage({ content, textContent, ydoc, lastUpdatedById, contributorIds })`
7. 成功后：stateless `page.updated` 广播、transclusion 同步、history 延迟任务、mention/AI 队列

**创建路径** — `page.service.ts`：有初始 content 时 `createYdocFromJson` 同时写入 ydoc。  
**导入路径** — `import.service.ts`：同类 toYdoc + encode。

### 3.3 一致性模型

| 问题                 | Docmost 行为                                                                       | 含义                                                    |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 谁是运行时真相？     | **内存 Y.Doc**（及客户端 Y.Doc）                                                   | 落库是投影快照                                          |
| 三者是否原子？       | **同一次 `updatePage` 事务**更新 content/text/ydoc                                 | 行级一致：要么三列同批更新，要么跳过                    |
| 与在线编辑的延迟？   | 防抖 10–45s                                                                        | 崩溃窗口内 DB 可能旧；客户端有 y-indexeddb 可局部恢复   |
| 加载优先级           | ydoc 优先；无 ydoc 才 json→Y                                                       | 旧数据/迁移路径兼容                                     |
| 历史存什么？         | `page_history` 存 **content JSON**（见 `page-history.repo` / `history.processor`） | 历史不存 ydoc；恢复需再生成 Y 态                        |
| 深比较短路           | content JSON 深相等则不写                                                          | 省 IO，但 ydoc 二进制即使「语义相同」也不会单独压缩重写 |
| 有无 update 日志表？ | **无**                                                                             | 不像 AFFiNE 的 snapshot + pending updates 队列          |

**代价**：

1. **写放大**：每次落库 `encodeStateAsUpdate` **整文档** bytea + 整棵 JSON + 全文 text（无差量 append-only 日志）。
2. **CPU**：`fromYdoc` / `toYdoc` / `generateText` 均在 Node 主路径；大文档落库尖峰**推断**明显。
3. **空间**：jsonb 与 ydoc 近似双倍结构存储；text 再一份；history 再堆 content 快照。
4. **Y 状态膨胀**：**未见**协作目录内 mergeUpdates 压缩、服务端 GC 管线或 snapshot 水位——长期编辑的 ydoc 体积**推断**会大于「纯 JSON 语义尺寸」（Yjs tombstone/结构历史特性）。
5. **搜索截断**：`text_content` 进 tsvector 时 `substring(..., 1, 1000000)`——超大页检索只覆盖约 1M 字符。

### 3.4 读路径分工

| 用途         | 用哪份                                                                      |
| ------------ | --------------------------------------------------------------------------- |
| 打开页 REST  | `content` JSON → 静态编辑器首屏                                             |
| 进入协同     | 服务端用 `ydoc`（或 content 转换）灌 Hocuspocus                             |
| 全文搜索     | `text_content` → `tsv`；headline 也扫 `text_content`（`search.service.ts`） |
| 导出/HTML/MD | 自 `content` 经 `jsonToHtml` / `jsonToMarkdown`（`collaboration.util.ts`）  |
| 历史 diff    | 历史表中的 `content`                                                        |

**一致性风险点（架构层，非已证实 bug）**：

- API `updatePage` 仅改 title/icon 等元数据时不动三份内容——正确。
- 内容 API **必须**经 collab 网关；若 collab 进程宕机，**内容写失败**（耦合）。
- `replace` 整文档写 Y 时，在线用户依赖 Yjs 合并语义；粗暴全量 replace 在并发下的体验/冲突形态与「细粒度 CRDT 编辑」不同（**推断**）。

---

## 4. 权限、Space、实时协同（产品模型）

### 4.1 层级

```
Workspace（租户）
  └── Space（知识空间）
        ├── space_members：user 或 group + role
        └── pages（树：parent_page_id）
              └── page_permissions / page_access（可选限制）
```

角色枚举（`apps/server/src/common/helpers/types/permission.ts`）：

| 枚举                 | 值                      | 语义                           |
| -------------------- | ----------------------- | ------------------------------ |
| `SpaceRole`          | admin / writer / reader | Space 管理 / 读写 / 只读       |
| `SpaceVisibility`    | open / private          | 工作区成员可见可加入 vs 仅成员 |
| `PagePermissionRole` | reader / writer         | 页级限制下的最近祖先角色       |
| `UserRole`（工作区） | owner / admin / member  | 租户级，与 Space 正交          |

Space 表：`migrations/20240324T085900-spaces.ts`（`default_role` 默认 writer，`visibility` 默认 private）。  
成员：`space_members` 强制 **user_id XOR group_id**。

### 4.2 协同鉴权链

`authentication.extension.ts`：

1. 校验 collab JWT（`workspaceId` + `sub`）
2. 用户存在且未禁用
3. 页存在 → 取 `page.spaceId`
4. `spaceMemberRepo.getUserSpaceRoles` → `findHighestUserSpaceRole`
5. 无 Space 角色 → 401
6. 若存在页级限制：`pagePermissionRepo.canUserEditPage`
   - 无访问 → 401
   - 有访问无编辑 → `connectionConfig.readOnly = true`
7. 无页级限制：Space **reader** → readOnly
8. 页在回收站（`deletedAt`）→ readOnly

**可学点**：协同通道与 REST **共用同一套 Space/页权限语义**，并在 **WebSocket 握手**时固化 readOnly，而不是仅靠前端 `editable` prop（前端仍会 `editor.setEditable(editable && editMode)` 双闸）。

### 4.3 非文档协同通道

- **文档 CRDT**：Hocuspocus `/collab`
- **业务实时**（树刷新、通知等）：`apps/server/src/ws/`（Socket.IO 风格，与文档 update **分离**）
- 落库后 stateless：`page.updated` 刷新客户端 React Query 的 `updatedAt` / `lastUpdatedBy`（不传全文）

与 AFFiNE「doc update 通道 vs realtime 元数据通道」**同构思想**，实现更轻。

### 4.4 历史与贡献者

- 防抖落库后入 `HISTORY_QUEUE`：新页 5 分钟内 **1 分钟**延迟，之后 **5 分钟**（`collaboration/constants.ts`）
- 贡献者：内存 Map 在 `onChange` 收集 userId；落库时并入 `contributorIds`；另 Redis set 供 history worker `popContributors`
- 历史比较：content JSON 深相等则跳过快照

---

## 5. 大文档 / 性能线索

源码中**没有**独立的「大文档引擎」；线索如下。

| 线索                                 | 位置                                                                         | 解读                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------- |
| 落库 debounce 10s / max 45s          | `collaboration.gateway.ts`                                                   | 用时间换写次数；大文档单次 store 更重        |
| 整文档 `encodeStateAsUpdate`         | `persistence.extension.ts`                                                   | 无差量 updates 表                            |
| content 深相等跳过                   | 同上                                                                         | 防无意义写；比较本身是整棵 JSON              |
| `text_content` → tsv 截断 1M         | tsvector 迁移                                                                | 承认超大纯文本检索上限                       |
| 代码块自动语言检测采样上限           | `packages/editor-ext/.../lowlight-plugin.ts`：`AUTO_DETECT_SAMPLE_SIZE` 注释 | 大代码块性能补丁                             |
| collab 事务与 lowlight               | 同文件注释：y-prosemirror 同步事务需小心                                     | 协同 + 装饰器插件的已知张力                  |
| `shouldRerenderOnTransaction: false` | `page-editor.tsx`                                                            | 减 React 税，不减 PM/Y 税                    |
| UniqueID 过滤远程事务                | `extensions.ts`：`filterTransaction: !isChangeOrigin`                        | 避免协同下 ID 抖动                           |
| 空闲断 WS                            | `page-editor.tsx`                                                            | 减服务器连接；重连成本在大 ydoc **推断**升高 |
| y-indexeddb 全量镜像                 | 同文件                                                                       | 大文档本地 IDB 体积与同步成本 **推断**       |
| Redis 文档锁 / 代理                  | `redis-sync.extension.ts`                                                    | 扩展连接，不降低单文档 CPU                   |
| 独立 collab 进程                     | `collab-main.ts`                                                             | 与 API 进程分离，仍是 Node+Yjs               |

**推断上限（无基准）**：

- 单页体量受 **浏览器 PM 文档 + Y.Doc +（可选）整页 DOM** 共同约束；未见虚拟列表/窗口化正文。
- 服务端单文档连接数受 **持有该 Doc 的 Node 进程内存** 约束；Redis 只把连接路由过去。
- Agent 批量改：每次 `replace` ≈ 整树 Y 转换 + 广播 + 最终整行落库——**不适合**高频细粒度块 mutate。

---

## 6. 与 AFFiNE 的同构 / 差异

对照既有分析：`docs/block-workspace-architecture/round-A-affine/03-优点-协同与local-first.md`、`05-缺点-性能与体验风险.md`。

### 6.1 同构

| 点                     | Docmost                   | AFFiNE                                     |
| ---------------------- | ------------------------- | ------------------------------------------ |
| 文档交换单位           | Yjs binary update         | Yjs binary update                          |
| 编辑器绑定             | TipTap ↔ Y（XmlFragment） | BlockSuite ↔ Y（yBlocks 等）               |
| 浏览器持完整 Y.Doc     | 是                        | 是（大文档内存风险同源）                   |
| 服务端也跑 CRDT        | Hocuspocus + **JS yjs**   | 网关 + 存储；热合并可走 **y-octo（Rust）** |
| 元数据实时 ≠ 文档 CRDT | Socket/ws 业务通道分离    | `@affine/realtime` 与 space:push 分离      |
| 本地缓存               | y-indexeddb               | IDB / 桌面 SQLite（更完整 local-first）    |
| 权限进协同门           | collab JWT + Space/页     | space 成员与 doc 权限（更复杂产品）        |

### 6.2 差异（Docmost 更「薄」、更 Wiki）

| 维度           | Docmost                                         | AFFiNE                                           |
| -------------- | ----------------------------------------------- | ------------------------------------------------ |
| 产品形态       | 团队 Wiki / 页面树 / Space                      | 块宇宙 + 白板 + 工作区同步                       |
| 持久化模型     | **行内三列快照**（content/ydoc/text）           | **snapshot + updates 日志 + clock**，读时 squash |
| 服务端合并     | 纯 JS Yjs                                       | 可选 **Rust y-octo** merge/validate/压缩广播     |
| Local-first    | 弱（IDB 辅助 + 必须以服务端 collab 为写入中枢） | 强（DocFrontend 队列、离线可写再 sync）          |
| 块 ID / 结构化 | UniqueID 仅部分节点类型                         | 块 ID 一等，扩展协议完整                         |
| Agent/API 写   | 经 Yjs replace/prepend/append                   | 仍偏 CRDT；但存储层差量更细                      |
| 多实例         | Redis 文档锁 + 代理                             | 自有 SpaceSync 协议 + 时间戳水位                 |
| 复杂度税       | 低，可读完协同目录                              | 高（nbstore/sync/原生）                          |

**同构结论**：两者都证明——**「实时协同 + 富文本」在开源界的默认吸引子是 Yjs**。  
**差异结论**：AFFiNE 在 **存储管线与服务端原生合并** 上抬了一档；Docmost 展示 **没有** 这些加码时，经典 Hocuspocus 样板长什么样。**两者都没有**把「文档权威」沉到可给 Agent 安全细粒度写的非 JS 内核（AppFlowy/思源更接近那条轴）。

---

## 7. 上限裁决素材：若协同权威永远在 JS Yjs

> 裁决问句（对齐 `00-筛选与本波目标.md`）：文档真相在哪一层？大文档能否不整树重绘？块 mutate 是否一等？MD 是否契约？理论上限是否高于自研？

### 7.1 性能上限（结构决定，非调参能消）

| 上限                                        | 机制                                        | Docmost 证据锚                                             |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| **单文档内存 ≈ 全量 CRDT + PM 文档 + 视图** | 权威 Y.Doc 在浏览器；编辑器持完整 doc       | `Collaboration.configure({ document: provider.document })` |
| **落库 CPU/IO ∝ 全文**                      | 每次 store 全量 encode + JSON 投影 + 纯文本 | `onStoreDocument` 三步转换                                 |
| **无服务端原生合并红利**                    | Hocuspocus 用 JS yjs，无 y-octo 类路径      | `collaboration/` 仅 yjs / hocuspocus                       |
| **无文档虚拟化**                            | 标准 TipTap `EditorContent`                 | `page-editor.tsx` 无 windowing                             |
| **多光标/装饰**                             | CollaborationCaret + 评论 Y mark            | 布局读成本随人数升（**推断**，同类 AFFiNE R4）             |
| **扩展节点加重同堆**                        | Excalidraw/Drawio/Mermaid 等进编辑邻域      | `packages/editor-ext` + client components                  |

**可对比的「抬上限」方向**（他仓已验证的轴，非 Docmost 内能力）：

- 权威与 merge 沉 **Rust**（AppFlowy collab / AFFiNE y-octo）
- 持久化 **append updates + 异步 squash**（AFFiNE nbstore）
- 视图 **窗口化**，CRDT 可不进主线程全量（需自研边界）

### 7.2 Agent 写盘上限

Docmost 内容写入口收束为 Yjs 事务：

| 操作                    | 实现                               | Agent 友好度                            |
| ----------------------- | ---------------------------------- | --------------------------------------- |
| `replace`               | 清空 fragment + 整文档 applyUpdate | 适合「整页覆写」；并发时粗暴            |
| `prepend` / 默认 append | `fragment.insert` 一批 Y 元素      | 适合文首/文末塞块；**不能**按块 ID 点改 |
| 评论 mark               | 按 Yjs 选区设 mark                 | 人类选区语义，非 Agent 块地址           |
| 直接 SQL 改 content     | **不经此路径则与在线 Y.Doc 分叉**  | 危险；系统选择禁止旁路                  |

因此：**若权威永远在 JS Yjs**：

1. Agent 必须 **连上协同宿主**（或 openDirectConnection）才能安全写——运维与延迟绑定 collab 进程。
2. 细粒度「改第 17 个块的 attrs」需要 **自己在 JSON/Y 树上定位**，没有一等块事务 API。
3. 批量 N 次小改若每次 replace，复杂度接近 **N 次全量转换+广播**；若合并为一次 replace，则丢失中间合并粒度。
4. MD 是 **导出/导入编解码**（html↔md 工具链），不是磁盘上的权威契约——Agent「只写 .md 文件」与运行时真相无关。
5. 搜索/AI 队列消费的是落库后的 **text/json 投影**，与内存 Y 之间存在 debounce 窗口的 **可见性延迟**。

### 7.3 对本产品的裁决句（素材，非最终选型文）

- Docmost 证明：**团队实时协同可以很「短路径」做完**（TipTap + Hocuspocus + 三列 PG）。
- 它同时证明：该短路径把 **性能天花板与 Agent 写模型** 锁死在 **JS CRDT 整文档语义**。
- 与 AFFiNE 比，Docmost 更清楚暴露「**没有** local-first 队列 / 原生 merge / 块宇宙时」的税单。
- 与思源/AppFlowy 比，Docmost **不在**「内核事务 + 块 ID」赛道上——**不可**用 Docmost 反驳「权威沉内核」路线。
- **效果锁下**：可借鉴其 **Space/权限/防抖落库/读模型拆分**；不可把「Yjs 唯一真相」当作 AI 工作栈笔记的终局架构。

---

## 8. 可学 / 不可学

### 8.1 可学

| 项                                       | 为什么值得学                                | 证据                                                     |
| ---------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| **Workspace → Space → Page 产品分层**    | 团队知识库心智清晰；默认角色 + 可见性       | `permission.ts`、spaces 迁移                             |
| **Space 角色与页级限制叠加**             | 协同握手时统一算 readOnly；最近限制祖先语义 | `authentication.extension.ts`、`page-permission.repo.ts` |
| **文档 CRDT 通道与业务 WS 分离**         | 避免把树/通知塞进 Y 文档                    | `collaboration/` vs `ws/`                                |
| **三投影职责清晰**                       | JSON 读导出、Y 协同、text 搜索              | pages 迁移 + PersistenceExtension                        |
| **静态 JSON 首屏 + synced 后切协同**     | 降 TTFI、避免空白                           | `page-editor.tsx` showStatic                             |
| **落库防抖 + 深相等短路 + 历史延迟分层** | 写放大可控（在「整页快照」模型内）          | gateway debounce、history constants                      |
| **内容旁路也强制进 Yjs**                 | 防止 REST 与协同分叉（在选定权威下正确）    | `updatePageContent` → handler                            |
| **列表查询不带 content/ydoc**            | 基本的载荷纪律                              | `page.repo` `$if(include*)`                              |
| **独立 collab 进程 + 可选 Redis 粘滞**   | 运维上把协同 CPU 与 API 隔离                | collab-main、RedisSync                                   |

### 8.2 不可学（或仅作反面教材）

| 项                                         | 原因                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **把 CRDT 留在浏览器/Node 当唯一可写真相** | Agent、批量迁移、离线权威、大文档 GC 全绑 V8；与「重任务沉 Rust / 结构化 mutate」效果锁冲突 |
| **整行三列快照当唯一持久策略**             | 无 updates 日志则难以差量同步、难以服务端廉价 merge、落库尖峰硬                             |
| **API 内容写 = 整文档 replace/prepend**    | 不是块级事务；并发与审计粒度差                                                              |
| **MD 仅作进出口**                          | AI 工作栈若以 MD/块文件为契约，Docmost 模型不兼容                                           |
| **无文档虚拟化仍堆重型节点**               | 白板/图表进正文同堆会复制 AFFiNE 类内存税                                                   |
| **ydoc 无压缩/GC 管线却长期累积**          | 运维上 bytea 膨胀与加载变慢（**推断**，结构允许发生）                                       |

---

## 9. 关键路径索引（绝对路径风格，相对于仓库根）

| 主题                    | 路径                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| 页面编辑器 / 协同 UI    | `reference/markdown_compare/docmost/apps/client/src/features/editor/page-editor.tsx` |
| Collab 扩展             | `…/features/editor/extensions/extensions.ts`                                         |
| WS 单例                 | `…/features/editor/collab-socket.ts`                                                 |
| Hocuspocus Gateway      | `…/apps/server/src/collaboration/collaboration.gateway.ts`                           |
| 持久化三写              | `…/collaboration/extensions/persistence.extension.ts`                                |
| 鉴权                    | `…/collaboration/extensions/authentication.extension.ts`                             |
| Yjs 旁路事件            | `…/collaboration/collaboration.handler.ts`                                           |
| Redis 同步              | `…/collaboration/extensions/redis-sync/redis-sync.extension.ts`                      |
| TipTap 扩展与 json↔text | `…/collaboration/collaboration.util.ts`                                              |
| 页面服务 / Agent 写入口 | `…/apps/server/src/core/page/services/page.service.ts`                               |
| pages schema            | `…/database/migrations/20240324T086300-pages.ts`                                     |
| spaces schema           | `…/database/migrations/20240324T085900-spaces.ts`                                    |
| 权限枚举                | `…/common/helpers/types/permission.ts`                                               |
| 页权限计算              | `…/database/repos/page/page-permission.repo.ts`                                      |
| 搜索用 text             | `…/core/search/search.service.ts`                                                    |
| 依赖版本                | `reference/markdown_compare/docmost/package.json`                                    |

---

## 10. 与 Round C 筛选五问的简答

1. **文档真相在哪一层？** → 运行时 **JS Y.Doc**；磁盘 **ydoc 优先 + content/text 投影**。
2. **大文档热路径能否虚拟化？** → **否**（未见）；性能靠防抖与 React 开关，不靠窗口化。
3. **块 ID + 结构化 mutate 是否一等？** → **弱**（部分 UniqueID；写 API 为 replace/prepend）。
4. **MD 是契约还是导出？** → **导出/导入凑合**。
5. **理论上限是否高于 Tauri+RS+TS 自研？** → **否**作为终局架构；它标记的是 **JS 协同经典上限**。自研若权威沉 Rust + 投影编辑 + 块事务，**理论上限应高于** Docmost 所代表的吸引子——Docmost 的价值是 **把税单写清楚**，并贡献 **Space/权限产品模型** 与 **通道拆分** 等可搬运零件。

---

_文档状态：Round C 架构扫读完成；无运行时基准；不改 Docmost 源码。_
