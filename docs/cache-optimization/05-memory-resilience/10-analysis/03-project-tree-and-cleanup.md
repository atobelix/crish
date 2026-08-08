# 03：project_tree 工具与命令输出清洗模块（送 AI 前的 token 优化）

- 撰写日期：2026-08-08
- 文档性质：分析方案（只读研究 + 本文件；未修改任何源代码）
- 所属系列：`docs/cache-optimization/05-memory-resilience/`（10-analysis 分析层）
- 前置事实（均经实读核实，行号以 2026-08-08 实读为准）：
  - `crates/agent-tools/src/tools/search.rs`：`MAX_WALK_DEPTH=16`（:23）、`SKIP_DIRS` 九项清单（:26-35）、`walk_files` 的 WalkBuilder 用法（:326-332，hidden+git_ignore+git_global+git_exclude+max_depth）、排除优先级「excludeGlobs → SKIP_DIRS → 正例 glob」（:316-318、:344-378）、`glob_match`（:385，`pub(crate)` 可复用）；`fuzzy_find`（:415-500）每次执行重建 `conex_search::walker::build_directory_index`，无缓存。
  - `crates/agent-tools/src/tools/mod.rs`：工具注册面 `register_builtin_tools_with_config`（:109-165，逐个 `registry.register(Arc::new(...))`）；注册面计数测试 17 个工具（:701）与工具名清单（:707-727）；共享助手 `resolve_workspace_path`（:222-287）/ `display_path`（:318-325）/ `snapshot_tag`（:363）/ `clamp_text_by_lines`（:507-533）。
  - `crates/conex-compaction/src/tool_output.rs`：head+标记+tail 截断 `truncate_tool_output`（:178-288）、双阈值 2000 行/50KB（:25-27）、`ToolOutputTruncationLimits`（:40-64）、`ToolOutputTruncationResult`（:68-87）、留痕 `ToolOutputTruncationRecord`（:93-127）、水位联动 `estimate_after_truncation`（:305-307）/ `classify_after_truncation`（:314-321）。**该模块当前为零接线纯函数**（全仓仅自测调用），G8 注释声明「截断动作的注入时机与事件落库由调用方（session-loop）接线」——清洗模块与截断的接线点应落在同一处。
  - `crates/agent-tools/src/context.rs`：`ToolContext.workspace_root`（:108）、`background`（:121）/ `output_dir`（:125）/ `log_root`（:129）三组「Option<Arc<dyn …>> + 执行期装配」注入先例；`ToolContext::new`（:154-167）。
  - `crates/session-loop/src/loop/handlers/executing_tools.rs`：工具结果进对话的唯一点 `tool_result_message`（:142-157）+ `tool_output_from_result`（:160-198）——raw 输出此刻被转换为 `ToolOutput`（text/json/artifacts 三通道）后 `record_message`。
  - `crates/agent-tools/src/tools/shell.rs`：命令输出 head+tail 预览与 200KB 预算（:1457-1467 `preview_text`）、截断时完整原始输出落盘（:1565-1576 `spill_full_output`，T-AB-03）——「原始输出落库、展示面截短」的既有先例；shell 输出含 stdout/stderr/exitCode/timedOut/truncated 多键（:1589-1592）。
  - 姊妹方案锚点：`02-cache-hit-prefix.md` §4.3 已定「目录树必须工具化，绝不入每轮 user 文本」的缓存经济学结论（同系列本目录），本文件承接其工具面设计；T-20（02 文档 §六 C 阶段）已将 project_tree 列为独立方案。

## 结论先行

