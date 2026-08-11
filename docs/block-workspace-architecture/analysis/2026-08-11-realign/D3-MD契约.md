# D3 · MD 契约对齐分析

| 元数据       | 值                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **日期**     | 2026-08-11                                                                                                                                                     |
| **角色**     | 方案分析子 Agent（只读 + 文档；禁改业务代码 / 禁 commit）                                                                                                      |
| **范围**     | EL-06 / `plans/03` / D3 详设 / A-MD / `crates/conex-md-ast/**`                                                                                                 |
| **输入**     | `20` 章程、`15`、`plans/00`、`plans/03`、`specs/conex-md-id-and-nesting.md`、`plans/08`、`audit/00`+`audit/02` MD 段、`round-D-stack/03`+`07` §5.7、crate 源码 |
| **产出动作** | 保留 / 改造 / 方案回写建议；**非**实现 TODO 冒充方案                                                                                                           |

---

## 0. 结论先行

| 判定             | 说明                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **效果锁 EL-06** | **未关闭**。子集结构往返 + ID 注释 + apply 零半树 **真交付**；A-MD-01 全表 / RT-1…7 全集 / markdown-rs 基座 **未兑现**                                |
| **方向**         | **未歪**。双轨（IR 权威 + Conex-MD 契约）、`<!--c:ID-->` 独占行、IR re-export、禁止 HTML 反推、get_md=即时 S、聊天 pulldown 分面——与 `15`/D7 **同向** |
| **相对计划做满** | **约 55–65%（W2-A/B 库内）**。手写行解析 **静默漂移** 出栈锁；无 `normalize` API、无 mode=conex/pure-gfm 正式面、无 GFM 表/任务/删除线/wiki 真节点    |
| **处置**         | **不推倒**。保留 ID/P/S 对外契约与 apply 形状；**方案再生必须钉死「markdown-rs 接线包」或书面改锁**；扩写 `03` 从索引级到可执行验收映射               |
| **伪完成风险**   | 中高：容易把「结构-only golden 绿」口播成「A-MD / W2-A 完成」——审计已标黄，本分析再钉红线                                                             |

---

## 1. 效果锁（不可降级）

权威：`15` §2 EL-06；D3 §1；D7 §5.7 A-MD；`plans/03`。

| ID         | 效果 / 断言                               | 本维闭合条件                        | 现状                                                |
| ---------- | ----------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| **EL-06**  | MD 契约：往返可测 + ID 守恒；权威仍是块树 | A-MD 全表 + RT-1…7 可映射到测       | **未关**                                            |
| E-D3-01    | 文件即 MD 可读（mirror/导出为 Conex-MD）  | 属 02 mirror；契约侧须 `S(树)` 合法 | 契约侧有 S；mirror 完整态非本 crate                 |
| E-D3-02    | GFM 子集无损往返                          | A-MD-01 golden 全 GFM 核心          | **子集**（段/标题/列表/引用/码/分割线）             |
| E-D3-03    | 块 ID 稳定可引用                          | A-MD-02；`<!--c:ID-->`              | **库内绿**                                          |
| E-D3-04    | 扩展诚实有损                              | A-MD-03/05 lossy                    | **骨架**（strip ID + 表 note）；wiki/callout/数学无 |
| E-D3-05    | Agent 可读写 MD                           | apply_md→Op→apply；get_md=S         | **库内绿**；产品热路径另波                          |
| E-D3-06    | 与聊天预览 GFM 核心不打脸                 | 分面 Options；禁 HTML 反推          | 分面意图正确；无对照测                              |
| I-D3-01    | 权威树在 RS                               | re-export collab IR                 | **绿**                                              |
| I-D3-02    | MD 一等契约（非偶然 toMarkdown）          | 统一 dialect + N                    | dialect 半写；**无 N**                              |
| I-D3-03    | 热路径 ≠ 每键 S∘P                         | A-MD-06；apply 只产 Op              | **设计绿**                                          |
| I-D3-04    | `N(S(P(md)))` 幂等                        | 显式 N                              | **缺 API**；仅 S∘P 稳定子集                         |
| I-D3-06    | 块 ID 进 MD 是规格一部分                  | W0-B 钉死                           | **绿**                                              |
| A-MD-01…08 | 见 §2.3                                   | 缺测=未交付                         | 见差距表                                            |

