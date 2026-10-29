# 文档协作 IR 往返无损化与 GFM 扩展块模型深度审计报告

> **审计基准**：基于最近提交批次（`BATCH-MD-PHASE0` 至 `PHASE7`，核心提交 `6a2ee150d feat(doc-collab): 文档 IR 往返无损化与 GFM 扩展块模型 [BATCH-MD-PHASE6]`）的代码实现与测试套件。  
> **审查对象**：
> 1. `crates/conex-doc-collab/src/ir.rs`（`BlockKind` 扩展与建模）
> 2. `crates/conex-md-ast/src/`（`parse_mdast.rs`, `serialize.rs`, `lib.rs`, `parse.rs`, 原 `assemble.rs` 清退）
> 3. `crates/conex-md-ast/tests/`（`golden_gfm_core.rs`, `golden_deepen.rs`, `lossy_report.rs`, `markdown_rs_backend.rs` 及 golden 用例）
> 4. `packages/block-paper-contract/src/opsWire.ts`（前端协同契约绑定与类型守卫）
> 5. 跨层运行时投影与呈现层（`conex-note-runtime`, `conex-workspace-store`, `block-paper`, `crish-desktop`）  
> **审计日期**：2026-10-29  
> **产出文件**：`docs/markdown-rendering-analysis/audits/04-document-ir-and-lossless-collab.md`

---

## 1. 审计概述与基准事实

在 `BATCH-MD-PHASE6`（commit `6a2ee150d`）之前，Conex 的文档协作基础设施（`conex-doc-collab` 与 `conex-md-ast`）存在严重的“**有损往返与结构降维**”隐患。早期架构受制于扁平容器栈（`assemble.rs` 中的 `container_rank`）以及过于狭隘的 `BlockKind` 变体集合，导致 Markdown 文档在进入协作树（`BlockTree`）再反向序列化（`document_to_md` / Agent 读路径）时发生静默退化。旧版测试用例（如历史版本的 `golden_deepen.rs` 与 `golden_gfm_core.rs`）甚至主动使用断言承认了这些降维行为（例如断言任务项降级为普通无序项、代码语言被剥离进 `structure_note`、表格被拍平进引用导语等）。

提交 `6a2ee150d` 是针对这一历史技术债的重大攻坚批次：
- **涉及跨度**：跨越 Rust 核心协同库、AST 解析库、持久化存储投影与前端 TypeScript 协同契约等 29 个文件（+1506 / -1655 行代码净收敛）。
- **执行结果**：`cargo test -p conex-md-ast -p conex-doc-collab`（全量 79 + 40 个用例全部通过，零失败）；`vitest run packages/block-paper-contract`（32 个契约单测全绿）。

本报告全面评估这批重构改动的**真实正面突破**，并深入挖掘**深层格式损耗边界、协同并发冲突隐患以及前端契约投影断层**。

---

## 2. 改动效果评估（正面突破与架构成果）

### 2.1 破坏性缺陷的根治机理

此前整改方案（`docs/markdown-rendering-analysis/01-系统性整改行动方案.md` §0.3 #5 及 §2.4 表项 55/56）严厉揭露的四大破坏性缺陷，在本次重构中均从架构根源得到了正面解决：

```
【旧版有损管线】
Markdown 源文本 ──> markdown-rs mdast ──> 扁平 RawBlock ──> assemble.rs (容器栈) ──> BlockTree (结构丢失/拍平)
                                                                                          │
                                                                                          ▼
Markdown 目标文本 <───────────────────── serialize.rs (无缩进/丢元数据/全扁平) <────────────┘

【重构后无损管线】
Markdown 源文本 ──> markdown-rs mdast ──> parse_mdast.rs (递归 lowering) ───────────> BlockTree (真嵌套树)
                                                                                          │
                                                                                          ▼
Markdown 目标文本 <───────────────────── serialize.rs (DFS + 动态缩进 + 语法转义) <───────┘
```