1. **project_tree 做成工具（而非注入）是缓存与注意力的双重必然**：注入缺点＝注意力分散（每轮全价重发、模型只读一次）/ 前缀变异（树字节随文件变动进 system 或首条消息 → 全前缀作废）/ 缓存命中破坏（tree 字节每轮落在 miss 区按全价计费；工具化后作为 tool-result 历史消息进入前缀，之后按缓存价）。工具参数契约、懒构建缓存（进程内 + mtime 指纹失效 + 并发共享）、SKIP_DIRS 复用、token 折叠约束如下文 §2。
2. **输出清洗 = 截断的上游规则层，两者组成「清洗 → 截断 → 发 AI」单段管线**：清洗只作用发往 AI 的副本，数据库/落盘保留原始输出（shell 的 T-AB-03 先例可推广）；清洗留痕记录与截断记录并行落 events（33-event-schema-changelog 纪律）。
3. **落 crate 与注册面**：project_tree 落 `agent-tools/src/tools/project_tree.rs`，经 `register_builtin_tools_with_config`（mod.rs:109-165）注册进内置工具注册表（注册面工具数 17→18，危险度 false）；清洗落 `conex-compaction/src/clean_output.rs`（tool_output 的兄弟模块，同 crate 无运行依赖）。两模块均为纯函数/只读，不触碰 `ToolContext`（workspace_root 已足）。
4. 「最近改动文件周边树」标注为**可选增强（不确定性）**：时间依赖会冲击 mtime 指纹缓存的失效语义，列为独立演进项，见 §2.7。

---

## 2. project_tree 工具设计

### 2.1 参数契约（input_schema 草案，`additionalProperties: false`）

| 参数 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `path` | string | `"."`（workspace_root） | 树根；经 `resolve_workspace_path`（mod.rs:222）越界校验（同 list_dir/read_file） |
| `depth` | number | 3 | 递归深度（1-based），钳制上界 `MAX_WALK_DEPTH`（search.rs:23） |
| `includeFiles` | boolean | true | 是否列出文件（false = 只目录骨架） |
| `dirsOnly` | boolean | false | 同 includeFiles=false 的别名语义，取更名字段 `dirsOnly`；两者并存时 dirsOnly 优先 |
| `excludeGlobs` | array[string] | [] | 排除式 glob（复用 search.rs:344-355 判定）；优先级高于 SKIP_DIRS 与正例文件过滤 |
| `maxItems` | number | 400 | 输出节点总数上限（token 约束，见 §2.5） |
| `maxDepthContent` | number | 4 | 折叠起点：超过该深度的目录以 `(+N)` 统计行替代展开 |

输出形状（对齐现有工具「text 对话正文 + json 结构化」双通道惯例，参考 read_file/list_dir）：

```
<root>/
├── crates/
│   ├── agent-tools/
│   │   ├── src/
│   │   │   ├── tools/           (+ 12 项)
│   │   │   └── ...(3) ……
│   ├── conex-compaction/
│   └── (+38) …
└── docs/
    └── rust-rewrite/            (+63) …

root: <rel>
dirs: 127, files: 892, shown: 400, collapsedNodes: 619
```

树形图用 `/` 统一分隔的相对路径 + 前缀线（`├──`/`└──`/`│`），目录行优先、字母序排序——折叠时保 head 稳定（排序确定性，缓存命中面字节稳定）。JSON 通道输出 `{root, depth, dirs, files, shown, collapsedNodes, truncated}` 结构化计数。

### 2.2 懒构建 + 进程内缓存（mtime 失效）