**效果锁语句（分析锁，不得在方案再生时静默缩水）**：

> Agent/磁盘/剪贴板看到的 Conex-MD 与 `P/S` 可测往返；机器 ID 为 `<!--c:UUID-->` 独占行；GFM 核心按规格无损；pure-gfm 有损可报告；写路径经 RS apply 且失败零半树；**禁止** `conex-markdown` HTML 反推块树、TS remark 写权威、Lute 嵌入、旁路 ID map 主存、每键整篇 S∘P。

---

## 2. 文档要求（契约靶）

### 2.1 栈与编码锁

| 源                | 要求                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `15` §3           | MD = BlockIR + Conex-MD；基座 **`markdown-rs`**；ID=`<!--c:ID-->`                                          |
| D7 矩阵 D3 行     | 双轨；GFM 基座 markdown-rs；P/S/ID/有损自研；**否决** HTML 反推 / remark 写回 / Lute / 旁路 map / 每键 S∘P |
| D3 §9.1           | 首选 crate `markdown`（markdown-rs）；备选 comrak（仅 A-SWAP 触发）                                        |
| `15` E2 S2 / W0-B | 机器主编码 **`<!--c:ID-->` 独占行**；`{#id}` 仅别名；pure-gfm 剥 ID + lossy                                |
| `plans/03`        | 文件域 `conex-md-ast/**`；IR **re-export** doc-collab；聊天 pulldown **不升格**                            |
| S1 落盘           | 权威 RS+SQLite；契约视图 Conex-MD；**get_md = 即时 S(树)**，禁默认读 exports                               |

### 2.2 往返不变量 RT-1…7（D3 §2.1）

| #    | 不变量               | 形式                                           |
| ---- | -------------------- | ---------------------------------------------- |
| RT-1 | 结构幂等             | `P(S(t)) ≡ t`（BlockTree 等价，忽略纯 UI）     |
| RT-2 | 文本幂等（规范化后） | `N(S(P(md))) = N(md)` 对 GFM 核心 + Conex 子集 |
| RT-3 | 双次稳定             | `S(P(S(P(md)))) = S(P(md))`                    |
| RT-4 | 块 ID 守恒           | conex 模式 P→S→P ID 集与父子序守恒             |
| RT-5 | 引用守恒             | wiki/块引可解析或 pure-gfm 显式 lossy          |
| RT-6 | 模式分离             | conex vs pure-gfm 有损差集可列举               |
| RT-7 | merge 后可契约       | merge 结果可 S 且 `P(S(t')) ≡ t'`              |

### 2.3 验收 ID（D7 §5.7 / `08` EL-06）

| ID      | 断言                                             |
| ------- | ------------------------------------------------ |
| A-MD-01 | GFM 核心 P→S→P 结构幂等（RT-1…3）golden          |
| A-MD-02 | 往返 block_id 守恒（conex；RT-4）                |
| A-MD-03 | 引用/wiki 可解析或 pure-gfm 显式 lossy（RT-5/6） |
| A-MD-04 | merge 后必可 S 且 P∘S ≡（RT-7）                  |
| A-MD-05 | pure-gfm 剥 ID 时 tool/export 声明 lossy         |
| A-MD-06 | 热路径权威是块树，非整文件 MD 被行级独占         |
| A-MD-07 | 危险 HTML 与 ID 注释白名单分测                   |
| A-MD-08 | **禁止**用 HTML 快照冒充 MD roundtrip            |

跨层：`08` X-01 = apply_md_fragment → apply → flush → Diff → 焦点 pin（md-ast 只负责链首两环库内形态）。

### 2.4 必须自研 vs 可调包（D3 §6）

- **调包**：markdown-rs / comrak → CM/GFM AST 基座 **仅 P 的标准子集**
- **自研**：BlockIR（归属 01）、lowering/raising、ID 编解码、N、mode、lossy、apply_md 接线、golden
- **禁止**：`conex-markdown` HTML→树；remark 运行时权威；Lute；旁路 map 主存

