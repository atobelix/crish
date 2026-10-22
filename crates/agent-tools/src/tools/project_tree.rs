//! project_tree 工具（T-38，00-plan §8.1 / 03 分析 §2 / 11 测试 11）
//!
//! 定位：目录树工具化（02 分析 §4.3 缓存经济学：树只作为工具结果历史
//! 消息进入前缀，绝不注入每轮 user/system 文本）。进程级懒构建缓存 +
//! 目录指纹（mtime + entry_count）失效 + 同键构建去重，主 agent 与
//! 子 agent（run_subagent 同进程）共享。
//!
//! 参数契约（v1.1 §8.1）：
//! - `path`：树根（缺省工作区根），经 resolve_workspace_path 校验越界
//! - `depth`：递归深度（缺省 3，钳制上界 MAX_WALK_DEPTH=16）
//! - `includeFiles`（缺省 true）/ `dirsOnly`（缺省 false，两者并存时
//!   dirsOnly 优先）
//! - `excludeGlobs`：排除式 glob（缺省空，判定优先级与 grep_search
//!   一致：excludeGlobs > SKIP_DIRS > 包含过滤；命中目录整枝剪除）
//! - `maxItems`（缺省 400）/ `maxDepthContent`（缺省 4，超深目录折叠行）
//!
//! 输出：树形文本（`├──/└──/│` 前缀，目录优先 + 字母序，行宽 ≤120），
//! 以及 JSON 计数（root/depth/dirs/files/shown/collapsedNodes/truncated/
//! cacheHit）。折叠不变量为「shown + collapsedNodes = dirs + files」——
//! 被折叠的信息总量 = collapsedNodes 计数，AI 可据计数决定是否加深
//! 重查，绝不静默丢弃。`focus` 子路径聚焦为增强项（03 §2.7 不确定
//! 性：时间依赖冲击 mtime 指纹缓存语义），V1 不做。
//!
//! 缓存（进程级 LazyLock<TreeCache>）：
//! - 键 = (canonical_root, depth, include_files, exclude_globs 排序后)；
//!   maxItems / maxDepthContent 为**渲染期**参数不进键（树结构一次
//!   构建、按请求渲染折叠，见 build 与 render 分离）；
//! - 值 = 树节点 + 目录指纹表（dir mtime_ns + readdir 条目数）；
//! - 失效：只 re-stat 指纹目录（毫秒级）；指纹不匹配 → 整体重建。
//!   **V1 取舍：不做子树级重建**（03 §2.2 的目录级粒度标注为演进项）——
//!   重建代价为一次目录遍历（默认 depth 3 的正常仓库 <100ms），
//!   正确性优先；
//! - 并发：**条目级锁**（P2-4 落地）——cells: HashMap<CacheKey,
//!   Arc<Mutex<Option<Arc<TreeEntry>>>>>，同键构建持该键 cell 锁去重
//!   （后到者等待复用），不同键互不阻塞（各自 cell 独立），避免
//!   整表互斥；
//! - 已知误差（诚实标注，03 §2.2/§6 风险 1）：mtime 粒度不足或「内容
//!   覆盖但 mtime 不变」的 edge case 会漏判 → 树略旧（读语义可接受，
//!   模型可 git 二次查证）；目录条目数变化（增删改名）恒检出。
//!
//! 指纹语义：fingerprint = (dir mtime_ns, readdir 条目数)。readdir 计
//! 数含隐藏/被剪枝条目（粗粒度）：隐藏文件增删触发重建（无害）；任何
//! 影响树形状的变动恒被检出。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::search::{glob_match, walker_for_root, MAX_WALK_DEPTH, SKIP_DIRS};
use crate::tools::{
    display_path, optional_bool, optional_string, optional_u64, resolve_workspace_path,
};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

/// 缺省深度（03 §2.1：3，1-based）
const DEFAULT_DEPTH: usize = 3;
/// 缺省节点总数上限（token 约束）
const DEFAULT_MAX_ITEMS: usize = 400;
/// 缺省内容文件深度上限（超过该深度的目录以 (+N) 统计行替代展开）
const DEFAULT_MAX_DEPTH_CONTENT: usize = 4;
/// 单行字符上限（对齐 CleanupOptions.max_line_width=120；char 边界截断）
const MAX_LINE_CHARS: usize = 120;

/// project_tree 工具（dangerous=false，只读，进子 agent 只读集）
pub(crate) struct ProjectTreeTool {
    def: ToolDefinition,
}

