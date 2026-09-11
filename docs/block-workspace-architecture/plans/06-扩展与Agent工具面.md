# 06 · 扩展与 Agent 工具面（分维度任务书 · 再生加厚）

| 字段         | 内容                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **效果**     | EL-05 / EL-07：Agent 块级 mutate 一等；TS 扩展 View∥Command 一等；无旁路写                                                        |
| **文件域**   | `crates/agent-tools/**`；`crates/conex-note-runtime/**`；`session-loop` 扩展点；`packages/plugin-sdk/**`；workbench `note_*` 注入 |
| **依赖**     | 01 真 apply / hydrate；03 get_md/apply_md 契约；02 search/投影索引；写锥未闭合则 **A-AGT 持久项不得关**                           |
| **锁定**     | D6：View∥Command；统一 Registry；禁 DOM/盘旁路；工具写仅 Transaction.apply                                                        |
| **规格**     | `specs/query-blocks-tool-schema.md`；`specs/register-flavour-roadmap.md`                                                          |
| **上游分析** | `analysis/2026-08-11-realign/D6D7-工具与双引擎.md`                                                                                |
| **流程**     | `20`：Memory 测绿 ≠ 生产；五工具 ≠ 06 全清单；注入真 ≠ EL-05 关                                                                   |
| **调度**     | **包 ID 以 `plans/09` 为唯一权威**；本文缺口包建议服从 09                                                                         |

> **硬句（调度纪律）**：调度包 ID **仅以 `plans/09` 为准**。本文工具对照表「缺口包」列中的 **W4-F** 已入库 09 Wave 4；**W4-E′ / W4-C′** 等撇号 ID **非法**，映射为 **W4-A 持久子集 + W1-H** / **W4-C**。
> 禁止在 PR/进度中使用未入库 09 的包号关闭任何验收。对照全文见 `09` §0.4。

---

## 0. 结论先行（会计纪律）

| #      | 判定                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **NoteBackend trait 叶子 + workbench 真注入 + contribute 投影-only** 方向正确，**保留**。                                  |
| **C2** | 相对 06 目标清单：**大幅缩水**（现状约 5 个笔记工具；无 `block_batch`/细粒度 `block_*`/表驱动矩阵）。**未注册 = 未交付**。 |
| **C3** | **MemoryNoteBackend 仅测试**；**禁止** Memory 全绿关闭任何生产向 A-AGT / EL-05。                                           |
| **C4** | 结构 encode 占位 / 无 hydrate → 冷启动 `get_md` 半截；**hydrate 未绿 → 禁止关闭依赖持久的 A-AGT 项**。                     |
| **C5** | contribute 写句柄拒绝 = A-EXT-05 局部；**≠** EL-07 全关；registerFlavour F1 后半–F3 仍开。                                 |

> **一句话**：地基可用，EL-05/07 全未关；方案钉死工具对照表、注入契约、A-AGT 映射与伪完成禁令。

---

## 1. 目标模块

1. 笔记工具注册：`block_*` / `document_*` / `search_*` / `outline_*` / `ref_*` / **`block_batch`**
2. **safeActions × ActionEffects × Source** 矩阵 + 会话 batch token
3. MCP：同一 registry 外壳（stdio 可延续）
4. 扩展 **contribute points**：slash / widget / blockView / keymap
5. TrustGate：`note:read|write`、`ui:contribute`
6. 领域 system prompt 片段（工具描述陷阱，学思源）
7. dryRun / 幂等 batchId / **execution_unknown**
8. **NoteBackend** 注入与 Store 热路径（apply_md → commit → 投影/FTS）

### S1 + 写路径（保留并加硬）

| 规则                                      | 说明                                             |
| ----------------------------------------- | ------------------------------------------------ |
| 读 md                                     | **即时 S(树)**；不默认 mirror 文件当局           |
| `document_write_md` / `document_apply_md` | ≡ 事务化 `apply_md` / replace_via_tx             |
| **禁止**                                  | `fs.write` 后当笔记权威；file 工具写笔记数据当局 |
| `read_file(笔记路径)` 若暴露              | 必须经 import 检测或拒绝                         |
| Agent                                     | **禁止改 DOM**；版本/时钟仅经 apply              |

---

