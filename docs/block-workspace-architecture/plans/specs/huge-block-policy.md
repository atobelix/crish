# M2 · 超长单块策略（Huge Block Policy）

| 元数据             | 值                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| **状态**           | **已钉死**（实现波可执行）                                                                           |
| **权威来源**       | `18-实现波前待决锁定-H1H2H3M1.md` §M2；D5 §3.4 V6                                                    |
| **主责 Wave**      | **W1-B**（数据层阈值/分段/冷热）+ **W3-D**（叶编辑虚拟行窗口）                                       |
| **依赖**           | H1 热集/冷藏；H2 A-INV-09 跨引擎同批；D5 块窗口 + pin                                                |
| **文件域（实现）** | W1-B：`crates/conex-doc-collab/**`；W3-D：`packages/block-paper/leaves/**` + `editor-kit` 行窗口接口 |
| **禁止**           | 无窗口编辑数 MB 单 text node；超长写入半树成功；对冷 YText 静默丢 update                             |

---

## 0. 结论先行（一句话）

> **默认一叶一 YText**；字节超过 `T_HUGE`（默认 **256 KiB**）时数据层走 **分段叶子（`split_of`）或只读折叠**；呈现层无论数据是否分段，**编辑面必须 V6 虚拟行窗口**，禁止把整段 MB 级文本塞进单个无窗口 PM/CE text node。

| 层                    | 默认                                  | 超阈后                                                    |
| --------------------- | ------------------------------------- | --------------------------------------------------------- |
| **数据（W1-B）**      | 单 block ↔ 单 YText / 单 snapshot     | **主路径：分段叶子**；备路径：只读折叠 + 显式展开编辑     |
| **呈现（W3-D / D5）** | 块在文档窗口内 pin 后整段小文本可直挂 | **块内行窗口（V6）**；始终禁止无窗口 MB 单 node           |
| **Agent 写入**        | 单 `text_edit` / 小批 Op              | 超阈 **分批 apply** 或 **单事务多 Op 原子**；失败整批回滚 |

---

## 1. 阈值与配置

### 1.1 `T_HUGE`

| 项           | 锁定                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| **语义**     | 单叶子文本权威长度阈值（**UTF-8 字节数**，与 `text_snapshot` / YText 编码长度一致）                     |
| **默认值**   | `256 * 1024` = **262 144 字节（256 KiB）**                                                              |
| **可配置**   | 是。会话 / 工作区设置：`huge_block.threshold_bytes`；运行时可读；变更**不**回溯已分段树，仅影响后续判定 |
| **计量点**   | `len(utf8_bytes(block_text))`；**不含** props JSON、不含子树                                            |
| **下限钳制** | 配置若 `< 64 KiB` → 实现钳到 `64 KiB` 并记 warning（防误配把正常段落当超长）                            |
| **上限钳制** | 配置若 `> 16 MiB` → 钳到 `16 MiB`（防关闭策略）                                                         |

### 1.2 辅助阈值（实现默认，可同配置表）

| 符号                  | 默认     | 用途                                                             |
| --------------------- | -------- | ---------------------------------------------------------------- |
| `T_HUGE`              | 256 KiB  | 进入超长策略的硬阈                                               |
| `T_SEGMENT`           | 128 KiB  | 分段时目标段大小（每段 ≤ 此值；最后一段可更小）                  |
| `T_RO_FOLD`           | `T_HUGE` | 只读折叠触发（与 `T_HUGE` 对齐；产品可设更高）                   |
| `T_EDIT_WINDOW_LINES` | 200      | 块内虚拟行窗口：可见 + overscan 行数上界（呈现）                 |
| `T_PM_NODE_SOFT`      | 64 KiB   | **软阈**：超过则 W3-D **必须**启用 V6 行窗口，即使数据层尚未分段 |
| `T_AGENT_CHUNK`       | 64 KiB   | Agent 单次 text 写入建议切片；超过走分批协议                     |

**不变量**：`T_PM_NODE_SOFT ≤ T_HUGE`；`T_SEGMENT ≤ T_HUGE`；`T_AGENT_CHUNK ≤ T_HUGE`。

### 1.3 适用 flavour