impl ProjectTreeTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "project_tree".to_string(),
                description: "输出工作区目录树（树形文本 + JSON 计数）：目录优先 + 字母序，内置排除 node_modules/.git/target 等目录（SKIP_DIRS），支持 excludeGlobs 排除式 glob；懒构建 + mtime 指纹缓存（同参数二次调用零扫描）。树只作为工具结果进入历史消息，绝不被注入每轮对话。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "树根目录，缺省为工作区根" },
                        "depth": { "type": "number", "description": "递归深度，默认 3，上限 16（超限钳制）" },
                        "includeFiles": { "type": "boolean", "description": "是否列出文件，缺省 true" },
                        "dirsOnly": { "type": "boolean", "description": "只输出目录骨架，缺省 false（与 includeFiles 并存时本参数优先）" },
                        "excludeGlobs": { "type": "array", "items": { "type": "string" }, "description": "排除式 glob 列表（如 **/generated/**），命中目录整枝剪除；判定优先级高于内置目录排除" },
                        "maxItems": { "type": "number", "description": "输出节点总数上限（含折叠），默认 400；超限以折叠行收尾并置 truncated" },
                        "maxDepthContent": { "type": "number", "description": "内容文件深度上限，默认 4；超过该深度的目录以 (+N 项) 统计行替代展开" }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

/// 工具入参（解析 + 校验 + 钳制后的结构化参数）
#[derive(Clone)]
struct ProjectTreeParams {
    /// resolve_workspace_path 规范化后的树根（canonical）
    root: PathBuf,
    /// 树根显示名（display_path 语义；与缓存无关，渲染期用）
    root_display: String,
    /// 递归深度（已钳制 1..=MAX_WALK_DEPTH）
    depth: usize,
    /// 是否列出文件（dirsOnly 已折叠进本字段：false = 只目录）
    include_files: bool,
    /// 排除式 glob（已排序，参与缓存键）
    exclude_globs: Vec<String>,
    /// 渲染期节点总数上限（不进缓存键）
    max_items: usize,
    /// 渲染期超深目录折叠起点（不进缓存键）
    max_depth_content: usize,
}

/// 树节点（构建期完成排序与子树大小计算，渲染期只读）
struct TreeNode {
    name: String,
    is_dir: bool,
    /// 子树节点总数（含自身；折叠计数用）
    size: usize,
    /// 直接子节点（目录优先 + 字母序）
    children: Vec<TreeNode>,
}

/// 缓存条目 = 树结构 + 目录指纹表（dir mtime_ns, readdir 条目数）
struct TreeEntry {
    /// 树根显示名（相对工作区；供根行与 JSON root 字段）
    root_display: String,
    /// 树根是否为目录（path 指向文件时树退化为单行）
    root_is_dir: bool,
    /// 根的直接子节点（排序完成）
    children: Vec<TreeNode>,
    /// 树内目录数（不含根）
    dirs: usize,
    /// 树内文件数（root 为文件时计 1）
    files: usize,
    /// 目录指纹：可见目录 → (mtime_ns, readdir 条目数)
    fingerprints: HashMap<PathBuf, (u64, usize)>,
}

/// 缓存键（excludeGlobs 排序后入键，避免顺序抖动）
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    root: PathBuf,
    depth: usize,
    include_files: bool,
    exclude_globs: Vec<String>,
}

/// 条目级缓存单元格（同键构建持本锁去重，不同键互不阻塞——P2-4）
type CacheCell = Arc<Mutex<Option<Arc<TreeEntry>>>>;

/// 进程级缓存（条目级锁：同键构建持 cell 锁去重，不同键并行）
struct TreeCache {
    cells: Mutex<HashMap<CacheKey, CacheCell>>,
}

static TREE_CACHE: LazyLock<TreeCache> = LazyLock::new(|| TreeCache {
    cells: Mutex::new(HashMap::new()),
});

