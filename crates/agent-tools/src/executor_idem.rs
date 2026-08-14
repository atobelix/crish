//! 幂等键面（SR-06a-4 拆分 · executor.rs `#[path]` 接线）：从执行上下文
//! 与入参构造幂等上下文 + 目标存在性探针键素材（F7 遗留 2 接线）。

use super::executor_types::ExecutorContext;
use crate::idempotency::IdempotencyContext;
use serde_json::Value;

/// 从执行上下文与入参构造幂等上下文
///
/// snapshotTag 取入参携带值（如 edit 类工具的 snapshotTag 字段），
/// 作为文件状态类工具的更精确键；ctx 无需显式提供。
/// 键素材另附加「目标存在性」探针（F7 遗留 2 接线）：路径类工具同参对
/// 「已存在/不存在」文件的结果不同（如 write_file overwrite=false →
/// tool.file_exists），参数 hash 键须含目标当前存在状态，否则同一键会掩盖
/// 结果差异。check 与 record 各自实时探测：record 记录的是执行后的状态，
/// 重试时状态一致则去重、状态翻转（如外部删除后重试）则重新执行。
pub(super) fn build_idempotency_context(
    ctx: &ExecutorContext,
    tool_name: &str,
    args: &Value,
) -> IdempotencyContext {
    IdempotencyContext {
        run_id: ctx.run_id.clone(),
        session_id: ctx.session_id.clone(),
        tool_name: tool_name.to_string(),
        snapshot_tag: args
            .get("snapshotTag")
            .and_then(Value::as_str)
            .map(String::from),
        extra_key_material: path_existence_markers(ctx, args),
    }
}

/// 目标存在性键素材：对带 path / target_file 入参的工具，以 cwd 为基准解析
/// 目标路径并探测存在状态；cwd 缺失时返回空（行为与未接线一致，纯增量）。
fn path_existence_markers(ctx: &ExecutorContext, args: &Value) -> Vec<String> {
    let Some(cwd) = &ctx.cwd else {
        return Vec::new();
    };
    let mut markers = Vec::new();
    for key in ["path", "target_file"] {
        if let Some(raw) = args.get(key).and_then(Value::as_str) {
            // join 遇绝对路径自动替换基准（write_file schema 允许绝对路径）
            let target = std::path::Path::new(cwd).join(raw);
            markers.push(format!("{key}:exists={}", target.exists()));
        }
    }
    markers
}