| 适用           | 说明                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| **文本叶**     | `paragraph`、`heading`、`quote`、`code`、`list_item` 正文等持 YText 的叶 |
| **不适用本阈** | 纯结构容器（无文本）、附件/blob 引用块（走 blob 存储，不进 YText）       |
| **代码块**     | 同样计字节；编辑面优先 CM6 行窗口（W3-E），策略与本文件 V6 同构          |

---

## 2. 默认路径：单块单 YText

在 `len < T_HUGE` 时：

1. **结构**：一个 `BlockId` ↔ 一个文本槽（热：YText；冷：`text_snapshot: Arc<str>`）。
2. **无** `split_of` 链；无强制子段。
3. **呈现**：若 `len < T_PM_NODE_SOFT`，允许单 text node 直挂；若 `T_PM_NODE_SOFT ≤ len < T_HUGE`，**仍启用 V6 行窗口**（数据层可仍为单 YText）。
4. **热集（H1）**：与普通块同一 LRU/窗口/pin 规则；超长块因体积大，**再热成本更高**（见 §5），但不改变「一叶一槽」默认。

```
[用户/Agent 文本]
       │
       ▼
 len < T_HUGE ──yes──► 单 YText / 单 snapshot
       │
       no
       ▼
  §3 超阈策略
```

---

## 3. 超过 `T_HUGE`：分段叶子 **或** 只读折叠

两种策略 **产品可并存**；**主路径为分段叶子**，只读折叠为 **导入/一次性粘贴/内存告警** 逃生门。

### 3.1 主路径 · 分段叶子（`split_of`）

#### 3.1.1 语义

| 概念                       | 定义                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| **逻辑超长块**             | 用户感知的一颗「大段」；对外查询/大纲可仍显示为一个逻辑单元（可选聚合 ID）                       |
| **段叶子（segment leaf）** | 真实树节点；每段 `len ≤ T_SEGMENT`；**各自**持有 YText 或 snapshot                               |
| **`split_of`**             | 段叶子 props：`split_of: BlockId` 指向 **逻辑锚点块**（anchor）；anchor 可为第一段自身或独立容器 |
| **顺序**                   | 同父下按 `fractional_index`（或等价 order）排列；拼接顺序 = 树序                                 |

**推荐结构（钉死实现默认）**：

```text
parent
└── anchor (flavour 保持原 leaf 或 `huge_split_group`)
    ├── seg-0  props.split_of = anchor.id   text ≤ T_SEGMENT
    ├── seg-1  props.split_of = anchor.id
    └── seg-k  …
```

- **最小实现**：无独立 group 容器时，**第一段即 anchor**（`split_of` 自指或省略），后续段 `split_of = first.id`，兄弟序紧邻。
- **禁止**：多段共享同一 YText 句柄（违背 M1 粘贴纪律与 H1 冷热）。
- **MD 往返**：分段后序列化为连续段落/同一 fence 的策略见 W2；本规格要求 **导出可无损拼接正文**，ID 按段各自 `<!--c:…-->` 或组策略由 MD 契约扩展（W2 读本文件时不得丢字）。

#### 3.1.2 触发时机

| 时机                                                 | 行为                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **本地键入/粘贴** 使 `len` 跨过 `T_HUGE`             | 当前事务 **提交后** 异步或同事务尾部执行 `maybe_split_huge(blockId)`；**不得**在 IME composing 中拆段（对齐 D5 IME：合成期禁结构） |
| **Agent / remote apply** 写入后 `len ≥ T_HUGE`       | apply **成功且同批** 后进入 split；若采用「写入即分段」，必须在 **同一 `Transaction`** 内完成 insert 段 + 文本安置（A-INV-09a）    |
| **打开/hydrate** 发现 snapshot ≥ `T_HUGE` 且仍是单叶 | 惰性：只读可暂不拆；**首次进入编辑** 或 **后台 normalize** 时拆（产品默认：**首次 edit 前 split**）                                |
| **导入**                                             | 优先导入期 split，避免热路径尖刺                                                                                                   |

#### 3.1.3 拆分算法（可测）