## 2. 工具注册对照表（库存 vs 靶 · 强制）

> **进度会计必须以本表为准**。不得在汇报中用「笔记工具已通」偷换「06 清单完成」。

### 2.1 全表

| 工具名 / 能力                                                            | 06 要求      | 库存（分析时点）          | dangerous | 主责验收                    | 缺口包建议                 |
| ------------------------------------------------------------------------ | ------------ | ------------------------- | --------- | --------------------------- | -------------------------- |
| `query_blocks`                                                           | ✅ M5 schema | ✅ 已注册；readonly       | 否        | A-QRY / 读路径              | 契约保持；冷索引依赖 02    |
| `document_outline`                                                       | ✅           | ✅ 工具有；**无 IPC**     | 否        | 读路径                      | IPC 可选（§6）             |
| `document_get_md`                                                        | ✅ 即时 S    | ✅ 热路径；冷启动半截     | 否        | 读；依赖 hydrate            | 01/02                      |
| `document_apply_md`（≡ write_md）                                        | ✅           | ✅ dangerous + maybe_ask  | 是        | A-AGT 形状                  | 真树/持久未关则 A-AGT 未关 |
| `send_to_note`                                                           | ✅ 显式桥    | ✅ 工具+桥+IPC            | 是        | A-SURF-05/06（**主责 07**） | 产品链 07                  |
| **`block_batch`** + dryRun                                               | ✅           | ❌ **无**                 | 是        | **A-AGT-05**                | **W4-F**                   |
| `block_insert` / `block_update` / `block_delete` / `block_move` 等细粒度 | ✅ `block_*` | ❌ **无**                 | 分项      | A-AGT-01…03 形状            | W4-F                       |
| `search_*` 独立工具                                                      | ✅           | ❌ 仅 query 谓词          | 否        | 检索面                      | 可并 query 须书面改清单    |
| `ref_*` 独立工具                                                         | ✅           | ❌ 仅 query `ref_to/from` | 否        | 引用面                      | 同上                       |
| `outline_*` 族扩展                                                       | ✅           | 仅 document_outline       | 否        | —                           | 按产品扩                   |
| safeActions×Effects×Source **表驱动**                                    | ✅           | ❌ 仅 ask 钩子半套        | —         | **A-AGT-06**                | W4-F                       |
| plan **Deny** 路径                                                       | ✅           | 半                        | —         | A-AGT-06                    | W4-F                       |
| **execution_unknown** 写中断                                             | ✅           | ❌                        | —         | **A-AGT-07**                | W4-F                       |
| 会话 batch token 校验                                                    | ✅           | 有 validate 形状          | —         | 批安全                      | 与 batch 工具闭合          |
| MCP 笔记专项                                                             | 同 registry  | 方向对；专项验收弱        | —         | 不得宣称关闭                | 外壳复用                   |
| 幂等 batchId / intent                                                    | ✅           | 进程内 Map；**非跨进程**  | —         | A-AGT / A-SURF-06           | 02/store 落盘              |

### 2.2 现状注册面（诚实基线）

```
读：query_blocks · document_outline · document_get_md
写：document_apply_md · send_to_note
```

**钉死**：当前 **5** 工具；上表 ❌ 行在注册前 **一律未交付**。

### 2.3 扩展时纪律

- 新工具必须：Registry 注册 + schema + dangerous/readonly 标注 + 验收 ID 挂表。
- 禁止「内部函数可调但未注册」计交付。
- 禁止用 Memory 后端绿代替 Store 生产路径绿。

---

## 3. NoteBackend 注入契约

### 3.1 架构（保留）

```
agent-tools note_*  →  ctx.note_backend: Option<Arc<dyn NoteBackend>>
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     None → note_backend_unwired   Memory（仅测）   StoreNoteBackend（生产）
              稳定 JSON 占位                      apply_md → commit_ops → 投影/FTS
```

| 规则         | 内容                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **叶子依赖** | tools crate **不**硬绑 workspace-store                                  |
| **default**  | `SessionLoopOptions.note_backend = None`                                |
| **生产**     | workbench `engine` / `core_run`：db 打开成功则注入 **StoreNoteBackend** |
| **未注入**   | 稳定错误：`note_backend_unwired` / `note.unwired`——**禁止**静默成功     |
| **写路径**   | 仅 apply_md / Op 事务；禁 fs.write 当局                                 |