### 2.5 `plans/03` 目标模块清单

1. BlockIR re-export
2. parse / serialize / **normalize**
3. 块 ID 编解码（主 `<!--c:ID-->`）
4. 有损报告结构
5. apply_md_fragment → Op
6. Golden（GFM 核心 + conex 方言）
7. pure-gfm 剥离模式

### 2.6 文档薄点（再生时必须加厚）

`03` 正文约 40 行索引级（E-review P12）：**未**内联 RT 全表、A-MD 映射、有损点表、mode API、markdown-rs lowering 边界。实现 Agent 若只读 `03` 会默认「手写结构-only 即完成」——这是本波偏离的文档根因之一。

---

## 3. 库存（代码事实）

### 3.1 Crate 布局

| 路径                                               | 职责                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `C:\Software\conex\crates\conex-md-ast\Cargo.toml` | 依赖 **仅** `conex-doc-collab` + serde + thiserror；**无** `markdown` / comrak |
| `src/lib.rs`                                       | re-export IR；`LossyReport`；ID encode/decode/strip；`structure_eq`            |
| `src/parse.rs`                                     | **手写行解析** → BlockTree（自承「W2 后续可换 markdown-rs」）                  |
| `src/serialize.rs`                                 | DFS `<!--c:-->` + kind 格式化；`document_to_md` ≡ `serialize_tree`             |
| `src/apply.rs`                                     | MD 片段 → `Vec<Op>`；不 mutate target                                          |
| `tests/golden/*`                                   | 6 个 md 样本                                                                   |
| 集成测                                             | `golden_structure` / `golden_lists_quote` / `roundtrip_text` / `lossy_report`  |

下游消费（只读旁证，非本维文件域改造）：

- `conex-workspace-store`：mirror export 用 `serialize_tree`
- `conex-note-runtime`：`apply_md_fragment` + `document_to_md` 作 get_md

### 3.2 `<!--c:ID-->`（对齐 W0-B / 15）

| 项              | 库存                                                              | 证据                               |
| --------------- | ----------------------------------------------------------------- | ---------------------------------- |
| 编码            | `BlockId::to_html_comment` → `<!--c:{uuid}-->`                    | `conex-doc-collab/src/block_id.rs` |
| 解码            | `block_id_from_comment`：严格 `<!--c:` + UUID + `-->`             | 同上；普通 HTML 注释不匹配         |
| 序列化落位      | **块起始独占行** + 内容 + DFS 子块                                | `serialize.rs` `serialize_node`    |
| 解析落位        | 先读 ID 行再 `take_block_content`                                 | `parse.rs`                         |
| pure-gfm 剥离   | `strip_conex_id_comments_detailed` → `stripped_block_ids` + count | `lib.rs`                           |
| 重复 ID         | 后者重分配 + `duplicate_block_id` lossy                           | `parse.rs`                         |
| 缺 ID           | 生成新 ID + `missing_block_id`                                    | `parse.rs`                         |
| `{#short}` 别名 | **未实现**                                                        | 规格允许「可选」；机器主路径不依赖 |

**判定：机器主编码库存与锁一致，可保留。**

### 3.3 P / S（结构-only）

**已支持 kind（结构层）**：

- `Paragraph`、`Heading{1..6}`、`BulletItem`、`OrderedItem`、`Quote`、`Code`（围栏轻量）、`Divider`
- 嵌套：容器栈（Heading 秩=level；列表/引用秩=10）；与 S 的 DFS **对齐**，支撑子集 `P(S(t))`

**明确不做 / 未做**：

- 无 GFM **Table** 节点（`|` 当段落 + `structure_note`）
- 无 task list、删除线、链接/强调 **inline AST**（文本 plain `text_snapshot`）
- 无 setext 标题 / 缩进代码块规范化策略的完整钉死
- 无 wiki / callout / 数学 / 脚注 / front matter
- **无 `normalize` 函数**（`plans/03` 目标 2 未落地）
- **无 `ParseOpts` / `SerializeOpts` / mode 枚举**（conex vs pure-gfm 仅有 strip 辅助，非 S 模式）

