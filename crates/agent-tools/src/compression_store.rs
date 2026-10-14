//! 压缩块只读访问契约（T-40，00-plan §7.3 依赖注入 / 评审 02 ⑥6.1）
//!
//! agent-tools 是叶子 crate，生产代码不依赖 conex-db（Cargo.toml 注释
//! 明文「生产代码保持叶子依赖，接线在引擎侧完成」）。search_context /
//! decompress_context 对压缩块（compression_blocks 表）的访问**必须**走
//! 本 trait 注入：agent-tools 只定义契约，引擎侧（conex-db / orchestrator）
//! 实现 [CompressionContextStore] 并经 [crate::context::ToolContext] 装配。
//!
//! 语义边界（00-plan §7.1/7.2 + 01 分析 §2.3）：
//! - 只读：本契约无任何写面（不替换对话、不动前缀）；
//! - **会话作用域由实现方绑定**（session_id 入参贯穿两个方法）：工具侧
//!   只传当前会话标识，实现方保证查询不越会话；
//! - search 只搜「已压缩块」，不搜上下文可见消息（模型看得见就不浪费
//!   工具调用）；
//! - decompress 返回**原始字节**（事件流原文回放，不经 clean 清洗管线），
//!   文档化防模型认知差（P2-6）；
//! - 引擎实现侧 v6 旧库缺表时返回空集 + warn，不 SQL 报错（风险 12）。

use std::fmt::Debug;

/// 压缩块索引命中（search_context 单条结果，字段对齐 conex-db
/// CompactionBlockRow 的块级元数据子集；state 字面量对齐块表：
/// awaiting | committed | retired）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockHit {
    /// 块 id（R-B：`compacted-summary-{generation}-{fold_index}`）
    pub block_id: String,
    /// 会话级压缩代数（R-K 单源）
    pub generation: u32,
    /// 树高度（迭代合并次数）
    pub height: u32,
    /// 链内摘要文本（md 渲染或 stub），search 命中返回片段
    pub summary: String,
    /// 被压缩（丢弃并进入摘要）的消息数
    pub dropped_count: usize,
    /// 摘要状态字面量（awaiting / committed / retired）
    pub state: String,
}

/// 压缩块原文（decompress_context 取回内容）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockContent {
    /// 块 id（与请求的 blockId 一致，供消费方回环校验）
    pub block_id: String,
    /// 原文（事件流回放提取，原始字节不经 clean）
    pub text: String,
}

/// 压缩块只读访问服务契约（注入 ToolContext，None = 未接线，工具返回
/// common.unsupported 结构化错误）
///
/// 注：ToolContext 派生 Debug，trait 对象须可打印——追加 `std::fmt::Debug`
/// 上界（对齐 [crate::tools::output_dir::OutputDirResolver] 同款做法）。
pub trait CompressionContextStore: Send + Sync + Debug {
    /// 在会话的已压缩块中检索（只搜 compression_blocks，不搜上下文可见
    /// 消息）；返回按实现方排序的命中（工具侧再按 generation 降序稳定
    /// 排序保证契约）。`limit` 为返回条数上限；失败返回 Err(String)。
    fn search_blocks(
        &self,
        session_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<BlockHit>, String>;

    /// 按块 id 取回原文（事件流回放提取，原始字节）。None = 该会话内
    /// 块不存在；失败返回 Err(String)。
    fn decompress_block(
        &self,
        session_id: &str,
        block_id: &str,
    ) -> Result<Option<BlockContent>, String>;
}

use std::sync::{Arc, RwLock};

static GLOBAL_COMPRESSION_STORE: RwLock<Option<Arc<dyn CompressionContextStore>>> =
    RwLock::new(None);

/// 注册全局压缩块只读存储实例（BC11-4：供未通过 ToolContext 直接注入的场景透明回退）
pub fn register_global_compression_store(store: Arc<dyn CompressionContextStore>) {
    if let Ok(mut lock) = GLOBAL_COMPRESSION_STORE.write() {
        *lock = Some(store);
    }
}

/// 清除全局压缩块只读存储实例（主要供测试使用）
pub fn clear_global_compression_store() {
    if let Ok(mut lock) = GLOBAL_COMPRESSION_STORE.write() {
        *lock = None;
    }
}

/// 获取全局压缩块只读存储实例
pub fn global_compression_store() -> Option<Arc<dyn CompressionContextStore>> {
    GLOBAL_COMPRESSION_STORE.read().ok().and_then(|g| g.clone())
}
