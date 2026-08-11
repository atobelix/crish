# 05 · 对照：AFFiNE × AppFlowy × 本产品目标

| 元数据                   | 值                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **状态**                 | 调研落盘（round-B-appflowy）                                                                                                                                                                                                      |
| **证据口径**             | 本地镜像 `reference/markdown_compare/AFFiNE`、`reference/markdown_compare/AppFlowy`；既有 round-A 产出 `docs/block-workspace-architecture/round-A-affine/`                                                                        |
| **本产品目标（效果锁）** | **Tauri + TypeScript + Rust**；**Notion 皮**（块与丰富交互）+ **Rust 心**（极速、低内存、原生协同计算）；必备块操作、多人实时协同、TS 扩展生态；**性能与体验双双超过**参考产品                                                    |
| **关联**                 | [00-调研边界与效果锁.md](../00-调研边界与效果锁.md) · [04-缺点-复杂度与工程DX.md](../round-A-affine/04-缺点-复杂度与工程DX.md) · [07-跨产品-Notion-Typora-AFFiNE对照.md](../round-A-affine/07-跨产品-Notion-Typora-AFFiNE对照.md) |
| **不做**                 | 工期 / 人天 / 业务 P0 排序；禁止「照抄 AFFiNE/AppFlowy」作终局设计句；禁止劝退 Tauri                                                                                                                                              |

---

## 0. 结论先行

| 参考系       | 一句话定位                                                                                                                               | 对本产品的主价值                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **AFFiNE**   | Notion+Miro 向的 **TS 块工作区**：BlockSuite 强块模型 + 文档/画布超融合 + Yjs 协同 + 本地优先多后端；Native 只在外围（SQLite/索引/预览） | **块交互面、画布概念、扩展装载、Widget 横切能力清单**   |
| **AppFlowy** | Notion 替代叙事的 **Flutter UI + Rust 心**：`flowy-*` 领域 crate + `collab`/`yrs` 沉底 + Dart FFI 事件总线；Database 多视图完整          | **Rust 领域分层、事件派发、协同/DB 沉底、FFI 边界纪律** |
| **本产品**   | 效果锁已定：Tauri 壳 + TS 皮 + Rust 心；静默写作 ∩ Notion 块操作；MD 往返一等；性能/体验双超                                             | **领域问题对标两边，工程形态两边都反标**                |

**融合立场**：

- **皮（块/slash/拖拽/选区/纸面）** 主看 AFFiNE 的能力地图，压上 Typora 静默（见 round-A `07`）。
- **心（协同合并、存储、索引、DB 语义、事件边界）** 主看 AppFlowy 的 Rust 沉底与 crate 切分意图。
- **壳层**：两边都不是终局——AFFiNE 的 Electron 多进程、AppFlowy 的 Flutter 渲染栈均与 **Tauri + React/TS** 目标错位；只学「壳应薄、原生能力经单一边界」的意图。

---

## 1. 总表：维度 × AFFiNE × AppFlowy × 本产品应达到

> 「本产品应达到」为效果锁目标，不可自行降级为「简化版 / 砍功能」。