impl TreeCache {
    /// 取或构建：返回 (条目, 是否缓存命中)。
    ///
    /// 条目级锁语义（P2-4）：先经外层 cells 表取/建 `Arc<Mutex<Option<...>>>`
    /// 单元格（不同键不同 cell），再持 cell 锁做指纹校验与构建——同键
    /// 并发调用串行（后到者等待并复用），不同键完全并行。构建在 cell
    /// 锁内同步完成（目录遍历量级毫秒，无 await，无死锁风险）。
    fn get_or_build(params: &ProjectTreeParams) -> (Arc<TreeEntry>, bool) {
        let key = CacheKey {
            root: params.root.clone(),
            depth: params.depth,
            include_files: params.include_files,
            exclude_globs: params.exclude_globs.clone(),
        };
        let cell = {
            let mut cells = TREE_CACHE
                .cells
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            cells
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut slot = cell
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = slot.as_ref() {
            if fingerprints_valid(entry) {
                return (Arc::clone(entry), true);
            }
        }
        let entry = Arc::new(build_tree(params));
        *slot = Some(Arc::clone(&entry));
        (entry, false)
    }
}

/// 指纹校验：只 re-stat 指纹表内目录（元数据 + readdir 计数），零 IO 扫描。
///
/// 任一日录 mtime 或条目数变化 → 视为失效 → 整体重建（V1 取舍见模块头）。
fn fingerprints_valid(entry: &TreeEntry) -> bool {
    entry.fingerprints.iter().all(|(dir, (mtime, count))| {
        let m = dir_mtime_ns(dir);
        let c = std::fs::read_dir(dir).map(|rd| rd.count()).unwrap_or(0);
        m == *mtime && c == *count
    })
}

/// 目录 mtime 纪元纳秒（stat 失败回退 0——与记录期同口径，恒不匹配则重建）
fn dir_mtime_ns(dir: &Path) -> u64 {
    std::fs::metadata(dir)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// 排除式 glob 判定（对齐 search.rs 语义：无 `/` 的模式匹配末段文件名）
fn glob_excluded(patterns: &[String], rel_str: &str) -> bool {
    patterns.iter().any(|pattern| {
        if pattern.contains('/') {
            glob_match(pattern, rel_str)
        } else {
            glob_match(pattern, rel_str.rsplit('/').next().unwrap_or(rel_str))
        }
    })
}

/// 目录级排除判定（子树模式语义，T-38 扩展）：以 `/**` 结尾的模式按
/// 前缀匹配目录自身即整枝剪除（grep_search 只对文件判定，树需要目录级
/// 剪枝面：`**/generated/**` 剪除整个 generated 子树）；其余模式回退
/// [glob_excluded] 逐文件语义（目录保留、命中文件剔除，与 search 一致）。
///
/// 已知近似（诚实标注）：`a/**` 形式的模式按目录名匹配（任意深度同名
/// 目录剪除），与 gitignore 的深度语义有出入——文件级匹配恒精确。
fn dir_glob_excluded(patterns: &[String], rel_str: &str) -> bool {
    patterns.iter().any(|pattern| {
        if let Some(prefix) = pattern.strip_suffix("/**") {
            if prefix.is_empty() {
                return true; // "/**" 裸子树模式：剪除一切
            }
            if prefix.contains('/') {
                return glob_match(prefix, rel_str);
            }
            return glob_match(prefix, rel_str.rsplit('/').next().unwrap_or(rel_str));
        }
        if pattern.contains('/') {
            glob_match(pattern, rel_str)
        } else {
            glob_match(pattern, rel_str.rsplit('/').next().unwrap_or(rel_str))
        }
    })
}

/// 构建树（一次前序遍历；SKIP_DIRS 由 walker_for_root 目录级剪枝，
/// excludeGlobs 由本函数跟踪已排除目录集合剪枝）。
///
/// 栈式组装：`stack[k]` 承载「深度 k 的最后一个目录」的子节点缓冲，
/// walker 前序保证子节点在父之后连续到达，出栈时把缓冲挂回父节点并
/// 完成排序与 size 累计（自底向上）。已排除目录不入栈也不进树，其后代
/// 由排除集合跳过——栈深度不依赖被剪枝子树，天然对齐。
fn build_tree(params: &ProjectTreeParams) -> TreeEntry {
    let root_is_dir = std::fs::metadata(&params.root)
        .map(|m| m.is_dir())
        .unwrap_or(true);
    let mut stack: Vec<Vec<TreeNode>> = vec![Vec::new()];
    let mut fingerprints: HashMap<PathBuf, (u64, usize)> = HashMap::new();
    let mut excluded: HashSet<PathBuf> = HashSet::new();
    let mut dirs = 0usize;
    let mut files = if root_is_dir { 0 } else { 1 };

    if root_is_dir {
        // 根目录自身指纹（根内容变动恒检出）
        fingerprints.insert(
            params.root.clone(),
            (
                dir_mtime_ns(&params.root),
                std::fs::read_dir(&params.root)
                    .map(|rd| rd.count())
                    .unwrap_or(0),
            ),
        );
        for entry in walker_for_root(&params.root, params.depth, SKIP_DIRS).flatten() {
            let path = entry.path().to_path_buf();
            let rel = path.strip_prefix(&params.root).unwrap_or(&path);
            let depth_rel = rel.components().count();
            if depth_rel == 0 {
                continue; // 根条目自身（指纹已记录）；空子树缓冲留在栈底
            }
            // 位于已排除子树内：跳过（含该目录自身与其全部后代）
            if excluded.iter().any(|ex| path.starts_with(ex)) {
                continue;
            }
            // 栈对齐到当前深度（前序：深度先升后降），出栈缓冲挂回父节点
            while stack.len() > depth_rel {
                let Some(done) = stack.pop() else {
                    break;
                };
                if let Some(parent) = stack.last_mut().and_then(|lv| lv.last_mut()) {
                    parent.children.extend(done);
                    sort_and_finalize(&mut parent.children);
                    parent.size = 1 + parent.children.iter().map(|c| c.size).sum::<usize>();
                }
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if is_dir {
                // 排除式 glob 命中目录 → 整枝剪除（子树跳过，不入栈）
                if dir_glob_excluded(&params.exclude_globs, &rel_str) {
                    excluded.insert(path);
                    continue;
                }
                fingerprints.insert(
                    path.clone(),
                    (
                        dir_mtime_ns(&path),
                        std::fs::read_dir(&path).map(|rd| rd.count()).unwrap_or(0),
                    ),
                );
                dirs += 1;
                if let Some(last) = stack.last_mut() {
                    last.push(TreeNode {
                        name,
                        is_dir: true,
                        size: 1,
                        children: Vec::new(),
                    });
                }
                stack.push(Vec::new());
            } else if params.include_files {
                if glob_excluded(&params.exclude_globs, &rel_str) {
                    continue;
                }
                files += 1;
                if let Some(last) = stack.last_mut() {
                    last.push(TreeNode {
                        name,
                        is_dir: false,
                        size: 1,
                        children: Vec::new(),
                    });
                }
            }
        }
    }
    // 收尾：逐层出栈挂载（自底向上完成排序与 size）
    while stack.len() > 1 {
        let Some(done) = stack.pop() else {
            break;
        };
        if let Some(parent) = stack.last_mut().and_then(|lv| lv.last_mut()) {
            parent.children.extend(done);
            sort_and_finalize(&mut parent.children);
            parent.size = 1 + parent.children.iter().map(|c| c.size).sum::<usize>();
        }
    }
    let mut children = stack.pop().unwrap_or_default();
    sort_and_finalize(&mut children);
    TreeEntry {
        root_display: params.root_display.clone(),
        root_is_dir,
        children,
        dirs,
        files,
        fingerprints,
    }
}

/// 排序（目录优先 + 字母序）——确定性决定树文本字节（缓存命中面稳定）
fn sort_and_finalize(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
}

/// 渲染结果（文本 + 计数，单一权威面：JSON 与摘要行同源）
struct RenderOutcome {
    text: String,
    shown: usize,
    collapsed: usize,
    truncated: bool,
}

/// 渲染树文本 + 折叠（maxItems / maxDepthContent 均为渲染期参数）。
///
/// 折叠不变量：shown + collapsed = 树内全部节点（dirs + files）——
/// 折叠行的 `(+N)` 只作标记不计入 shown，被折叠节点恒计入 collapsed。
fn render_tree(entry: &TreeEntry, params: &ProjectTreeParams) -> RenderOutcome {
    let mut st = RenderState {
        out: Vec::new(),
        shown: 0,
        collapsed: 0,
        truncated: false,
        budget: params.max_items,
        max_depth_content: params.max_depth_content,
    };
    let root_line = if entry.root_is_dir {
        format!("{}/", entry.root_display)
    } else {
        entry.root_display.clone()
    };
    st.out.push(root_line);
    if !entry.children.is_empty() {
        render_children(&mut st, "", &entry.children, 1);
    }
    let shown = st.shown;
    let collapsed = st.collapsed;
    let truncated = st.truncated;
    debug_assert_eq!(
        shown + collapsed,
        entry.dirs + entry.files,
        "折叠不变量：shown + collapsedNodes = dirs + files"
    );
    st.out.push(String::new());
    st.out.push(format!("root: {}", entry.root_display));
    st.out.push(format!("depth: {}", params.depth));
    st.out.push(format!(
        "dirs: {}, files: {}, shown: {}, collapsedNodes: {}, truncated: {}",
        entry.dirs, entry.files, shown, collapsed, truncated
    ));
    RenderOutcome {
        text: st.out.join("\n"),
        shown,
        collapsed,
        truncated,
    }
}

/// 渲染期状态
struct RenderState {
    out: Vec<String>,
    shown: usize,
    collapsed: usize,
    truncated: bool,
    budget: usize,
    max_depth_content: usize,
}

/// 渲染一层子节点（`depth` = 本层节点的显示深度，根的直接子节点 = 1）
fn render_children(st: &mut RenderState, prefix: &str, nodes: &[TreeNode], depth: usize) {
    let n = nodes.len();
    for (i, node) in nodes.iter().enumerate() {
        if st.shown >= st.budget {
            // maxItems 预算耗尽：本层剩余节点（含各自子树）折叠
            let rest: usize = nodes[i..].iter().map(|nd| nd.size).sum();
            st.collapsed += rest;
            st.truncated = true;
            let last = i == n - 1;
            let branch = if last { "└── " } else { "├── " };
            st.out
                .push(format!("{prefix}{branch}... (+{rest} 项未展开)"));
            return;
        }
        let last = i == n - 1;
        let branch = if last { "└── " } else { "├── " };
        // 行宽约束（≤120）作用于整行：前缀 + 分支 + 名称（char 边界）
        let prefix_chars = prefix.chars().count();
        let name_budget = MAX_LINE_CHARS.saturating_sub(prefix_chars + 4);
        let name = truncate_name(&node.name, name_budget);
        let deep_fold = node.is_dir && depth > st.max_depth_content && !node.children.is_empty();
        if deep_fold {
            // 超深目录：以 (+N) 统计行替代展开（N = 该目录子树节点数 - 自身）
            let cnt = node.size - 1;
            st.collapsed += cnt;
            st.out.push(format!("{prefix}{branch}{name}/ (+{cnt} 项)"));
            st.shown += 1;
        } else {
            let suffix = if node.is_dir { "/" } else { "" };
            st.out.push(format!("{prefix}{branch}{name}{suffix}"));
            st.shown += 1;
            if node.is_dir && !node.children.is_empty() {
                let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
                render_children(st, &child_prefix, &node.children, depth + 1);
            }
        }
    }
}

/// 单行超宽截断：整行（前缀+分支+名称）不得超 [MAX_LINE_CHARS]，
/// 名称预算按 char 边界截断，超限取预算 - 1 + `…`
fn truncate_name(name: &str, budget: usize) -> String {
    let len = name.chars().count();
    if len <= budget {
        return name.to_string();
    }
    if budget == 0 {
        return "…".to_string();
    }
    let head: String = name.chars().take(budget - 1).collect();
    format!("{head}…")
}

#[async_trait]
impl Tool for ProjectTreeTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let path_str = optional_string(&args, "path").unwrap_or_else(|| ".".to_string());
        let root = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let root_display = display_path(&ctx.workspace_root, &root);
        let depth = (optional_u64(&args, "depth").unwrap_or(DEFAULT_DEPTH as u64) as usize)
            .clamp(1, MAX_WALK_DEPTH);
        let include_files = optional_bool(&args, "includeFiles").unwrap_or(true);
        let dirs_only = optional_bool(&args, "dirsOnly").unwrap_or(false);
        // dirsOnly 与 includeFiles 并存时 dirsOnly 优先（03 §2.1）
        let include_files = include_files && !dirs_only;
        let mut exclude_globs: Vec<String> = args
            .get("excludeGlobs")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        exclude_globs.sort();
        let max_items =
            optional_u64(&args, "maxItems").unwrap_or(DEFAULT_MAX_ITEMS as u64) as usize;
        let max_depth_content = optional_u64(&args, "maxDepthContent")
            .unwrap_or(DEFAULT_MAX_DEPTH_CONTENT as u64) as usize;

        let params = ProjectTreeParams {
            root,
            root_display,
            depth,
            include_files,
            exclude_globs,
            max_items,
            max_depth_content,
        };
        // U-BLOCK：目录树构建经 spawn_blocking
        let (entry, cache_hit) = {
            let params = params.clone();
            tokio::task::spawn_blocking(move || TreeCache::get_or_build(&params))
                .await
                .map_err(|e| {
                    ToolError::execution_failed("project_tree", format!("spawn_blocking: {e}"))
                })?
        };
        let render = render_tree(&entry, &params);
        Ok(serde_json::json!({
            "root": entry.root_display,
            "depth": params.depth,
            "dirs": entry.dirs,
            "files": entry.files,
            "shown": render.shown,
            "collapsedNodes": render.collapsed,
            "truncated": render.truncated,
            "cacheHit": cache_hit,
            "text": render.text,
        }))
    }
}

#[cfg(test)]
mod tests {
    // G2 测试面：临时工作区清理（删除测试目录内文件，非产品删除路径，
    // 可恢复语义不适用）——对齐 clippy.toml 豁免面（测试临时目录清理）
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::context::{create_mock_tool_context, ToolContext};
    use conex_test_utils::TempWorkspace;