### 3.4 markdown-rs vs 手写

| 文档锁                               | 代码                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `15` / D7 / D3：**markdown-rs 基座** | `Cargo.toml` **零** markdown 依赖                                       |
| 手写仅可作过渡                       | `parse.rs` 头注释：「结构-only 手写…W2 后续可换」——**过渡被当成交付面** |

审计 `02` G4 已定性：**栈锁未兑现 / 中高**。本分析同意。

### 3.5 RT 范围（库存实测覆盖）

| RT   | 库存覆盖           | 说明                                                                  |
| ---- | ------------------ | --------------------------------------------------------------------- |
| RT-1 | **子集绿**         | `structure_eq` + golden / 单测嵌套往返                                |
| RT-2 | **弱**             | 无 N；`roundtrip_text` 测 plain 文本守恒，非「任意合法 GFM 源经 N」   |
| RT-3 | **子集绿**         | `roundtrip_text` 双次 S 稳定                                          |
| RT-4 | **子集绿**         | 带 `<!--c:-->` 的样本 ID 守恒；无「全 GFM 核心矩阵」                  |
| RT-5 | **红**             | 无 wiki/块引解析                                                      |
| RT-6 | **半**             | strip 有损码有；无 serialize(mode=pure-gfm) 正式面与差集表测          |
| RT-7 | **红（本 crate）** | merge 在 doc-collab；无「merge 后 S/P」联测挂在 md-ast 或共享 harness |

### 3.6 `apply_md_fragment` 零半树

| 不变量                                   | 库存           | 证据                                              |
| ---------------------------------------- | -------------- | ------------------------------------------------- |
| 只返回 `Vec<Op>`，**不 mutate** `target` | **绿**         | `apply.rs`；`does_not_mutate_target`              |
| 失败整批 `Err`，无部分 Op                | **绿**         | `IdConflict` / `UnknownParent`；冲突测            |
| 空片段 → 空 Op                           | **绿**         | `empty_md_zero_ops`                               |
| 合法 ID 复用；文档内冲突整批失败         | **绿**         | 与 D3 A-6「不写半棵树」同向（mutate 在 apply 侧） |
| 与 `DocSession::apply` 形状对齐          | **绿（联测）** | `integration_session_apply_matches_parse`         |
| 透出 lossy                               | **未**         | apply 路径丢弃 parse lossy；Agent 诊断缺口        |

**判定：零半树契约是扎实库存，方案再生必须保留，禁止改成「尽力插入半树」。**

### 3.7 禁止 HTML 反推

| 层      | 库存                                                                      |
| ------- | ------------------------------------------------------------------------- |
| 设计    | `lib.rs` 文档：禁止 HTML 反推块树；与 `conex-markdown` 分面               |
| 行为    | raw HTML 进 **Paragraph.text_snapshot**，不升格 `Unknown` 结构            | `parse.rs` `lossy_raw_html_kept_as_paragraph_not_tree`；`lossy_report::unknown_html_not_promoted_to_block_kind` |
| A-MD-08 | 精神测有；**非**完整「危险 HTML 白名单 + 安全分测」矩阵（A-MD-07 仍缺口） |
| 依赖边  | md-ast **不**依赖 conex-markdown                                          | Cargo 干净                                                                                                      |

### 3.8 有损报告

已有 code：`missing_block_id` / `duplicate_block_id` / `structure_note` / `stripped_block_ids`(+count)。  
D3 §3 大表（表合并、数学、脚注、callout…）**多数码未建模**。

### 3.9 审计已认账（同意并继承）

来自 `audit/00` §4 + `audit/02`：

- **保留**：Conex-MD ID 注释；apply_md 冲突整批失败；document_to_md=即时 S
- **G4**：markdown-rs 未接线
- **W2-A ~65%** 结构 golden 实、栈与 GFM 全表未
- **W2-B ~85%** 库内契约好
- A-MD-01…03 子集黄；A-MD-05 绿倾向；A-MD-04 热路径黄