| 维度            | AFFiNE                                                                                                                                                                                 | AppFlowy                                                                                                                                                                                                     | **本产品应达到**                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **文档模型**    | 强块树：`affine:paragraph` / list / code / note / surface 等独立包；Store 绑 Yjs，内部真相是 **块属性 + CRDT**，Markdown 为 adapter【`blocksuite/affine/blocks/*`，`framework/store`】 | 编辑器树（`appflowy_editor`）+ 后端 **flat 块 + external text**；`TransactionAdapter` 把树事务译成块 action / text delta 下沉 Rust【`editor_transaction_adapter.dart`，`flowy-document`，`collab-document`】 | **一等 Block 树**（内存真相）+ **Markdown 可往返**为主序列化；结构 op 与文本 op 可分路径；Agent/外部工具可读可写，不「导出凑合」                       |
| **块交互**      | Widget 横切完整：drag-handle / slash-menu / toolbar / page-dragging-area / remote-selection；各块 `configs/slash-menu.ts` 注册【`blocksuite/affine/widgets/*`】                        | Flutter 侧插件海：slash、拖拽重排、浮动工具、callout/table/toggle/columns、mention、AI writer 等【`editor_plugins/` ~320 dart】；`appflowy_editor` 作编辑内核                                                | **Notion 级完整感**：把手、多选、`/`+`、` slash、转类型、嵌套缩进；**默认 Typora 静默**（无激活行底色、无永久顶栏格式条）；chrome 仅 hover/多选/命令态 |
| **画布**        | 产品核心叙事「Docs + whiteboard 超融合」；`gfx/*`（brush/shape/connector/mindmap/…）+ `surface` + edgeless widgets 全套【`blocksuite/affine/gfx`，README】                             | **无** Miro 级 edgeless 画布；Board 是 **Database 看板视图**，不是自由画布                                                                                                                                   | 文档主路径优先；画布为 **后续可扩展面**，不阻塞块+协同效果锁；若做画布，协议与文档块可共享，UI 不绑架默认纸面                                          |
| **数据库**      | `blocks/database` + `data-view` 大包；多视图嵌文档【`blocksuite/affine/blocks/database`，`data-view/`】                                                                                | **一等竞争力**：`flowy-database2`（field/filter/sort/group/calculation）+ Flutter grid/board/calendar 全视图【`flowy-database2/src`，`plugins/database/`】；行可挂文档                                       | **非默认 MD 写作主路径**（对齐 BAN-05）；工作区若要视图，与文档壳解耦；语义/过滤/分组可参考 AppFlowy Rust 分层，不把 CRM 控件塞进默认纸面              |
| **协同**        | **Yjs 热路径在 JS**：Store SyncController + y-protocols；`remote-selection` + Awareness；nbstore peer/cloud【`framework/sync`，`packages/common/nbstore`，`widgets/remote-selection`】 | **yrs + AppFlowy-Collab 在 Rust**：`collab-document` / folder / database；Dart 侧 collab adapter（含 diff 全量同步路径 syncV3）【`Cargo.toml` collab\*，`document_collab_adapter.dart`】                     | **多人实时协同一等**；合并/索引/权威状态在 **Rust**；TS 渲染光标与块；大文档/多协作者下内存与帧率超过两边体感；远端 chrome 克制（细线+轻名牌）         |
| **存储**        | 本地优先矩阵：IDB / SQLite(NAPI) / cloud / broadcast / worker；含 v1 并行路径【`nbstore` exports】                                                                                     | `CollabKVDB` + `flowy-sqlite`（diesel）+ 存储管理器；本地 collab 持久与快照【`collab-integrate`，`flowy-sqlite`，`flowy-storage`】                                                                           | **桌面路径单一权威存储（Rust/SQLite）** + 显式 schema migration；前端只适配；主线程不堵；禁止永久并行 v1 树作为常态                                    |
| **壳层**        | Electron（main/helper/preload/renderer…）+ Web + Capacitor iOS/Android；`@affine/core` 巨石 + React 壳【`packages/frontend/apps/*`，`core/`】                                          | **Flutter** 跨端 UI（desktop/mobile 同仓）；`bitsdojo_window` 等桌面窗体；Bloc 状态遍布【`appflowy_flutter/`】                                                                                               | **Tauri 单壳**；一次依赖图；IPC = `invoke`/事件；壳薄、纸面沉浸；**不**复制 Electron 多进程，也**不**引入 Flutter 渲染栈                               |
| **扩展**        | `@blocksuite/affine-ext-loader`：Store/View ExtensionProvider + zod schema + page/edgeless scope【`ext-loader/README.md`】                                                             | 产品侧「社区驱动可扩展」叙事；实践上以 **内置 editor_plugins + Flutter 包** 为主，无对等的开放 TS 扩展市场                                                                                                   | **TS 扩展生态一等**：`registerBlockType` / 命令 / slash / 序列化钩子；契约薄、宿主可嵌入；扩展失败不拖垮 Rust 内核                                     |
| **Native 沉底** | 根 `Cargo.toml` 约 7 成员：nbstore/sqlite/schema/importer/preview/media…；**编辑与 CRDT 热路径仍在 JS/Yjs**【`Cargo.toml`，`packages/frontend/native`】                                | **Rust 即产品心**：`flowy-core` 聚合 document/folder/database/user/ai/search/storage；`dart-ffi` + `lib-dispatch` 事件总线；协同与 DB 逻辑在 RS【`rust-lib/*`】                                              | **Rust 进热路径**：解析/行高/协同合并/大文档索引/（可选）DB 语义；TS 负责块 UI 与扩展；目标内存与帧率 **双超** 参考体感                                |
| **许可**        | 混合：**主体 MIT**；`packages/backend` 与 `packages/common/native` 另有许可证约束【根 `LICENSE` + `LICENSE-MIT`】                                                                      | **AGPL-3.0** 全仓【`LICENSE`，README badge】                                                                                                                                                                 | 自研代码与依赖选型须 **独立合规**；可内化机制意图，禁止整仓粘贴；对 AGPL 依赖的链接/嵌入策略单独裁决（本文只标事实）                                   |