- **缓存键**：`(canonical_root, depth, include_files, dirs_only, exclude_globs 排序串)` ——excludeGlobs 参与键（不同排除集 = 不同树），排序后拼接避免顺序抖动。
- **缓存值 = 树节点列表 + 目录指纹表**：构建时对每个遍历到的目录记录 `(dir_name, mtime_epoch_ns, entry_count)`；校验时只 re-stat 指纹表中这些目录（元数据级开销，数十个目录约几十次 stat，毫秒级），全部一致 → 返回缓存树（零 IO 扫描）；任一目录 mtime 或条目数变化 → 对该目录子树重建（粒度：目录级）。
- **懒构建**：首次调用、键未命中、指纹失效时才构建（对齐「惰性」语义）；构建期间同键并发调用串行等待（std `Mutex<HashMap<CacheKey, Arc<CacheEntry>>>`，入口拿锁查存、miss 则持锁构建并写入——天然去重并发，无需独立并发原语）。**进程内缓存 + 多 agent 共享**：缓存挂在进程级 `static LazyLock<TreeCache>`（agent-tools 内新建模块），主 agent 与子 agent（run_subagent）同进程共享；跨进程不共享（多 daemon 多工作区场景由键的 canonical root 天然隔离，无串扰）。
- **mtime 失效的已知误差（诚实标注）**：mtime 粒度不足（FAT/网络盘秒级）或「内容被覆盖但 mtime 不变」的边缘 case 会漏判——对目录树读语义可接受（漏判=树稍旧，模型可二次 git 查证）；如需更强一致性，演进项是把指纹换成目录内文件数量+字节和（顺目录扫描一阶，成本相当，见 §6 风险 1）。
- **防抖**：同键 1 秒内多次调用直接命中缓存（指纹校验本身是 re-stat，天然防抖）。

### 2.3 SKIP_DIRS 复用

`search.rs:26-35` 的 `SKIP_DIRS`（.git/node_modules/dist/build/.next/.turbo/.cache/target）**不做第二次拷贝**：将其提为 `pub(crate) const SKIP_DIRS`，`project_tree.rs` 直接引用；`walk_files`（search.rs:327-360）与 tree 构建共用同一 WalkBuilder 配置（hidden+git_ignore+git_global+git_exclude+max_depth，search.rs:26-35）和逐组件排除语义。同时支持 `excludeGlobs` 入参（判定优先级与 search 完全一致：excludeGlob > SKIP_DIRS > 包含过滤）。

### 2.4 与 fuzzy_find / grep_search 的关系（分工矩阵）

| 工具 | 回答的问题 | 触发时机 | 与项目树的衔接 |
|---|---|---|---|
| `fuzzy_find` | 「这个文件在哪个路径」 | 已知目标文件名的定位 | tree 位于后：树给全局，fuzzy 给精确定位 |
| `grep_search` | 「哪些文件含这个内容」 | 内容检索 | tree 可先给 TODO 目录再 grep 内容 |
| `project_tree`(新) | 「项目结构/模块边界/最近动过的块在哪」 | 会话开始时一次、后续按需 | 树结果是**历史消息**（每轮复用），fuzzy/grep 是**新请求**（按需调用）——三者互不替代，组合覆盖「结构→定位→内容」三层 |

### 2.5 巨大项目下的 token 约束（宽度截断 + N items 折叠）

线数/字节双维约束（对齐工具输出截断的预算思想，tool_output.rs:39-64）：

| 约束 | 默认 | 机制 |
|---|---|---|
| `maxItems`（节点总数） | 400 | 深度优先遍历超限即停；剩余节点以 `… (+N 项) …` 折叠行收尾，`collapsedNodes` 计入 JSON 计数 |
| `maxDepthContent`（行宽折叠起点） | 4 | 超过该深度的目录不再展开子项，输出 `(+N)` 统计行 |
| `maxLineChars`（单行字符上限） | 120 | 树行超宽按 char 边界截断 + `…`（多字节安全，对齐 tool_output.rs:130-142 边界逻辑） |
| 排序确定性 | — | 目录优先 + 字母序 → head 稳定（截断后头部 = 结构性重要节点，字节稳定利于缓存） |

折叠不变量：**被折叠的信息总量 = collapsedNodes 计数**（AI 可据计数决定是否加深重查），绝不静默丢弃。

### 2.6 工具而非注入：注入三宗罪

注入（把树文本拼进 system / 首条 user 消息）有三个结构性缺陷：