```text
fn split_huge(block_id, text):
  assert utf8_len(text) >= T_HUGE
  segments = partition_utf8(text, max_bytes = T_SEGMENT)
    // 优先在 \n 边界切开；无换行则按 grapheme 边界切，禁止切开 surrogate / 组合字符中间
  tx:
    keep or create anchor
    for i, seg in segments:
      if i == 0 and reuse_original:
        set_text(block_id, seg); set props.split_role = segment
      else:
        insert_block(parent, after prev, flavour=same, split_of=anchor, text=seg)
    commit  // 全成或全败
```

| 规则       | 锁定                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| **边界**   | 禁止 UTF-8/UTF-16/grapheme 中截断；测试用含 emoji / 中文 / `\r\n`                            |
| **原子性** | split 与文本安置 **同 Transaction**；失败 **零段插入、原文块保持 apply 前状态**（A-HUGE-02） |
| **选区**   | 拆后逻辑 offset 映射到 `(segmentBlockId, localOffset)`；SelectionStore 更新（W3-B 接口）     |
| **undo**   | 整次 split 为 **一步** 结构+文本可撤销（origin=system 或 user，产品钉一种并文档化）          |

#### 3.1.4 合并（反向）

| 条件                                              | 行为                                                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| 用户删除使相邻段合计 `< T_HUGE * 0.5`（滞后阈值） | **可**合并为单叶，清除 `split_of` 链                 |
| 默认                                              | **不**积极合并（避免抖动）；显式「合并段落」命令可调 |

### 3.2 备路径 · 只读折叠（Read-only fold）

#### 3.2.1 触发条件（满足任一且 **未** 完成分段时）

1. `len ≥ T_RO_FOLD` 且当前模式为 **导入预览 / 搜索命中预览 / 内存压力降级**。
2. 配置 `huge_block.prefer_readonly_fold = true`（调试或低内存设备）。
3. 分段失败（极端：磁盘/配额）→ **降级为只读折叠**，并 surface 错误，**禁止**半段树残留。

#### 3.2.2 呈现与数据

| 面       | 行为                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| **数据** | 仍可保持 **单叶** YText 或冷 `text_snapshot`；**不**假装已 split                  |
| **呈现** | 块外壳 + **折叠摘要**（前 N 字/行 +「共 B 字节 / L 行」）；**非** contenteditable |
| **搜索** | 走 snapshot / FTS；高亮跳转先 `scrollIntoView` 再展开                             |

#### 3.2.3 恢复编辑路径（必须可测）

```text
用户点击「展开编辑」或 API ensure_editable(blockId)
  → 1) 若 len ≥ T_HUGE：先 split_huge（主路径）再聚焦首段
  → 2) 若 len < T_HUGE：rehydrate YText（若冷）+ 挂 V6 行窗口（若 ≥ T_PM_NODE_SOFT）
  → 3) pin(blockId)；映射 caret 到逻辑 offset
```

| 禁止                                 | 说明                |
| ------------------------------------ | ------------------- |
| 只读折叠块上直接 PM 全量挂载 MB 文本 | 违 A-HUGE-03        |
| 展开失败仍标记为可编辑               | 保持只读 + 错误提示 |

---

## 4. PM / 叶编辑：禁止无窗口编辑数 MB 单 node（V6）

对齐 D5 §3.4 **V6：块窗口 + 块内行窗口**。

### 4.1 硬禁止

| ID        | 禁止                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| **HB-P1** | 将 `len ≥ T_PM_NODE_SOFT` 的全文作为 **单个** ProseMirror/CE text node 无窗口挂载 |
| **HB-P2** | 为「省事」在超长叶上 `fullRemount` 整叶 DOM 作为默认输入恢复                      |
| **HB-P3** | 文档级虚拟化 unmount 焦点超长块（仍受 D5 pin：焦点/composing **钉住**）           |

### 4.2 虚拟行窗口契约（W3-D 必须实现）

```text
interface HugeLeafEditorHost {
  /** 数据侧：按行或按 offset 窗口取切片 */
  getLineWindow(blockId: BlockId, lineStart: number, lineEnd: number): TextSlice;
  /** 或 offset 窗口（与逻辑选区一致） */
  getOffsetWindow(blockId: BlockId, start: number, end: number): TextSlice;

  /** 编辑 Intent：只携带触及区间，禁止每次提交整段 MB */
  applyTextIntent(intent: TextEditIntent): void;  // → RS Op

  /** 高度：块内 HeightMap.totalHeight 上报块级 HeightMap */
  reportInnerHeight(blockId: BlockId, totalPx: number): void;

  pinInner(blockId: BlockId, reason: "focus" | "composing" | "selection"): void;
}
```