---

## 2. 各自「最值得内化的机制意图」Top5

> 只谈**机制意图**（为什么这样切问题），不谈抄包名、不谈目录镜像。

### 2.1 AFFiNE Top5（内化）

| #      | 机制意图                                                                                                           | 证据锚点                                                        | 对本产品的映射方式                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A1** | **块是横切能力的挂载点，而非仅 DOM 节点**：slash / toolbar / clipboard / markdown adapter 按块类型配置，能力可组合 | `blocks/*/configs`，`widgets/slash-menu`，`widgets/drag-handle` | 用 **注册表 + 能力描述符** 表达块能力；实现可在粗粒度包内，不必一类型一 npm 包 |
| **A2** | **Store 与 View 分离**：数据扩展与视图扩展分轨，scope（page/edgeless）决定装配                                     | `ext-loader` Store/View provider                                | TS 扩展契约拆 **数据钩子 / 视图钩子**；宿主可只装 store 做无头处理             |
| **A3** | **文档与画布共享块宇宙**：同一 block 可在纸面流与无限画布两种呈现                                                  | `surface` + `note` + `gfx/*`，README 超融合叙事                 | 协议层预留「空间放置」元数据；**默认 UI 仍文档流**，画布不抢主路径             |
| **A4** | **本地优先存储分层**：doc / blob / indexer / awareness 分通道，可 Worker 化                                        | `nbstore` 分层与 worker client/consumer                         | 桌面由 Rust 实现等价分层；前端不直接操作多后端细节                             |
| **A5** | **远端选区是一等协同 UX**：awareness 不只是「数据已同步」，还要可见可辨                                            | `widgets/remote-selection`，`AwarenessStore`                    | 要有；样式更克制、更新节流，服务静默纸面                                       |

### 2.2 AppFlowy Top5（内化）

| #      | 机制意图                                                                                                              | 证据锚点                                                         | 对本产品的映射方式                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **B1** | **领域全部沉到 Rust crate，UI 只发事件/收通知**：document / folder / database / user / search / ai / storage 清晰边界 | `flowy-core` 聚合字段，`flowy-*` 成员列表                        | 本产品 `crates/` 按领域切；Tauri command 对齐「事件/命令」而非把业务堆在前端 |
| **B2** | **统一派发总线（request → plugin → response）+ 通知回流**：Dart FFI 与业务解耦                                        | `lib-dispatch`，`dart-ffi` Task/Isolate 模型                     | Tauri：`invoke` 入、事件出；禁止每个功能私造 IPC 方言                        |
| **B3** | **协同权威在原生侧（yrs/collab），UI 适配远端变更**：订阅 block changed / awareness / sync state                      | `flowy-document/src/document.rs` subscribe_*，`collab-integrate` | 协同合并与持久在 Rust；TS 只 apply 投影；避免「两端各有一套 CRDT 真相」      |
| **B4** | **编辑器树 ↔ 后端扁平块 的显式适配层**：结构 action 与 external text delta 分流                                       | `TransactionAdapter` 注释与实现                                  | 明确「编辑投影」与「持久/协同模型」可不同构，但 **适配层可测、单一**         |
| **B5** | **Database 语义在 Rust 完整建模**（field type option、filter/sort/group、calculation、多 layout）                     | `flowy-database2/services/**`                                    | 若工作区要 DB，**语义沉底**；视图层可换（不必 Flutter）；与 MD 文档壳解耦    |