1. **注意力分散**：树每轮自动作废（注入 tail 区 = 永远 miss 区），消费者只有第一轮实际用；token 每轮全价重发（假设 1000 token 树 × 100 轮 = 100K miss token），而工具化后「抓一次 5-10K token（miss）+ 此后每轮命中 0.1x ≈ 10 价格」——数量级差距。此处确认为：**cache 命中率上，注入 = 每轮全价**；工具化 = 一次性抓取 + 复用。
2. **前缀变异**：树的任何文件增删都会引起 node 变化 → 若注入位置在 system 或首条 user 消息，该消息字节每轮变化 → **整个请求前缀作废**（对应 02-cache-hit-prefix.md §4.2 禁止列表）；即使放在尾部 user 消息，也违反 P4 的「每轮注入内容必须字节稳定或位于 LCP 外」纪律——树恰恰是「每轮可能变化」的内容，归属工具化而非注入（02 §4.3 的缓存经济学两重论证，此处从设计面落地）。
3. **缓存命中破坏**：注入树会令 `tools_snapshot`/`messages` 前缀 hash 因树字节变化而漂移，即使只是新增一个文件（watch 服务场景），服务端 LCP 命中段缩小到 system 为止，缓存命中率崩塌（命中率观测见 P5 cache_tracker）；工具化后树字节冻结为历史消息，前缀稳定三角（02 §三）不受冲击。

### 2.7 最近改动文件周边树（可选增强，标注不确定性）

在 project_tree 基础上扩展「围绕最近改动文件周边的局部树」：给 `path`/`recentFocus`（如 `focus: "crates/agent-tools"`）参数时，输出该路径子树 + 近 N 小时 mtime 变化文件的高亮（`*` 标记）与排序前置。

**不确定性标注（诚实边界）**：

1. **时间窗口语义未定**：mtime 窗口（近 1 天？近 10 次提交？）与跨平台粒度的取舍未做产品决策；
2. **与缓存指纹冲突**：时间依赖使缓存键需包含「截止时间」维度，弱化 mtime 指纹失效的简化优势（key 膨胀 + 频繁重建）——本方案默认**不缓存 focus 查询**（每次现算，范围受 maxItems 截断保护）或独立 key；
3. **收益未量化**：尚无实测证明高频改动的树视图比 git status / grep_search 更高效，为降低风险列入独立演进项（未排期），首版只做全量树。

---

## 3. 输出清洗（clean_output）设计

### 3.1 清洗规则清单（按规则顺序执行，全部确定性、幂等）

| # | 规则 | 规则细节 | 防误伤护栏 |
|---|---|---|---|
| R1 | 脱 ANSI/控制字符 | CSI（`ESC[` 起 `m`/`K`/`J` 等参数字序列）、OSC、SGR 全类别剥离；C0 控制符除 `\n`/`\t` 外删除 | 状态机实现，字节安全（含多字节字符跨界时不劈裂）；剥离后不改变行结构计数 |
| R2 | 行尾空白 | `trim_end_matches` 每行尾（空格/Tab/`\r`）| 行首前导空白保留（缩进语义）|
| R3 | 空行合并 | 连续空行 → 至多 1 行（命令输出大量空行噪音）；树/表格输出等有意义空行场景由 R 开关（`preserveBlank` 缺省 false）|
| R4 | 重复行合并 | 相邻完全相同的行折叠为 1 行；连续 3 行及以上相同 → `… 重复 N 行 …` 一行标记（对齐截断 marker 文案惯例）| 仅对「完全相等」的行合并；不含子串/模糊 |
| R5 | 超长行截断 | 单行字符 > `maxLineChars`（缺省 2000，缺省值同 read_file 预算口径的 1/100）→ 按 char 边界截前段 + `…(截断 N 字符)…` | 不劈裂多字节字符（复用 tool_output.rs:130-142 的 take_prefix_bytes 字符边界逻辑）|
| R6 | JSON 压缩（可选规则）| text 通道的 JSON 区段（`{` 或 `[` 开头且 >1KB）重序列化 compact（去缩进/空白）；**json 通道本身不再压缩**（`serde_json::to_string` 已 compact，`count_tool_output_tokens` 口径中 json 已按紧凑序列化）| 解析失败原样保留（清洗偏置「宁可不压缩不可破坏」）|