---

## 4. 差距（文档靶 − 库存）

按效果完整度 → 正确性 → 可验证性排序（问题同权，无 P0 砍项）。

| #       | 差距                                | 锁来源                  | 效果影响                                             | 建议动作类                                                                         |
| ------- | ----------------------------------- | ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| G-D3-01 | **基座未接线 markdown-rs**          | `15`/D7/D3              | A-MD-01 无法宣称 GFM 核心；边角与 GitHub 行为无锚    | **改造代码 + 方案写清包边界**；若坚持手写 → **必须改锁并双评审**（Agent 不得默许） |
| G-D3-02 | **无 `normalize` / 规范化黄金律**   | RT-2/I-D3-04；D3 §8.4   | 无法钉 `expected.normalized.md`；git diff 策略漂     | 方案回写 03：N 规则表 + API                                                        |
| G-D3-03 | **mode=conex \| pure-gfm 未一等**   | RT-6；A-MD-05 工具声明  | strip 辅助 ≠ serialize 模式；Agent export 易漏 lossy | 回写 03 API 形状（对齐 D3 §7.3）                                                   |
| G-D3-04 | **GFM 核心节点不全**                | E-D3-02；A-MD-01        | 表/task/删除线/链接语义无真树                        | golden 目录按 D3 §8 扩；lowering 表                                                |
| G-D3-05 | **wiki/块引/RT-5**                  | A-MD-03；E-D3-03 引用面 | Agent 反链、query refs 上游无语义                    | 与 02 refs 物化联责；03 钉语法                                                     |
| G-D3-06 | **有损点表未产品化**                | E-D3-04；D3 §3          | 静默裂表风险（现仅 note 字符串）                     | Lossy code 枚举进规格                                                              |
| G-D3-07 | **inline 富文本 vs plain snapshot** | 01 yrs 叶；D3 叶子边界  | 结构 RT 真；「所见 MD 强调」非往返对象               | 03 写死：结构-only 阶段边界；全文 RT 依赖 TextEngine 投影策略                      |
| G-D3-08 | **RT-7 / A-MD-04 无本维 harness**   | RT-7；08 X-01           | merge 后契约靠口头                                   | 03 验收写「联测归属」：md-ast 提供 S/P；collab 提供 merge fixture                  |
| G-D3-09 | **A-MD-06/07/08 门禁测不全**        | D7 §5.7                 | 热路径/安全易被演示绕过                              | 架构 lint + 安全 golden；禁 HTML 快照 CI 规则写进 08                               |
| G-D3-10 | **`plans/03` 过薄**                 | 20 L1；E-review P12     | 实现只读短任务书 → 手写交付冒充闭锁                  | **方案再生主战场**                                                                 |
| G-D3-11 | **apply 丢 lossy**                  | A-3；Agent 可审计       | 工具 result 无法声明 warnings                        | apply API 扩展 `ApplyReport{ops,lossy}`（方案层）                                  |
| G-D3-12 | **列表模型简化**                    | GFM 列表紧密度          | 无 list container 块；项扁平 + 续行吞文本            | 规格钉「项即块」或引入 List 容器；与 W0-B 嵌套例对齐说明                           |

---

## 5. 伪完成（比没写更毒）

| 伪完成形态                                 | 为何毒                                         | 诚实口径                                       |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| 「W2-A / A-MD 完成」因 golden 6 篇绿       | 偷换 A-MD-01「GFM 核心」为「自研子集」         | **结构-only 子集往返已交付；A-MD-01 全表未关** |
| 「已锁定 markdown-rs」因文档有字           | Cargo 无依赖；运行时仍是手写                   | **栈锁文档有效、实现未接线 = 漂移**            |
| 「pure-gfm 模式完成」因 strip 有测         | 无 S(mode) / 扩展降级差集                      | **ID 剥离辅助已交付；模式面未交付**            |
| 「有损报告完成」因 LossyReport 类型在      | D3 §3 大类未枚举                               | **骨架 + 3～4 码；非有损体系**                 |
| 「零半树 = A-MD-04」                       | A-MD-04 含 merge 后 RT-7                       | **零半树 ⊆ 写安全；≠ merge 契约**              |
| 「禁止 HTML 反推已关闭 A-MD-08」           | 有精神测，无 CI 禁 HTML 快照冒充 RT 的全局门禁 | **方向正确；A-MD-08 产品门禁未立**             |
| 用 `conex-markdown` 渲染快照当笔记往返证据 | D3/H-03 明禁                                   | **任何 PR 若出现即伪完成红灯**                 |

