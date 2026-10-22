//! resolve_output_dir 工具（T-EG-08 / REQ-G01）

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;

// ==================== resolve_output_dir 工具 ====================

/// resolve_output_dir 工具：解析本次会话的文档产出目录（T-EG-08 / REQ-G01）
///
/// schema 按方案 04 §4.4 冻结：可选 folder（工作区内绝对路径）；输出
/// path / userSpecified / dirCreated / text。查询类工具（不写盘、不建目录），
/// 按任务书定稿不加入 readonly.rs 的 WRITE_TOOL_NAMES。
pub(crate) struct ResolveOutputDirTool {
    def: ToolDefinition,
}

impl ResolveOutputDirTool {
    /// 新建工具（产出目录服务经 ToolContext.output_dir 注入，构造零依赖）
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "resolve_output_dir".to_string(),
                description: "解析本次会话的文档产出目录：显式 folder 优先（直接使用，\
                              不创建）；否则返回 .agent-outputs/<YYYY-MM-DD>-<会话标识>/\
                              （惰性——首次写入时自动创建）。同会话重复调用返回同一路径。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "folder": {
                            "type": "string",
                            "description": "用户显式指定的产出目录（工作区内绝对路径），\
                                            优先于默认生成；只读子代理不允许自选（仅按主 \
                                            agent 规划的目录返回）"
                        }
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
impl Tool for ResolveOutputDirTool {
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
        // 产出目录服务未接线 → 结构化不可用错误（对齐 set_timer /
        // wait_subagents 未接线模式，引擎集成前零副作用）
        let Some(resolver) = &ctx.output_dir else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "resolve_output_dir 未接线：产出目录服务未装配（引擎侧注入 OutputDirResolver 后可用）",
            ));
        };

        // 只读子代理不允许自选输出目录（已决策）：folder 参数忽略——
        // 不做路径校验也不透传，仅返回主 agent 规划的产出目录
        let is_readonly_caller = ctx.explore_docs_quota.is_some();
        let raw_folder = super::optional_string(&args, "folder");
        let folder_ignored = is_readonly_caller && raw_folder.is_some();
        let mut folder = if is_readonly_caller { None } else { raw_folder };

        // 显式 folder → 工作区路径校验（越界 / 非法字符 / glob 形态拒绝，
        // 对齐 write_file 目标路径的 resolve_workspace_path 语义；目标目录
        // 尚不存在时 safe_canonicalize 走「最近存在前缀 + 词法尾部」归一化）
        if let Some(raw) = folder {
            if raw.trim().is_empty() {
                return Err(ToolError::invalid_input(
                    "folder must be a non-empty string",
                ));
            }
            let canonical = super::resolve_workspace_path(&ctx.workspace_root, &raw)?;
            folder = Some(canonical.to_string_lossy().into_owned());
        }

        let result = resolver.resolve(&ctx.session_id, folder.as_deref());

        // 输出形状按方案 04 §4.4 冻结：path（工作区相对展示路径 + 尾斜杠）/
        // userSpecified / dirCreated / text
        let display = super::display_path(&ctx.workspace_root, &result.dir.dir);
        let mut notes: Vec<&str> = Vec::new();
        if result.first_resolve && result.dir.user_specified {
            notes.push("用户指定路径已生效并作为本会话默认产出目录");
        }
        if folder_ignored {
            notes.push("只读子代理不允许自选输出目录，folder 参数已忽略");
        }
        let mut text = format!(
            "会话产出目录：{}（首次写入时自动创建；后续文档产出默认写入该目录）",
            result.dir.dir.display()
        );
        if !notes.is_empty() {
            text.push_str(&format!("；{}", notes.join("；")));
        }
        text.push_str("\nSnapshot tag: <无>");

        Ok(serde_json::json!({
            "path": format!("{display}/"),
            "userSpecified": result.dir.user_specified,
            "dirCreated": result.dir_created,
            "text": text,
        }))
    }
}