执行的不可变准则：**逐行、行内**处理；不合并不同内容的行、不删行首向缩进、不做重复语义折叠（两处输出内容不同但相同的行保留两次的例外情形由 R4 处理之后由截断管线兜底）。

### 3.2 清洗 vs 截断的执行顺序（管线）

```
工具原始输出（ToolOutput.text）
   ↓ ① clean_output::clean（R1-R6，确定性）
   ↓ ② 复制副本语义（见 §3.3）
   ↓ ③ truncate_tool_output（tool_output.rs:178，head+标记+tail，双阈值）
   → 发往 AI 的单条 tool-result 文本
```

- **清洗在前、截断在后**是唯一正确序：清洗后的字节数才是截断判定的真实输入（先截断再清洗会丢 tail 有效信息）；截断的 `original_bytes`/`tokens_saved` 语义以清洗后文本为基准表述（`estimate_after_truncation` 水位联动不改变，计数以清洗后为准）。
- **管线单点**：接线在 `session-loop/src/loop/handlers/executing_tools.rs:142-160` 的 `tool_result_message`/`tool_output_from_result`（工具结果进消息的唯一转换点）——与 G8 预留的截断接线点同处（tool_output.rs:19 注释「注入时机由调用方（session-loop）接线」尚未落地，本方案两个模块一次接线）。

### 3.3 必须保留原始输出落库，只清洗发往 AI 的副本

- **落库面（不改语义）**：tool-result 消息的 `AgentMessage`（含 `blocks: ToolResult.output`）与 `tool-end` 事件（executing_tools.rs:293-310）保持**原始（未清洗）输出**；DB/事件/回放面永远可见真实字节——诊断与 fine-tune 不丢信（对齐 shell T-AB-03：截断时落库完整原始输出到 `<log_root>/sessions/<session_id>/`，清洗也遵循同一先例）。
- **发 AI 面（清洗副本）**：清洗发生在 wire 序列化之前、消息记录之后的「发给 provider 的单独副本」——即每次 provider 请求构造时对 tool-result 文本跑管线（在请求面做可重复计算）。**清洗必须确定性**（同输入同输出），保证「缓存前缀字节」不因清洗路径不同而漂移。
- 清洗记录携带 `cleaned` 布尔（未清洗时断言副本 == 原文本）。

### 3.4 token 节省量化预估方法

- **口径**：对 N=100 条真实工具输出（shell 命令、build 日志、git 输出等历史 DB 采样），对每条计算 `count_tokens(raw)` 与 `count_tokens(clean)`（复用 conex-compaction/src/lib.rs:882），ε = 1 - cleaned/raw。
- **分量估算法**：对每条规则单独统计——`clean(bytes, [R1])`、`clean(bytes, [R1+R2])`、`clean(bytes, [R1+R2+R3])`…逐条累计得到各规则增量 δ（可加法不成立：R4 与 R1 作用域重叠时取单规则最大增量）。
- 预期量级（来自同类系统经验，标注为估算）：ANSI 剥离 3–8%（构建/测试日志常 200–600 字节/千行 ANSI）；空行合并 2–5%；重复行 5–30%（watch loop 输出/爬虫类命令常见翻倍级别噪音）；超长行截断通常 <1%（只有在 json 单行巨大时显著）；合计典型节约 8–40%，上限场景（ANSI 满屏 + 重复轮播）可达 50%+。
- 落地指标：清洗管线事件携带 `tokensSavedByCleanup`，按月聚合到 cache 遥测；若聚合节约 <5%（绝大多数场景未触发）则考虑默认关闭 R4/R6（规则可控开关，实现时给 0 成本空转路径）。