**章程对齐（`20` L3/L4）**：Round 测绿 ≠ EL-06 关闭；挂 A-MD 测名而无 GFM/RT 语义 = 伪完成。

---

## 6. 方案再生建议（回写 `plans/03-MD契约.md`）

> 本节供下一阶段「方案生成」直接改 `03`（及必要时 `00`/`08`/`09` 补丁句）。**不**在本文件改业务代码。

### 6.1 文首加厚（必做）

在 `03` 文首「锁定」下追加 **详设指针**一行：

- 必读：`round-D-stack/03-MD-AST往返.md`（RT/有损/API）、`07` §5.7 A-MD 全文、`specs/conex-md-id-and-nesting.md`、`15` §3–4 MD 行
- 禁止：仅凭本索引开工宣称 A-MD 关闭

### 6.2 效果与不变量节（替换/扩写 §2）

写入 RT-1…7 表 + 等价关系 `≡` 摘要（从 D3 §2 提升进任务书，避免实现不读 D 波）。

钉死：

```text
P = parse_document[_detailed]
S = serialize_tree / document_to_md（即时；禁 mirror）
N = normalize（必须实现；规则表另节）
mode ∈ { conex, pure_gfm }
```

### 6.3 基座策略（关闭 G-D3-01 歧义）

**推荐回写（保持现锁，不降级）**：

| 项       | 正文建议                                                                                    |
| -------- | ------------------------------------------------------------------------------------------- |
| 依赖     | `markdown`（markdown-rs）为 **唯一** GFM P 基座                                             |
| 分层     | `mdast (库) → lowering → BlockIR`；S **自研** raising（不信任库 to_md 当契约）              |
| 手写解析 | 标为 **退役路径**：markdown-rs 接线后删除或 `#[cfg(test)]` 对照，禁止双 P 长期并存          |
| 备选     | comrak 仅 A-SWAP-01 触发；触发条件抄 D7                                                     |
| 聊天     | `pulldown-cmark` + `conex-markdown` **surface=chat**；依赖图/lint 禁止 note 保存调用 render |

**若主控改锁选手写全自研 GFM**（不推荐）：必须改 `15`/D7 并双评审；验收改为「自研 GFM 规格 + 与 cmark 对照 corpus」——**不得**无改锁维持现状。

### 6.4 ID 与嵌套（保持现钉，补别名）

- 机器主：保持 `<!--c:UUID-->` 独占行（已与实现一致）
- 回写：parse **忽略**非 `<!--c:` 形注释；`{#id}` 若做，**不**进 Agent 主键
- 嵌套：保持「ID 永远在块内容前」；明确 list **项**为块（与当前实现一致）或未来 List 容器迁移策略

### 6.5 API 形状（对齐 D3 §7.3，回写 §1）

```text
parse_md(md, ParseOpts{ mode, strict_ids }) -> Result<(BlockTree, LossyReport)>
serialize_md(tree, SerializeOpts{ mode, emit_ids }) -> Result<(String, LossyReport)>
normalize(md|tree 规则) -> …
apply_md_fragment(target, parent, md, opts) -> Result<ApplyReport { ops, lossy, new_ids }>
// document_to_md(tree) 保留为 Agent 读捷径 = serialize_md(conex, emit_ids=true)
```

钉：`apply_md_fragment` **继续**不 mutate；IdConflict 整批失败；**新增** lossy 透出。

### 6.6 Golden / 验收映射（回写 §3）

