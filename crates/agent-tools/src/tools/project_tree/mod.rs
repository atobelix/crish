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
use crate::tools::search::MAX_WALK_DEPTH;
use crate::tools::{
    display_path, optional_bool, optional_string, optional_u64, resolve_workspace_path,
};
use async_trait::async_trait;

mod build;
mod cache;
mod params;
mod render;
#[cfg(test)]
mod tests;

use cache::TreeCache;
use params::ProjectTreeParams;
use render::render_tree;

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
