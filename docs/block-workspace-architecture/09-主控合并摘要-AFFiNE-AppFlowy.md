# 09 · 主控合并摘要：AFFiNE × AppFlowy × 本产品

| 元数据     | 值                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **状态**   | 双波调研收齐后的主控合并（只读结论，不定案实现）                                                                                                                                                                                                              |
| **证据**   | `reference/markdown_compare/AFFiNE` · `reference/markdown_compare/AppFlowy`（shallow，HEAD `5cf3a36`，remote AppFlowy-IO/AppFlowy）                                                                                                                           |
| **效果锁** | Tauri + TS + Rust；Notion 皮 + Rust 心；块操作 / 多人协同 / TS 扩展；性能与体验双超                                                                                                                                                                           |
| **关联**   | [00-调研边界](./00-调研边界与效果锁.md) · [round-A 全套](./round-A-affine/) · [round-B 全套](./round-B-appflowy/) · 尤其 [05 对照](./round-B-appflowy/05-对照-AFFiNE-AppFlowy-本产品.md) · [06 映射](./round-B-appflowy/06-映射-AppFlowy-Rust心到Tauri-TS.md) |

---

## 1. 克隆与产出清单

| 项                  | 路径                                  | 状态                                                                  |
| ------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| AppFlowy 源码       | `reference/markdown_compare/AppFlowy` | 已 shallow clone，远端 `https://github.com/AppFlowy-IO/AppFlowy.git`  |
| AFFiNE 源码         | `reference/markdown_compare/AFFiNE`   | 已存在，本轮对照使用                                                  |
| round-A（AFFiNE）   | `round-A-affine/01`–`08`              | 产品交互 / 架构扩展 / 协同 / 缺点×2 / Rust 边界 / 跨产品 / Tauri 映射 |
| round-B（AppFlowy） | `round-B-appflowy/01`–`06`            | 产品交互 / Rust 心 / 协同存储 / 缺点 / 三方对照 / Tauri 映射          |

---

## 2. 一句话定位

| 参考         | 定位                                                                                                              | 对本产品主价值                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **AFFiNE**   | Notion+Miro 向 **TS 块工作区**；BlockSuite 强块模型 + 文档/画布超融合 + **Yjs 热路径在 JS**；Native 多在外围      | **皮**：块交互清单、Store/View 扩展、远端选区、画布概念 |
| **AppFlowy** | Notion 替代 **Flutter UI + Rust 心**；`flowy-*` 域 crate + **yrs/collab 沉底**；Database 多视图完整；**AGPL-3.0** | **心**：领域分层、事件边界、协同权威在 RS、DB 语义      |
| **本产品**   | **Tauri 壳 + TS 皮 + Rust 心**；静默写作 ∩ Notion 块；MD 往返一等                                                 | 领域对标两边，**工程形态两边都反标**                    |

**融合裁决（选型逻辑，非工期）**：

> 用 AFFiNE 当「块工作区完成度与扩展想象力」标尺，用 AppFlowy 当「Rust 领域沉底与协同/DB 权威」标尺；壳/皮/心自建——Electron 与 Flutter 一律不入国。

---

## 3. 关键硬事实（有源码证据）

### 3.1 「谁更像 Rust 心」

|                  | AFFiNE                                       | AppFlowy                                           |
| ---------------- | -------------------------------------------- | -------------------------------------------------- |
| 编辑/CRDT 热路径 | **Yjs 在 JS**；Native ≈ SQLite/索引/预览外围 | **yrs + collab 在 Rust**；UI 只发事件/收通知       |
| 领域逻辑位置     | 大量在 TS monorepo + BlockSuite              | `flowy-document` / `folder` / `database2` 等 crate |
| 与效果锁对齐度   | 皮对齐、**心深度不够**                       | 心对齐、**皮栈（Flutter）与 TS 扩展互斥**          |

→ 本产品要 **AppFlowy 式沉底深度 + AFFiNE 式块/扩展面**，不能只学 AFFiNE 的 NAPI 外围加速。

### 3.2 块模型与协同

|          | AFFiNE                                    | AppFlowy                                                                |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| 文档真相 | 块属性 + Y.Doc；MD 为 adapter             | 扁平块 + external text；树编辑经 `TransactionAdapter` 译成 action/delta |
| 协同 UX  | Awareness + remote-selection 完整         | 有 presence；远端路径含 **diff/forceReload**，syncV2 注释未全实现       |
| 本地优先 | nbstore 多后端（IDB/SQLite/cloud/worker） | RocksDB collab + SQLite 元数据/队列；`LocalServer` 一等                 |

→ 本产品：**RS 权威块树 + 增量 op**；禁止默认「全量 diff 整树」；MD 往返须一等（两边都不够）。

### 3.3 栈张力与许可

| 风险     | AFFiNE                                   | AppFlowy                                          |
| -------- | ---------------------------------------- | ------------------------------------------------- |
| UI 双栈  | React 壳 + Lit 内核                      | Flutter 全栈                                      |
| 工程倍率 | ~70 级 workspace 粉尘包、DI/状态原语叠层 | Flutter 钉死版本 + protoc 双端 + 30+ rust crate   |
| 壳       | Electron 多进程                          | Flutter；makefile 残留 tauri 路径但本树无对应实现 |
| 许可     | 主体 **MIT**（backend/native 另有约束）  | 全仓 **AGPL-3.0** → **禁整仓嵌入**，只内化意图    |