### 3.5 事件留痕

- 新增 `ToolOutputCleanupRecord`（serde camelCase，与 `ToolOutputTruncationRecord` 同构）：`{cleaned: bool, originalBytes, cleanedBytes, tokensSaved, rulesApplied: {stripAnsi, collapseBlank, dedupLines, jsonCompress}, longLineTruncated}`。
- 落库点位：截断事件字段 `truncated` 旁沿（同一 events 表写入位）；两记录独立写，**不合并字段**（保留职责单一；若未来验收方要求合并进截断记录再改名演进，走 33-event-schema-changelog.md 登记）。

---

## 4. 公共 API 草案

### 4.1 project_tree（agent-tools）

```rust
// crates/agent-tools/src/tools/project_tree.rs（新建）
pub(crate) struct ProjectTreeTool { def: ToolDefinition }   // dangerous:false, fatal_on_error:false

/// 查询参数（工具入参 → 解析出的结构化参数）
pub(crate) struct ProjectTreeParams {
    pub root: PathBuf,                 // resolve_workspace_path 后
    pub depth: usize,                  // 1..=MAX_WALK_DEPTH
    pub include_files: bool,
    pub dirs_only: bool,
    pub exclude_globs: Vec<String>,
    pub max_items: usize,
}

/// 构建结果（text 为树文本，json 为结构化字段）
pub(crate) struct ProjectTreeResult {
    pub text: String,
    pub json: serde_json::Value,       // {root, depth, dirs, files, shown, collapsedNodes, truncated}
    pub cache_hit: bool,               // 命中缓存标记（诊断用）
}

/// 进程级共享缓存（LazyLock<Mutex<HashMap<CacheKey, Arc<CacheEntry>>>>）
pub(crate) struct ProjectTreeCache;
impl ProjectTreeCache {
    pub fn get_or_build(&self, params: &ProjectTreeParams) -> ProjectTreeResult; // mtime 指纹校验
}
```

注册：`mod.rs:115-159`（`register_builtin_tools_with_config`）增加一行
`registry.register(Arc::new(project_tree::ProjectTreeTool::new()))?;`，工具注册数 17→18（mod.rs:698-709 清单测试同步改）。

### 4.2 clean_output（conex-compaction）

```rust
// crates/conex-compaction/src/clean_output.rs（新建，纯函数无运行时依赖，与 tool_output 同层）
pub struct CleanupOptions {
    pub strip_ansi: bool,              // R1
    pub collapse_blank_lines: bool,     // R3
    pub dedup_lines: bool,              // R4
    pub compress_json: bool,            // R6
    pub max_line_chars: usize,          // R5，0 = 关闭
}

pub struct CleanupResult {
    pub text: String,
    pub cleaned: bool,
    pub original_bytes: usize,
    pub after_bytes: usize,
    pub tokens_saved: u64,              // count_tokens 差值（水位联动备用）
    pub lines_removed: usize,           // R3+R4 合计
    pub long_lines_truncated: usize,    // R5 计数
}

pub fn clean_tool_output(text: &str, opts: &CleanupOptions) -> CleanupResult;

/// 留痕记录（camelCase，随清洗动作写入 events 表）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputCleanupRecord { … }
```

接线签名（session-loop 侧，与 G8 截断接线同点）：

```rust
// executing_tools.rs:150 附近
let clean = clean_output::clean_tool_output(raw_text, &cleanup_opts);   // ① 清洗
let trunc = tool_output::truncate_tool_output(&clean.text, &limits);    // ② 截断
// ③ 事件：clean 记录经同一事件路径写 ToolOutputCleanupRecord；落库保持 raw
```

---

## 5. 逐条 task 清单（crate:文件:行号，新增/修改）