### 3.2 Memory 禁关生产（硬锁）

| 允许                            | **禁止**                                        |
| ------------------------------- | ----------------------------------------------- |
| MemoryNoteBackend 单测 / 属性测 | 用 Memory 全绿关闭 **A-AGT-01…08** 任一生产向项 |
| CI 快层 Memory                  | 宣称「Agent 笔记可用 / EL-05」仅凭 Memory       |
| 文档写明 test-only              | 生产默认注入 Memory                             |

**关闭 A-AGT 依赖持久的项** 最低要求：

1. 生产路径 = **StoreNoteBackend**（或等价真 store）集成测；**且**
2. **01 hydrate / 结构可逆** 已绿（杀进程后 get_md/query 仍权威）；**且**
3. 测名/报告标注 `StoreNoteBackend` 或 workbench 注入路径——**禁止**仅 Memory。

### 3.3 与 01/02 依赖（写进完成定义）

| 缺口                                       | 影响                       | 方案态度                                       |
| ------------------------------------------ | -------------------------- | ---------------------------------------------- |
| 结构 encode 占位、无 `DocSession::hydrate` | 杀进程丢树；冷 `get_md` 空 | **hydrate 未绿 → 禁止关 EL-05 / 持久 A-AGT**   |
| intent 幂等仅进程内                        | 重启可双插                 | 跨进程幂等归 store（02/01）；A-SURF-06 交叉 07 |
| commit 未默认 mirror 水位                  | 契约 mirror 不自动推进     | 产品可后挂，**须文档化**不得假装已推进         |

---

## 4. A-AGT 映射（主责 06 + 01）

| ID           | 断言要点（方案级）                                | 依赖实现                        | **禁止冒充**             |
| ------------ | ------------------------------------------------- | ------------------------------- | ------------------------ |
| **A-AGT-01** | 批 mutate 进单一 apply / 树一致                   | 真批事务 + DocSession           | Memory；仅 schema        |
| **A-AGT-02** | 大批/并发安全边界                                 | 真 apply + 队列/事务            | mock 调用计数            |
| **A-AGT-03** | origin=agent 可过滤 / 可观测                      | origin 标签 + 心侧              | 无 origin 测             |
| **A-AGT-04** | Agent **不改 DOM**；改 DOM 版本不变               | 集成：DOM 旁路零版本变化        | 仅「工具无 DOM API」文字 |
| **A-AGT-05** | **`block_batch` + dryRun**                        | 工具注册 + 批事务 + dryRun 无写 | **无工具宣称**           |
| **A-AGT-06** | safeActions×Effects×Source **表驱动** + plan Deny | 表模块 + 测 ID                  | 仅 maybe_ask 半套        |
| **A-AGT-07** | **execution_unknown** 写中断协议                  | 专路径 + 测                     | 无路径宣称               |
| **A-AGT-08** | update ≠ append 等诊断可区分                      | 错误码/诊断字段                 | 无                       |

**EL-05 关闭不得早于**（08）：**W4-B + W6-E**；且本文件 A-AGT 表与 01 心侧断言仍绿。
**W4 五工具注册成功 ≠ EL-05。**

---

## 5. A-EXT / registerFlavour（EL-07）

### 5.1 contribute 现状与阶段

| 项                                               | 实态 | 会计                   |
| ------------------------------------------------ | ---- | ---------------------- |
| View kinds：slash / block_view / widget / keymap | 有   | 骨架                   |
| `FORBIDDEN_WRITE_KEYS` 拒绝 store/applyOp/…      | 有   | **A-EXT-05 局部**      |
| registerFlavour F0 + known 扩展                  | 有   | F0/F1 前半             |
| RS schema 扩展 / F2 真渲染 / F3 TrustGate 打包   | 未关 | **EL-07 主路径未完成** |

### 5.2 M4 阶段门（`register-flavour-roadmap`）

| 阶段   | 内容                             | 与 A-EXT            |
| ------ | -------------------------------- | ------------------- |
| **F0** | 接口草稿                         | 形状                |
| **F1** | RS schema 扩展 + Unknown 占位    | 心侧+呈现占位       |
| **F2** | View 轨真渲染自定义块；写仍走 Op | A-EXT 呈现          |
| **F3** | 打包分发 / TrustGate             | A-EXT-01… 权限/重载 |