| 规则           | 锁定                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| **窗口大小**   | 可见行 + overscan；挂载行 DOM 节点数 ≤ `T_EDIT_WINDOW_LINES`（默认 200，可配）           |
| **逻辑坐标**   | 仍为 `blockId + offset`（分段后为 **段** blockId + 段内 offset）；跨段选区 = 多 LogicPos |
| **IME**        | composing ⇒ pin 块 **且** pin 内行窗口；合成期禁止 split / 合并段 / 卸载内窗口焦点行     |
| **代码叶**     | CM6 自身视口；仍须 `reportInnerHeight` 与 Intent 切片纪律                                |
| **与 D5 接口** | `MountSpec.text` 对超长块可下发 **handle + 版本 + 窗口切片**，禁止首屏塞全文             |

### 4.3 分段后的编辑映射

| 用户动作                | 映射                                         |
| ----------------------- | -------------------------------------------- |
| 在逻辑大段中间键入      | 命中段叶 `seg-i`；`text_edit` 仅对该段 YText |
| 在段边界 Backspace 合并 | 结构 Op（删边界/并段）+ 文本；同事务         |
| 全选逻辑大段            | 多段 `LogicRange` 或块多选；复制时拼接文本   |

---

## 5. 与 H1 冷藏关系

### 5.1 超长冷块快照

| 项                | 锁定                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **冷形态**        | 与普通叶相同：卸载 YText，保留 `text_snapshot: Arc<str>`（分段则 **每段** 各自 snapshot）                                                                                                         |
| **内存**          | 冷超长块的 snapshot **仍占堆**（字符串）；EL-03 上界靠 **热 YText 数量**，不靠「冷块字节为 0」。超大文档依赖 **按块懒加载**（D4）使冷 snapshot 也可不在进程内——若未加载，投影只持 meta + 长度提示 |
| **搜索/只读投影** | 优先 snapshot 或存储侧 FTS；**不**为搜索强制 rehydrate 全部超长叶为 YText                                                                                                                         |
| **A-MEM-02 延伸** | 冷超长块 text 可读；不依赖热 YText                                                                                                                                                                |

### 5.2 再热（rehydrate）成本

| 场景                 | 成本与纪律                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 焦点进入超长段       | rehydrate **该段** YText（O(段长)），非整逻辑大段一次性除非未 split                                                      |
| 未 split 的单叶超长  | rehydrate 整叶 O(`len`)；**应**在编辑前触发 split，使后续再热 O(`T_SEGMENT`)                                             |
| 远端 update → 冷超长 | **先** rehydrate 或 apply-to-snapshot 再编码（H1）；**禁止**丢 update（A-MEM-03）                                        |
| undo 跨冷超长        | 先 rehydrate 再结构/文本 undo；细粒度击键史可丢（A-MEM-04）                                                              |
| 热集驱逐             | 超长热块优先按 **字节权重** 计入 LRU 成本（实现建议：cost ∝ max(1, len/T_SEGMENT)），避免少量超长叶占满 512 热槽后仍 OOM |

### 5.3 与 A-MEM-01

- 活动 YText **实例数** 仍 ≤ 窗口+pin+LRU 上界（默认 512）。
- 分段后「逻辑一页」可能占 **多** 个 YText；窗口策略应只热 **可见段 + pin 段**，而非一次热全部 `split_of` 兄弟。

---

## 6. Agent 写入超长

### 6.1 原则

| 原则           | 说明                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **原子可见性** | 任意中间失败 → **文档树与文本与 apply 前一致**；禁止「前 N 段在、后段无」半树（A-HUGE-02 / A-INV-09a）                                                |
| **优先分批**   | 载荷 `> T_AGENT_CHUNK` 时，工具层或 `DocSession` **切片**为多 Op，但用 **同一 `tx_id` / 同一 Transaction** 提交；或显式 multi-tx 时每 tx 自洽且可续传 |
| **单 Op 上限** | 允许单 Op 携带大文本，但实现必须在 apply 内完成 split 安置且不阻塞 UI 线程过久；推荐仍切片                                                            |

### 6.2 推荐协议