| # | 位置 | 动作 | 验收 |
|---|---|---|---|
| T-01 | agent-tools/src/tools/search.rs:26-35 | `SKIP_DIRS` 提为 `pub(crate) const`（供 project_tree 复用，禁重复定义）；补共享注释 | 现有测试不破 |
| T-02 | agent-tools/src/tools/search.rs:319-382 | `walk_files` 拆出公共 `walker_for_root(root, max_depth) -> ignore::Walk`（hidden/git_ignore/git_global/git_exclude/max_depth），project_tree 复用 | grep 行为不变 |
| T-03 | agent-tools/src/tools/project_tree.rs（新建） | 工具实现：参数契约（§2.1）+ 树文本/JSON 双通道 + SKIP_DIRS/excludeGlobs 过滤 + depth 钳制 | 单测（§7） |
| T-04 | agent-tools/src/tools/project_tree.rs（缓存段） | 进程级 `ProjectTreeCache`：参数键 + 目录指纹（mtime+entry_count）+ 锁防并发重复构建；mtime 失效重建 | 单测：touch 后重建、未变不重建、并发共享 |
| T-05 | agent-tools/src/tools/project_tree.rs（token 约束段） | 节点折叠：`maxItems` 截断 + `+N 项` 标记 + 超深目录折叠行 + maxLineChars（对齐 §2.5） | 单测：超限树输出稳定 + truncated 标记 |
| T-06 | agent-tools/src/tools/mod.rs:31-45 | `pub mod project_tree;` 声明 | 编译通过 |
| T-07 | agent-tools/src/tools/mod.rs:115-159（新增注册行） | `register_builtin_tools_with_config` 注册 `ProjectTreeTool`（dangerous=false）；mod.rs:698-709 工具计数清单 17→18 | registry 长度/名单断言更新 |
| T-08 | agent-tools/src/tools/mod.rs:701 附近测试 | 工具清单测试追加 `"project_tree"` | 既有断言全绿 |
| T-09 | conex-compaction/src/clean_output.rs（新建） | R1-R6 六条规则 + `CleanupOptions`/`CleanupResult`/`clean_tool_output`；`ToolOutputCleanupRecord` 留痕结构 | 单测（§7） |
| T-10 | conex-compaction/src/lib.rs:25-28 | `pub mod clean_output;` 声明导出 | 编译通过 |
| T-11 | conex-compaction/src/tool_output.rs:178-288（可选） | 若需要组合 API：`truncate_after_clean(text, limits, opts)`（清洗+截断组合）；纯函数不接监听 | 组合单测 |
| T-12 | session-loop/src/loop/handlers/executing_tools.rs:142-176（接线，本期可选） | 在 `tool_result_message`/`tool_output_from_result` 转副本路径接线 ①clean → ②truncate；**原始输出保持消息/事件原始通道**（清洗只进 wire 副本）；`ToolOutputCleanupRecord` 落库 | 集成测试：wire 文本=清洗+截断，事件原始字节完整 |
| T-13 | 文档 | `docs/rust-rewrite/30-execution-plan.md` 收尾清单登记两模块；`33-event-schema-changelog.md` 登记 CleanupRecord 事件 | 文档更新 |
| T-14 | 可选：`context.rs:90-131` | 若后续缓存不满足（多 daemon），缓存迁移 `ToolContext` 注入（对齐 output_dir 模式）——首版不做，列为演进 | 无 |

---