| 验收    | 测位置建议                                | 关闭条件                                 |
| ------- | ----------------------------------------- | ---------------------------------------- |
| A-MD-01 | `tests/golden/gfm-core/**` + RT-1…3       | 覆盖 D3 §8.2 GFM 核心类；非 6 篇结构样本 |
| A-MD-02 | id 矩阵 + 嵌套 heading                    | 现有可升格为正式 ID 矩阵                 |
| A-MD-03 | conex-ext wiki + pure-gfm lossy.json      | 新                                       |
| A-MD-04 | collab merge fixture × S/P                | 跨 crate 快测或 `tests` harness          |
| A-MD-05 | serialize pure_gfm + tool result 字段契约 | strip 可并入                             |
| A-MD-06 | 架构：编辑路径无整篇 S∘P（lint/集成）     | 与 05/07 联责                            |
| A-MD-07 | adversarial HTML + ID 白名单              | 扩 lossy_report                          |
| A-MD-08 | CI 禁「仅 HTML 快照」命名/夹具政策        | 08 门禁句                                |

目录形状建议（D3 §8.1）写进 03，替换「有 golden 即可」：

```text
tests/golden/{gfm-core,conex-ext,pure-gfm-lossy,adversarial}/
```

### 6.7 有损点与禁止项（扩写 §4）

- 禁止项保持并加粗：**conex-markdown HTML 反推**；Lute；remark 写权威；旁路 map 主存；每键 S∘P；智能标点默认 S
- 有损点：嵌入 D3 §3 缩表或指针 + **code 枚举稳定性**承诺

### 6.8 实现包建议（供 `09` 再生，非本波改 09）

| 建议包           | 效果                                             | 文件域              | 关闭              |
| ---------------- | ------------------------------------------------ | ------------------- | ----------------- |
| **W2-A'** / R2-D | markdown-rs 接线 + lowering + 扩 gfm-core golden | `conex-md-ast`      | A-MD-01 子集→核心 |
| **W2-A-N**       | normalize + mode API + pure-gfm S                | 同上                | RT-2/6；A-MD-05   |
| **W2-B'**        | ApplyReport 透出 lossy；opts                     | 同上                | Agent 可审计      |
| **W2-A-ext**     | wiki/callout/数学分档                            | 同上 + 与 refs      | A-MD-03           |
| **X-MD-merge**   | RT-7 harness                                     | md-ast + doc-collab | A-MD-04           |

依赖：IR 类型仍 **串行归属** doc-collab（T3）；md-ast 只 re-export——**保持**，禁止在 md-ast 平行 IR。

### 6.9 保留清单（方案再生勿删）

1. `<!--c:ID-->` 独占行机器主编码与 pure-gfm 剥离
2. IR re-export 单归属
3. `document_to_md` = 即时 S 语义与命名
4. `apply_md_fragment` 零 mutate + IdConflict 整批失败
5. HTML 原文进文本、不升格结构的纪律
6. 与 `conex-markdown` 分面（聊天 vs 契约）

### 6.10 可废弃 / 改造

| 资产                             | 态度                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| 手写 `take_block_content` 主路径 | **改造退役**（换基座后）                                          |
| 6 个结构 golden                  | **保留为回归子集**，降级为 gfm-core 的一部分，不充当 A-MD-01 全集 |
| 注释「W2 后续可换」              | **删除逃逸句**；改为验收绑定 markdown-rs 或改锁                   |

---

## 7. 前提（本维闭合所依赖、非本 crate 可独力假绿）

| 前提                                     | 归属             | 若不满足                                 |
| ---------------------------------------- | ---------------- | ---------------------------------------- |
| BlockIR / Op / BlockId 稳定              | 01 doc-collab    | P/S 字段漂移；禁止 md-ast 分叉类型       |
| 文本叶子 yrs 与 `text_snapshot` 投影策略 | 01               | 结构 RT 真、用户可见强调/链接 RT 假      |
| `DocSession::apply` 原子与 origin        | 01               | 零半树仅库内；产品仍可能半提交           |
| 结构 encode/hydrate                      | 01+02（审计 G1） | 杀进程后 S(树) 无树；MD 契约「落盘」空心 |
| mirror 导出用水位                        | 02               | E-D3-01 人/git 面；与 S 一致性           |
| 工具读禁 mirror                          | 06 + runtime     | S1；已有语义，需硬门禁测                 |
| 行级引擎不夺块权威                       | 07               | A-MD-06 / A-INV-03                       |