```text
Agent tool: replace_block_text / apply_ops
  if payload_bytes <= T_AGENT_CHUNK:
    single Transaction { text_edit | set_text; maybe_split_huge }
  else:
    Transaction {
      // 方案 A（钉死默认）：一次 tx 内
      clear_or_set anchor;
      for chunk in partition(payload, T_SEGMENT):
        ensure_segment_i; set_text(seg_i, chunk)
      // 任一步 schema/authz 失败 → 整 tx 回滚
    }
    // 方案 B（流式大导入）：
    //   tx1..txn 每批自洽追加段；维护 import_job_id；
    //   失败 → 标记 job failed + 回滚未提交批；已提交批可显式 compensating delete（须审计）
    // 默认产品路径用方案 A；仅超大导入 job 启用 B 且 UI 显示进度
```

| 规则       | 锁定                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| **默认**   | **方案 A：单 Transaction 多 Op 原子**                                                  |
| **方案 B** | 仅导入/迁移 API；必须 `job_id` + 可查询状态 + 失败补偿；**交互式 Agent 编辑** 不用 B   |
| **origin** | `agent`；undo 可整批滤掉                                                               |
| **半树**   | 任何公开 API 成功返回 ⇒ 不存在残缺 `split_of` 链（段数与 props 一致、无空悬 split_of） |

### 6.3 与投影

- 批 Op 提交后 **一次** ProjectionDiff 收敛（D5 P-Agent-Batch）。
- 超长写入中 UI 可不挂全文；只更新长度/摘要，编辑面按需窗口拉取。

---

## 7. 验收断言草案（A-HUGE）

> 实现测试必须引用 ID 字符串。结构断言 Wave 1–3 可硬；数值阈值随 H3 标定。

| ID            | 断言                                                                                                                                         | 主责        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **A-HUGE-01** | 单叶 `utf8_len < T_HUGE` 时保持 **单 YText/单 snapshot**，无强制 `split_of` 子段                                                             | W1-B        |
| **A-HUGE-02** | 写入或 split 使树变化时：**同 Transaction 全成或全败**；失败后无半段、无孤儿 split_of、文本与 apply 前一致（对齐 A-INV-09a）                 | W1-B        |
| **A-HUGE-03** | 对 `len ≥ T_PM_NODE_SOFT` 的可编辑叶：**编辑面挂载行/切片 DOM 节点数 ≤ T_EDIT_WINDOW_LINES**；禁止无窗口整段 MB text node（可用探针/计数器） | W3-D        |
| **A-HUGE-04** | 冷超长叶（或段）：可读 snapshot；远端/Agent update **不丢**；再热后文本与双端一致（对齐 A-MEM-02/03 超长场景）                               | W1-B        |
| **A-HUGE-05** | Agent 写入 `> T_HUGE` 文本后：存在合法分段（每段 ≤ `T_SEGMENT`）或只读折叠态二者之一；拼接全文 = 写入载荷；无半树                            | W1-B / W4   |
| **A-HUGE-06** | 只读折叠 →「展开编辑」：若超阈则先 split 再进 V6；过程中 IME/焦点可建立；`fullRemountCount` 默认路径不因展开而整页重建                       | W3-D        |
| **A-HUGE-07** | 分段边界：含 emoji/CJK/组合字符的文本 split **不**破坏 grapheme；往返拼接 equals 原文                                                        | W1-B        |
| **A-HUGE-08** | 超长焦点段 pin：滚动文档级窗口时焦点段不卸载；块内行窗口 pin composing 行；合成 end 后文本与 offset 正确（接 A-IME-03 超长场景）             | W3-D / W3-B |

**最低关闭集（M2 规格落地验收）**：**A-HUGE-01…04** 有测试挂钩或红测骨架；05–08 可随 W3/W4 变绿。

---

## 8. 实现落点分工表（W1-B vs W3-D）