## 6. 风险

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | project_tree 缓存 mtime 漏判（粒度/覆盖写）| 中 | 指标=树「略旧可接受」（懒语义）；提供 `cacheBypass=true` 参数强制重建；指纹可选升级（hash 累计）|
| 2 | 树非常大时构建本身耗 CPU（数千文件 + 深度 16 上限已钳）| 低 | maxDepth 缺省 3-4；maxItems 缺省 400 强截；构建在工具执行线程内（量级 <100ms 正常仓库）|
| 3 | 清洗规则误伤（R4 重复行合并破坏「重复行有意」的表格式输出）| 中 | R4 仅「完全相等」；3+ 连续相同才折叠；`collapseBlankLines` 等全开关；清洗记录可审计（留痕不丢原始）|
| 4 | 清洗管线未接线前截断先行：顺序颠倒 → 截断后 token 误统计 | 中 | 接线与截断同点（T-12 同一 PR）落一步；接口签名防呆（clean 返回 `cleaned` 标志）|
| 5 | 事件字段登记面（CleanupRecord 是新事件/新字段）| 低 | 走 33-event-schema-changelog.md 登记导入，按台账发布面同步 |
| 6 | 「最近改动文件周边树」mtime 逻辑与缓存指纹冲突 | 中 | 独立演进：首版先砍，做 focus 树时把「围绕 focus 的树」视为独立 key+子树指纹，不与其他子树耦合（见 §8）|

---

## 7. 测试建议（测试清单 + 门禁）

### project_tree 单测（agent-tools）

1. `tree_shape_flat_vs_nested`：深度 1 仅根目录文件；深度 3 嵌套展开正确。
2. `skips_builtin_dirs_reused`：node_modules/.git/target 不出树（复用 SKIP_DIRS：T-01 后断言不复制）。
3. `exclude_globs_and_dirs_only`：dirsOnly 无文件行；excludeGlobs 生效（`**/generated/**`）。
4. `max_items_fold_marker`：节点超限 → `+N` 标记 + `truncated: true` 计数正确。
5. `cache_mtime_invalidation`：构建→不 touch→缓存命中；touch 目录→指纹变→重建且命中 false。
6. `cache_shared_across_params_keyed`：不同 depth/excludeGlobs 不同缓存条目；相同参数返回同 Arc。
7. `depth_clamps_to_max_walk`：入参 depth>16 钳制。
8. `path_escape_and_symlink_rejected`：root 越界 → `tool.path_escape`（复用 resolve_workspace_path 既有测试语义）。

### clean_output 单测（conex-compaction）

1. `ansi_sgr_stripped_and_c0_removed`：`\x1b[31m红\x1b[0m` → `红`；`\x00\x08` 剥离。
2. `blank_lines_collapsed_and_trailing_trimmed`：`a\n\n\n\nb`（R2+R3）→ `a\n\nb`→连空行至多1；`x   ` → `x`（R2 前后序）。
3. `exact_duplicates_folded`：连续相同行1条；`a a a`(3+行) → `a (x2)` 标记。
4. `long_line_truncated_at_char_boundary`：多字节字符不劈裂 + 截断标记。
5. `json_large_reformatted`（R6）：大 JSON 文本重排 compact；非 JSON 原样；坏 JSON 原样。
6. `determinism_byte_exact`：同输入两次 → 逐字节相同（缓存/重放安全）。
7. `clean_truncate_pipeline_integration`（同文件测试）：RAW → clean → truncate 后 token 数 ≤ clean 后 ≤ raw；截断标记计数以清洗后为准。

### 门禁

- agent-tools 既有测试面（`cargo test -p agent-tools`）+ conex-compaction 既有测试（tool_output 相关、水位联动）全绿；`cargo test --workspace` 基线不降。
- 编码纪律：两模块全部中文注释、UTF-8 无 BOM（AGENTS.md 铁律）。

---

## 8. 风险登记与不确定项

表格见 §6；关键条目复述：**「最近改动文件周边树」（可选增强）标注不确定性**（§2.7）——改动定位 / 时间窗口语义 / 指纹耦合三项未定；建议先封版，首版不做（§2.7），按需延伸设计（focus 树作为独立 key+子树指纹，不与其他子树耦合）。

**实施顺序建议**：T-01→T-08（project_tree 工具）+ T-09→T-10（清洗规则）任选其一先行；接线 T-12 与截断接线同一 PR；project_tree 不阻塞清洗接线，两模块无相互依赖。

---

（完）