### 3.4 与本仓 markdown-editor 关系（映射共识）

| 选项                     | 裁决                                                 |
| ------------------------ | ---------------------------------------------------- |
| R1 并存                  | **推荐**：聊天流式行级引擎 + 工作区块树权威 **并存** |
| R4 块内复用              | 块内可复用行级渲染/IME 组件，**不**把行级当局        |
| R3 行级当权威 + 块 UI 壳 | **否决**（与效果锁「一等 Block 树」冲突）            |
| 注意                     | `conex-db::blocks` = 压缩块，**≠** 文档块            |

建议 crate 边界（内化名，非照搬 flowy-*）：`conex-doc-model` / `engine` / `collab` / `store` + `doc_commands` + 独立 `doc-page-event` 通道（与 Agent `workbench-run-event` 隔离）。

---

## 4. 内化 / 禁复刻 速查

### 内化

| 层       | 主参考            | 机制意图                                                      |
| -------- | ----------------- | ------------------------------------------------------------- |
| TS 皮    | AFFiNE            | 块=能力挂载点；Store/View 分轨；远端选区；slash/把手/多选清单 |
| 边界     | 两边              | 统一 IPC；树↔扁平适配层可测且单一                             |
| Rust 心  | AppFlowy          | 域 crate；协同权威在 RS；存储分层；DB 语义可沉底但默认可关    |
| 纸面约束 | 本仓 BAN + Typora | 默认静默；chrome 仅 hover/多选/命令态                         |

### 禁复刻

| 来源     | 禁止                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| AFFiNE   | 一类型一 npm 包；React+Lit 双 UI；Electron 拓扑；CRDT 留在 JS；DI 全家桶       |
| AppFlowy | Flutter 终局；整迁 PB/FFI 宗教；全量 diff 常态同步；AGPL 直嵌；DB 污染默认纸面 |
| 共同     | 功能清单长度代替默认路径质量；壳与心耦死在同一渲染叙事；MD 降为二等导出        |

---

## 5. 逻辑装配顺序（依赖，非工期）

```
1. 文档模型 + MD 往返契约（块树 ⟷ MD）     ← 两边不够，自研锁死
2. Rust 存储 + 协同权威 + 事件边界           ← 主 AppFlowy 意图
3. TS 块交互（slash/拖/多选）+ 静默纸面       ← 主 AFFiNE 清单 + 本仓 BAN
4. Awareness / 远端选区（克制 chrome）        ← AFFiNE UX + Rust 节流
5. TS 扩展装载（store/view 分轨）            ← AFFiNE ext-loader 意图
6. Database / 画布（可选，默认可关）          ← DB←AppFlowy 语义；画布←AFFiNE 概念
```

不变量：步骤 6 不得破坏 1–3 默认路径；设计句禁止「照抄 AFFiNE/AppFlowy」；验收轴 = 打开大文档 / 连续输入 / 多人光标。

---

## 6. 产出索引

### round-A-affine

| 文件                                    | 主题                   |
| --------------------------------------- | ---------------------- |
| `01-优点-产品与块交互.md`               | Notion 向块 UX         |
| `02-优点-架构与扩展模型.md`             | Store/View、DI、扩展点 |
| `03-优点-协同与local-first.md`          | Yjs/nbstore 管线       |
| `04-缺点-复杂度与工程DX.md`             | 包爆炸、双栈、Electron |
| `05-缺点-性能与体验风险.md`             | JS 热路径、体感风险    |
| `06-反例-Rust与Native职责边界.md`       | Native 仅外围          |
| `07-跨产品-Notion-Typora-AFFiNE对照.md` | 静默 ∩ 块              |
| `08-映射-Tauri-TS-RS与本仓差距.md`      | 到本仓差距             |

### round-B-appflowy

| 文件                                   | 主题                      |
| -------------------------------------- | ------------------------- |
| `01-优点-产品与块交互.md`              | 块/DB/跨端交互            |
| `02-优点-Rust核心与FFI边界.md`         | flowy-* / dispatch / FFI  |
| `03-优点-协同与存储.md`                | yrs、RocksDB、LocalServer |
| `04-缺点-栈张力与体验风险.md`          | Flutter/AGPL/半实现协同   |
| `05-对照-AFFiNE-AppFlowy-本产品.md`    | 三方总表 + 内化/禁复刻    |
| `06-映射-AppFlowy-Rust心到Tauri-TS.md` | crate/IPC/扩展/与行级引擎 |

---

## 7. 主控下一步（待用户指令，本文件不定案实现）

| 可选动作     | 说明                                                    |
| ------------ | ------------------------------------------------------- |
| 评审波       | 2 个只读评审 Agent 审本合并摘要 + `05`/`06`，出修订意见 |
| 选型定案文档 | 将装配顺序 1–6 写成效果锁验收断言（仍不谈工期）         |
| 执行波       | 按维度落实现任务书（仅用户明确启动后）                  |

**当前未做**：代码实现、改 AFFiNE/AppFlowy 源码、估工期、业务 P0 砍项。