    /// 测试用会话上下文：workspace_root 指向临时工作区
    fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        }
    }

    fn sample_ws() -> TempWorkspace {
        let ws = TempWorkspace::new("ptree_shape");
        ws.write_file("src/main.rs", "fn main() {}\n");
        ws.write_file("src/lib.rs", "pub fn x() {}\n");
        ws.write_file("docs/readme.md", "# doc\n");
        ws.write_file("Cargo.toml", "[package]\n");
        ws
    }

    /// 取树文本（含根行与摘要行的完整文本）
    fn tree_text(out: &serde_json::Value) -> String {
        out["text"].as_str().unwrap().to_string()
    }

    /// 只取树体行（去掉根行与尾部摘要块）
    fn tree_body(out: &serde_json::Value) -> Vec<String> {
        let text = tree_text(out);
        text.lines()
            .skip(1)
            .take_while(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect()
    }

    #[tokio::test]
    async fn tree_shape_dirs_first_sorted_prefixes() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        let text = tree_text(&out);
        let lines: Vec<&str> = text.lines().collect();
        // 首行为根行（根名 + /）
        assert!(lines[0].ends_with('/'), "根行应为根名 + /: {}", lines[0]);
        let body = tree_body(&out);
        // 目录优先 + 字母序（渲染为深度优先：目录行后紧跟其子树）：
        // docs/ → readme.md；src/ → lib.rs main.rs；最后根级文件 Cargo.toml
        assert!(body[0].starts_with("├── docs/"), "got {}", body[0]);
        // docs 非最后兄弟 → 其子树前缀 │
        assert!(body[1].starts_with("│   └── readme.md"), "got {}", body[1]);
        assert!(body[2].starts_with("├── src/"), "got {}", body[2]);
        assert!(body[3].starts_with("│   ├── lib.rs"), "got {}", body[3]);
        assert!(body[4].starts_with("│   └── main.rs"), "got {}", body[4]);
        assert!(body[5].starts_with("└── Cargo.toml"), "got {}", body[5]);
        // JSON 计数：docs/src 2 目录 + main/lib/readme/Cargo 4 文件 = 6 节点
        assert_eq!(out["dirs"], 2);
        assert_eq!(out["files"], 4);
        assert_eq!(out["shown"], 6);
        assert_eq!(out["collapsedNodes"], 0);
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn skips_builtin_dirs_reused() {
        let ws = TempWorkspace::new("ptree_skip");
        ws.write_file("src/a.rs", "x");
        ws.write_file("node_modules/pkg/index.js", "x");
        ws.write_file("target/debug/app.exe", "x");
        ws.write_file("dist/bundle.js", "x");
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        let text = tree_text(&out);
        // SKIP_DIRS 复用：node_modules/target/dist 整枝不出树（src 正常）
        assert!(!text.contains("node_modules"), "{text}");
        assert!(!text.contains("target"), "{text}");
        assert!(!text.contains("dist"), "{text}");
        assert!(text.contains("src/"), "{text}");
        assert_eq!(out["dirs"], 1);
        assert_eq!(out["files"], 1);
    }

    #[tokio::test]
    async fn dirs_only_excludes_files() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "dirsOnly": true }),
            )
            .await
            .unwrap();
        let text = tree_text(&out);
        assert!(!text.contains("main.rs"), "{text}");
        assert!(!text.contains("Cargo.toml"), "{text}");
        assert!(text.contains("src/"), "{text}");
        assert_eq!(out["files"], 0);
        assert_eq!(out["dirs"], 2);
        assert_eq!(out["shown"], 2);
    }

    #[tokio::test]
    async fn include_files_false_equals_dirs_only() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "includeFiles": false }),
            )
            .await
            .unwrap();
        assert_eq!(out["files"], 0);
        assert_eq!(out["shown"], 2);
        // dirsOnly=true 折叠到同一参数面（同一缓存键）→ 同文本
        let out2 = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "dirsOnly": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["text"], out2["text"]);
        assert_eq!(out2["cacheHit"], true, "同一参数面应命中缓存");
    }

    #[tokio::test]
    async fn exclude_globs_prunes_subtree() {
        let ws = TempWorkspace::new("ptree_exclude");
        ws.write_file("src/generated/gen.rs", "x");
        ws.write_file("src/generated/extra/deep.rs", "x");
        ws.write_file("src/keep.rs", "x");
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "excludeGlobs": ["**/generated/**"] }),
            )
            .await
            .unwrap();
        let text = tree_text(&out);
        assert!(
            !text.contains("generated"),
            "整枝剪除：generated 子树不出树: {text}"
        );
        assert!(text.contains("keep.rs"), "{text}");
        assert_eq!(out["dirs"], 1);
        assert_eq!(out["files"], 1);
    }

    #[tokio::test]
    async fn exclude_globs_file_pattern_skips_files_keeps_dir() {
        let ws = TempWorkspace::new("ptree_exclude_file");
        ws.write_file("src/generated/gen.rs", "x");
        ws.write_file("src/keep.rs", "x");
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "excludeGlobs": ["**/generated/*.rs"] }),
            )
            .await
            .unwrap();
        let text = tree_text(&out);
        // 文件级 glob：目录保留、命中文件剔除（对齐 grep_search 语义）
        assert!(text.contains("generated/"), "{text}");
        assert!(!text.contains("gen.rs"), "{text}");
        assert!(text.contains("keep.rs"), "{text}");
        assert_eq!(out["files"], 1);
    }

    #[tokio::test]
    async fn depth_clamped_to_max_walk() {
        let ws = TempWorkspace::new("ptree_clamp");
        ws.write_file("a/b/c/d/e/f.txt", "x");
        let tool = ProjectTreeTool::new();
        // depth=999 钳制到 MAX_WALK_DEPTH=16：不报错、输出 depth 字段为 16；
        // maxDepthContent 调高避免折叠遮挡断言目标
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 999, "maxDepthContent": 16 }),
            )
            .await
            .unwrap();
        assert_eq!(out["depth"], 16);
        assert!(
            tree_text(&out).contains("f.txt"),
            "树应包含 f.txt:\n{}",
            tree_text(&out)
        );
    }

    #[tokio::test]
    async fn path_escape_rejected() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let err = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "path": "../escape" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
    }

    #[tokio::test]
    async fn path_subdir_trees_from_that_root() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "path": "src", "depth": 16 }),
            )
            .await
            .unwrap();
        let text = tree_text(&out);
        assert!(text.contains("main.rs"), "{text}");
        assert!(!text.contains("docs"), "{text}");
        assert_eq!(out["dirs"], 0);
        assert_eq!(out["files"], 2);
    }

    #[tokio::test]
    async fn max_items_folds_with_marker_and_counts() {
        let ws = TempWorkspace::new("ptree_maxitems");
        for i in 0..10 {
            ws.write_file(&format!("a/f{i}.txt"), "x");
        }
        ws.write_file("b/g.txt", "x");
        ws.write_file("b/h.txt", "x");
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "maxItems": 4 }),
            )
            .await
            .unwrap();
        let text = tree_text(&out);
        assert!(text.contains("项未展开"), "超限应输出折叠行: {text}");
        assert!(text.contains("truncated: true"));
        assert_eq!(out["truncated"], true);
        // 折叠不变量：shown + collapsedNodes = dirs + files
        let dirs = out["dirs"].as_u64().unwrap();
        let files = out["files"].as_u64().unwrap();
        let shown = out["shown"].as_u64().unwrap();
        let collapsed = out["collapsedNodes"].as_u64().unwrap();
        assert_eq!(shown + collapsed, dirs + files);
        assert!(collapsed > 0);
        // 头部稳定：预算内节点照常渲染
        assert!(text.contains("a/"), "{text}");
        assert!(text.contains("f0.txt"), "{text}");
    }

    #[tokio::test]
    async fn max_items_budget_respects_subtree_sizes() {
        let ws = TempWorkspace::new("ptree_budget");
        ws.write_file("a/x1.txt", "x");
        ws.write_file("a/x2.txt", "x");
        ws.write_file("a/x3.txt", "x");
        ws.write_file("b/y1.txt", "x");
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "maxItems": 3 }),
            )
            .await
            .unwrap();
        // 树共 2 目录 + 4 文件 = 6 节点；预算 3：a/ x1 x2 渲染，其余 3 折叠
        assert_eq!(out["shown"], 3);
        assert_eq!(out["collapsedNodes"], 3);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn max_depth_content_folds_deep_dirs() {
        let ws = TempWorkspace::new("ptree_deepfold");
        ws.write_file("a/b/c/d/e.txt", "x");
        let tool = ProjectTreeTool::new();
        // maxDepthContent=2：显示深度 3 及以上的目录折叠为 (+N 项)
        let out = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "maxDepthContent": 2 }),
            )
            .await
            .unwrap();
        let text = tree_text(&out);
        // 树：a(深1) b(深2) 展开；c(深3) 折叠 → c 子树 = c+d+e 共 3 节点，
        // (+N) 统计 = 子树节点数 - 自身 = 2
        assert!(text.contains("c/ (+2 项)"), "深度 3 目录应折叠: {text}");
        assert!(!text.contains("d/"), "折叠目录子树不出树: {text}");
        assert!(text.contains("a/"), "{text}");
        // 不变量：shown + collapsed = dirs + files
        let shown = out["shown"].as_u64().unwrap();
        let collapsed = out["collapsedNodes"].as_u64().unwrap();
        assert_eq!(
            shown + collapsed,
            out["dirs"].as_u64().unwrap() + out["files"].as_u64().unwrap()
        );
        assert_eq!(collapsed, 2, "c/d 两节点折叠, got {collapsed}");
        assert_eq!(shown, 3, "a/b/c 三行渲染, got {shown}");
    }

    #[tokio::test]
    async fn cache_reused_for_same_params_and_hit_flag() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let args = serde_json::json!({ "depth": 16 });
        let first = tool.execute(&mock_ctx(&ws), args.clone()).await.unwrap();
        assert_eq!(first["cacheHit"], false);
        let second = tool.execute(&mock_ctx(&ws), args).await.unwrap();
        assert_eq!(second["cacheHit"], true);
        assert_eq!(first["text"], second["text"], "缓存命中输出逐字节一致");
    }

    #[tokio::test]
    async fn cache_keyed_by_params() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let d1 = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 1 }))
            .await
            .unwrap();
        assert_eq!(d1["cacheHit"], false);
        // 不同参数（depth）→ 不同缓存条目：重新构建
        let d16 = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        assert_eq!(d16["cacheHit"], false);
        assert!(d1["text"].as_str().unwrap() != d16["text"].as_str().unwrap());
        // 参数复归 → 命中原条目
        let d1_again = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 1 }))
            .await
            .unwrap();
        assert_eq!(d1_again["cacheHit"], true);
        assert_eq!(d1["text"], d1_again["text"]);
    }

    #[tokio::test]
    async fn cache_keyed_by_exclude_globs_order() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let a = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "excludeGlobs": ["**/docs/**", "**/src/**"] }),
            )
            .await
            .unwrap();
        // 同一集合不同顺序 → 同一键（排序后 join）：第二次命中
        let b = tool
            .execute(
                &mock_ctx(&ws),
                serde_json::json!({ "depth": 16, "excludeGlobs": ["**/src/**", "**/docs/**"] }),
            )
            .await
            .unwrap();
        assert_eq!(b["cacheHit"], true);
        assert_eq!(a["text"], b["text"]);
    }

    #[tokio::test]
    async fn cache_invalidates_when_file_added() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let first = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        assert_eq!(first["cacheHit"], false);
        let hit = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        assert_eq!(hit["cacheHit"], true);
        // 新增文件 → 父目录条目数变化 → 指纹失效 → 重建
        ws.write_file("src/new_file.rs", "x");
        let after = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        assert_eq!(after["cacheHit"], false, "指纹变化应触发重建");
        assert!(tree_text(&after).contains("new_file.rs"));
        assert_eq!(after["files"], 5);
        // 再次调用恢复命中
        let hit2 = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        assert_eq!(hit2["cacheHit"], true);
    }

    #[tokio::test]
    async fn cache_invalidates_when_file_removed() {
        let ws = sample_ws();
        let tool = ProjectTreeTool::new();
        let _ = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        std::fs::remove_file(ws.path().join("docs/readme.md")).unwrap();
        let after = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        assert_eq!(after["cacheHit"], false);
        assert!(!tree_text(&after).contains("readme.md"));
        assert_eq!(after["files"], 3);
    }

    #[tokio::test]
    async fn line_width_truncated_at_char_boundary() {
        let ws = TempWorkspace::new("ptree_wide");
        let long_name = "超长文件名".repeat(50); // 250 chars
        ws.write_file(&format!("{long_name}.txt"), "x");
        let tool = ProjectTreeTool::new();
        let out = tool
            .execute(&mock_ctx(&ws), serde_json::json!({ "depth": 16 }))
            .await
            .unwrap();
        let text = tree_text(&out);
        let max_line = text.lines().map(|l| l.chars().count()).max().unwrap_or(0);
        assert!(
            max_line <= MAX_LINE_CHARS,
            "树行不得超宽，got {max_line} > {MAX_LINE_CHARS}"
        );
        assert!(text.contains('…'), "超宽行应截断并带省略号");
    }
}