| ID 族          | 说明                                | 禁止                      |
| -------------- | ----------------------------------- | ------------------------- |
| A-EXT-01…04,06 | TrustGate / 重载 / 注册冲突端到端等 | 「contribute 绿 = EL-07」 |
| A-EXT-05       | 投影-only / 无写句柄                | 局部满足 **≠** 全表       |
| A-INV-01       | 扩展写仍进单一 apply                | 旁路写盘/DOM              |

**实现不得**把第三方块永久锁死在「只能装饰内置 flavour」。

---

## 6. IPC 子集声明（故意边界）

| 面                            | 命令/能力                                     | 说明                          |
| ----------------------------- | --------------------------------------------- | ----------------------------- |
| **人机 IPC（现状）**          | apply / query / send_to_note                  | 与 noteApi 对齐的三命令级     |
| **Agent 工具**                | 另含 outline / get_md 等                      | 工具全集 ≥ IPC 子集           |
| **是否补** outline/get_md IPC | **可选产品**                                  | **不**挡工具面 A-AGT 形状验收 |
| **禁止**                      | 第二套 in-process 写库；MCP 名与 `mcp_*` 冲突 | —                             |

---

## 7. 不变量

1. 工具写 → **仅** `Transaction.apply` / 文档化的 apply_md 事务。
2. 读 md → **S(树) 即时**；不默认 mirror 文件。
3. 插件 **无法**提升权限绕过审批（TrustGate + session-loop 三态）。
4. contribute **投影-only**；无 applyOp/sqlite/innerHTML 等写句柄。
5. 未注入 backend → **显式 unwired**，不假装成功。
6. **Memory ≠ 生产**。

---

## 8. 验收 ID 汇总

| 族          | ID                       | 主责    | 关闭注意                                   |
| ----------- | ------------------------ | ------- | ------------------------------------------ |
| A-AGT       | 01…08                    | 06 + 01 | Memory 禁关；batch/矩阵/unknown 缺则对应红 |
| A-EXT       | 01…06 + 恶意扩展零持久化 | 06      | F 阶段门；contribute ≠ 全关                |
| A-INV-01    | 单一 apply               | 01/06   | 旁路=失败                                  |
| A-QRY       | query_blocks             | 06/02   | 禁任意 SQL                                 |
| 确认矩阵    | 表驱动测                 | 06      | A-AGT-06                                   |
| X-02 / X-06 | 批+键入；插件写盘/DOM    | 08 联测 | 跨层                                       |

**恶意扩展**：零版本变化 / 零持久化（X-06）；缺测=未交付。

---

## 9. 伪完成禁止

| ID         | 禁止                                  | 正确                               |
| ---------- | ------------------------------------- | ---------------------------------- |
| **P-06-1** | 「W4 完成 → Agent 笔记可用 / EL-05」  | 查 A-AGT 表 + hydrate + Store 路径 |
| **P-06-2** | 「MemoryNoteBackend 测绿 = 生产闭环」 | **禁止关 A-AGT 生产项**            |
| **P-06-3** | 「5 工具 = 06 清单完成」              | 对照 §2 全表；❌ 行未交付          |
| **P-06-4** | 「contribute 绿 = EL-07」             | 仅 A-EXT 局部；F1–F3 开            |
| **P-06-5** | 无 `block_batch` 宣称 A-AGT-05        | 无工具=未交付                      |
| **P-06-6** | 仅 maybe_ask 宣称 A-AGT-06            | 须表驱动 + Deny                    |
| **P-06-7** | Agent 改 DOM / fs.write 当局          | 架构红灯                           |
| **P-06-8** | 第二套 in-process 写库                | 禁止                               |

---

## 10. 依赖

```
01 可逆结构 + hydrate + 真 apply
        │
        ▼
02 投影/FTS/intent 落盘（持久幂等）
        │
        ▼
06 工具满表 + Store 注入验收 + A-AGT
        │
        ├──► 07 send_to_note 产品链（A-SURF）
        └──► EL-05 / EL-07（W4-B/C + W6-E）
```