| 职责                                                        | **W1-B 数据层**                                            | **W3-D 呈现层**          |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `T_HUGE` / `T_SEGMENT` 配置读取                             | ✅ 权威                                                    | 只读展示/调试            |
| 单 YText 默认；`set_text` / `text_edit`                     | ✅                                                         | Intent → IPC/Op 调用     |
| `maybe_split_huge` / `split_of` 树 Op                       | ✅                                                         | 禁止前端私自拆树         |
| 只读折叠 **数据标志**（如 `props.edit_mode=readonly_fold`） | ✅ 可选 props                                              | ✅ 折叠 UI + 展开 CTA    |
| 冷 `text_snapshot` / rehydrate                              | ✅ H1                                                      | 触发 ensure_hot 请求     |
| 热集 LRU **字节权重**                                       | ✅ 建议                                                    | —                        |
| Agent 大写入原子 Transaction                                | ✅                                                         | —                        |
| `T_PM_NODE_SOFT` 检测与 V6 启用                             | 可提供 `text_len` 元数据                                   | ✅ **强制**              |
| 块内行窗口 / CM6 视口                                       | —                                                          | ✅                       |
| `HugeLeafEditorHost` / 切片 Intent                          | 提供按 offset 读 API                                       | ✅ 实现宿主              |
| 段高上报 BlockHeightMap                                     | 可选 heightHints                                           | ✅ `reportInnerHeight`   |
| pin 块 + pin 内行                                           | 事件可含 pin 提示                                          | ✅ 接 D5 WindowManager   |
| IME 与 split 互斥                                           | apply 拒绝 composing 中的 split（若可感知）或由 TS 推迟 Op | ✅ 合成期不发结构 Intent |
| A-HUGE-01/02/04/05/07                                       | ✅ 单测                                                    | —                        |
| A-HUGE-03/06/08                                             | 配合 mock 长度                                             | ✅ 单测/e2e              |
| MD 分段序列化                                               | W2 读本规格                                                | —                        |

### 8.1 接口约定摘要（供 W0/W1/W3 引用）

```text
// 数据 → 投影元数据（可进 BlockProjection.props / text meta）
HugeMeta {
  byte_len: u64,
  line_count_est?: u32,
  split_of?: BlockId,
  segment_index?: u32,
  edit_mode: "normal" | "readonly_fold" | "segment",
}

// 呈现 → 数据
Op::TextEdit { block_id, start, end, insert }  // 区间局部
Op::SetText  { block_id, text }                 // 整叶替换；超阈则 tx 内 split
Op::SplitHuge { block_id }                      // 显式；通常 system 在 apply 后触发
```

### 8.2 非目标（本规格不锁）

- 跨文档 blob 级大文件（走附件存储）。
- 协同传输压缩算法选型（协同产品化波）。
- 将主文本引擎从 yrs 切 Loro（仍受 H1 逃生门 / A-SWAP 约束）。

---

## 9. 魔鬼用例（实现/评审）

1. 粘贴 1 MiB 纯文本到空段落 → 单 tx 后段齐、可滚、可在中段键入。
2. IME 合成中缓冲将超 `T_HUGE` → end 后才 split；合成中不拆。
3. Agent 写入 2 MiB 中途 schema 失败 → 零残留段。
4. 冷 512 KiB 段 + 远端 patch → 不丢；再热一致。
5. 未分段 300 KiB 叶点编辑 → 先 split 或 V6，**无**单 node 全量挂载。
6. 10 万块文档中仅 3 个超长段 → 热 YText 数仍守 A-MEM-01；超长段按权重计 LRU。
7. 只读折叠 → 展开 → 中文 IME → 滚动文档 → end 不丢字。
8. emoji 家族符落在 `T_SEGMENT` 边界 → 不切开；拼接 equals。

---

## 10. 证据与交叉引用

| 主题          | 路径                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| M2 处置原文   | `docs/block-workspace-architecture/18-实现波前待决锁定-H1H2H3M1.md` §M2 |
| H1 冷热       | 同文件 §H1；A-MEM-01…04                                                 |
| H2 同批       | A-INV-09a/b/c                                                           |
| V6 块内行窗口 | `round-D-stack/05-投影虚拟化与IME.md` §3.4、§11.1                       |
| 任务书        | `plans/01-文档心与合并.md`、`plans/04-投影虚拟化与IME.md`               |
| 包索引        | `plans/09-执行任务包索引.md` W1-B / W3-D                                |
| 调度          | `19-实现波调度状态.md` M2 行                                            |
| 断言索引      | `plans/acceptance/A-assert-index.md` A-HUGE 族                          |

---

**文档结束（M2 · huge-block-policy）**