#### (1) 表格（Table）降维为普通段落的彻底根治
- **旧实现硬伤**：旧版 `BlockKind` 缺乏 `Table` 变体，解析器在遇到 GFM 表格时只能将其折叠为普通文本段落（`BlockKind::Paragraph`），表格的多行文本混杂在单一叶子中，且在反向序列化时失去表格语法防护。
- **本次重构突破**：
  - 在 [`crates/conex-doc-collab/src/ir.rs:31`](file:///C:/Software/conex/crates/conex-doc-collab/src/ir.rs#L31) 中新增一等公民变体 `BlockKind::Table`。
  - 在 [`crates/conex-md-ast/src/parse_mdast.rs:186-195`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L186-L195) 中，显式匹配 `Node::Table(table)`，将其转入 `table_plain`，生成规范化的 GFM 表格源文本（包含表头、对齐分隔行 `:---` / `:---:` / `---:` 与数据行），并绑定为 `BlockKind::Table`。
  - 彻底移除了“表格有损报告”，在 [`crates/conex-md-ast/tests/lossy_report.rs:53-67`](file:///C:/Software/conex/crates/conex-md-ast/tests/lossy_report.rs#L53-L67) 中专门测试断言表格解析零 `lossy`。

#### (2) 任务列表项（TaskItem）丢失与勾选态被吞
- **旧实现硬伤**：旧系统将 `- [x]` 任务项降级为 `BlockKind::BulletItem`，并将 `[x]` 作为普通字符串拼接到正文头部，多次往返或编辑极易导致任务标记漂移或失效。
- **本次重构突破**：
  - 在 [`ir.rs:23-25`](file:///C:/Software/conex/crates/conex-doc-collab/src/ir.rs#L23-L25) 中定义 `BlockKind::TaskItem { ordered: bool }`。将无序任务与有序任务结构统一抽象；同时做出关键设计取舍：**勾选状态不放入 `BlockKind` 变体，而是进入 `props.attrs["conex_md_task_checked"]`**。
  - **架构理由**：用户勾选任务项属于高频可变状态，若将 `checked` 放在枚举体中，每次勾选都必须触发昂贵的 `Op::TurnInto` 结构状态机转移；放入 `attrs` 后，客户端只需发起轻量的 `Op::PatchAttrs` 即可完成协同变更。
  - 在 [`crates/conex-md-ast/src/serialize.rs:211-230`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L211-L230) 中，序列化时根据 `task_checked(node)` 自动精准补齐 `- [x] ` 或 `- [ ] `，且正文不再冗余存储该标记。

#### (3) 围栏代码块（Code）语言与元数据清空
- **旧实现硬伤**：旧版 `BlockKind::Code` 不携带任何语言信息，序列化时一律输出无语言标记的 ` ``` `，并在有损报告中记录 `lang=xxx 未进载荷`。
- **本次重构突破**：
  - 在 [`parse_mdast.rs:149-169`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L149-L169) 中，解析器读取 `code.lang` 与 `code.meta`，并写入 `attrs["conex_md_code_lang"]` 与 `attrs["conex_md_code_meta"]`。
  - 在 [`serialize.rs:135-143`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L135-L143) 与 [`serialize.rs:278-297`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L278-L297) 中，序列化阶段通过 `code_info` 完整复原 ` ```rust title="demo"` 形式，并使用 `code_fence` 动态探测正文中反引号的最大连缀长度（`max_run + 1`，保底 3 个反引号），防止包含代码示例的内容意外截断围栏。

#### (4) 嵌套列表与引用容器的“拍平”问题根治
- **旧实现硬伤**：旧代码依赖 [`crates/conex-md-ast/src/assemble.rs`](file:///C:/Software/conex/crates/conex-md-ast/src/assemble.rs)（现已被物理删除）中的容器栈算法。该算法为 `BulletItem`、`OrderedItem`、`Quote` 赋予相同的固定秩（`rank = 10`），当连续遇到列表项时，由于 `stack_rank >= current_rank`，前一项会被无条件弹出，导致深层缩进的子列表项被迫提升到根级，发生严重的“结构拍平”。
- **本次重构突破**：
  - **物理清退 `assemble.rs`**：完全废弃扁平块序列与容器栈推演。
  - **采用真递归 Lowering**：在 [`parse_mdast.rs:79-129`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L79-L129) 中，由 `Lowerer::lower_children`、`lower_list` 与 `lower_blockquote` 直接映射 `markdown-rs` AST 的嵌套树结构。列表项内的子段落、子列表、嵌入代码块和嵌入表格全部显式作为子节点挂载到父项的 `children` 数组中。
  - **动态缩进序列化**：在 [`serialize.rs:78-97`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L78-L97) 中实现 `child_prefix`：无序列表缩进 2 空格；有序列表按序号字符宽度动态补空格（`number.len() + 2`）；引用块加 `> ` 前缀；脚注定义缩进 4 空格。

---

### 2.2 递归 Lowering 与 GFM 核心用例覆盖表现

在 `crates/conex-md-ast/tests/` 目录下，测试矩阵完成了一次根本性的范式反转：从“验证有损记录”反转为“**结构无损往返断言（Round-trip Stability Assertion）**”：

| 测试套件 | 用例数 | 覆盖场景 | 往返稳定性断言（P ∘ S ≡ id） |
| :--- | :---: | :--- | :--- |
| [`golden_gfm_core.rs`](file:///C:/Software/conex/crates/conex-md-ast/tests/golden_gfm_core.rs) | 10 | 基础表、空单元格表、任务列表、有序任务列表、删除线/Autolink、分割线/Wiki、任务嵌表、引用嵌表、列表嵌表、真嵌套列表 | `assert!(structure_eq(tree, &again));`<br>`assert_eq!(document_to_md(&again), md);`（两轮序列化幂等稳定） |
| [`golden_deepen.rs`](file:///C:/Software/conex/crates/conex-md-ast/tests/golden_deepen.rs) | 9 | 任务嵌段落、代码围栏 lang/meta、多层嵌套 Blockquote、真嵌套与兄弟模型、列表嵌代码块、Alerts/Math/Footnote 综合体、表格内管道转义、列表非任务标记防伪转义、块首敏感标点防破坏转义 | 同上，双向完全无损，`lossy.is_empty()` 成为常规断言 |
| [`golden_lists_quote.rs`](file:///C:/Software/conex/crates/conex-md-ast/tests/golden_lists_quote.rs) | 6 | 列表项续接段落、有序列表起始序号保持（start=3）、PatchAttrs 增量修改序号往返 | 序号与属性无损跨轮次同步 |
| [`lossy_report.rs`](file:///C:/Software/conex/crates/conex-md-ast/tests/lossy_report.rs) | 5 | pure-gfm 注释剥离统计、缺失/重复 UUID 诊断、表格零 Lossy、HTML 绝不非法提升为结构块 | 诚实边界与异常防御全面覆盖 |

特别值得肯定的是 [`golden_deepen.rs:297-341`](file:///C:/Software/conex/crates/conex-md-ast/tests/golden_deepen.rs#L297-L341) 的 `plain_text_block_start_escape_roundtrip`：
对于正文首行可能诱发 Markdown 语法误判的敏感标点（如 `#`、`-`、`>`、`1.`、`~~~`、`<!--c:`、`[^`、`[!` 等），在序列化时由 [`serialize.rs:323-407`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L323-L407) 的 `protect_block_start` 实施严密的转义防护，确保反向解析时绝不会发生“普通段落被误升格为标题或列表”的结构变形。

---

### 2.3 块级身份持久化宏（`<!--c:UUID-->`）的兼容性表现

Conex 采用在 Markdown 源文件中嵌入独占行注释 `<!--c:UUID-->` 的机制来持久化 `BlockId`（W0-B / 15 铁律）。本次重构为该宏在复杂扩展块中的兼容性打下了坚实基础：

1. **表格（Table）兼容性**：
   在 [`golden_gfm_core.rs:44-82`](file:///C:/Software/conex/crates/conex-md-ast/tests/golden_gfm_core.rs#L44-L82) 中，`<!--c:UUID-->` 紧邻 `| col1 | col2 |` 之前放置。`markdown-rs` 将其解析为独立 `Node::Html`，`Lowerer::set_pending` 将其挂入暂存区；紧接着遇到 `Node::Table` 时，`create_block` 成功消费暂存的 UUID 并完成绑定，完全不破坏表格语法。
2. **块级数学（Math）兼容性**：
   宏注释置于 `$$` 上方，`Lowerer` 正确将 ID 消费至 `BlockKind::Math` 节点，序列化输出保持 `<!--c:UUID-->\n$$\n...\n$$`，格式整洁且稳定。
3. **GFM Alert / Callout 兼容性**：
   宏注释置于 `> [!NOTE]` 前方，解析后生成 `BlockKind::Callout`。更关键的是，**若 Callout 内部包含多个子段落或子块，子块的 `<!--c:UUID-->` 会以 `> <!--c:UUID-->` 的形式嵌入在引用前缀后**（见 [`serialize.rs:72-74`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L72-L74)），完全兼容 CommonMark 的容器块解析语法。
4. **嵌套容器内部继承机制**：
   在 [`parse_mdast.rs:299-311`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L299-L311) 中，针对 `List` 容器首项与内部子项设计了 `list_pending` 隔离消费流，有效防止了外层父项的 ID 意外渗透给内部子节点的问题。

---

## 3. 仍然存在的问题与潜在隐患（深度挖掘）

尽管上述重构取得了实质性进展，但在严苛的“往返无损（Lossless Round-trip）”标准下，底层依然存在若干由于 CommonMark / GFM 规范固有特性、抽象颗粒度取舍以及边缘情况未完全闭环所导致的**格式损耗（Lossy Edge Cases）与潜在隐患**。

### 3.1 往返仍存在的细微格式损耗（Lossy Edge Cases）

#### (1) 表格内部单元格空白符对齐被彻底归一化（Formatting Loss）
- **代码事实**：
  在 [`crates/conex-md-ast/src/parse_mdast.rs:560-593`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L560-L593) 的 `table_plain` 中：
  ```rust
  let cells: Vec<String> = row.children.iter().map(|c| match c {
      Node::TableCell(cell) => escape_table_cell(&inline_plain(&cell.children)),
      other => other.to_string(),
  }).collect();
  rows.push(format!("| {} |", cells.join(" | ")));
  ```
- **损耗分析**：
  若用户的原始 Markdown 文档中对表格列宽进行了精细的美化填充对齐：
  ```markdown
  | Header Long Text | Short |
  | :--------------- | ----: |
  | Item 1           |   100 |
  ```
  经过 `table_plain` 提取后，所有单元格间隙全部被压缩为单一空格分隔符 `| Header Long Text | Short |`。虽然 AST 语义和数据内容无损，但**人工排版与等宽视觉对齐格式完全丢失**。文档注释中也坦承了这一点（“*规范化 GFM 表格源；非字节级源还原*”）。

#### (2) 列表缩进前导空格强制归一化与惰性序号（Lazy Numbering）重写
- **代码事实 1（缩进空格数固定化）**：
  在 [`crates/conex-md-ast/src/serialize.rs:81-84`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L81-L84) 中：
  ```rust
  BlockKind::BulletItem => format!("{prefix}  "), // 硬编码 2 个空格
  ```
  在 CommonMark 中，子列表项缩进 2、3 或 4 个空格均合法。若用户原本习惯使用 4 空格缩进（例如 Python/代码规范爱好者），一旦经 Conex 往返，将被强制全量重写为 2 空格。
- **代码事实 2（惰性列表序号被强制递增重写）**：
  在 [`parse_mdast.rs:315-325`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L315-L325) 中：
  ```rust
  let number = start.checked_add(item_index)...;
  item_index += 1;
  props.attrs.insert(ORDERED_LIST_ITEM_NUMBER_ATTR.to_string(), number.into());
  ```
  在 Markdown 中，用户极为常用的书写模式是使用全 `1.` 的惰性序号：
  ```markdown
  1. 第一步
  1. 第二步
  1. 第三步
  ```
  `parse_mdast` 在遍历时会根据 `start + item_index` 强制计算出 1, 2, 3，随后序列化阶段（[`serialize.rs:124`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L124)）输出 `1.`, `2.`, `3.`。虽然符合 CommonMark 最终呈现语义，但**破坏了源文件的原始字符形态**。

#### (3) 行尾反斜杠 `\` / 双空格硬换行（Hardbreak）退化为软换行（Softbreak）
- **代码事实**：
  在 [`parse_mdast.rs:516`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L516) 的 `inline_plain` 中：
  ```rust
  Node::Break(_) => out.push('\n'),
  ```
  而在 [`serialize.rs:198-200`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L198-L200) 中：
  ```rust
  for line in text.split('\n') {
      lines.push(format!("{prefix}{line}"));
  }
  ```
- **损耗机制与验证断层**：
  在 Markdown 规范中，硬换行（Hardbreak `<br>`）是通过行尾紧跟 `\` 或两个以上空格 `  ` 触发的；单纯的 `\n` 是软换行（Softbreak，在普通段落中仅渲染为空格）。  
  当源文档包含：
  ```markdown
  第一行\
  第二行
  ```
  1. `markdown-rs` 解析到行尾 `\`，产出 `Node::Break`；
  2. `inline_plain` 仅将其转换为字符 `\n`，存储在 `text_snapshot` 中；
  3. `serialize.rs` 在写回文本时，直接按 `\n` 拆行输出，**丢失了行尾的反斜杠或双空格**；
  4. 当该文本被再次读取解析时，`markdown-rs` 将其判定为普通软换行（Softbreak），**原本的硬折行被降维消失**！这是一个尚未覆盖的真实文本有损点。

#### (4) 原生开发注释与 Conex UUID 宏冲突被转义
- **代码事实**：
  在 [`parse_mdast.rs:223-237`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L223-L237) 中，所有未能命中 `<!--c:UUID-->` 格式的普通 HTML 注释（如 `<!-- TODO: fixme -->`）均落入 `Node::Html` 分支：
  ```rust
  self.lossy.push("raw_html_as_text", ...);
  self.create_block(BlockKind::Paragraph, html.value.clone(), ...);
  ```
  而在序列化阶段（[`serialize.rs:378-380`](file:///C:/Software/conex/crates/conex-md-ast/src/serialize.rs#L378-L380)）：
  ```rust
  if first == '<' {
      return format!("\\{body}");
  }
  ```
  普通 HTML 注释在写回时会被强制转义为 `\<!-- TODO: fixme -->`，并由段落逻辑包裹！第二次读取时，它将彻底沦为一个以斜杠开头的纯文本字符串，原生 HTML 注释身份被破坏。

#### (5) Callout 仅收敛于 GFM 预设 5 种类型，生态扩展回退
- **代码事实**：
  [`parse_mdast.rs:489-494`](file:///C:/Software/conex/crates/conex-md-ast/src/parse_mdast.rs#L489-L494) 仅硬编码支持：
  `"note" | "tip" | "important" | "warning" | "caution"`。  
  在 Obsidian、VitePress 等活跃生态中广泛使用的 `[!INFO]`、`[!DANGER]`、`[!EXAMPLE]`、`[!QUESTION]`、`[!ABSTRACT]` 等扩展标记，会被直接拒绝识别，回退为普通 `BlockKind::Quote`，并在其正文第一行残留原始字符串 `[!INFO]`。

---

## 4. 协作并发冲突：BlockTree 粒度过粗带来的深层隐患

在多端多人协作编辑（CRDT / OT）场景下，当前 `conex-doc-collab` 的块树建模暴露出了**抽象颗粒度过粗**的架构短板：

### 4.1 表格单块粒度（Single Block Table）的并发冲突与结构撕裂风险

在当前设计中，整张表格（无论包含多少行、多少列、多大的数据量）在 `BlockTree` 中**仅仅是一个单一的叶子节点**（[`ir.rs:31`](file:///C:/Software/conex/crates/conex-doc-collab/src/ir.rs#L31)）：
```rust
BlockNode {
    id: TableBlockId,
    kind: BlockKind::Table,
    text_snapshot: Some("| A1 | B1 |\n| --- | --- |\n| A2 | B2 |"),
    children: vec![],
}
```

#### 并发编辑的冲突场景剖析：
1. **多端编辑不同单元格引发语法撕裂**：
   - 协作库 `conex-doc-collab` 的并发文本编辑依靠 `Op::TextEdit { id, start, end, insert }`（底层由 `TextEngine` 或 Yrs 字符级 CRDT 处理）。
   - 设协同端 A 正在编辑第 1 行第 1 列（单元格 A1），将其从 `"A1"` 改为 `"LongCellValue"`；
   - 协同端 B 正在编辑第 2 行第 2 列（单元格 B2），将其从 `"B2"` 改为 `"NewB2"`；
   - 因为两者操作的是同一个一维字符串的不同字符偏移量，虽然 CRDT 可以收敛字符流，但是：
     - 若协同端 A 删除了第 1 行的管道符 `|`，或者修改了换行符；
     - 若两个端同时向表格添加不同的行或列；
     - **二维网格结构缺乏行/列级约束**。只要并发产生错位，序列化出来的文本就会管道数量失衡（Mismatched Pipes），导致 Markdown 解析器无法再将其识别为有效表格，在下一次保存或加载时整表损坏崩溃！
2. **整块替换操作导致 Last-Write-Wins 覆盖**：
   若前端或工具层通过 `Op::UpdateProps` 或一次性全量 `Op::TextEdit(0, len, new_table)` 提交表格修改，两个端并发修改不同行将直接触发后写覆盖先写（LWW），另一端的整行输入彻底蒸发。

> **架构建议**：未来若要支持产品级表格协作，必须将 `Table` 演进为二级结构树（`Table` 容器块 -> `TableRow` 子块 -> `TableCell` 叶子块），或者在 CRDT 层面内嵌独立的二维协同数据结构，而非单纯依赖一维纯文本快照。

---

### 4.2 TaskItem 勾选状态与正文编辑的并发表现

#### (1) 优点：勾选与正文解耦
由于 `TaskItem` 的勾选态存储在 `props.attrs["conex_md_task_checked"]`，而文本存储在 `text_snapshot`（或 `TextEngine`）中：
- 协同端 A 勾选复选框（触发 `Op::PatchAttrs`）；
- 协同端 B 修改该任务的正文文本（触发 `Op::TextEdit`）；
- 两个 Op 作用于不同的数据槽，在 CRDT 树上能够**无冲突并发合并**，这体现了重构将可变状态从 `BlockKind` 剥离的明智决策。

#### (2) 隐患：并发勾选的 LWW 与 Markdown 文本编辑同步冲突
- **LWW 覆盖**：若两端同时并发切换勾选状态（例如 A 设为 `true`，B 设为 `false`），`DocSession` 在处理 `PatchAttrs` 时按时间戳或向量钟仲裁，单端状态会被直接覆盖；
- **全文本反向解析（Markdown Round-trip）的降维**：
  若外部 Agent 通过 `apply_md_fragment` 或直接修改 Markdown 文本（将 `- [ ]` 手动改成 `- [x]`），解析器会在全量重解析时提取新的 checked 属性，重新覆写 `BlockProps`。如果此时协作端正在并发编辑子项，外部片段合并可能会产生整块结构颠簸。

---

## 5. 契约同步：前端 block-paper-contract 与桌面 UI 投影断层

通过对前端契约库 [`packages/block-paper-contract/src/opsWire.ts`](file:///C:/Software/conex/packages/block-paper-contract/src/opsWire.ts) 及桌面消费层的深入审查，发现了**数个关键的契约断层与实现遗漏**：

### 5.1 `opsWire.ts` 类型定义已更新，但 `flavourToCollabKind` 转换存在严重漏勺！

这是本次审计发现的一处**高度隐蔽的契约漏洞**：

在 [`packages/block-paper-contract/src/opsWire.ts:29-43`](file:///C:/Software/conex/packages/block-paper-contract/src/opsWire.ts#L29-L43) 中，TypeScript 类型定义确实已经补齐了新增块类型：
```typescript
export type CollabBlockKindWire =
  | 'paragraph'
  | 'bullet_item'
  | 'ordered_item'
  | 'code'
  | 'quote'
  | 'divider'
  | 'table'                  // 已声明
  | 'math'                   // 已声明
  | 'footnote_definition'    // 已声明
  | { heading: { level: number } }
  | { task_item: { ordered: boolean } } // 已声明
  | { callout: { kind: string } }       // 已声明
  | { unknown: { flavour: string } };
```
并且在 [`opsWire.ts:228-272`](file:///C:/Software/conex/packages/block-paper-contract/src/opsWire.ts#L228-L272) 的运行时校验守卫 `isKindWire` 中，也严密检验了 `'table'`、`'math'`、`'footnote_definition'` 以及 `'callout'`。

**但是**，在将 UI 层的 flavour 映射为协同契约的转换函数 [`flavourToCollabKind`](file:///C:/Software/conex/packages/block-paper-contract/src/opsWire.ts#L131-L189) 中：
```typescript
export function flavourToCollabKind(flavour: string): CollabBlockKindWire {
  const f = (flavour || '').trim().toLowerCase();
  // ... 处理 paragraph, heading, bullet, ordered, code, quote, divider ...
  if (
    f === 'task' ||
    f === 'task_item' ||
    f === 'task-item' ||
    f === 'todo' ||
    f === 'checkbox'
  ) {
    return { task_item: { ordered: false } }; // 仅增加了 task
  }
  return { unknown: { flavour: flavour || f } }; // 其余全部漏网！
}
```
**严重事实**：
当客户端或 slash 菜单尝试使用 `table`、`math`、`callout` 或 `footnote` 作为 flavour 创建块时：
- `flavourToCollabKind('table')` 返回的是 `{ unknown: { flavour: 'table' } }`！
- `flavourToCollabKind('math')` 返回的是 `{ unknown: { flavour: 'math' } }`！
- `flavourToCollabKind('callout')` 返回的是 `{ unknown: { flavour: 'callout' } }`！
- `flavourToCollabKind('footnote')` 返回的是 `{ unknown: { flavour: 'footnote' } }`！

它们被**静默退化为了 `Unknown` 变体**！前端单元测试 [`packages/block-paper/src/chrome/chrome.a_blk.test.ts:285`](file:///C:/Software/conex/packages/block-paper/src/chrome/chrome.a_blk.test.ts#L285) 甚至还在直接验证这种降级行为：
```typescript
expect(flavourToCollabKind('callout-ext')).toEqual({ unknown: { flavour: 'callout-ext' } });
```

---

### 5.2 Rust 端 `BlockKind::from_flavour` 存在完全镜像的漏勺

令人惊讶的是，相同的漏洞在 Rust 内核中一模一样地存在：
查阅 [`crates/conex-doc-collab/src/ir.rs:47-87`](file:///C:/Software/conex/crates/conex-doc-collab/src/ir.rs#L47-L87) 的 `BlockKind::from_flavour`：
```rust
match f.as_str() {
    "h1" => BlockKind::Heading { level: 1 },
    // ...
    "task" | "task_item" | "task-item" | "todo" | "checkbox" => {
        BlockKind::TaskItem { ordered: false }
    }
    "code" | "code_block" | "code-block" => BlockKind::Code,
    "quote" | "blockquote" => BlockKind::Quote,
    "divider" | "hr" | "horizontal_rule" => BlockKind::Divider,
    _ => BlockKind::Unknown {
        flavour: if raw.is_empty() { f } else { raw.to_string() },
    },
}
```
在 commit `6a2ee150d` 中，开发者在 `ir.rs` 中仅为 `from_flavour` 补充了 `"task"` 分支，**完全遗漏了 `"table"`、`"math"`、`"callout"` 和 `"footnote"`**！  
这就导致一旦前端通过 `pending_turn_into_flavour` 请求将某个块转为表格（`table`）时，Rust 端 [`ir.rs:114`](file:///C:/Software/conex/crates/conex-doc-collab/src/ir.rs#L114) 的 `pending_turn_into_kind` 会将其转换为 `BlockKind::Unknown { flavour: "table" }`，而无法进入合法的 `BlockKind::Table`！

---

### 5.3 工具层 `kind_label` 与 `kind_from_tool_label` 的不对称破损

在 [`crates/conex-note-runtime/src/store_plan_ops.rs:122-162`](file:///C:/Software/conex/crates/conex-note-runtime/src/store_plan_ops.rs#L122-L162) 中：
- `kind_label` 将 `BlockKind::Callout { kind }` 格式化为字符串 `"callout:{kind}"`（如 `"callout:note"`）；
- 但其对应的反向解析函数 `kind_from_tool_label`（lines 122-142）：
  ```rust
  if let Some(rest) = k.strip_prefix("heading:") {
      let level = rest.parse::<u8>().unwrap_or(1).clamp(1, 6);
      return BlockKind::Heading { level };
  }
  match k {
      "table" => BlockKind::Table,
      "math" => BlockKind::Math,
      "footnote_definition" | "footnote" => BlockKind::FootnoteDefinition,
      // 遗漏了 callout: 前缀解析！
      other => BlockKind::Unknown { flavour: other.to_string() },
  }
  ```
  `kind_from_tool_label` 根本没有检查 `callout:` 前缀！导致所有来自工具层或导出的 Callout 标签再次被读入时，全部沦为 `BlockKind::Unknown { flavour: "callout:note" }`！

---

### 5.4 客户端 UI 呈现层严重真空：缺乏专用 Leaf 组件

虽然在桌面聊天流（`apps/crish-desktop/` 的聊天消息渲染管线中，Phase 1~5 接入了丰富的 Islands，如 KaTeX、Mermaid、代码高亮等），但在**文档编辑器（NotePaper 与 block-paper）**中，新增块类型的 UI 呈现近乎为零：

1. **`block-paper` 核心库无专用叶子组件**：
   查阅 [`packages/block-paper/src/leaves/`](file:///C:/Software/conex/packages/block-paper/src/leaves/) 目录，仅存在 `code`（CM6 代码叶）与 `pm`（ProseMirror 纯文本叶），根本不存在任何 `TableLeaf`、`MathLeaf`、`CalloutLeaf` 或 `TaskItemLeaf`。
2. **`PaperList` 虚拟列表的粗暴降维渲染**：
   在 [`packages/block-paper/src/list/paperListReconcile.ts:108-118`](file:///C:/Software/conex/packages/block-paper/src/list/paperListReconcile.ts#L108-L118) 中：
   对于所有投影块，`PaperList` 仅仅是在 DOM 上标记 `data-flavour`，然后将其全部设置为 `contenteditable="plaintext-only"`，并将 `text_snapshot` 原样塞入 `el.textContent`。
   - **表格**：用户在笔记编辑器中看到的是未经排版的原始纯文本 `| a | b |\n| --- | --- |`；
   - **公式**：呈现为原始的 LaTeX 纯文本 `x^2 + y^2`，无任何渲染预览；
   - **任务项**：无任何可供鼠标点击交互的 Checkbox 控件。
3. **桌面 Strict 模式下的退化**：
   在 [`apps/crish-desktop/src/components/note-paper/StrictContentRowLeaf.tsx`](file:///C:/Software/conex/apps/crish-desktop/src/components/note-paper/StrictContentRowLeaf.tsx) 与 [`NotePaperStrictBody.tsx:295-310`](file:///C:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictBody.tsx#L295-L310) 中，无论何种块，均直接渲染为一个带有小文本标签的通用编辑框，完全缺乏现代富文本笔记该有的专用渲染与交互投影。
4. **斜杠菜单缺失新增块入口**：
   在 [`packages/block-paper/src/chrome/slashCatalog.ts:18-27`](file:///C:/Software/conex/packages/block-paper/src/chrome/slashCatalog.ts#L18-L27) 中，`DEFAULT_SLASH_CATALOG` 仅硬编码了 8 种基础块，用户在笔记内通过 `/` 键完全无法调出 Table、Math、Callout 或 TaskList。

---

## 6. 审计结论与整改优先级建议

### 6.1 综合评估结论

本次 `BATCH-MD-PHASE6`（commit `6a2ee150d`）重构是一次**极高质量且效果显著的内核级攻坚**：
1. **彻底摆脱了容器栈拍平的技术负债**，建立了基于 `markdown-rs` 的现代递归 Lowering 树体系；
2. **在 Rust AST 与序列化层实现了真正的结构无损与双向幂等稳定（P ∘ S ≡ id）**，测试矩阵完备坚固；
3. **架构边界清晰**，成功保护了测试资产并清退了旧架构死代码。

然而，**内核 AST 层的无损并不等同于系统全链路的完备**。当前系统在前端契约映射、跨语言 flavour 绑定、细微排版保留、协作并发控制以及笔记呈现层依然存在肉眼可见的断层，必须以务实的态度进行阶段性收口。

---

### 6.2 整改建议与行动项清单

| 优先级 | 问题域 | 具体行动建议 | 涉及文件 |
| :---: | :--- | :--- | :--- |
| **P0**<br>(立即修复) | **前端契约漏勺** | 补齐 `flavourToCollabKind` 中的 `table`、`math`、`callout`、`footnote` 映射，消除静默降级为 `Unknown` 的 Bug | `packages/block-paper-contract/src/opsWire.ts:131-189` |
| **P0**<br>(立即修复) | **Rust 内核 flavour 映射** | 在 `BlockKind::from_flavour` 中镜像补齐 `table`、`math`、`callout`、`footnote` 分支 | `crates/conex-doc-collab/src/ir.rs:47-87` |
| **P0**<br>(立即修复) | **工具层标签解析对称性** | 在 `kind_from_tool_label` 中增加对 `callout:*` 前缀的剥离与解析，修复与 `kind_label` 的不对称 | `crates/conex-note-runtime/src/store_plan_ops.rs:122-142` |
| **P1**<br>(下个批次) | **硬换行（Hardbreak）损耗** | 在 AST lowering 时识别 `Node::Break` 并记录硬换行标记；在 `serialize.rs` 写回时针对硬换行行尾自动补全反斜杠 `\` 或双空格，防止降级为 Softbreak | `crates/conex-md-ast/src/parse_mdast.rs:516`<br>`crates/conex-md-ast/src/serialize.rs:198` |
| **P1**<br>(下个批次) | **斜杠目录补全** | 在 `DEFAULT_SLASH_CATALOG` 中加入表格、任务列表、块级数学公式、提示框（Callout）等贡献项 | `packages/block-paper/src/chrome/slashCatalog.ts:18-27` |
| **P2**<br>(中期规划) | **表格协同粒度提升** | 评估将 `Table` 演进为二级树节点（`TableRow` / `TableCell`），彻底根治一维文本 CRDT 并发破坏表格语法的潜在隐患 | `crates/conex-doc-collab/src/ir.rs`<br>`crates/conex-doc-collab/src/op.rs` |
| **P2**<br>(中期规划) | **笔记 UI 专用 Leaf 投影** | 在 `block-paper` 与 `note-paper` 中为 Table、Math、Callout、TaskItem 建立专用的 Interactive Leaf 视图，结束纯文本预览现状 | `packages/block-paper/src/leaves/`<br>`apps/crish-desktop/src/components/note-paper/` |