| 依赖      | 本维                                               |
| --------- | -------------------------------------------------- |
| 01 未完成 | 工具形状可先做；**持久 A-AGT / EL-05 不得关**      |
| 03 MD     | apply_md / get_md 契约                             |
| 07        | send_to_note 产品与隔离主责在 07；本维提供工具注册 |

---

## 11. 文件域

| 路径                                                                                          | 角色                           |
| --------------------------------------------------------------------------------------------- | ------------------------------ |
| `crates/agent-tools/src/note_backend.rs`                                                      | trait / Memory / unwired       |
| `crates/agent-tools/src/tools/note_*.rs`                                                      | 工具实现                       |
| `crates/agent-tools/src/tools/mod.rs`                                                         | 注册面                         |
| `crates/conex-note-runtime/**`                                                                | StoreNoteBackend               |
| `crates/session-loop/**`                                                                      | options 默认 None；ToolContext |
| `apps/agent-workbench/src-tauri/src/{note_runtime,engine,core_run_commands,note_commands}.rs` | 生产注入 / IPC                 |
| `packages/plugin-sdk/src/contribute/**`                                                       | contribute / flavours          |
| 表驱动矩阵模块（待建）                                                                        | safeActions×Effects×Source     |
| `block_batch` 工具（待建）                                                                    | A-AGT-05/07                    |

---

## 12. 库存代码态度

| 资产                             | 态度                                 |
| -------------------------------- | ------------------------------------ |
| NoteBackend trait + unwired      | **保留**                             |
| 读 readonly / 写 dangerous 分轨  | **保留**                             |
| StoreNoteBackend 热路径          | **保留并改造**（焊 hydrate，不推倒） |
| workbench 真注入                 | **保留**                             |
| 现有 5 工具                      | **保留**；按 §2 补齐其余             |
| MemoryNoteBackend                | **保留测试**；禁生产关项             |
| FORBIDDEN_WRITE_KEYS / 投影-only | **保留**                             |
| 「W4=EL-05」「Memory=生产」叙事  | **废弃**                             |

---

## 13. 实现包建议（逻辑依赖 · 09 官方号）

> 调度权威：`plans/09` Wave 4。下表不含撇号私号。

| 09 包    | 内容                                                                                | 推进                                          |
| -------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| **W4-A** | 既有工具 schema + registry + **注入验收子集**（真 StoreNoteBackend；依赖 **W1-H**） | 已注册行；持久 A-AGT 形状；**禁 Memory 冒充** |
| **W4-B** | 审批矩阵 + batch token                                                              | A-AGT 批安全方向                              |
| **W4-C** | contribute points View 轨；registerFlavour 路径（原 W4-C′/M4 叙述）                 | EL-07 主路径方向                              |
| **W4-D** | MCP 外壳同一 registry                                                               | 与工具面一致                                  |
| **W4-F** | `block_batch`+dryRun；细粒度 block_*；表驱动；execution_unknown；plan Deny          | **A-AGT-05/06/07**；§2 ❌ 行闭合              |
| 跨 01/02 | hydrate + intent 落盘（**W1-H** 等）                                                | 一切「重启仍权威」                            |

工具补齐 **不**依赖聊天气泡 UI（07）；hydrate 未完成前 **禁止**宣称 EL-05 关闭。

---

## 14. 实现波强制文档集

```
1. plans/00-总方案.md
2. plans/06-扩展与Agent工具面.md（本文）
3. 15 EL-05/07；08 关闭闸
4. specs/query-blocks-tool-schema.md
5. specs/register-flavour-roadmap.md
6. 20 §1 + A-AGT/A-EXT 自检表（Memory 禁令）
```

---

## 15. 参考指针

| 文档                                        | 用途                       |
| ------------------------------------------- | -------------------------- |
| `analysis/.../D6D7-工具与双引擎.md`         | 库存与对照源               |
| `plans/07`                                  | send_to_note / EL-08       |
| `plans/01` / `02`                           | apply / hydrate / 幂等落盘 |
| `round-D-stack/06-扩展宿主与Agent工具面.md` | 选型背景                   |

---

_再生加厚 · 只改方案文档 · 对齐 D6D7 · 禁业务代码 · 禁 commit_