### 2.3 对照小结（谁的意图进哪一层）

```
┌─────────────────────────────────────────────────────────────┐
│ TS 皮（交互/扩展/纸面）  ← 主内化 AFFiNE：A1 A2 A3 A5        │
├─────────────────────────────────────────────────────────────┤
│ 边界协议（事务/适配/IPC） ← 两边：A2 + B2 B4                 │
├─────────────────────────────────────────────────────────────┤
│ Rust 心（协同/存储/领域） ← 主内化 AppFlowy：B1 B3 B5 + A4  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 各自「明确不要复刻」Top5

### 3.1 AFFiNE 不要复刻

| #        | 不要复刻                                                                           | 为何                                                             | 替代原则                                  |
| -------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| **X-A1** | **一 Block 类型一 npm package**（约 70 级 workspace 粉尘包）                       | 类型检查图、CI、import 面线性爆炸【round-A `04` D1】             | 包按稳定性/测试边界切；块类型用注册表扩展 |
| **X-A2** | **React 壳 + Lit 内核双 UI 运行时**                                                | 双生命周期、焦点/IME/样式桥接税；直接威胁「更快更好用」          | **单一 UI 宿主**；扩展不引入第二组件框架  |
| **X-A3** | **Electron 多进程拓扑 + 双 hoist 桌面安装仪式**                                    | 与已锁 **Tauri** 错位；构建与安全模型整套不可迁移【`04` D5/D14】 | Tauri 单壳、一次依赖图                    |
| **X-A4** | **编辑/CRDT 热路径留在 JS，Native 只做外围加速**                                   | 效果锁要求 Rust 心进热路径；外围 NAPI 不够                       | 合并/索引/大文档路径在 RS；TS 投影        |
| **X-A5** | **自研 DI 全家桶 + 多层状态原语叠床架屋**（Framework/LiveData/jotai/signals/rxjs） | 心智与竞态面过大【`04` D4】                                      | 权威状态在 Rust 事件流；TS 一种投影模型   |

### 3.2 AppFlowy 不要复刻

| #        | 不要复刻                                                                | 为何                                                                                                  | 替代原则                                                                   |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **X-B1** | **Flutter 作为桌面/移动统一 UI 终局**                                   | 效果锁固定 **TS 扩展生态** 与 Notion 向 Web 技术栈皮；Flutter 插件市场 ≠ TS 扩展                      | Tauri + TS 渲染；扩展用 TS API                                             |
| **X-B2** | **Protobuf + Dart FFI 作为唯一前后端契约形态**                          | 与 Tauri/serde/TS 类型生成链路不同；整套 codegen（flowy-codegen）是另一套工程宗教                     | 契约可用 serde/JSON/二进制，但 **工具链贴合本仓**，不整迁 flowy-ast 流水线 |
| **X-B3** | **UI 侧「全量 diff 文档」作为常态远端同步策略**（syncV3 拉全量再 diff） | 大文档下带宽与主线程成本高；syncV2 事件路径未完全闭环也说明模型张力【`document_collab_adapter.dart`】 | 增量 op 流 + 可校验快照；禁止默认「每次远端变更整树 diff」                 |
| **X-B4** | **AGPL 传染面下的「直接嵌入其 crate/UI」产品策略**                      | 许可与商业/分发约束强于 MIT 主体【`LICENSE` AGPL-3.0】                                                | 只内化架构意图；依赖与拷贝须合规评审                                       |
| **X-B5** | **Database 多视图与行文档成为默认写作中心**                             | 会污染 MD 静默纸面与 Agent 友好往返；与 BAN-05 / 效果锁「文档主路径」冲突                             | DB 能力可选、解耦；默认纸面干净                                            |

### 3.3 两边共同不要复刻

| #        | 共同陷阱                                   | 说明                                                                                                        |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **X-C1** | **用「功能清单长度」代替「默认路径质量」** | AFFiNE 画布/DB、AppFlowy DB/AI 都很满；本产品胜利条件是 **静默+块+协同+性能** 同时真                        |
| **X-C2** | **壳与心耦死在同一渲染技术叙事里**         | 「因为 Flutter 所以原生」或「因为 Electron 所以块编辑」都是假因果；本产品 **Tauri 壳 + RS 心 + TS 皮** 已锁 |
| **X-C3** | **Markdown 降级为二等导出**                | 两边内部真相都是块/CRDT；本产品要求 **MD 往返一等契约**                                                     |

---

## 4. 选型逻辑建议：双参考如何分工

### 4.1 分工总表

| 问题域                                         | 主参考                                  | 辅参考                                           | 本产品终局形态                            |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| 块类型能力清单、slash、拖拽、多选、远端选区 UX | **AFFiNE**                              | AppFlowy 插件目录作 checklist                    | TS 注册表 + 单一 UI；静默约束来自本仓 BAN |
| 文档流默认纸面、chrome 显隐                    | AFFiNE（能力）∩ Typora（静默，见 `07`） | AppFlowy 块操作可对表                            | L0 静默 / L1 按需块操作                   |
| 画布 / edgeless                                | **AFFiNE**（概念与元素族）              | —                                                | 协议可预留；实现后置，不挡文档效果锁      |
| Database 语义与多视图                          | **AppFlowy**（Rust 模型完整度）         | AFFiNE data-view 嵌文档方式                      | 解耦模块；默认可关                        |
| 协同权威与持久                                 | **AppFlowy**（yrs 在 RS + collab 分层） | AFFiNE awareness/选区 UX                         | Rust 合并 + TS 渲染                       |
| 存储分层（doc/blob/index）                     | 两边意图相近                            | AFFiNE nbstore 命名清晰；AppFlowy KV/SQLite 沉底 | **单一 Rust 实现**                        |
| 领域 crate 切分与事件总线                      | **AppFlowy**                            | AFFiNE modules 仅作「不要做成巨石」反例          | `flowy-*` 意图 → 本仓 `crates/` + Tauri   |
| 扩展装载（Store/View、schema）                 | **AFFiNE**                              | AppFlowy 叙事级「可扩展」                        | TS ext API；zod/等价 schema 可选          |
| 桌面壳 / 安装 / IPC                            | **都不是终局**                          | —                                                | **Tauri**                                 |
| Native 沉底深度                                | **AppFlowy**（心在 RS）                 | AFFiNE（外围加速方向对，深度不够）               | 热路径 RS 化，超过两边                    |
| 许可友好度（借鉴源码时）                       | AFFiNE 主体 MIT 更松                    | AppFlowy AGPL 更紧                               | 自研为主；依赖单独过合规                  |

### 4.2 为何壳层两边都不是终局

| 壳                     | 锁死的代价                                                                  | 与本产品冲突点                                                                    |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **AFFiNE / Electron**  | main/helper/preload 多入口、双 hoist 安装、Node 版本窄窗、与 Web 同仓移动端 | 栈已锁 Tauri；IPC/权限/更新模型不可平移；复制即结构债【`04` §4】                  |
| **AppFlowy / Flutter** | UI 与动画/输入走 Dart；扩展生态是 Dart 包而非 TS；与 Web 块编辑器生态割裂   | 效果锁要求 **TS 扩展生态** 与 Web 向块交互实现面；Rust 心可留，Flutter 皮不可终局 |

**正确抽取**：

- 从 Electron：**不要**进程拓扑；**可**学「本地优先桌面必须有原生 IO 边界」。
- 从 Flutter：**不要** Widget 树；**可**学「UI 线程不跑领域逻辑、经总线问 Rust」。

### 4.3 推荐的能力装配顺序（逻辑依赖，非工期）

```
1. 文档模型 + MD 往返契约（块树 ⟷ MD）     ← 两边都不够「MD 一等」，自研锁死
2. Rust 存储 + 协同权威 + 事件边界           ← 主 AppFlowy 意图
3. TS 块交互（slash/拖/多选）+ 静默纸面       ← 主 AFFiNE 能力清单 + 本仓 BAN
4. Awareness / 远端选区（克制 chrome）        ← AFFiNE UX + Rust 节流
5. TS 扩展装载（store/view 分轨）            ← AFFiNE ext-loader 意图
6. Database / 画布（可选模块，默认可关）      ← DB 看 AppFlowy 语义；画布看 AFFiNE 概念
```

**不变量**：

1. 步骤 6 不得破坏步骤 1–3 的默认路径质量。
2. 任何参考源码路径只作证据，**设计句禁止**「照抄 AFFiNE/AppFlowy」。
3. 性能验收相对两边：**打开大文档、连续输入、多人光标** 三类可感知路径必须可测、可回归。

### 4.4 一句话选型裁决

> **用 AFFiNE 当「块工作区产品完成度与画布想象力」的标尺，用 AppFlowy 当「Rust 领域沉底与协同/DB 权威」的标尺；壳用 Tauri 自建，皮用 TS 自建，心用 Rust 自建——两边的工程倍率与 UI 栈一律不入国。**

---

## 5. 证据索引（便于复核）

### AFFiNE

| 主题               | 路径                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| 产品叙事 / 许可    | `reference/markdown_compare/AFFiNE/README.md`，`LICENSE`，`LICENSE-MIT`      |
| 块与 Widget        | `blocksuite/affine/blocks/*`，`blocksuite/affine/widgets/*`                  |
| 画布               | `blocksuite/affine/gfx/*`，`blocks/surface`                                  |
| 协同抽象           | `blocksuite/framework/sync`，`framework/store`                               |
| 存储               | `packages/common/nbstore`                                                    |
| 扩展               | `blocksuite/affine/ext-loader`                                               |
| Native             | 根 `Cargo.toml`，`packages/frontend/native/**`                               |
| 工程债             | `docs/block-workspace-architecture/round-A-affine/04-缺点-复杂度与工程DX.md` |
| Notion/Typora 融合 | `.../round-A-affine/07-跨产品-Notion-Typora-AFFiNE对照.md`                   |

### AppFlowy

| 主题           | 路径                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| 产品 / 许可    | `reference/markdown_compare/AppFlowy/README.md`，`LICENSE`（AGPL-3.0）                 |
| Rust 工作区    | `frontend/rust-lib/Cargo.toml`，`flowy-core`                                           |
| 文档与协同订阅 | `flowy-document/src/document.rs`                                                       |
| 协同集成       | `collab-integrate`，workspace `collab*` / `yrs`                                        |
| FFI / 派发     | `dart-ffi`，`lib-dispatch`                                                             |
| Database       | `flowy-database2/src/**`，`appflowy_flutter/lib/plugins/database/`                     |
| 编辑适配       | `document/application/editor_transaction_adapter.dart`，`document_collab_adapter.dart` |
| 编辑插件       | `document/presentation/editor_plugins/`                                                |

### 本产品约束

| 主题          | 路径                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| 效果锁        | `docs/block-workspace-architecture/00-调研边界与效果锁.md`                                        |
| 视觉/静默禁令 | `reference/chat-composer-component/docs/markdown-editor/BANNED-VISUAL-UX.md`（round-A `07` 引用） |
| 行级性能资产  | `reference/markdown-editor`                                                                       |

---

## 6. 修订

| 日期       | 说明                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| 2026-08-10 | 初版：AFFiNE × AppFlowy × 本产品总表 + Top5 内化/禁复刻 + 双参考分工建议 |