**本维可先做**：markdown-rs、golden、N、mode、ApplyReport——**不**等待 hydrate 才能写契约测；但 **不得**在 hydrate 红时宣称 EL-06 产品关闭。

---

## 8. 冲突

| #   | 冲突面                                                 | 说明                                      | 裁决建议（方案层）                                                                               |
| --- | ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1  | **D3 早期「文件即 MD 权威」叙事 vs 15 S1 编码态权威**  | E2 S1 已合成：权威 SQLite；MD=契约/mirror | **以 15/S1 为准**；03 已写 S1，保持；D3 历史句不覆盖 15                                          |
| C2  | **D3 §4.2 曾「注释或 {#id} 二选一」vs 15/W0-B 钉注释** | 实现与 W0-B 已钉 `<!--c:-->`              | **以 15/W0-B 为准**；03/规格已钉；D3 旧歧义作废                                                  |
| C3  | **栈锁 markdown-rs vs 手写交付**                       | 最大实现漂移                              | **保持锁 → 接线**；改锁须评审；禁止第三态「文档锁、代码漂」长期存在                              |
| C4  | **结构-only plain vs 「GFM 无损」字面**                | 强调/链接在 plain 快照中不可区分          | 方案分层：**块结构 RT** 与 **叶子 inline RT**；A-MD-01 分期关闭条件写清，禁止用结构测关闭 inline |
| C5  | **List 无容器 vs 部分大纲模型**                        | 扁平 BulletItem                           | 规格明确当前模型；若产品要 list 容器，单独立项，不静默改 P 语义                                  |
| C6  | **A-MD-04 主责 03 vs merge 在 01**                     | 任务书写 A-MD-04 相关                     | 03 写「S/P 提供方」；关闭条件联测；禁止单方谎绿                                                  |
| C7  | **T3 评审：md-ast 与 collab 双主 IR**                  | 代码已 re-export                          | **冲突已在代码侧关闭**；03 保持「只 re-export」；再生勿写回平行 IR                               |

---

## 9. 总判表（回写索引用）

| 维         | 保留                                                                       | 改造                                                           | 废弃/退役                                                          | 方案必须改                                                                 |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| D3 MD 契约 | ID 编码、零半树 apply、即时 S、HTML 不升格、IR re-export、结构 golden 子集 | P 换 markdown-rs、N、mode、lossy 枚举、GFM golden、ApplyReport | 手写主路径长期双轨、注释逃逸「后续再换」、以 6 golden 冒充 A-MD-01 | **加厚 03**：RT/A-MD 映射、API、基座退役句、有损/禁止项、与 01/02 联测边界 |

---

## 10. 证据索引

| 主题    | 路径                                                                                |
| ------- | ----------------------------------------------------------------------------------- |
| 效果锁  | `docs/block-workspace-architecture/15-评审后锁定修订.md` §2–4                       |
| 任务书  | `docs/block-workspace-architecture/plans/03-MD契约.md`                              |
| ID 规格 | `docs/block-workspace-architecture/plans/specs/conex-md-id-and-nesting.md`          |
| 验收    | `plans/08`；`round-D-stack/07` §5.7                                                 |
| 详设    | `round-D-stack/03-MD-AST往返.md`                                                    |
| 审计    | `audit/2026-08-11-round-quality/00-总判-主控认账.md`；`02-W2-存储MD索引.md` §G4/5.2 |
| 章程    | `20-流程重启-教训与章程.md` §1 L3–L4、§5 分析约定                                   |
| 代码    | `crates/conex-md-ast/src/{lib,parse,serialize,apply}.rs`；`Cargo.toml`              |
| ID 类型 | `crates/conex-doc-collab/src/block_id.rs`                                           |

---

_文档版本：analysis/2026-08-11-realign · D3-MD契约 · UTF-8 无 BOM。_
